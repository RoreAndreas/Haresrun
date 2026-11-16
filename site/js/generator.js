/*
 * Générateur de boucles de N km (départ = arrivée).
 *
 * 1. Le réseau des rues autour du départ vient de HR.streets (tuiles de la
 *    carte, ou Overpass en secours ; souvent déjà préchargé).
 * 2. Un algorithme de Dijkstra explore ce graphe depuis le départ, rue par
 *    rue, dans l'ordre des distances : c'est ce qu'affiche l'animation.
 * 3. La boucle passe par deux points posés sur un cercle qui touche le
 *    départ, dans une direction tirée au hasard. Chaque tronçon est calculé
 *    par A* en pénalisant les rues déjà empruntées, pour éviter les
 *    allers-retours. Le rayon est ajusté jusqu'à tomber à ±7 % de la
 *    distance voulue.
 *
 * Si aucun réseau de rues n'est disponible, on se rabat sur le service
 * d'itinéraire OSRM, sans animation d'exploration.
 */
(() => {
  'use strict';
  const { offset, pathLength } = HR;
  const TORTUOSITY = 1.3; // une boucle réelle est ~30 % plus longue que le cercle idéal
  const abortError = () => Object.assign(new Error('Génération annulée.'), { name: 'AbortError' });

  /** Rayon de rues nécessaire pour une boucle de `target` mètres. */
  const needRadius = target => Math.min(5000, 2 * target / (2 * Math.PI * TORTUOSITY) * 1.2 + 300);

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

  // ---------- algorithmes sur le graphe ----------
  function nearest(g, p, filter) {
    const kx = Math.PI / 180 * 6371008.8 * Math.cos(g.origin.lat * Math.PI / 180), ky = Math.PI / 180 * 6371008.8;
    const qx = (p.lng - g.origin.lng) * kx, qy = (p.lat - g.origin.lat) * ky;
    let best = -1, bd = Infinity;
    for (let i = 0; i < g.n; i++) {
      if (!g.adj[i].length || (filter && !filter(i))) continue;
      const d = (g.x[i] - qx) ** 2 + (g.y[i] - qy) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Dijkstra depuis `src` jusqu'à `limit` mètres : distance de chaque nœud. */
  function explore(g, src, limit) {
    const d = new Float64Array(g.n).fill(Infinity);
    const heap = new Heap();
    d[src] = 0; heap.push(0, src);
    while (heap.size) {
      const u = heap.pop(), du = d[u];
      if (du > limit) break;
      for (const e of g.adj[u]) {
        const [a, b, len] = g.edges[e], v = a === u ? b : a, nd = du + len;
        if (nd < d[v]) { d[v] = nd; heap.push(nd, v); }
      }
    }
    return d;
  }

  /** A* de `s` à `t`, avec pénalités de voie et rues déjà prises (`used`). */
  function astar(g, s, t, used) {
    const gs = new Float64Array(g.n).fill(Infinity), prev = new Int32Array(g.n).fill(-1);
    const heap = new Heap(), h = i => Math.hypot(g.x[i] - g.x[t], g.y[i] - g.y[t]);
    const closed = new Uint8Array(g.n);
    gs[s] = 0; heap.push(h(s), s);
    while (heap.size) {
      const u = heap.pop();
      if (u === t) break;
      if (closed[u]) continue;
      closed[u] = 1;
      for (const e of g.adj[u]) {
        const [a, b, len, pen] = g.edges[e], v = a === u ? b : a;
        const ng = gs[u] + len * pen * (used.has(e) ? 5 : 1);
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
   * @param opts.onExplore(featureCollection) dès que l'exploration est prête
   * @param opts.onStage(étape) : download | slow | explore | build | fallback
   * @param opts.signal AbortSignal pour annuler
   */
  async function generate(start, target, { onExplore, onStage = () => {}, signal } = {}) {
    const check = () => { if (signal && signal.aborted) throw abortError(); };
    const breathe = () => new Promise(r => setTimeout(r, 0)); // laisse l'écran se mettre à jour
    const r0 = target / (2 * Math.PI * TORTUOSITY), need = needRadius(target);
    onStage('download');
    let g;
    try {
      g = await HR.streets.load(start, need, { signal, onSlow: () => onStage('slow') });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('Rues :', e.message);
      onStage('fallback');
      return generateOSRM(start, target, signal);
    }
    check();
    onStage('explore');
    await breathe();
    const src = nearest(g, start);
    if (src < 0) { onStage('fallback'); return generateOSRM(start, target, signal); }
    const limit = need * 1.4;
    const d = explore(g, src, limit);

    // animation : chaque rue explorée, repérée par sa distance au départ
    if (onExplore) {
      let far = 0;
      for (const v of d) if (v <= limit && v > far) far = v;
      const features = [];
      for (const [a, b] of g.edges) {
        const da = d[a], db = d[b];
        if (!(da <= limit) || !(db <= limit)) continue;
        features.push({
          type: 'Feature', properties: { o: Math.max(da, db) / (far || 1) },
          geometry: { type: 'LineString', coordinates: [[g.lng[a], g.lat[a]], [g.lng[b], g.lat[b]]] },
        });
      }
      onExplore({ type: 'FeatureCollection', features });
    }
    await breathe();
    check();
    onStage('build');

    const reachable = i => d[i] <= limit;
    let best = null, bearing = Math.random() * 360, r = r0;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt && attempt % 4 === 0) { bearing = Math.random() * 360; r = r0; }
      const c = offset(start, r, bearing);
      // départ vu du centre : bearing + 180 ; deux points à ±120° de là
      const A = offset(c, r, bearing + 180 + 120), B = offset(c, r, bearing + 180 - 120);
      const ids = [src, nearest(g, A, reachable), nearest(g, B, reachable), src];
      if (ids.some(i => i < 0) || ids[1] === ids[2]) { r *= 1.15; continue; }
      const loop = loopThrough(g, ids);
      if (!loop) { bearing = Math.random() * 360; continue; }
      const err = Math.abs(loop.distance - target) / target;
      if (!best || err < best.err) best = { ...loop, err, via: [ids[1], ids[2]] };
      if (err < 0.07) break;
      r *= Math.max(0.6, Math.min(1.6, target / loop.distance));
      await breathe();
      check();
    }
    if (!best) { onStage('fallback'); return generateOSRM(start, target, signal); }
    return {
      path: best.path, distance: best.distance, source: 'generated', explored: true, streets: g.source,
      points: [{ lat: g.lat[src], lng: g.lng[src] }, ...best.via.map(i => ({ lat: g.lat[i], lng: g.lng[i] }))],
    };
  }

  /** Repli sans réseau de rues : mêmes points sur un cercle, itinéraire par OSRM. */
  async function generateOSRM(start, target, signal) {
    let r = target / (2 * Math.PI * TORTUOSITY), best = null;
    const bearing = Math.random() * 360;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) throw abortError();
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

  /** Précharge les rues pour une future boucle de `target` mètres depuis `start`. */
  function prefetch(start, target) {
    // marge de 30 % : couvre un départ un peu déplacé ou quelques km de plus
    if (start) HR.streets.prefetch(start, Math.min(6000, needRadius(target) * 1.3));
  }

  HR.generator = { generate, prefetch };
})();
