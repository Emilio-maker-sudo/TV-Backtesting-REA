/**
 * TV Backtester · hook.js
 * Reemplaza window.WebSocket (corre en document_start, antes que el código de TradingView).
 *  - Mira los mensajes que TradingView envía (create_series, modify_series, resolve_symbol…).
 *  - Intercepta los que recibe y, con el backtest activo, entrega la versión filtrada.
 *  - Permite inyectar mensajes sintéticos (avanzar velas).
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});
  if (NS.hook) return;
  const P = NS.protocol;
  const E = () => NS.engine;
  const Native = window.WebSocket;
  const sockets = new Set();
  const stats = { sockets: 0, frames: 0, hooked: Date.now() };

  const INTERESTING = ['timescale_update', '"du"', 'series_completed', 'series_error', 'symbol_error', 'symbol_resolved'];

  function handleIncoming(ws, ev) {
    if (ev.__tvbt) return;                       // mensaje sintético nuestro: pasa tal cual
    const raw = ev.data;
    if (typeof raw !== 'string') return;
    stats.frames++;
    let hit = false;
    for (const k of INTERESTING) if (raw.indexOf(k) >= 0) { hit = true; break; }
    if (!hit) return;
    const frames = P.split(raw);
    if (!frames) return;

    let changed = false;
    const out = [];
    for (const f of frames) {
      if (f.charCodeAt(0) !== 123) { out.push(f); continue; }    // no es JSON (heartbeat, etc.)
      let obj;
      try { obj = JSON.parse(f); } catch (e) { out.push(f); continue; }
      if (!obj || typeof obj.m !== 'string') { out.push(f); continue; }
      const r = E().onIncoming(obj, ws);
      if (r.drop) { changed = true; continue; }
      if (r.changed) { changed = true; out.push(JSON.stringify(r.obj)); } else out.push(f);
    }
    if (!changed) return;
    if (!out.length) { ev.stopImmediatePropagation(); return; }  // nada que mostrarle al gráfico
    Object.defineProperty(ev, 'data', { value: P.join(out), configurable: true });
  }

  function sniffOutgoing(ws, data) {
    if (typeof data !== 'string' || data.indexOf('series') < 0 && data.indexOf('symbol') < 0 && data.indexOf('session') < 0) return;
    const frames = P.split(data);
    if (!frames) return;
    for (const f of frames) {
      if (f.charCodeAt(0) !== 123) continue;
      try { const o = JSON.parse(f); if (o && typeof o.m === 'string') E().onOutgoing(o, ws); } catch (e) { /* ignorar */ }
    }
  }

  class TVBTWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      sockets.add(this); stats.sockets++;
      this.addEventListener('close', () => sockets.delete(this));
      this.addEventListener('message', (ev) => {
        try { handleIncoming(this, ev); } catch (e) { console.error('[TVBT] hook error (se deja pasar):', e); }
      });
    }
    send(data) {
      try { sniffOutgoing(this, data); } catch (e) { console.error('[TVBT] sniff error:', e); }
      return super.send(data);
    }
  }
  window.WebSocket = TVBTWebSocket;

  /** Entrega al código de TradingView mensajes como si los hubiera mandado el servidor. */
  function inject(ws, payloads) {
    const ev = new MessageEvent('message', { data: P.join(payloads) });
    ev.__tvbt = true;
    ws.dispatchEvent(ev);
  }

  NS.hook = { inject, sockets, stats, Native };
  console.log('%c[TV Backtester] hook instalado', 'color:#2962ff');
})();
