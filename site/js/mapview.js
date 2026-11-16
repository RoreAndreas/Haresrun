/*
 * Carte MapLibre : fonds, tracé, flèches de sens, repères, position GPS,
 * animation d'exploration des rues.
 *
 * Fonds (gratuits, sans clé) :
 *   epure      carte vectorielle OpenFreeMap, style maison : rues + noms des rues
 *   complete   tuiles OpenStreetMap standard, assombries
 *   satellite  imagerie Esri World Imagery
 */
(() => {
  'use strict';
  const COLORS = { route: '#1ec8ff', done: '#5b6672', start: '#34c27a', via: '#5b6672', finish: '#ff4d6a' };
  const OFM = 'https://tiles.openfreemap.org';

  // ---------- styles ----------
  const w = (stops) => ['interpolate', ['exponential', 1.6], ['zoom'], ...stops];
  const roadClass = cls => ['match', ['get', 'class'], cls, true, false];

  function epure() {
    return {
      version: 8,
      glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
      sources: { ofm: { type: 'vector', url: `${OFM}/planet` } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a0d12' } },
        {
          id: 'road-path', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 13,
          filter: roadClass(['path', 'track']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2c3540', 'line-width': w([13, 0.6, 16, 1.4, 19, 3]), 'line-dasharray': [2, 1.6] },
        },
        {
          id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11,
          filter: roadClass(['minor', 'service', 'busway', 'raceway']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#222a33', 'line-width': w([11, 0.4, 14, 1.6, 17, 6, 19, 14]) },
        },
        {
          id: 'road-mid', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 9,
          filter: roadClass(['secondary', 'tertiary']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2d3742', 'line-width': w([9, 0.5, 13, 2, 16, 7, 19, 18]) },
        },
        {
          id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 6,
          filter: roadClass(['motorway', 'trunk', 'primary']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3a4654', 'line-width': w([6, 0.5, 12, 2.4, 16, 9, 19, 22]) },
        },
        {
          id: 'road-names', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 13,
          layout: {
            'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:fr'], ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 13],
            'text-max-angle': 30, 'symbol-spacing': 280,
          },
          paint: { 'text-color': '#7f8b99', 'text-halo-color': '#0a0d12', 'text-halo-width': 1.5 },
        },
      ],
    };
  }
  function raster(tiles, attribution, paint, maxzoom = 19) {
    return {
      version: 8,
      glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
      sources: { base: { type: 'raster', tiles, tileSize: 256, maxzoom, attribution } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a0d12' } },
        { id: 'base', type: 'raster', source: 'base', paint },
      ],
    };
  }
  const STYLES = {
    epure: { name: 'Épurée', style: epure },
    complete: {
      name: 'Complète',
      // inversion de la luminosité : la carte OSM claire devient sombre
      style: () => raster(['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        { 'raster-brightness-min': 0.92, 'raster-brightness-max': 0.08, 'raster-saturation': -0.6, 'raster-contrast': 0.1 }),
    },
    satellite: {
      name: 'Satellite',
      style: () => raster(['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        'Imagerie © Esri, Maxar, Earthstar Geographics', { 'raster-brightness-max': 0.8 }),
    },
  };

  // ---------- état des surcouches (survit aux changements de fond) ----------
  const empty = () => ({ type: 'FeatureCollection', features: [] });
  const data = { route: empty(), done: empty(), acc: empty() };
  let map = null, styleId = 'epure', straight = false;
  let pinMarkers = [], meMarker = null;

  const line = path => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path.map(p => [p.lng, p.lat]) } });

  function arrowImage() {
    const s = 32, c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.translate(s / 2, s / 2);
    g.beginPath(); g.moveTo(11, 0); g.lineTo(-7, -9); g.lineTo(-2, 0); g.lineTo(-7, 9); g.closePath();
    g.lineJoin = 'round'; g.lineWidth = 3; g.strokeStyle = '#121212'; g.stroke();
    g.fillStyle = '#ffffff'; g.fill();
    return g.getImageData(0, 0, s, s);
  }

  function addOverlays() {
    if (!map.hasImage('arrow')) map.addImage('arrow', arrowImage(), { pixelRatio: 2 });
    for (const k of Object.keys(data)) if (!map.getSource(k)) map.addSource(k, { type: 'geojson', data: data[k] });
    const add = l => { if (!map.getLayer(l.id)) map.addLayer(l); };
    add({ id: 'acc', type: 'fill', source: 'acc', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
    add({ id: 'acc-line', type: 'line', source: 'acc', paint: { 'line-color': '#3b82f6', 'line-opacity': 0.5, 'line-width': 1 } });
    add({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.route, 'line-width': 14, 'line-opacity': 0.18, 'line-blur': 6 } });
    add({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0a0d12', 'line-width': 9, 'line-opacity': 0.7 } });
    add({
      id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': COLORS.route, 'line-width': 5, ...(straight ? { 'line-dasharray': [2, 1.5] } : {}) },
    });
    add({ id: 'done-line', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.done, 'line-width': 5 } });
    add({
      id: 'route-arrows', type: 'symbol', source: 'route',
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 90, 'icon-image': 'arrow', 'icon-allow-overlap': true, 'icon-rotation-alignment': 'map' },
    });
  }

  function setData(k, fc) {
    data[k] = fc;
    const src = map && map.getSource(k);
    if (src) src.setData(fc);
  }

  // ---------- API ----------
  function init(el, { center, zoom, style = 'epure', onClick }) {
    styleId = STYLES[style] ? style : 'epure';
    map = new maplibregl.Map({
      container: el, style: STYLES[styleId].style(), center: [center.lng, center.lat], zoom,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('style.load', addOverlays);
    map.on('click', e => {
      if (e.originalEvent.target.closest && e.originalEvent.target.closest('.pin')) return;
      onClick && onClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    return map;
  }

  function setStyle(id) {
    if (!STYLES[id] || id === styleId) return;
    styleId = id;
    map.setStyle(STYLES[id].style(), { diff: false });
  }

  function setRoute(path, opts = {}) {
    const wasStraight = straight;
    straight = !!opts.straight;
    setData('route', path && path.length > 1 ? { type: 'FeatureCollection', features: [line(path)] } : empty());
    if (map && map.getLayer('route-line') && wasStraight !== straight) {
      map.setPaintProperty('route-line', 'line-dasharray', straight ? [2, 1.5] : null);
    }
  }
  function setDone(path) {
    setData('done', path && path.length > 1 ? { type: 'FeatureCollection', features: [line(path)] } : empty());
  }

  const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  const easeOut = t => 1 - (1 - t) ** 3;

  /** Dessine le tracé progressivement, du départ à l'arrivée. */
  function animateRoute(path, duration = 700) {
    return new Promise(resolve => {
      const cum = HR.cumulative(path), total = cum[cum.length - 1], t0 = performance.now();
      const step = now => {
        const f = Math.min(1, (now - t0) / duration), lim = total * easeInOut(f);
        let i = cum.findIndex(c => c >= lim);
        if (i < 0) i = path.length;
        setRoute(path.slice(0, Math.max(2, i + 1)));
        if (f < 1) requestAnimationFrame(step); else { setRoute(path); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- animation d'exploration ----------
  // Dessinée sur deux calques <canvas> posés sur la carte, et non par
  // MapLibre : chaque image n'ajoute que les rues nouvellement atteintes
  // (rien n'est recalculé), d'où une animation fluide même avec des dizaines
  // de milliers de rues. Calque « base » : rues déjà explorées, qui
  // s'accumulent ; calque « front » : la vague du moment, lumineuse, effacé
  // et redessiné à chaque image.
  let ex = null; // { segs, o, n, drawn, base, front, bctx, fctx, dpr }
  const exColor = o => `hsl(${195 + 25 * o}, 95%, ${78 - 30 * o}%)`; // cyan clair → bleu profond

  function exCanvases() {
    const holder = map.getCanvasContainer(), after = map.getCanvas().nextSibling;
    const mk = () => {
      const c = document.createElement('canvas');
      c.className = 'explore-layer';
      holder.insertBefore(c, after); // sous les repères, au-dessus de la carte
      return c;
    };
    return [mk(), mk()];
  }
  function exResize() {
    if (!ex) return;
    const el = map.getContainer(), w = el.clientWidth, h = el.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [ex.base, ex.front]) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
    }
    ex.dpr = dpr;
    ex.bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ex.fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // Position à l'écran : la carte n'est ni tournée ni inclinée, donc l'écran
  // est une simple mise à l'échelle des coordonnées Mercator. On calcule
  // l'échelle une fois par image à partir de deux points de référence, au
  // lieu d'appeler map.project() pour chacun des dizaines de milliers de points.
  const mercX = lng => (lng + 180) / 360;
  const mercY = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  function exFrame() {
    const r = ex.ref, p0 = map.project([r[0], r[1]]), p1 = map.project([r[2], r[3]]);
    const k = Math.abs(ex.m[2] - ex.m[0]) > Math.abs(ex.m[3] - ex.m[1]) ? (p1.x - p0.x) / (ex.m[2] - ex.m[0]) : (p1.y - p0.y) / (ex.m[3] - ex.m[1]);
    return { x0: p0.x - ex.m[0] * k, y0: p0.y - ex.m[1] * k, k };
  }
  function exDraw(ctx, from, to, color, width) {
    if (to <= from) return;
    const m = ex.merc, f = exFrame();
    ctx.lineCap = 'round';
    // par paquets de même teinte (l'ordre suit la distance au départ)
    for (let i = from; i < to;) {
      const j = Math.min(to, i + 600);
      ctx.beginPath();
      for (let q = 4 * i, end = 4 * j; q < end; q += 4) {
        ctx.moveTo(f.x0 + m[q] * f.k, f.y0 + m[q + 1] * f.k);
        ctx.lineTo(f.x0 + m[q + 2] * f.k, f.y0 + m[q + 3] * f.k);
      }
      ctx.strokeStyle = color || exColor(ex.o[i]);
      ctx.lineWidth = width;
      ctx.stroke();
      i = j;
    }
  }
  const exWidth = () => (map.getZoom() >= 15 ? 2.2 : map.getZoom() >= 13.5 ? 1.6 : 1.1);
  function exRedraw() {
    if (!ex) return;
    ex.bctx.clearRect(0, 0, ex.base.width, ex.base.height);
    ex.fctx.clearRect(0, 0, ex.front.width, ex.front.height);
    exDraw(ex.bctx, 0, ex.drawn, null, exWidth());
  }

  /** Rues explorées : segs = [lng1, lat1, lng2, lat2, …], o = ordre de découverte (0 → 1). */
  function setExplore({ segs, o }) {
    clearExplore();
    if (!o.length) return;
    const [base, front] = exCanvases();
    // coordonnées Mercator précalculées + deux points de référence éloignés
    const merc = new Float64Array(segs.length);
    let iMin = 0, iMax = 0;
    for (let q = 0; q < segs.length; q += 2) {
      merc[q] = mercX(segs[q]); merc[q + 1] = mercY(segs[q + 1]);
      if (merc[q] + merc[q + 1] < merc[iMin] + merc[iMin + 1]) iMin = q;
      if (merc[q] + merc[q + 1] > merc[iMax] + merc[iMax + 1]) iMax = q;
    }
    ex = {
      segs, o, merc, n: o.length, drawn: 0, base, front, bctx: base.getContext('2d'), fctx: front.getContext('2d'),
      ref: [segs[iMin], segs[iMin + 1], segs[iMax], segs[iMax + 1]], m: [merc[iMin], merc[iMin + 1], merc[iMax], merc[iMax + 1]],
    };
    exResize();
    map.on('resize', exResize);
    map.on('move', exRedraw); // la carte bouge : on redessine ce qui est déjà exploré
  }
  /** La vague part vite du départ puis ralentit en s'éloignant. */
  function animateExplore(duration = 1800) {
    return new Promise(resolve => {
      if (!ex) return resolve();
      const t0 = performance.now(), run = ex;
      const tick = now => {
        if (ex !== run) return resolve();
        const f = Math.min(1, (now - t0) / duration), target = Math.round(easeOut(f) * ex.n);
        const w = exWidth();
        exDraw(ex.bctx, ex.drawn, target, null, w);
        ex.drawn = target;
        // front : les ~4 % dernières rues atteintes, en blanc lumineux ; le
        // halo est un trait large et translucide (un vrai flou coûterait trop)
        ex.fctx.clearRect(0, 0, ex.front.width, ex.front.height);
        if (f < 1) {
          const from = Math.max(0, target - Math.ceil(ex.n * 0.04));
          exDraw(ex.fctx, from, target, 'rgba(30, 200, 255, 0.28)', w + 6);
          exDraw(ex.fctx, from, target, 'rgba(236, 252, 255, 0.95)', w + 0.8);
          requestAnimationFrame(tick);
        } else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  /** Rues explorées en retrait, le temps que la boucle se dessine par-dessus. */
  function dimExplore() {
    if (ex) { ex.base.style.opacity = '0.22'; ex.front.style.opacity = '0'; }
  }
  function clearExplore() {
    if (!ex) return;
    map.off('resize', exResize);
    map.off('move', exRedraw);
    ex.base.remove(); ex.front.remove();
    ex = null;
  }
  function fadeExplore() {
    if (!ex) return;
    const run = ex;
    run.base.style.opacity = '0'; run.front.style.opacity = '0';
    setTimeout(() => { if (ex === run) clearExplore(); }, 650);
  }

  function setPins(points, onDragEnd) {
    pinMarkers.forEach(m => m.remove());
    pinMarkers = points.map((p, i) => {
      const el = document.createElement('div');
      el.className = `pin pin--${p.role}`;
      el.textContent = p.badge;
      const m = new maplibregl.Marker({ element: el, draggable: !!onDragEnd }).setLngLat([p.lng, p.lat]).addTo(map);
      if (onDragEnd) m.on('dragend', () => { const ll = m.getLngLat(); onDragEnd(i, { lat: ll.lat, lng: ll.lng }); });
      return m;
    });
  }

  function setMe(pos) {
    if (!map) return;
    if (!pos) { if (meMarker) { meMarker.remove(); meMarker = null; } setData('acc', empty()); return; }
    if (!meMarker) {
      const el = document.createElement('div');
      el.className = 'me-dot';
      meMarker = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(map);
    }
    meMarker.setLngLat([pos.lng, pos.lat]);
    const ring = [];
    for (let a = 0; a <= 360; a += 15) { const q = HR.offset(pos, pos.acc || 0, a); ring.push([q.lng, q.lat]); }
    setData('acc', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] });
  }

  function fit(pts, padding) {
    if (!map || !pts.length) return;
    if (pts.length === 1) { map.easeTo({ center: [pts[0].lng, pts[0].lat], zoom: Math.max(map.getZoom(), 15) }); return; }
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    pts.forEach(p => { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    map.fitBounds([[w, s], [e, n]], { padding, maxZoom: 17, duration: 600 });
  }

  /**
   * Rendu hors écran d'une zone pour l'image PNG : même fond, cadré sur le
   * tracé. Rend { canvas, project(p) → [x, y] } ou null si la carte ne peut
   * pas s'afficher (WebGL absent, tuiles injoignables…).
   */
  async function snapshot(path, width, height, pad) {
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;`;
    document.body.appendChild(box);
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    path.forEach(p => { w = Math.min(w, p.lng); e = Math.max(e, p.lng); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    let off;
    try {
      off = new maplibregl.Map({
        container: box, style: STYLES[styleId].style(), bounds: [[w, s], [e, n]], fitBoundsOptions: { padding: pad, maxZoom: 17 },
        interactive: false, attributionControl: false, preserveDrawingBuffer: true, pixelRatio: 1, fadeDuration: 0,
      });
      const ok = await new Promise(resolve => {
        const t = setTimeout(() => resolve(false), 12000);
        off.once('idle', () => { clearTimeout(t); resolve(true); });
        off.once('error', () => {});
      });
      if (!ok) throw new Error('délai');
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(off.getCanvas(), 0, 0, width, height);
      const project = p => { const q = off.project([p.lng, p.lat]); return [q.x, q.y]; };
      return { canvas, project, credit: styleId === 'satellite' ? '© Esri, Maxar' : styleId === 'complete' ? '© OpenStreetMap' : '© OpenFreeMap · OpenStreetMap' };
    } catch (err) {
      console.warn('Fond de carte de l’image :', err.message);
      return null;
    } finally {
      if (off) off.remove();
      box.remove();
    }
  }

  HR.mapview = {
    COLORS, STYLES, init, setStyle, setRoute, setDone, animateRoute, setExplore, animateExplore, dimExplore, fadeExplore,
    setPins, setMe, fit, snapshot,
    get map() { return map; }, get styleId() { return styleId; },
  };
})();
