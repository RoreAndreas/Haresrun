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
  const COLORS = { route: '#ff7a1a', done: '#6b6b6b', explore: '#3fa9f5', start: '#3fa34d', via: '#6b6b6b', finish: '#d64545' };
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
        { id: 'bg', type: 'background', paint: { 'background-color': '#0d0d0d' } },
        {
          id: 'road-path', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 13,
          filter: roadClass(['path', 'track']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#333333', 'line-width': w([13, 0.6, 16, 1.4, 19, 3]), 'line-dasharray': [2, 1.6] },
        },
        {
          id: 'road-minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11,
          filter: roadClass(['minor', 'service', 'busway', 'raceway']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2e2e2e', 'line-width': w([11, 0.4, 14, 1.6, 17, 6, 19, 14]) },
        },
        {
          id: 'road-mid', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 9,
          filter: roadClass(['secondary', 'tertiary']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3a3a3a', 'line-width': w([9, 0.5, 13, 2, 16, 7, 19, 18]) },
        },
        {
          id: 'road-major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 6,
          filter: roadClass(['motorway', 'trunk', 'primary']),
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#474747', 'line-width': w([6, 0.5, 12, 2.4, 16, 9, 19, 22]) },
        },
        {
          id: 'road-names', type: 'symbol', source: 'ofm', 'source-layer': 'transportation_name', minzoom: 13,
          layout: {
            'symbol-placement': 'line', 'text-field': ['coalesce', ['get', 'name:fr'], ['get', 'name'], ['get', 'name:latin']],
            'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 17, 13],
            'text-max-angle': 30, 'symbol-spacing': 280,
          },
          paint: { 'text-color': '#8c8c8c', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.5 },
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
        { id: 'bg', type: 'background', paint: { 'background-color': '#0d0d0d' } },
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
  const data = { route: empty(), done: empty(), explore: empty(), acc: empty() };
  // L'animation d'exploration avance par paliers : changer le filtre d'une
  // couche oblige MapLibre à recalculer ses tuiles, ce qui est trop lourd à
  // chaque image avec des dizaines de milliers de rues.
  const STEPS = 30;
  let map = null, styleId = 'epure', straight = false, exploreStep = STEPS;
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
    add({
      id: 'explore', type: 'line', source: 'explore', layout: { 'line-cap': 'round' },
      filter: ['<=', ['get', 'b'], exploreStep],
      paint: {
        'line-color': ['interpolate', ['linear'], ['get', 'o'], 0, '#7fd3ff', 1, '#1f5f99'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 2.5], 'line-opacity': 0.85,
        'line-opacity-transition': { duration: 600 },
      },
    });
    add({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0d0d0d', 'line-width': 9, 'line-opacity': 0.7 } });
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

  /** Dessine le tracé progressivement, du départ à l'arrivée. */
  function animateRoute(path, duration = 900) {
    return new Promise(resolve => {
      const cum = HR.cumulative(path), total = cum[cum.length - 1], t0 = performance.now();
      const step = now => {
        const f = Math.min(1, (now - t0) / duration), lim = total * (1 - (1 - f) ** 2);
        let i = cum.findIndex(c => c >= lim);
        if (i < 0) i = path.length;
        setRoute(path.slice(0, Math.max(2, i + 1)));
        if (f < 1) requestAnimationFrame(step); else { setRoute(path); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  /** Rues explorées : chaque segment porte `o`, son ordre de découverte (0 → 1). */
  function setExplore(fc) {
    exploreStep = -1;
    fc.features.forEach(f => { f.properties.b = Math.min(STEPS - 1, Math.floor(f.properties.o * STEPS)); });
    if (map.getLayer('explore')) {
      map.setFilter('explore', ['<=', ['get', 'b'], -1]);
      map.setPaintProperty('explore', 'line-opacity', 0.85);
    }
    setData('explore', fc);
  }
  function animateExplore(duration = 2600) {
    return new Promise(resolve => {
      const t0 = performance.now();
      const tick = now => {
        const f = Math.min(1, (now - t0) / duration), s = Math.min(STEPS, Math.ceil(f * STEPS));
        if (s !== exploreStep) {
          exploreStep = s;
          if (map.getLayer('explore')) map.setFilter('explore', ['<=', ['get', 'b'], s]);
        }
        if (f < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  function fadeExplore() {
    if (map.getLayer('explore')) map.setPaintProperty('explore', 'line-opacity', 0);
    setTimeout(() => setData('explore', empty()), 700);
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
    COLORS, STYLES, init, setStyle, setRoute, setDone, animateRoute, setExplore, animateExplore, fadeExplore,
    setPins, setMe, fit, snapshot,
    get map() { return map; }, get styleId() { return styleId; },
  };
})();
