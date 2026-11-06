/**
 * TV Backtester · tvapi.js
 * Acceso a la API pública del gráfico de TradingView (window.TradingViewApi).
 * Todo con feature-detection: si algo no existe, se degrada sin romper nada.
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});

  function chart() {
    try { return window.TradingViewApi && window.TradingViewApi.activeChart && window.TradingViewApi.activeChart(); } catch (e) { return null; }
  }
  const call = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

  const resolution = () => call(() => String(chart().resolution()), null);
  const symbol = () => call(() => chart().symbol(), null);
  const visibleRange = () => call(() => chart().getVisibleRange(), null);

  /** Suscribe a la posición del crosshair. cb({time}). Devuelve función para desuscribir. */
  function onCrosshair(cb) {
    const c = chart();
    if (!c || typeof c.crossHairMoved !== 'function') return null;
    const sub = c.crossHairMoved();
    const fn = (p) => cb(p || {});
    try { sub.subscribe(null, fn); } catch (e) { return null; }
    return () => { try { sub.unsubscribe(null, fn); } catch (e) { /* ignorar */ } };
  }

  /** Suscribe a cambios de timeframe del gráfico (por si hace falta refrescar la UI). */
  function onInterval(cb) {
    const c = chart();
    if (!c || typeof c.onIntervalChanged !== 'function') return null;
    try { const sub = c.onIntervalChanged(); const fn = () => cb(); sub.subscribe(null, fn); return () => { try { sub.unsubscribe(null, fn); } catch (e) { /* ignorar */ } }; } catch (e) { return null; }
  }

  /**
   * Limpia el gráfico pidiéndole que recargue (resetData) sin esperar la respuesta del servidor.
   * Devuelve true si resetData existe y se invocó; false si hay que usar el toggle de timeframe.
   */
  function reset() {
    const c = chart();
    if (!c || typeof c.resetData !== 'function') return false;
    call(() => c.resetData());
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(cond, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(40); }
    return cond();
  }

  /**
   * Fuerza a TradingView a volver a pedir la serie al servidor. Esa respuesta pasa por el filtro,
   * así que es lo que aplica / quita el corte. Devuelve el método usado o false.
   */
  async function reload() {
    const c = chart();
    if (!c) return false;
    const S = NS.state;

    // 1) lo normal: resetData() (recarga completa de la serie)
    if (typeof c.resetData === 'function') {
      const e0 = S.epoch;
      call(() => c.resetData());
      if (await waitFor(() => S.epoch > e0, 1500)) return 'resetData';
    }

    // 2) plan B: ir a otro timeframe y volver (siempre dispara una recarga)
    if (typeof c.setResolution === 'function') {
      const cur = String(c.resolution());
      const alt = ['5', '15', '60', '240', 'D'].find((r) => r !== cur);
      let e0 = S.epoch;
      call(() => c.setResolution(alt));
      if (!(await waitFor(() => S.epoch > e0, 2500))) return false;
      await waitFor(() => !S.loading, 4000);
      e0 = S.epoch;
      call(() => c.setResolution(cur));
      await waitFor(() => S.epoch > e0, 2500);
      return 'toggle';
    }
    return false;
  }

  NS.tvapi = { chart, resolution, symbol, visibleRange, onCrosshair, onInterval, reload, reset };
})();
