/*
 * Réseau des rues praticables à pied autour d'un point, sous forme de graphe.
 *
 * Source rapide : les tuiles vectorielles d'OpenFreeMap, celles de la carte
 * épurée, lues au niveau de détail maximal (z14). Elles viennent d'un CDN
 * et sont souvent déjà en cache dans le navigateur : quelques centaines de
 * millisecondes.
 * Source de secours : l'API Overpass d'OpenStreetMap (lente, partagée).
 *
 * Les graphes sont gardés en mémoire : un graphe qui couvre déjà la zone
 * demandée est réutilisé sans rien télécharger. prefetch() permet de lancer
 * le chargement en avance, avant que l'utilisateur ne demande une boucle.
 *
 * Graphe : { origin, n, lat[], lng[], x[], y[] (mètres autour d'origin),
 *            adj[] (indices d'arêtes par nœud), edges[[a, b, longueur, pénalité]] }
 */
(() => {
  'use strict';
  const { dist } = HR;
  const R = 6371008.8, RAD = Math.PI / 180;

  // Coût relatif d'un mètre selon le type de voie, pour un coureur : les
  // chemins et rues piétonnes sont préférés, les petites rues sont neutres,
  // les grands axes (trafic, traversées), les voies de service (parkings,
  // accès privés) et les escaliers sont évités. Classes absentes : exclues.
  const CLASS_PENALTY = {
    trunk: 3, primary: 1.8, secondary: 1.3, tertiary: 1.1, minor: 1, service: 2.2,
    track: 1.2, path: 0.9, pedestrian: 0.9, busway: 1.5,
  };
  const OSM_PENALTY = {
    trunk: 3, primary: 1.8, secondary: 1.3, tertiary: 1.1, service: 2.2, track: 1.2, steps: 3,
    footway: 0.9, path: 0.9, pedestrian: 0.9, cycleway: 1,
  };
  const STEPS_PENALTY = 3;
  const abortError = () => Object.assign(new Error('Génération annulée.'), { name: 'AbortError' });

  // ---------- construction du graphe ----------
  function newGraph(origin) {
    return { origin, n: 0, lat: [], lng: [], x: [], y: [], adj: [], edges: [] };
  }
  function addNode(g, lat, lng) {
    const kx = RAD * R * Math.cos(g.origin.lat * RAD);
    g.lat.push(lat); g.lng.push(lng);
    g.x.push((lng - g.origin.lng) * kx); g.y.push((lat - g.origin.lat) * RAD * R);
    g.adj.push([]);
    return g.n++;
  }
  // edges[e] = [a, b, longueur, pénalité, pont/tunnel (0/1)]
  function addEdge(g, a, b, pen, brg = 0) {
    if (a === b) return -1;
    const e = g.edges.length;
    g.edges.push([a, b, Math.hypot(g.x[a] - g.x[b], g.y[a] - g.y[b]), pen, brg]);
    g.adj[a].push(e); g.adj[b].push(e);
    return e;
  }

  /** Coupe l'arête `e` aux nœuds `mids` (déjà rangés de a vers b). */
  function splitEdge(g, e, mids) {
    const [a, b, , pen, brg] = g.edges[e];
    const chain = [a, ...mids, b];
    // l'arête existante devient le premier morceau ; les suivants sont ajoutés
    g.edges[e] = [a, chain[1], Math.hypot(g.x[a] - g.x[chain[1]], g.y[a] - g.y[chain[1]]), pen, brg];
    g.adj[b].splice(g.adj[b].indexOf(e), 1);
    g.adj[chain[1]].push(e);
    for (let i = 1; i < chain.length - 1; i++) addEdge(g, chain[i], chain[i + 1], pen, brg);
  }

  /**
   * Répare les carrefours perdus par la simplification des tuiles :
   *  - deux rues qui se croisent sans point commun (hors ponts et tunnels)
   *    sont reliées à leur intersection ;
   *  - une rue qui s'arrête à moins de 2,5 m d'une autre (jonction en T dont
   *    le point a disparu) y est raccordée.
   */
  function repair(g) {
    const CELL = 30, kx = RAD * R * Math.cos(g.origin.lat * RAD), ky = RAD * R;
    const buildGrid = () => {
      const grid = new Map();
      g.edges.forEach(([a, b], e) => {
        const x0 = Math.floor(Math.min(g.x[a], g.x[b]) / CELL), x1 = Math.floor(Math.max(g.x[a], g.x[b]) / CELL);
        const y0 = Math.floor(Math.min(g.y[a], g.y[b]) / CELL), y1 = Math.floor(Math.max(g.y[a], g.y[b]) / CELL);
        for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
          const k = i * 1e6 + j;
          (grid.get(k) || grid.set(k, []).get(k)).push(e);
        }
      });
      return grid;
    };
    const newNode = (x, y) => addNode(g, g.origin.lat + y / ky, g.origin.lng + x / kx);

    // 1. croisements à niveau
    let grid = buildGrid();
    const cuts = new Map(), done = new Set(), E = g.edges.length;
    for (const list of grid.values()) {
      for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
        const e1 = list[p], e2 = list[q];
        const key = e1 < e2 ? e1 * E + e2 : e2 * E + e1;
        if (done.has(key)) continue;
        done.add(key);
        const [a, b, , , br1] = g.edges[e1], [c, d, , , br2] = g.edges[e2];
        if (br1 || br2 || a === c || a === d || b === c || b === d) continue;
        const rx = g.x[b] - g.x[a], ry = g.y[b] - g.y[a], sx = g.x[d] - g.x[c], sy = g.y[d] - g.y[c];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const qx = g.x[c] - g.x[a], qy = g.y[c] - g.y[a];
        const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
        if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) continue;
        const n = newNode(g.x[a] + rx * t, g.y[a] + ry * t);
        (cuts.get(e1) || cuts.set(e1, []).get(e1)).push([t, n]);
        (cuts.get(e2) || cuts.set(e2, []).get(e2)).push([u, n]);
      }
    }
    for (const [e, list] of cuts) splitEdge(g, e, list.sort((p, q) => p[0] - q[0]).map(c => c[1]));

    // 2. jonctions en T
    grid = buildGrid();
    for (let n = 0; n < g.n; n++) {
      if (g.adj[n].length !== 1 || g.edges[g.adj[n][0]][4]) continue;
      const cell = Math.floor(g.x[n] / CELL) * 1e6 + Math.floor(g.y[n] / CELL);
      let best = null;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const e of grid.get(cell + i * 1e6 + j) || []) {
          const [a, b, , , br] = g.edges[e];
          if (br || a === n || b === n) continue;
          const rx = g.x[b] - g.x[a], ry = g.y[b] - g.y[a], L2 = rx * rx + ry * ry || 1;
          const t = Math.max(0, Math.min(1, ((g.x[n] - g.x[a]) * rx + (g.y[n] - g.y[a]) * ry) / L2));
          const dd = Math.hypot(g.x[a] + rx * t - g.x[n], g.y[a] + ry * t - g.y[n]);
          if (dd < 2.5 && (!best || dd < best.dd)) best = { e, t, dd, a, b };
        }
      }
      if (!best) continue;
      if (best.t < 0.02) addEdge(g, n, best.a, 1);
      else if (best.t > 0.98) addEdge(g, n, best.b, 1);
      else splitEdge(g, best.e, [n]);
    }
    return g;
  }

  /**
   * Graphe à partir de lignes [{ coords: [[lng, lat], …], pen }]. Les points
   * distants de moins d'un mètre sont fusionnés : c'est ce qui raccorde les
   * rues entre elles et d'une tuile à l'autre.
   */
  function fromLines(lines, origin) {
    const g = newGraph(origin), CELL = 1.5, cells = new Map(), seen = new Set();
    const kx = RAD * R * Math.cos(origin.lat * RAD), ky = RAD * R;
    const node = (lng, lat) => {
      const x = (lng - origin.lng) * kx, y = (lat - origin.lat) * ky;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = cells.get((cx + i) * 1e6 + (cy + j));
        if (list) for (const k of list) if (Math.hypot(g.x[k] - x, g.y[k] - y) <= 1) return k;
      }
      const k = addNode(g, lat, lng), key = cx * 1e6 + cy;
      (cells.get(key) || cells.set(key, []).get(key)).push(k);
      return k;
    };
    for (const l of lines) {
      let prev = node(l.coords[0][0], l.coords[0][1]);
      for (let i = 1; i < l.coords.length; i++) {
        const cur = node(l.coords[i][0], l.coords[i][1]);
        const key = prev < cur ? prev * 1e7 + cur : cur * 1e7 + prev;
        if (prev !== cur && !seen.has(key)) { seen.add(key); addEdge(g, prev, cur, l.pen, l.brg ? 1 : 0); }
        prev = cur;
      }
    }
    return g;
  }

  // ---------- tuiles vectorielles (format Mapbox Vector Tile) ----------
  // Décodeur minimal du protobuf MVT : seulement ce qu'il faut pour lire les
  // lignes de la couche « transportation » et leurs attributs class/subclass.
  class Reader {
    constructor(bytes) { this.b = bytes; this.p = 0; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    get more() { return this.p < this.b.length; }
    varint() {
      let r = 0, s = 0, byte;
      do {
        byte = this.b[this.p++];
        r += (byte & 0x7f) * 2 ** s;
        s += 7;
      } while (byte >= 0x80);
      return r;
    }
    key() { const v = this.varint(); return [Math.floor(v / 8), v & 7]; }
    bytes() { const len = this.varint(), out = this.b.subarray(this.p, this.p + len); this.p += len; return out; }
    skip(wt) {
      if (wt === 0) this.varint();
      else if (wt === 1) this.p += 8;
      else if (wt === 2) this.p += this.varint();
      else if (wt === 5) this.p += 4;
      else throw new Error('format de tuile inattendu');
    }
  }
  const utf8 = new TextDecoder();
  const packed = bytes => { const r = new Reader(bytes), out = []; while (r.more) out.push(r.varint()); return out; };
  const zigzag = n => (n % 2 ? -(n + 1) / 2 : n / 2);

  function readValue(bytes) {
    const r = new Reader(bytes);
    let v = null;
    while (r.more) {
      const [f, wt] = r.key();
      if (f === 1) v = utf8.decode(r.bytes());
      else if (f === 2) { v = r.dv.getFloat32(r.p, true); r.p += 4; }
      else if (f === 3) { v = r.dv.getFloat64(r.p, true); r.p += 8; }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) v = zigzag(r.varint());
      else if (f === 7) v = !!r.varint();
      else r.skip(wt);
    }
    return v;
  }

  /** Coupe une polyligne (coordonnées de tuile) au carré [0, ext] : rend les morceaux intérieurs. */
  function clip(pts, ext) {
    const out = [];
    let cur = null;
    for (let i = 1; i < pts.length; i++) {
      let [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      let t0 = 0, t1 = 1;
      const dx = x1 - x0, dy = y1 - y0;
      const ok = [[-dx, x0], [dx, ext - x0], [-dy, y0], [dy, ext - y0]].every(([p, q]) => {
        if (p === 0) return q >= 0;
        const t = q / p;
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
        return true;
      });
      if (!ok) { cur = null; continue; }
      const a = [x0 + dx * t0, y0 + dy * t0], b = [x0 + dx * t1, y0 + dy * t1];
      if (!cur || t0 > 0) { cur = [a]; out.push(cur); }
      cur.push(b);
      if (t1 < 1) cur = null;
    }
    return out.filter(l => l.length > 1);
  }

  /** Lignes de la couche transportation d'une tuile z/x/y. */
  function readTile(buf, z, tx, ty) {
    const tile = new Reader(new Uint8Array(buf)), lines = [], n = 2 ** z;
    while (tile.more) {
      const [f, wt] = tile.key();
      if (f !== 3 || wt !== 2) { tile.skip(wt); continue; }
      const layer = new Reader(tile.bytes());
      let name = null, ext = 4096;
      const keys = [], values = [], feats = [];
      while (layer.more) {
        const [lf, lwt] = layer.key();
        if (lf === 1) { name = utf8.decode(layer.bytes()); if (name !== 'transportation') break; }
        else if (lf === 2) feats.push(layer.bytes());
        else if (lf === 3) keys.push(utf8.decode(layer.bytes()));
        else if (lf === 4) values.push(readValue(layer.bytes()));
        else if (lf === 5) ext = layer.varint();
        else layer.skip(lwt);
      }
      if (name !== 'transportation') continue;
      const toLngLat = ([x, y]) => {
        const lng = (tx + x / ext) / n * 360 - 180;
        const m = Math.PI - 2 * Math.PI * (ty + y / ext) / n;
        return [lng, Math.atan(Math.sinh(m)) / RAD];
      };
      for (const fb of feats) {
        const fr = new Reader(fb);
        let type = 0, tags = [], geom = [];
        while (fr.more) {
          const [ff, fwt] = fr.key();
          if (ff === 2) tags = packed(fr.bytes());
          else if (ff === 3) type = fr.varint();
          else if (ff === 4) geom = packed(fr.bytes());
          else fr.skip(fwt);
        }
        if (type !== 2) continue;
        const props = {};
        for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
        let pen = CLASS_PENALTY[props.class];
        if (pen == null || /construction/.test(props.class || '')) continue;
        if (props.subclass === 'steps') pen = STEPS_PENALTY;
        // géométrie : MoveTo / LineTo, deltas en zigzag
        let x = 0, y = 0, i = 0, line = null;
        const parts = [];
        while (i < geom.length) {
          const cmd = geom[i] & 7, count = geom[i] >> 3;
          i++;
          if (cmd === 7) continue;
          for (let k = 0; k < count; k++) {
            x += zigzag(geom[i++]); y += zigzag(geom[i++]);
            if (cmd === 1) { line = [[x, y]]; parts.push(line); } else if (line) line.push([x, y]);
          }
        }
        const brg = props.brunnel === 'bridge' || props.brunnel === 'tunnel';
        for (const p of parts) for (const c of clip(p, ext)) lines.push({ coords: c.map(toLngLat), pen, brg });
      }
    }
    return lines;
  }

  let tileInfo = null;
  function getTileInfo() {
    if (!tileInfo) {
      tileInfo = HR.getJSON('https://tiles.openfreemap.org/planet', { timeout: 6000 })
        .then(tj => ({ template: tj.tiles[0], z: Math.min(14, tj.maxzoom || 14) }))
        .catch(e => { tileInfo = null; throw e; });
    }
    return tileInfo;
  }
  async function getBuffer(url, signal, timeout = 8000) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), timeout);
    const stop = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 204 || res.status === 404) return null; // tuile vide (mer, désert…)
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.arrayBuffer();
    } finally {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', stop);
    }
  }

  async function fromTiles(center, radius, signal) {
    const { template, z } = await getTileInfo();
    const n = 2 ** z;
    const lng2x = lng => Math.floor((lng + 180) / 360 * n);
    const lat2y = lat => { const s = Math.sin(lat * RAD); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
    const N = HR.offset(center, radius, 0), S = HR.offset(center, radius, 180), E = HR.offset(center, radius, 90), W = HR.offset(center, radius, 270);
    const x0 = lng2x(W.lng), x1 = lng2x(E.lng), y0 = lat2y(N.lat), y1 = lat2y(S.lat);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 49) throw new Error('zone trop grande pour les tuiles');
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const url = template.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
      jobs.push(getBuffer(url, signal).then(buf => (buf ? readTile(buf, z, x, y) : []), e => { if (e.name === 'AbortError' && signal && signal.aborted) throw abortError(); return null; }));
    }
    const res = await Promise.all(jobs);
    const failed = res.filter(r => r === null).length;
    if (failed > jobs.length * 0.25) throw new Error('tuiles injoignables');
    const g = repair(fromLines(res.flat().filter(Boolean), center));
    if (g.edges.length < 30) throw new Error('trop peu de rues dans les tuiles');
    g.source = 'tiles';
    return g;
  }

  // ---------- Overpass (secours) ----------
  const OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];
  const HIGHWAYS = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|track|cycleway|steps|service|road';
  const RELAY_DELAY = 5000, MAX_WAIT = 20000;

  /**
   * Les serveurs Overpass publics sont souvent saturés : on interroge le
   * premier, puis le suivant s'il n'a pas répondu après 5 s (ou tout de
   * suite s'il refuse). La première réponse gagne. Abandon après 20 s.
   */
  function overpass(center, radius, signal) {
    const q = `[out:json][timeout:20];
way(around:${Math.round(radius)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})[highway~"^(${HIGHWAYS})$"][access!~"^(private|no)$"][foot!~"^no$"]->.w;
.w out body qt;
node(w.w);
out skel qt;`;
    const race = new AbortController();
    const stop = () => race.abort();
    if (signal) signal.addEventListener('abort', stop, { once: true });
    return new Promise((resolve, reject) => {
      let failed = 0, done = false, next = 0;
      const timers = [];
      const finish = (ok, value) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        race.abort();
        if (signal) signal.removeEventListener('abort', stop);
        ok ? resolve(value) : reject(value);
      };
      race.signal.addEventListener('abort', () => finish(false, signal && signal.aborted ? abortError() : new Error('Overpass : délai dépassé')));
      timers.push(setTimeout(() => finish(false, new Error('Overpass : délai dépassé')), MAX_WAIT));
      const launch = () => {
        if (done || next >= OVERPASS.length) return;
        const url = OVERPASS[next++];
        timers.push(setTimeout(launch, RELAY_DELAY));
        HR.getJSON(url, {
          method: 'POST', body: 'data=' + encodeURIComponent(q), timeout: MAX_WAIT, signal: race.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).then(data => finish(true, data), err => {
          if (done) return;
          console.warn('Overpass', url, err.message);
          if (++failed === OVERPASS.length) finish(false, err); else launch();
        });
      };
      launch();
    });
  }
  function fromOSM(osm, origin) {
    const g = newGraph(origin), idx = new Map();
    for (const el of osm.elements) if (el.type === 'node') idx.set(el.id, addNode(g, el.lat, el.lon));
    for (const el of osm.elements) {
      if (el.type !== 'way' || !el.nodes) continue;
      const pen = OSM_PENALTY[el.tags && el.tags.highway] || 1;
      for (let i = 1; i < el.nodes.length; i++) {
        const a = idx.get(el.nodes[i - 1]), b = idx.get(el.nodes[i]);
        if (a != null && b != null) addEdge(g, a, b, pen);
      }
    }
    g.source = 'overpass';
    return g;
  }

  // ---------- chargement avec cache ----------
  const cache = []; // { center, radius, promise }
  const covers = (e, center, radius) => dist(e.center, center) + radius <= e.radius;

  function start(center, radius, signal, onSlow) {
    const entry = { center: { lat: center.lat, lng: center.lng }, radius };
    entry.promise = (async () => {
      try {
        return await fromTiles(center, radius, signal);
      } catch (e) {
        if (e.name === 'AbortError' && signal && signal.aborted) throw e;
        console.warn('Tuiles :', e.message, '→ Overpass');
        if (onSlow) onSlow();
        return fromOSM(await overpass(center, radius, signal), center);
      }
    })();
    entry.promise.catch(() => { const i = cache.indexOf(entry); if (i >= 0) cache.splice(i, 1); });
    cache.unshift(entry);
    if (cache.length > 4) cache.pop();
    return entry.promise;
  }

  /** Graphe couvrant le disque (center, radius) : du cache si possible. */
  async function load(center, radius, { signal, onSlow } = {}) {
    const hit = cache.find(e => covers(e, center, radius));
    const promise = hit ? hit.promise : start(center, radius, signal, onSlow);
    if (!signal) return promise;
    // une annulation arrête l'attente, sans casser un préchargement partagé
    return Promise.race([promise, new Promise((_, rej) => {
      if (signal.aborted) rej(abortError());
      signal.addEventListener('abort', () => rej(abortError()), { once: true });
    })]);
  }

  /** Lance le chargement en avance (sans attendre, sans erreur visible). */
  function prefetch(center, radius) {
    if (!center || cache.some(e => covers(e, center, radius))) return;
    start(center, radius).catch(e => console.warn('Préchargement des rues :', e.message));
  }

  HR.streets = { load, prefetch, _internal: { readTile, fromLines, repair, clip } };
})();
