/*
 * Générateur de boucles de N km (départ = arrivée).
 *
 * 1. Les rues praticables à pied autour du départ sont téléchargées depuis
 *    OpenStreetMap (API Overpass) et transformées en graphe.
 * 2. Un algorithme de Dijkstra explore ce graphe depuis le départ, rue par
 *    rue, dans l'ordre des distances : c'est ce qu'affiche l'animation.
 * 3. La boucle passe par deux points posés sur un cercle qui touche le
 *    départ, dans une direction tirée au hasard. Chaque tronçon est calculé
 *    par A* en pénalisant les rues déjà empruntées, pour éviter les
 *    allers-retours. Le rayon est ajusté jusqu'à tomber à ±7 % de la
 *    distance voulue.
 *
 * Si Overpass ne répond pas, on se rabat sur le service d'itinéraire OSRM,
 * sans animation d'exploration.
 */
(() => {
  'use strict';
  const { dist, offset, toXY, pathLength } = HR;

  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const HIGHWAYS = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|track|cycleway|steps|service|road';
  // coût relatif par type de voie : on préfère les petites rues et les chemins
  const PENALTY = { trunk: 1.6, primary: 1.3, secondary: 1.1, service: 1.4, steps: 1.5 };
  const TORTUOSITY = 1.3; // une boucle réelle est ~30 % plus longue que le cercle idéal

  // ---------- tas binaire (file de priorité) ----------
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v;
      let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
      if (k.length) {
        let i = 0;
        const n = k.length;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  // ---------- graphe ----------
  async function fetchStreets(center, radius) {
    const q = `[out:json][timeout:25];
way(around:${Math.round(radius)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})[highway~"^(${HIGHWAYS})$"][access!~"^(private|no)$"][foot!~"^no$"]->.w;
.w out body qt;
node(w.w);
out skel qt;`;
    let lastErr;
    for (const url of OVERPASS) {
      try {
        return await HR.getJSON(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), timeout: 30000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  function buildGraph(osm, origin) {
    const idx = new Map(), lat = [], lng = [], x = [], y = [];
    for (const el of osm.elements) {
      if (el.type !== 'node') continue;
      idx.set(el.id, lat.length);
      lat.push(el.lat); lng.push(el.lon);
      const p = toXY({ lat: el.lat, lng: el.lon }, origin);
      x.push(p.x); y.push(p.y);
    }
    const adj = Array.from({ length: lat.length }, () => []);
    const edges = []; // [a, b, longueur, pénalité]
    for (const el of osm.elements) {
      if (el.type !== 'way' || !el.nodes) continue;
      const pen = PENALTY[el.tags && el.tags.highway] || 1;
      for (let i = 1; i < el.nodes.length; i++) {
        const a = idx.get(el.nodes[i - 1]), b = idx.get(el.nodes[i]);
        if (a == null || b == null || a === b) continue;
        const len = Math.hypot(x[a] - x[b], y[a] - y[b]), e = edges.length;
        edges.push([a, b, len, pen]);
        adj[a].push(e); adj[b].push(e);
      }
    }
    return { lat, lng, x, y, adj, edges, n: lat.length };
  }

  function nearest(g, p, origin, filter) {
    const q = toXY(p, origin);
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.n; i++) {
      if (!g.adj[i].length || (filter && !filter(i))) continue;
      const d = (g.x[i] - q.x) ** 2 + (g.y[i] - q.y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Dijkstra depuis `src` jusqu'à `limit` mètres : distances + ordre de découverte. */
  function explore(g, src, limit) {
    const d = new Float64Array(g.n).fill(Infinity);
    const heap = new Heap();
    d[src] = 0; heap.push(0, src);
    while (heap.size) {
      const u = heap.pop();
      const du = d[u];
      if (du > limit) break;
      for (const e of g.adj[u]) {
        const [a, b, len] = g.edges[e], v = a === u ? b : a, nd = du + len;
        if (nd < d[v]) { d[v] = nd; heap.push(nd, v); }
      }
    }
    return d;
  }

  /** A* de `s` à `t`, pénalités de voie et rues déjà prises (`used`). */
  function astar(g, s, t, used) {
    const gs = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1);
    const heap = new Heap(), h = i => Math.hypot(g.x[i] - g.x[t], g.y[i] - g.y[t]);
    gs[s] = 0; heap.push(h(s), s);
    const closed = new Uint8Array(g.n);
    while (heap.size) {
      const u = heap.pop();
      if (u === t) break;
      if (closed[u]) continue;
      closed[u] = 1;
      for (const e of g.adj[u]) {
        const [a, b, len, pen] = g.edges[e], v = a === u ? b : a;
        const cost = len * pen * (used.has(e) ? 5 : 1), ng = gs[u] + cost;
        if (ng < gs[v]) { gs[v] = ng; prev[v] = e; heap.push(ng + h(v), v); }
      }
    }
    if (!isFinite(gs[t])) return null;
    const nodes = [t], es = [];
    for (let v = t; v !== s;) {
      const e = prev[v], [a, b] = g.edges[e];
      es.push(e);
      v = a === v ? b : a;
      nodes.push(v);
    }
    return { nodes: nodes.reverse(), edges: es.reverse() };
  }

  function loopThrough(g, ids) {
    const used = new Set(), nodes = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const leg = astar(g, ids[i], ids[i + 1], used);
      if (!leg) return null;
      leg.edges.forEach(e => used.add(e));
      nodes.push(...(i ? leg.nodes.slice(1) : leg.nodes));
    }
    const path = nodes.map(i => ({ lat: g.lat[i], lng: g.lng[i] }));
    return { path, distance: pathLength(path) };
  }

  // ---------- génération ----------
  /**
   * @param start   point de départ (= arrivée)
   * @param target  distance voulue, en mètres
   * @param onExplore(featureCollection) appelé dès que l'exploration est prête
   */
  async function generate(start, target, { onExplore } = {}) {
    const r0 = target / (2 * Math.PI * TORTUOSITY);
    const fetchR = Math.min(6000, 2 * r0 * 1.35 + 400);
    let osm;
    try {
      osm = await fetchStreets(start, fetchR);
    } catch (e) {
      console.warn('Overpass :', e.message);
      return generateOSRM(start, target);
    }
    const g = buildGraph(osm, start);
    if (g.edges.length < 10) return generateOSRM(start, target);
    const src = nearest(g, start, start);
    const limit = fetchR * 1.4;
    const d = explore(g, src, limit);

    // animation : chaque rue explorée, numérotée par sa distance au départ
    if (onExplore) {
      let far = 0;
      for (const v of d) if (isFinite(v) && v > far) far = v;
      const features = [];
      for (const [a, b] of g.edges) {
        const da = d[a], db = d[b];
        if (!isFinite(da) || !isFinite(db)) continue;
        features.push({
          type: 'Feature', properties: { o: Math.max(da, db) / (far || 1) },
          geometry: { type: 'LineString', coordinates: [[g.lng[a], g.lat[a]], [g.lng[b], g.lat[b]]] },
        });
      }
      features.sort((p, q) => p.properties.o - q.properties.o);
      onExplore({ type: 'FeatureCollection', features });
    }

    const reachable = i => isFinite(d[i]);
    let best = null;
    let bearing = Math.random() * 360, r = r0;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt && attempt % 4 === 0) { bearing = Math.random() * 360; r = r0; }
      const c = offset(start, r, bearing);
      // départ vu du centre : bearing + 180 ; deux points à ±120° de là
      const A = offset(c, r, bearing + 180 + 120), B = offset(c, r, bearing + 180 - 120);
      const ids = [src, nearest(g, A, start, reachable), nearest(g, B, start, reachable), src];
      if (ids.some(i => i < 0) || ids[1] === ids[2]) { r *= 1.15; continue; }
      const loop = loopThrough(g, ids);
      if (!loop) { bearing = Math.random() * 360; continue; }
      const err = Math.abs(loop.distance - target) / target;
      if (!best || err < best.err) best = { ...loop, err, via: [ids[1], ids[2]] };
      if (err < 0.07) break;
      r *= Math.max(0.6, Math.min(1.6, target / loop.distance));
    }
    if (!best) return generateOSRM(start, target);
    return {
      path: best.path, distance: best.distance, source: 'generated', explored: true,
      points: [{ lat: g.lat[src], lng: g.lng[src] }, ...best.via.map(i => ({ lat: g.lat[i], lng: g.lng[i] }))],
    };
  }

  /** Repli sans Overpass : mêmes points sur un cercle, itinéraire par OSRM. */
  async function generateOSRM(start, target) {
    let r = target / (2 * Math.PI * TORTUOSITY), best = null;
    const bearing = Math.random() * 360;
    for (let attempt = 0; attempt < 4; attempt++) {
      const c = offset(start, r, bearing);
      const pts = [start, offset(c, r, bearing + 300), offset(c, r, bearing + 60)];
      let res;
      try { res = await HR.services.route([...pts, start]); } catch { break; }
      const err = Math.abs(res.distance - target) / target;
      if (!best || err < best.err) best = { ...res, err, points: pts };
      if (err < 0.07) break;
      r *= Math.max(0.6, Math.min(1.6, target / res.distance));
    }
    if (!best) throw new Error('Impossible de générer une boucle ici pour le moment.');
    return { path: best.path, distance: best.distance, source: 'generated', explored: false, points: best.points };
  }

  HR.generator = { generate };
  // exposé pour les tests
  HR.generator._internal = { buildGraph, explore, astar, dist };
})();
