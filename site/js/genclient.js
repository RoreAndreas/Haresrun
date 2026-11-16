/*
 * Accès au générateur de boucles depuis l'interface : les calculs tournent
 * dans un worker (js/worker.js) pour ne jamais bloquer l'écran. Si le
 * navigateur refuse le worker, les mêmes calculs tournent ici directement.
 *
 * HR.gen.generate(start, target, { onExplore, onStage, signal }) → Promise
 * HR.gen.prefetch(start, target)
 */
(() => {
  'use strict';
  let worker = null, seq = 0;
  const pending = new Map();
  const plain = p => ({ lat: p.lat, lng: p.lng });

  function getWorker() {
    if (worker !== null) return worker;
    try {
      worker = new Worker('js/worker.js');
      worker.onmessage = onMessage;
      worker.onerror = e => {
        console.warn('Worker indisponible, calcul sur le fil principal :', e.message);
        worker = false;
        // les demandes en cours sont refaites ici
        for (const [id, p] of pending) {
          pending.delete(id);
          HR.generator.generate(p.start, p.target, p.opts).then(p.resolve, p.reject);
        }
      };
    } catch {
      worker = false;
    }
    return worker;
  }

  function onMessage({ data }) {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.type === 'stage') p.opts.onStage(data.stage);
    else if (data.type === 'explore') p.opts.onExplore({ segs: data.segs, o: data.o });
    else if (data.type === 'result') { pending.delete(data.id); p.resolve(data.res); }
    else if (data.type === 'error') { pending.delete(data.id); p.reject(Object.assign(new Error(data.message), { name: data.name })); }
  }

  function generate(start, target, { onExplore = () => {}, onStage = () => {}, signal } = {}) {
    const opts = { onExplore, onStage, signal };
    const w = getWorker();
    if (!w) return HR.generator.generate(start, target, opts);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { start: plain(start), target, opts, resolve, reject });
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          w.postMessage({ type: 'cancel', id });
          reject(Object.assign(new Error('Génération annulée.'), { name: 'AbortError' }));
        }, { once: true });
      }
      w.postMessage({ type: 'generate', id, start: plain(start), target });
    });
  }

  function prefetch(start, target) {
    if (!start) return;
    const w = getWorker();
    if (w) w.postMessage({ type: 'prefetch', start: plain(start), target });
    else HR.generator.prefetch(start, target);
  }

  HR.gen = { generate, prefetch };
})();
