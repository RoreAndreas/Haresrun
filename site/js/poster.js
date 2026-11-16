/*
 * Image PNG d'un parcours (1080 × 1350).
 *
 * Avec fond de carte, la zone est rendue hors écran par MapLibre avec le
 * fond choisi, puis le tracé est redessiné par-dessus à la même projection.
 */
(() => {
  'use strict';
  const W = 1080, H = 1350;
  const MAP = { x: 40, y: 230, w: 1000, h: 680 };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const C = { bg: '#121212', panel: '#1a1a1a', line: '#2e2e2e', text: '#e8e8e8', muted: '#8c8c8c', accent: '#ff7a1a' };
  const { fmt } = HR;

  // projection Mercator pour la version sans fond de carte
  const mx = lng => (lng + 180) / 360;
  const my = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  function frameProjection(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(p => { const x = mx(p.lng), y = my(p.lat); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); });
    const dx = Math.max(x1 - x0, 1e-7), dy = Math.max(y1 - y0, 1e-7);
    const k = Math.min(MAP.w * 0.8 / dx, MAP.h * 0.8 / dy), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return p => [MAP.w / 2 + (mx(p.lng) - cx) * k, MAP.h / 2 + (my(p.lat) - cy) * k];
  }

  function ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function statRow(ctx, y, items) {
    const cw = (W - 80) / items.length;
    items.forEach(([label, value, unit], i) => {
      const x = 40 + i * cw, tx = x + (i ? 24 : 0);
      if (i) { ctx.fillStyle = C.line; ctx.fillRect(x, y, 2, 110); }
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
  function arrowsAlong(pts, every) {
    const out = [];
    let acc = 0, next = every / 2;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], seg = Math.hypot(x1 - x0, y1 - y0);
      while (seg > 0 && acc + seg >= next) {
        const t = (next - acc) / seg;
        out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.atan2(y1 - y0, x1 - x0)]);
        next += every;
      }
      acc += seg;
    }
    return out;
  }

  /**
   * d : { name, date, path, distance, straight, loop, points:[{lat,lng,label,role,badge}],
   *       targetSec, paceSec, gain }
   */
  async function render(canvas, d, { withMap, colors }) {
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const snap = withMap && d.path.length > 1 ? await HR.mapview.snapshot(d.path, MAP.w, MAP.h, 70) : null;
    const proj = snap ? snap.project : frameProjection(d.path.length ? d.path : d.points);
    const P = p => { const [x, y] = proj(p); return [MAP.x + x, MAP.y + y]; };

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

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
    const sub = [start && start.label ? 'Départ : ' + start.label : '', d.loop ? 'Boucle' : ''].filter(Boolean).join(' · ');
    if (sub) { ctx.fillStyle = C.muted; ctx.font = `400 26px ${FONT}`; ctx.fillText(ellipsis(ctx, sub, W - 80), 40, 192); }

    // carte
    ctx.save();
    ctx.beginPath(); ctx.rect(MAP.x, MAP.y, MAP.w, MAP.h); ctx.clip();
    ctx.fillStyle = C.panel; ctx.fillRect(MAP.x, MAP.y, MAP.w, MAP.h);
    if (snap) ctx.drawImage(snap.canvas, MAP.x, MAP.y);
    if (d.path.length > 1) {
      const pts = d.path.map(P);
      const trace = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = C.bg; ctx.lineWidth = 12; trace(); ctx.stroke();
      ctx.strokeStyle = colors.route; ctx.lineWidth = 7;
      if (d.straight) ctx.setLineDash([14, 12]);
      trace(); ctx.stroke();
      ctx.setLineDash([]);
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
    const order = { via: 0, finish: 1, start: 2 };
    [...d.points].sort((a, b) => order[a.role] - order[b.role]).forEach(p => {
      const [x, y] = P(p), r = p.role === 'via' ? 17 : 22;
      ctx.fillStyle = colors[p.role]; ctx.strokeStyle = C.bg; ctx.lineWidth = 4;
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
    statRow(ctx, 960, [
      ['Distance', fmt.km(d.distance), 'km'],
      ['Temps prévu', d.targetSec ? fmt.dur(d.targetSec) : '—', ''],
      ['Allure', fmt.pace(d.paceSec), d.paceSec ? '/km' : ''],
    ]);
    ctx.fillStyle = C.line; ctx.fillRect(40, 1096, W - 80, 2);
    const stops = Math.max(0, d.points.length - (d.loop ? 1 : 2));
    statRow(ctx, 1130, [
      ['Vitesse', fmt.speed(d.paceSec), d.paceSec ? 'km/h' : ''],
      ['Dénivelé +', d.gain != null ? String(Math.round(d.gain)) : '—', d.gain != null ? 'm' : ''],
      ['Étapes', String(stops), ''],
    ]);

    // pied
    ctx.fillStyle = C.line; ctx.fillRect(40, 1266, W - 80, 2);
    ctx.fillStyle = C.muted; ctx.font = `400 22px ${FONT}`;
    const end = d.points.find(p => p.role === 'finish');
    const foot = d.loop ? 'Boucle, retour au départ' : end && end.label ? 'Arrivée : ' + end.label : '';
    const credit = snap ? snap.credit : '© OpenStreetMap';
    ctx.textAlign = 'right';
    ctx.fillText(credit, W - 40, 1310);
    const cw = ctx.measureText(credit).width;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsis(ctx, foot + (d.straight ? ' · à vol d’oiseau' : ''), W - 120 - cw), 40, 1310);
    return { mapUsed: !!snap };
  }

  HR.poster = { render };
})();
