/*
 * Calculs lourds hors du fil principal : lecture des tuiles de rues,
 * réparation du graphe, exploration et construction des boucles. L'écran
 * (animation, carte) reste ainsi parfaitement fluide pendant ce temps.
 *
 * Messages reçus :  { type: 'generate', id, start, target }
 *                   { type: 'prefetch', start, target }
 *                   { type: 'cancel', id }
 * Messages envoyés : { type: 'stage', id, stage }
 *                   { type: 'explore', id, segs, o }   (tableaux transférés)
 *                   { type: 'result', id, res } | { type: 'error', id, name, message }
 */
self.window = self;
importScripts('util.js', 'services.js', 'streets.js', 'generator.js');

const runs = new Map();

self.onmessage = async ({ data }) => {
  if (data.type === 'prefetch') { HR.generator.prefetch(data.start, data.target); return; }
  if (data.type === 'cancel') { const c = runs.get(data.id); if (c) c.abort(); return; }
  if (data.type !== 'generate') return;
  const ctrl = new AbortController(), id = data.id;
  runs.set(id, ctrl);
  try {
    const res = await HR.generator.generate(data.start, data.target, {
      signal: ctrl.signal,
      onStage: stage => self.postMessage({ type: 'stage', id, stage }),
      onExplore: ({ segs, o }) => self.postMessage({ type: 'explore', id, segs, o }, [segs.buffer, o.buffer]),
    });
    self.postMessage({ type: 'result', id, res });
  } catch (e) {
    self.postMessage({ type: 'error', id, name: e.name, message: e.message });
  } finally {
    runs.delete(id);
  }
};
