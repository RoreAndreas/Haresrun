/*
 * Image PNG d'un parcours (1080 × 1350).
 *
 * Le tracé est dessiné en projection Web Mercator. Le fond de carte est
 * recomposé à partir des tuiles du fond choisi dans l'appli (mêmes tuiles,
 * même projection : le tracé tombe sur les rues).
 */
window.HaresPoster = (() => {
  'use strict';

  const W = 1080, H = 1350;
  const MAP = { x: 40, y: 230, w: 1000, h: 680 };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const C = { bg: '#121212', panel: '#1a1a1a', line: '#2e2e2e', text: '#e8e8e8', muted: '#8c8c8c', accent: '#ff7a1a' };
  const imgCache = new Map();

  const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pad = n => String(n).padStart(2, '0');
  const fmtDur = s => {
    if (!(s > 0)) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
  };
  const fmtPace = s => (s > 0 ? `${Math.floor(Math.round(s) / 60)}:${pad(Math.round(s) % 60)}` : '—');

  // ---------- projection ----------
  const mx = lng => (lng + 180) / 360;
  const my = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

  function frame(path, w, h, padFrac) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    path.forEach(p => { const x = mx(p.lng), y = my(p.lat); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    const dx = Math.max(x1 - x0, 1e-7), dy = Math.max(y1 - y0, 1e-7);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, fit: Math.min(w * (1 - 2 * padFrac) / dx, h * (1 - 2 * padFrac) / dy) };
  }

  // ---------- fond de carte à partir des tuiles ----------
  function loadImage(url, timeout = 10000) {
    if (imgCache.has(url)) return imgCache.get(url);
    const p = new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => resolve(null), timeout);
      img.onload = () => { clearTimeout(t); resolve(img.naturalWidth > 1 ? img : null); };
      img.onerror = () => { clearTimeout(t); resolve(null); };
      img.src = url;
    });
    imgCache.set(url, p);
    p.then(img => { if (!img) imgCache.delete(url); });
    return p;
  }

  async function tileBackground(f, layer) {
    const z = Math.max(1, Math.min(18, layer.maxNative || 18, Math.floor(Math.log2(f.fit / 256))));
    const n = 2 ** z, world = 256 * n, s = f.fit / world; // échelle tuile → image (≈ 1 à 2)
    const left = f.cx * world - MAP.w / 2 / s, top = f.cy * world - MAP.h / 2 / s;
    const tx0 = Math.floor(left / 256), tx1 = Math.floor((left + MAP.w / s) / 256);
    const ty0 = Math.max(0, Math.floor(top / 256)), ty1 = Math.min(n - 1, Math.floor((top + MAP.h / s) / 256));
    const subs = layer.subdomains || 'abc';

    const off = document.createElement('canvas');
    off.width = MAP.w; off.height = MAP.h;
    const o = off.getContext('2d');
    o.fillStyle = '#1d1d1d';
    o.fillRect(0, 0, MAP.w, MAP.h);

    // fond puis, s'il y en a, la couche des noms par-dessus (dans l'ordre)
    const jobs = [];
    for (const tpl of [layer.url, layer.overlay].filter(Boolean)) {
      const imgs = [];
      for (let x = tx0; x <= tx1; x++) {
        for (let y = ty0; y <= ty1; y++) {
          const url = tpl
            .replace('{s}', subs[Math.abs(x + y) % subs.length])
            .replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y)
            .replace('{r}', '@2x');
          imgs.push(loadImage(url).then(img => ({ img, x, y })));
        }
      }
      const loaded = await Promise.all(imgs);
      loaded.forEach(({ img, x, y }) => {
        if (img) o.drawImage(img, (x * 256 - left) * s, (y * 256 - top) * s, 256 * s + 1, 256 * s + 1);
        if (tpl === layer.url) jobs.push(!!img);
      });
    }
    const ok = jobs.filter(Boolean).length;
    if (ok < jobs.length * 0.6) return null;

    try {
      const img = o.getImageData(0, 0, MAP.w, MAP.h), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        if (layer.invert) {
          // luminosité inversée, teintes conservées (fond OpenStreetMap clair → sombre)
          const shift = 255 - 2 * (0.299 * r + 0.587 * g + 0.114 * b);
          r = (r + shift) * 0.88; g = (g + shift) * 0.88; b = (b + shift) * 0.88;
        } else if (/World_Imagery/.test(layer.url)) {
          r *= 0.75; g *= 0.75; b *= 0.75; // satellite assombri pour que le tracé ressorte
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
      o.putImageData(img, 0, 0);
    } catch {
      return null; // tuiles sans autorisation CORS : l'image serait inexportable
    }
    return off;
  }

  // ---------- utilitaires ----------
  function ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function hline(ctx, y) {
    ctx.fillStyle = C.line;
    ctx.fillRect(40, y, W - 80, 2);
  }
  /** Rangée de colonnes « libellé / valeur / unité », séparées par des filets. */
  function statRow(ctx, y, items) {
    const cw = (W - 80) / items.length;
    items.forEach(([label, value, unit], i) => {
      const x = 40 + i * cw;
      if (i) { ctx.fillStyle = C.line; ctx.fillRect(x, y, 2, 110); }
      const tx = x + (i ? 24 : 0);
      ctx.fillStyle = C.muted; ctx.font = `600 20px ${FONT}`;
      ctx.fillText(label.toUpperCase(), tx, y + 24);
      ctx.fillStyle = C.text; ctx.font = `700 50px ${FONT}`;
      const v = ellipsis(ctx, value, cw - 40);
      ctx.fillText(v, tx, y + 84);
      if (unit) {
        const vw = ctx.measureText(v).width;
        ctx.fillStyle = C.muted; ctx.font = `500 24px ${FONT}`;
        ctx.fillText(unit, tx + vw + 8, y + 84);
      }
    });
  }
  /** Positions et orientations [x, y, angle] tous les `every` pixels le long du tracé. */
  function arrowsAlong(pts, every) {
    const out = [];
    let acc = 0, next = every / 2;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      while (seg > 0 && acc + seg >= next) {
        const t = (next - acc) / seg;
        out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.atan2(y1 - y0, x1 - x0)]);
        next += every;
      }
      acc += seg;
    }
    return out;
  }

  // ---------- rendu ----------
  async function render(canvas, d, opts) {
    const col = opts.colors;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const f = frame(d.path.length ? d.path : d.points, MAP.w, MAP.h, 0.1);
    const bg = opts.withMap && opts.layer && d.path.length > 1 ? await tileBackground(f, opts.layer) : null;
    const P = p => [MAP.x + MAP.w / 2 + (mx(p.lng) - f.cx) * f.fit, MAP.y + MAP.h / 2 + (my(p.lat) - f.cy) * f.fit];

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';

    // en-tête
    ctx.fillStyle = C.accent; ctx.font = `800 26px ${FONT}`;
    ctx.fillText('HARES RUN', 40, 72);
    ctx.fillStyle = C.muted; ctx.font = `400 24px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(d.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }), W - 40, 72);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text; ctx.font = `700 54px ${FONT}`;
    ctx.fillText(ellipsis(ctx, d.name, W - 80), 40, 146);
    const start = d.points[0];
    const sub = [start?.label ? 'Départ : ' + start.label : '', d.loop ? 'Boucle' : ''].filter(Boolean).join(' · ');
    if (sub) {
      ctx.fillStyle = C.muted; ctx.font = `400 26px ${FONT}`;
      ctx.fillText(ellipsis(ctx, sub, W - 80), 40, 192);
    }

    // carte
    ctx.save();
    ctx.beginPath(); ctx.rect(MAP.x, MAP.y, MAP.w, MAP.h); ctx.clip();
    ctx.fillStyle = C.panel; ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);
    if (bg) ctx.drawImage(bg, MAP.x, MAP.y);

    if (d.path.length > 1) {
      const pts = d.path.map(P);
      const trace = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = C.bg; ctx.lineWidth = 12; trace(); ctx.stroke();
      ctx.strokeStyle = col.route; ctx.lineWidth = 7;
      if (d.straight) ctx.setLineDash([14, 12]);
      trace(); ctx.stroke();
      ctx.setLineDash([]);

      // flèches de sens, régulièrement espacées, sauf trop près d'un repère
      const pins = d.points.map(P);
      arrowsAlong(pts, 130).forEach(([x, y, ang]) => {
        if (pins.some(([px, py]) => Math.hypot(px - x, py - y) < 40)) return;
        ctx.save();
        ctx.translate(x, y); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-9, -12); ctx.lineTo(-3, 0); ctx.lineTo(-9, 12); ctx.closePath();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = C.bg; ctx.lineWidth = 2; ctx.lineJoin = 'round';
        ctx.stroke(); ctx.fill();
        ctx.restore();
      });
    }
    // points : étapes d'abord, départ au-dessus
    const order = { via: 0, finish: 1, start: 2 };
    [...d.points].sort((a, b) => order[a.role] - order[b.role]).forEach(p => {
      const [x, y] = P(p), r = p.role === 'via' ? 17 : 22;
      ctx.fillStyle = col[p.role]; ctx.strokeStyle = C.bg; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${r === 22 ? 20 : 16}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.badge, x, y + 1);
    });
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.strokeRect(MAP.x + 1, MAP.y + 1, MAP.w - 2, MAP.h - 2);

    // chiffres
    const speed = d.paceSec ? nf1.format(3600 / d.paceSec) : '—';
    statRow(ctx, 960, [
      ['Distance', nf2.format(d.distance / 1000), 'km'],
      ['Temps prévu', fmtDur(d.targetSec), ''],
      ['Allure', fmtPace(d.paceSec), d.paceSec ? '/km' : ''],
    ]);
    hline(ctx, 1096);
    const stops = Math.max(0, d.points.length - (d.loop ? 1 : 2));
    statRow(ctx, 1130, [
      ['Vitesse', speed, d.paceSec ? 'km/h' : ''],
      ['Dénivelé +', d.elevation ? String(Math.round(d.elevation.gain)) : '—', d.elevation ? 'm' : ''],
      ['Étapes', String(stops), ''],
    ]);

    // pied
    hline(ctx, 1266);
    ctx.fillStyle = C.muted; ctx.font = `400 22px ${FONT}`;
    const end = d.points.find(p => p.role === 'finish');
    const route = d.loop ? 'Boucle, retour au départ' : end?.label ? 'Arrivée : ' + end.label : '';
    const credit = bg ? opts.layer.credit : '© OpenStreetMap';
    ctx.textAlign = 'right';
    ctx.fillText(credit, W - 40, 1310);
    const cw = ctx.measureText(credit).width;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsis(ctx, route + (d.straight ? ' · à vol d’oiseau' : ''), W - 120 - cw), 40, 1310);

    return { mapUsed: !!bg };
  }

  return { render };
})();
