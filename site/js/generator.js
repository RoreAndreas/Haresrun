/*
 * Générateur de boucles de N km (départ = arrivée).
 *
 * 1. Le réseau des rues autour du départ vient de HR.streets (tuiles de la
 *    carte, ou Overpass en secours ; souvent déjà préchargé).
 * 2. Un algorithme de Dijkstra explore ce graphe depuis le départ, rue par
 *    rue, dans l'ordre des distances : c'est ce qu'affiche l'animation.
 * 3. Une douzaine de boucles candidates sont construites, dans des
 *    directions différentes, puis notées ; la meilleure est retenue.
 *
 * Ce qui fait une bonne boucle de course (et donc sa note) :
 *   - la bonne distance (±7 % visé) ;
 *   - peu d'allers-retours sur les mêmes rues ;
 *   - des voies agréables : chemins et petites rues plutôt que grands axes,
 *     parkings ou voies de service (coûts par type de voie, voir streets.js) ;
 *   - peu de virages : à longueur égale, l'itinéraire le plus droit ;
 *   - une forme ronde, compacte, plutôt qu'un tracé tordu ou aplati.
 * Les points de passage ne sont jamais posés dans une impasse : seulement
 * sur le « cœur » du réseau, là où l'on peut arriver et repartir par deux
 * rues différentes.
 *
 * Sans réseau de rues, repli sur le service d'itinéraire OSRM.
 */
(() => {
  'use strict';
  const { offset, pathLength } = HR;
  const TORTUOSITY = 1.3;   // une boucle réelle est ~30 % plus longue que le cercle idéal
  const MIN_PENALTY = 0.9;  // coût minimal d'un mètre (chemins) : garde l'heuristique A* juste
  const REUSE = 10;         // coût d'une rue déjà empruntée par la boucle
  const MAX_REUSE = 0.10;   // au plus 10 % de la boucle sur des rues déjà courues
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

  // ---------- outils sur le graphe ----------
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
  const other = (g, e, u) => (g.edges[e][0] === u ? g.edges[e][1] : g.edges[e][0]);

  /** Dijkstra depuis `src` jusqu'à `limit` mètres : distance de chaque nœud. */
  function explore(g, src, limit) {
    const d = new Float64Array(g.n).fill(Infinity);
    const heap = new Heap();
    d[src] = 0; heap.push(0, src);
    while (heap.size) {
      const u = heap.pop(), du = d[u];
      if (du > limit) break;
      for (const e of g.adj[u]) {
        const v = other(g, e, u), nd = du + g.edges[e][2];
        if (nd < d[v]) { d[v] = nd; heap.push(nd, v); }
      }
    }
    return d;
  }

  /**
   * Cœur du réseau (2-cœur) : on retire de proche en proche les nœuds qui
   * n'ont qu'un voisin. Restent les rues où l'on peut entrer et ressortir
   * sans faire demi-tour : pas d'impasses.
   */
  function core(g) {
    const deg = new Int32Array(g.n), alive = new Uint8Array(g.n).fill(1), stack = [];
    for (let i = 0; i < g.n; i++) { deg[i] = new Set(g.adj[i].map(e => other(g, e, i))).size; if (deg[i] <= 1) stack.push(i); }
    while (stack.length) {
      const u = stack.pop();
      if (!alive[u]) continue;
      alive[u] = 0;
      for (const e of g.adj[u]) { const v = other(g, e, u); if (alive[v] && --deg[v] <= 1) stack.push(v); }
    }
    return alive;
  }

  // Coût d'un virage, en « mètres équivalents » : à longueur égale, on
  // préfère l'itinéraire qui tourne le moins (tracé lisible, sans zigzags).
  function turnCost(g, a, b, c) {
    if (a === c) return 300; // demi-tour
    const ux = g.x[b] - g.x[a], uy = g.y[b] - g.y[a], vx = g.x[c] - g.x[b], vy = g.y[c] - g.y[b];
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    return cos > 0.7 ? 0 : cos > -0.2 ? 15 : 45; // tout droit / virage / virage serré
  }

  /**
   * A* sur les arêtes orientées (pour connaître la direction d'arrivée et
   * compter les virages), de `s` à `t`. Coût : longueur × type de voie ×
   * réutilisation, + virages.
   */
  // ---------- zones déjà courues ----------
  // Une rue parallèle à 10 m (chaussée d'en face d'un boulevard, trottoir
  // tracé à part) est, pour le coureur, la même rue. On marque donc les
  // cases de 12 m traversées par la boucle, et leurs voisines : tout passage
  // à moins de ~20 m d'un endroit déjà couru compte comme une répétition.
  const CELL = 12;
  const cellKey = (x, y) => Math.floor(x / CELL) * 1e6 + Math.floor(y / CELL);
  function samples(g, e, step) {
    const [a, b, len] = g.edges[e], n = Math.max(1, Math.ceil(len / step)), out = [];
    for (let i = 0; i <= n; i++) out.push([g.x[a] + (g.x[b] - g.x[a]) * i / n, g.y[a] + (g.y[b] - g.y[a]) * i / n]);
    return out;
  }
  function cover(g, zone, edges) {
    for (const e of edges) for (const [x, y] of samples(g, e, 6)) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) zone.add((cx + i) * 1e6 + cy + j);
    }
  }
  /** Part (0 → 1) de l'arête `e` qui passe dans une zone déjà courue. */
  function coveredPart(g, zone, e) {
    if (!zone.size) return 0;
    const pts = samples(g, e, 8).slice(1, -1);
    if (!pts.length) pts.push([(g.x[g.edges[e][0]] + g.x[g.edges[e][1]]) / 2, (g.y[g.edges[e][0]] + g.y[g.edges[e][1]]) / 2]);
    return pts.filter(([x, y]) => zone.has(cellKey(x, y))).length / pts.length;
  }

  function astar(g, s, t, used, arrivedBy = -1, zone = new Set()) {
    const E = g.edges.length, gs = new Float64Array(2 * E).fill(Infinity), prev = new Int32Array(2 * E).fill(-1);
    const heap = new Heap();
    const h = v => MIN_PENALTY * Math.hypot(g.x[v] - g.x[t], g.y[v] - g.y[t]);
    const head = de => (de & 1 ? g.edges[de >> 1][0] : g.edges[de >> 1][1]);
    const tail = de => (de & 1 ? g.edges[de >> 1][1] : g.edges[de >> 1][0]);
    const memo = new Map();
    const cost = e => {
      let c = memo.get(e);
      if (c === undefined) {
        // rue déjà prise, ou passage dans une zone déjà courue : coût multiplié
        const f = used.has(e) ? 1 : coveredPart(g, zone, e);
        c = g.edges[e][2] * g.edges[e][3] * (1 + (REUSE - 1) * f);
        memo.set(e, c);
      }
      return c;
    };
    for (const e of g.adj[s]) {
      const de = 2 * e + (g.edges[e][0] === s ? 0 : 1);
      // repartir d'un point de passage par la rue d'arrivée = demi-tour
      gs[de] = cost(e) + (e === arrivedBy ? 300 : arrivedBy >= 0 ? turnCost(g, other(g, arrivedBy, s), s, head(de)) : 0);
      heap.push(gs[de] + h(head(de)), de);
    }
    let goal = -1;
    const closed = new Uint8Array(2 * E);
    while (heap.size) {
      const de = heap.pop();
      if (closed[de]) continue;
      closed[de] = 1;
      const v = head(de), u = tail(de);
      if (v === t) { goal = de; break; }
      for (const e of g.adj[v]) {
        const nd = 2 * e + (g.edges[e][0] === v ? 0 : 1);
        if (closed[nd]) continue;
        const ng = gs[de] + cost(e) + turnCost(g, u, v, head(nd));
        if (ng < gs[nd]) { gs[nd] = ng; prev[nd] = de; heap.push(ng + h(head(nd)), nd); }
      }
    }
    if (goal < 0) return null;
    const es = [], nodes = [t];
    for (let de = goal; de >= 0; de = prev[de]) { es.push(de >> 1); nodes.push(tail(de)); }
    return { nodes: nodes.reverse(), edges: es.reverse() };
  }

  function loopThrough(g, ids) {
    const used = new Set(), zone = new Set(), nodes = [], edges = [];
    for (let i = 0; i < ids.length - 1; i++) {
      const leg = astar(g, ids[i], ids[i + 1], used, edges.length ? edges[edges.length - 1] : -1, zone);
      if (!leg) return null;
      leg.edges.forEach(e => used.add(e));
      cover(g, zone, leg.edges);
      edges.push(...leg.edges);
      nodes.push(...(i ? leg.nodes.slice(1) : leg.nodes));
    }
    return { nodes, edges };
  }

  // Dernières boucles proposées (rues empruntées), pour que « Générer » à
  // nouveau propose vraiment autre chose.
  const recent = [];
  const edgeKey = (g, e) => {
    const [a, b] = g.edges[e], ka = g.lat[a].toFixed(5) + g.lng[a].toFixed(5), kb = g.lat[b].toFixed(5) + g.lng[b].toFixed(5);
    return ka < kb ? ka + kb : kb + ka;
  };
  function overlap(g, loop) {
    let worst = 0;
    for (const prev of recent) {
      let shared = 0, L = 0;
      for (const e of loop.edges) { const len = g.edges[e][2]; L += len; if (prev.has(edgeKey(g, e))) shared += len; }
      worst = Math.max(worst, shared / (L || 1));
    }
    return worst;
  }

  /**
   * Part (0 → 1) de la boucle qui repasse à moins de 20 m d'un endroit déjà
   * couru plus tôt (même rue, chaussée d'en face, trottoir parallèle…).
   * Les 100 premiers et derniers mètres, autour du départ, ne comptent pas :
   * on part et on revient forcément au même endroit.
   */
  function spatialOverlap(g, nodes) {
    const pts = [];
    let along = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i], len = Math.hypot(g.x[b] - g.x[a], g.y[b] - g.y[a]), n = Math.max(1, Math.round(len / 10));
      for (let k = 0; k < n; k++) pts.push([g.x[a] + (g.x[b] - g.x[a]) * k / n, g.y[a] + (g.y[b] - g.y[a]) * k / n, along + len * k / n]);
      along += len;
    }
    const L = along, C = 20, grid = new Map();
    pts.forEach((p, i) => { const k = Math.floor(p[0] / C) * 1e6 + Math.floor(p[1] / C); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    let hit = 0, counted = 0;
    for (const [x, y, s] of pts) {
      if (s < 100 || s > L - 100) continue;
      counted++;
      const cx = Math.floor(x / C), cy = Math.floor(y / C);
      let found = false;
      for (let i = -1; i <= 1 && !found; i++) for (let j = -1; j <= 1 && !found; j++) {
        for (const q of grid.get((cx + i) * 1e6 + cy + j) || []) {
          const [qx, qy, qs] = pts[q];
          // un autre passage : à plus de 150 m le long de la boucle, et pas dans la zone du départ
          if (Math.abs(qs - s) > 150 && qs >= 100 && qs <= L - 100 && Math.hypot(qx - x, qy - y) < 20) { found = true; break; }
        }
      }
      if (found) hit++;
    }
    return counted ? hit / counted : 0;
  }

  /** Note d'une boucle : plus elle est basse, meilleure est la boucle. */
  function score(g, loop, target) {
    let L = 0, weighted = 0, reused = 0;
    const count = new Map();
    for (const e of loop.edges) {
      const [, , len, pen] = g.edges[e];
      L += len; weighted += len * pen;
      const c = (count.get(e) || 0) + 1;
      count.set(e, c);
      if (c > 1) reused += len;
    }
    const n = loop.nodes;
    let turns = 0, area = 0;
    for (let i = 1; i < n.length - 1; i++) if (turnCost(g, n[i - 1], n[i], n[i + 1]) >= 45) turns++;
    for (let i = 1; i < n.length; i++) area += g.x[n[i - 1]] * g.y[n[i]] - g.x[n[i]] * g.y[n[i - 1]];
    const roundness = Math.min(1, 4 * Math.PI * Math.abs(area / 2) / (L * L)); // 1 = cercle parfait
    const err = Math.abs(L - target) / target;
    // répétition : même rue reprise, ou passage parallèle tout proche
    const reuse = Math.max(reused / L, spatialOverlap(g, n));
    return {
      L, err, reuse,
      value: err * 120 + reuse * 150 + (weighted / L - 1) * 40 + (turns / (L / 1000)) * 1.5 + (1 - roundness) * 25
        + overlap(g, loop) * 60, // trop proche d'une boucle déjà proposée
    };
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
    const breathe = () => new Promise(r => setTimeout(r, 0)); // laisse l'animation avancer
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

    // points de passage : sur le cœur du réseau, accessibles depuis le départ
    const alive = core(g);
    let ok = i => d[i] <= limit && alive[i];
    if (!g.adj.some((_, i) => ok(i))) ok = i => d[i] <= limit;

    // Candidates : 6 directions réparties autour du départ (avec un peu de
    // hasard pour varier d'une génération à l'autre) ; pour chacune, une
    // boucle par 3 points sur un cercle touchant le départ (forme ronde),
    // rayon ajusté une fois si la distance est loin du compte.
    const candidates = [], base = Math.random() * 360;
    for (let k = 0; k < 8; k++) {
      const bearing = base + k * 45 + (Math.random() - 0.5) * 20;
      let r = r0;
      for (let it = 0; it < 2; it++) {
        const c = offset(start, r, bearing);
        const via = [90, 180, 270].map(a => nearest(g, offset(c, r, bearing + 180 + a), ok));
        if (via.some(i => i < 0) || new Set(via).size < 3 || via.includes(src)) break;
        const loop = loopThrough(g, [src, ...via, src]);
        await breathe();
        check();
        if (!loop) break;
        const s = score(g, loop, target);
        candidates.push({ ...loop, ...s, via });
        if (s.err < 0.06) break;
        r *= Math.max(0.6, Math.min(1.6, target / s.L));
      }
    }
    if (!candidates.length) { onStage('fallback'); return generateOSRM(start, target, signal); }
    // Règles strictes d'abord : bonne distance (±15 %) et au moins 90 % de
    // rues nouvelles ; parmi celles-là, la meilleure note. Si aucune ne
    // passe (départ au fond d'une impasse, quartier très peu maillé…), on
    // relâche la distance, puis on prend la moins répétitive.
    const pick = list => list.sort((a, b) => a.value - b.value)[0];
    const best = pick(candidates.filter(c => c.err <= 0.15 && c.reuse <= MAX_REUSE))
      || pick(candidates.filter(c => c.reuse <= MAX_REUSE))
      || candidates.sort((a, b) => a.reuse - b.reuse || a.err - b.err)[0];
    const path = best.nodes.map(i => ({ lat: g.lat[i], lng: g.lng[i] }));
    recent.unshift(new Set(best.edges.map(e => edgeKey(g, e))));
    if (recent.length > 3) recent.pop();
    return {
      path, distance: pathLength(path), source: 'generated', explored: true, streets: g.source,
      points: [src, ...best.via].map(i => ({ lat: g.lat[i], lng: g.lng[i] })),
    };
  }

  /** Repli sans réseau de rues : points sur un cercle, itinéraire par OSRM. */
  async function generateOSRM(start, target, signal) {
    let r = target / (2 * Math.PI * TORTUOSITY), best = null;
    const bearing = Math.random() * 360;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal && signal.aborted) throw abortError();
      const c = offset(start, r, bearing);
      const pts = [start, ...[90, 180, 270].map(a => offset(c, r, bearing + 180 + a))];
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

  HR.generator = { generate, prefetch, _internal: { core, astar, score } };
})();
