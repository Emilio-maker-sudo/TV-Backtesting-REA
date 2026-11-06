/**
 * TV Backtester · main.js
 * API de consola (window.__tvbt) y diagnóstico.
 *   __tvbt.diag()        → estado del hook, series, API del gráfico (pegámelo si algo falla)
 *   __tvbt.cutAt(unixTs) → cortar por consola
 *   __tvbt.step(n) / __tvbt.exit()
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});
  const S = NS.state, E = NS.engine, A = NS.tvapi;

  function diag() {
    const H = NS.hook;
    const c = A.chart();
    const rows = [];
    for (const sess of S.sessions.values()) {
      for (const ser of sess.series.values()) {
        rows.push({ session: sess.id, serie: ser.key, res: ser.res, simbolo: String(ser.symKey || '').slice(0, 48),
                    velas_en_store: ser.full.size, entregadas: ser.delivered.size,
                    primera: ser.full.size ? new Date(E.sortedTimes(ser)[0] * 1000).toISOString() : null,
                    ultima: ser.full.size ? new Date(E.sortedTimes(ser).slice(-1)[0] * 1000).toISOString() : null });
      }
    }
    const api = {};
    ['resetData', 'setResolution', 'crossHairMoved', 'onIntervalChanged', 'getVisibleRange', 'resolution', 'symbol'].forEach((k) => { api[k] = !!(c && typeof c[k] === 'function'); });
    console.group('%cTV Backtester · diagnóstico', 'color:#2962ff;font-weight:bold');
    console.log('WebSocket hookeado:', window.WebSocket === NS.hook.Native ? 'NO (nativo)' : 'sí');
    console.log('Sockets creados/abiertos:', H.stats.sockets + '/' + H.sockets.size, '| mensajes vistos:', H.stats.frames, '| mensajes de datos:', S.stats.data);
    console.log('Backtest activo:', S.active, '| T:', S.T ? new Date(S.T * 1000).toISOString() : null, '| cargando:', S.loading, '| epoch:', S.epoch);
    console.log('Contadores:', JSON.stringify(S.stats));
    if (rows.length) console.table(rows); else console.warn('No hay series: o el hook no vio el WebSocket (recargá la pestaña con F5 después de instalar/actualizar la extensión) o los datos no pasan por WebSocket en el hilo principal.');
    console.log('API del gráfico (TradingViewApi.activeChart):', c ? api : 'NO DISPONIBLE');
    if (S.lastError) console.error('Último error:', S.lastError);
    if (S.samples.length) console.log('Muestra de timescale_update (recortada):', S.samples[0]);
    console.groupEnd();
    return { hook: H.stats, state: { active: S.active, T: S.T, loading: S.loading }, series: rows, api };
  }

  /** Diagnóstico de unidades: rango visible vs store (sirve para detectar si el crosshair viene en ms o s). */
  function probe() {
    const m = E.pickMain();
    const vr = A.visibleRange();
    const out = { resolution: A.resolution(), visibleRange: vr, visibleRangeUnit: vr && vr.from > 1e11 ? 'ms' : 's' };
    if (m) {
      const times = E.sortedTimes(m.ser);
      out.store = { count: times.length, first: times[0], last: times[times.length - 1],
                    firstISO: new Date(times[0] * 1000).toISOString(), lastISO: new Date(times[times.length - 1] * 1000).toISOString() };
    }
    console.log('%c[TVBT probe]', 'color:#2962ff;font-weight:bold');
    console.table({ resolution: out.resolution, visibleRange: out.visibleRange, visibleRangeUnit: out.visibleRangeUnit });
    if (out.store) console.table(out.store);
    return out;
  }

  window.__tvbt = {
    diag,
    probe,
    cutAt: (t) => E.cutAtOpenTime(t),
    step: (n) => E.step(n),
    exit: () => E.exit(),
    info: () => E.info(),
    state: S,
    strict: (v) => E.setStrict(v),
  };
})();
