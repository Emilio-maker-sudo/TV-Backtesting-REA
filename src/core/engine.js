/**
 * TV Backtester · engine.js
 *
 * Idea central: TradingView recibe las velas por WebSocket (`timescale_update` y `du`).
 * Este motor se sienta en ese flujo:
 *
 *   - Guarda TODAS las velas que manda el servidor (store completo).
 *   - Mientras el backtest está activo, al gráfico solo le entrega las velas "visibles"
 *     según un reloj T (un instante de tiempo). Las velas futuras NO LLEGAN al gráfico.
 *   - Avanzar = inyectar al gráfico las velas siguientes como si las mandara el servidor.
 *   - Retroceder / cortar / salir = pedirle al gráfico que recargue la serie; la recarga
 *     vuelve a pasar por el filtro, así que el resultado siempre es consistente.
 *   - Cambiar de timeframe o de símbolo: el servidor manda la serie nueva y se filtra con el
 *     MISMO reloj T, por eso el corte se respeta en todos los timeframes.
 *
 * Reloj T: "todo lo que cierre en o antes de T es visible". Una vela de un timeframe mayor
 * que todavía no cerró a T (vela en formación) se reconstruye solo con velas más chicas
 * anteriores a T (si las tenemos); si no, se omite. Nunca se muestra información posterior a T.
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});
  const P = NS.protocol;

  const S = (NS.state = {
    active: false,
    T: null,                 // reloj del backtest (segundos unix)
    sessionId: null,         // chart session que está bajo backtest
    strict: true,            // vacía los dibujos de indicadores (pueden filtrar el futuro)
    sessions: new Map(),
    fine: new Map(),         // symKey -> { resSec, bars: Map(time -> v[]) } (para velas en formación)
    fineVer: 0,
    epoch: 0,                // +1 cada vez que el gráfico (re)pide una serie
    loading: false,
    reloadPending: false,
    reloadTimer: null,
    loadingTimer: null,
    suppress: false,          // descarta los datos que reenvíe el servidor (redelivery sintética en curso)
    suppressTimer: null,
    injectTimer: null,
    redeliverTimer: null,
    mainSessionId: null,
    stats: { frames: 0, data: 0, rewritten: 0, dropped: 0, injected: 0, errors: 0, completed: 0 },
    samples: [],
    lastError: null,
  });

  /* ───────────── eventos ───────────── */
  const handlers = {};
  function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
  function emit(evt, arg) {
    (handlers[evt] || []).forEach((fn) => { try { fn(arg); } catch (e) { console.error('[TVBT]', e); } });
  }

  /* ───────────── estructuras ───────────── */
  function session(id) {
    let s = S.sessions.get(id);
    if (!s) {
      s = { id, ws: null, series: new Map(), studies: new Map(), symbols: new Map(), symInfo: new Map(),
            tsIdx: new Map(), marks: new Map(), orderCounter: 0 };
      S.sessions.set(id, s);
    }
    return s;
  }
  function series(sess, key) {
    let r = sess.series.get(key);
    if (!r) {
      r = { key, order: sess.orderCounter++, res: null, symId: null, symKey: null, turn: 's1', lbs: null, node: null,
            full: new Map(), delivered: new Map(), ver: 0, vis: null, _sorted: null, _sortedVer: -1 };
      sess.series.set(key, r);
    }
    return r;
  }
  function study(sess, key) {
    let r = sess.studies.get(key);
    if (!r) { r = { key, turn: 's1', rows: new Map() }; sess.studies.set(key, r); }
    return r;
  }
  function mainSeries(sess) {
    let best = null;
    for (const s of sess.series.values()) if (!best || s.order < best.order) best = s;
    return best;
  }
  function pickMain() {
    let best = null;
    for (const sess of S.sessions.values()) {
      const ser = mainSeries(sess);
      if (!ser || !ser.full.size) continue;
      const score = (sess.id === S.mainSessionId ? 1e9 : 0) + ser.full.size;
      if (!best || score > best.score) best = { sess, ser, score };
    }
    return best;
  }

  /* ───────────── tiempo y visibilidad ───────────── */
  const sig = (v) => v.join(',');
  function durOf(ser) { return P.resSeconds(ser.res) || 60; }
  function sortedTimes(ser) {
    if (!ser._sorted || ser._sortedVer !== ser.ver) {
      ser._sorted = Array.from(ser.full.keys()).sort((a, b) => a - b);
      ser._sortedVer = ser.ver;
    }
    return ser._sorted;
  }
  /** Cierre de la vela k = apertura de la siguiente (robusto a gaps de sesión y meses). */
  function closeAt(ser, times, k) { return k + 1 < times.length ? times[k + 1] : times[k] + durOf(ser); }

  function updateFine(sess, ser) {
    if (!ser.symKey || !ser.res) return;
    const sec = P.resSeconds(ser.res);
    if (!sec) return;
    let f = S.fine.get(ser.symKey);
    if (!f || sec < f.resSec) { f = { resSec: sec, bars: new Map() }; S.fine.set(ser.symKey, f); }
    if (sec === f.resSec) {
      for (const [t, rec] of ser.full) f.bars.set(t, rec.v);
      S.fineVer++;
    }
  }

  /** Reconstruye una vela en formación a partir de velas más finas que cerraron antes de T. */
  function buildPartial(ser, openT) {
    const f = S.fine.get(ser.symKey);
    if (!f || !(f.resSec < durOf(ser))) return null;
    let n = 0, minT = Infinity, maxT = -Infinity, o = 0, h = -Infinity, l = Infinity, c = 0, vol = 0;
    for (const [t, v] of f.bars) {
      if (t < openT || t + f.resSec > S.T) continue;
      n++;
      if (t < minT) { minT = t; o = v[1]; }
      if (t > maxT) { maxT = t; c = v[4]; }
      if (v[2] > h) h = v[2];
      if (v[3] < l) l = v[3];
      vol += v[5] || 0;
    }
    return n ? [openT, o, h, l, c, vol] : null;
  }

  /**
   * Qué es visible para una serie con el reloj actual.
   *   cutoff   : apertura de la primera vela NO completa (todo lo anterior es visible)
   *   partialT : apertura de la vela en formación (o null)
   *   partial  : su valor reconstruido (o null si no se pudo reconstruir)
   *   list     : [{t,i,v}] velas visibles en orden
   */
  function visInfo(ser) {
    const T = S.T == null ? Infinity : S.T;   // T=null (fuera de backtest) => todo visible
    const c = ser.vis;
    if (c && c.ver === ser.ver && c.T === S.T && c.fv === S.fineVer) return c;
    const times = sortedTimes(ser);
    const list = [];
    let cutoff = Infinity, partialT = null, partial = null;
    for (let k = 0; k < times.length; k++) {
      const t = times[k];
      if (closeAt(ser, times, k) <= T) {
        const rec = ser.full.get(t);
        list.push({ t, i: rec.i, v: rec.v });
      } else {
        cutoff = t;
        if (t < T) {
          partialT = t;
          partial = buildPartial(ser, t);
          if (partial) list.push({ t, i: ser.full.get(t).i, v: partial });
        }
        break;
      }
    }
    return (ser.vis = { ver: ser.ver, T: S.T, fv: S.fineVer, cutoff, partialT, partial, list });
  }
  const timeVisible = (info, t) => t < info.cutoff || (info.partial && t === info.partialT);

  /* ───────────── mensajes salientes (TradingView → servidor) ───────────── */
  function onOutgoing(obj, ws) {
    const p = obj.p;
    if (!Array.isArray(p) || typeof p[0] !== 'string') return;
    const sid = p[0];
    switch (obj.m) {
      case 'chart_create_session': session(sid).ws = ws; break;
      case 'chart_delete_session':
        S.sessions.delete(sid);
        if (S.sessionId === sid) { S.active = false; S.sessionId = null; emit('state'); }
        break;
      case 'resolve_symbol': { const s = session(sid); s.ws = ws; s.symbols.set(p[1], p[2]); break; }
      case 'create_series':
      case 'modify_series': {
        const sess = session(sid); sess.ws = ws;
        const ser = series(sess, p[1]);
        const newRes = String(p[4]);
        // Solo se pierde la historia si cambió el timeframe o el símbolo (las claves de tiempo ya no son comparables).
        // Una recarga del MISMO TF (resetData) debe conservar el store completo.
        const keyChanged = ser.res !== newRes || ser.symId !== p[3];
        ser.turn = p[2]; ser.symId = p[3]; ser.res = newRes;
        ser.symKey = sess.symbols.get(p[3]) || p[3];
        if (keyChanged) { ser.full = new Map(); ser.lbs = null; }
        ser.delivered = new Map(); ser.ver++; ser.vis = null;
        sess.tsIdx.clear(); sess.marks.clear();
        for (const st of sess.studies.values()) st.rows.clear();
        S.epoch++; S.mainSessionId = sid;
        setLoading(true);
        break;
      }
      case 'remove_series': { const sess = session(sid); sess.series.delete(p[1]); break; }
      case 'remove_study': { const sess = session(sid); sess.studies.delete(p[1]); break; }
      default:
    }
  }

  function setLoading(v) {
    S.loading = v;
    clearTimeout(S.loadingTimer);
    if (v) S.loadingTimer = setTimeout(() => { S.loading = false; emit('state'); }, 8000);
    emit('state');
  }

  /* ───────────── mensajes entrantes (servidor → TradingView) ───────────── */
  /** Devuelve {} (sin cambios) | {obj, changed:true} (reescrito) | {drop:true}. */
  function onIncoming(obj, ws) {
    try {
      switch (obj.m) {
        case 'timescale_update':
        case 'du': S.stats.data++; return onData(obj, ws);
        case 'series_completed':
          S.stats.completed++;
          if (S.suppress) { S.suppress = false; clearTimeout(S.suppressTimer); }
          if (S.loading) { setLoading(false); emit('loaded'); }
          return {};
        case 'series_error': case 'symbol_error': if (S.loading) setLoading(false); return {};
        case 'symbol_resolved': {
          const p = obj.p;
          if (Array.isArray(p) && typeof p[0] === 'string') {
            const sess = session(p[0]); sess.ws = ws; sess.symInfo.set(p[1], p[2]);
          }
          emit('state');
          return {};
        }
        default: return {};
      }
    } catch (e) {
      S.stats.errors++; S.lastError = String(e && e.stack || e);
      console.error('[TVBT] error procesando mensaje (se deja pasar sin tocar):', e);
      return {};
    }
  }

  function onData(obj, ws) {
    const p = obj.p;
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'string') return {};
    const dict = p[1];
    if (!dict || typeof dict !== 'object') return {};
    const ts = p[2] && typeof p[2] === 'object' ? p[2] : null;
    const sess = session(p[0]); sess.ws = ws;
    if (S.samples.length < 3 && obj.m === 'timescale_update') S.samples.push(JSON.stringify(obj).slice(0, 1600));
    record(sess, dict, ts);
    if (!S.active || sess.id !== S.sessionId) return {};
    if (S.suppress) return { drop: true };   // redelivery sintética en curso: no dejar pasar datos del servidor
    return filter(obj, sess, dict, ts);
  }

  function record(sess, dict, ts) {
    for (const key of Object.keys(dict)) {
      const d = dict[key];
      if (!d || typeof d !== 'object') continue;
      if (Array.isArray(d.s)) {
        const ser = series(sess, key);
        if (d.t) ser.turn = d.t;
        if (d.lbs) ser.lbs = d.lbs;
        if (d.node) ser.node = d.node;
        for (const b of d.s) { const v = b && b.v; if (v && v.length >= 5) ser.full.set(v[0], { i: b.i, v }); }
        ser.ver++;
        if (ser === mainSeries(sess)) updateFine(sess, ser);
      } else if (Array.isArray(d.st)) {
        // Guardar filas de estudios SIEMPRE: las necesita buildFullFrames para redelivery completa.
        const st = study(sess, key);
        if (d.t) st.turn = d.t;
        for (const r of d.st) if (r && r.v) st.rows.set(r.v[0], r);
      }
    }
    if (ts) {
      if (Array.isArray(ts.changes)) { const base = +ts.index || 0; ts.changes.forEach((t, k) => sess.tsIdx.set(t, base + k)); }
      if (Array.isArray(ts.marks)) for (const m of ts.marks) if (Array.isArray(m)) sess.marks.set(m[1], m);
    }
  }

  function filter(obj, sess, dict, ts) {
    let changed = false;
    const main = mainSeries(sess);
    const mainInfo = main ? visInfo(main) : null;

    for (const key of Object.keys(dict)) {
      const d = dict[key];
      if (!d || typeof d !== 'object') continue;

      if (Array.isArray(d.s)) {
        const ser = sess.series.get(key);
        const info = visInfo(ser);
        const keep = [];
        for (const b of d.s) {
          const v = b && b.v;
          if (!v) { keep.push(b); continue; }
          if (v[0] < info.cutoff) { keep.push(b); ser.delivered.set(v[0], sig(v)); }
          else if (info.partial && v[0] === info.partialT) {
            keep.push({ i: b.i, v: info.partial }); ser.delivered.set(v[0], sig(info.partial)); changed = true;
          } else { changed = true; S.stats.dropped++; }
        }
        if (keep.length !== d.s.length) {
          if (!keep.length && obj.m === 'du') delete dict[key]; else d.s = keep;
        }
      } else {
        // estudio / indicador: filas de datos + (opcional) dibujos de Pine en ns.d
        if (Array.isArray(d.st) && mainInfo) {
          const n = d.st.length;
          d.st = d.st.filter((r) => r && r.v && timeVisible(mainInfo, r.v[0]));
          if (d.st.length !== n) changed = true;
        }
        if (S.strict && d.ns && d.ns.d) { d.ns.d = ''; changed = true; }
        if (Array.isArray(d.st) && !d.st.length && obj.m === 'du' && !(d.ns && d.ns.d)) { delete dict[key]; changed = true; continue; }
      }
    }

    if (ts && mainInfo) {
      if (Array.isArray(ts.changes)) {
        const n = ts.changes.length;
        ts.changes = ts.changes.filter((t) => timeVisible(mainInfo, t));
        if (ts.changes.length !== n) changed = true;
      }
      if (Array.isArray(ts.marks)) {
        const n = ts.marks.length;
        ts.marks = ts.marks.filter((m) => !Array.isArray(m) || timeVisible(mainInfo, m[1]));
        if (ts.marks.length !== n) changed = true;
      }
    }

    if (!changed) return {};
    S.stats.rewritten++;
    if (obj.m === 'du' && !Object.keys(dict).length && !(ts && ts.changes && ts.changes.length)) return { drop: true };
    return { obj, changed: true };
  }

  /* ───────────── API del backtest ───────────── */

  /** Busca la vela cuya apertura es la mayor <= t en la serie principal. */
  function locate(t) {
    const m = pickMain();
    if (!m) return null;
    const times = sortedTimes(m.ser);
    let lo = 0, hi = times.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    if (k < 0) return null;
    return { ...m, times, k, open: times[k], close: closeAt(m.ser, times, k) };
  }

  function cutAtOpenTime(t) {
    const loc = locate(t);
    if (!loc) { console.warn('[TVBT] cutAtOpenTime: no hay velas en el store todavía.'); return { ok: false, reason: 'No tengo velas cargadas todavía. Esperá a que cargue el gráfico.' }; }
    if (loc.k >= loc.times.length - 1) { console.warn('[TVBT] cutAtOpenTime: t=', t, 'cae en la última vela (índice', loc.k, 'de', loc.times.length, '). Elegí una anterior.'); return { ok: false, reason: 'Elegí una vela anterior a la última.' }; }
    S.T = loc.close;
    S.sessionId = loc.sess.id;
    S.active = true;
    console.log('[TVBT] corte ok: barra', loc.k, '/', loc.times.length, '| open=', new Date(loc.open * 1000).toISOString(), '| T=', new Date(S.T * 1000).toISOString());
    redeliverAll();
    emit('state');
    return { ok: true, open: loc.open };
  }

  function exit() {
    if (!S.active) return;
    S.active = false; S.T = null;
    for (const sess of S.sessions.values()) for (const st of sess.studies.values()) st.rows.clear();
    requestReload(0);
    emit('state');
  }

  /** Avanza (+n) o retrocede (-n) n velas COMPLETAS del timeframe actual. */
  function step(n) {
    if (!S.active) return { ok: false, reason: 'inactive' };
    if (S.loading) return { ok: false, reason: 'loading' };
    const sess = S.sessions.get(S.sessionId);
    const ser = sess && mainSeries(sess);
    if (!ser || !ser.full.size) return { ok: false, reason: 'no-data' };

    const times = sortedTimes(ser), m = times.length;
    const closes = times.map((_, k) => closeAt(ser, times, k));
    let lo = 0, hi = m;                                   // p = cantidad de cierres <= T
    while (lo < hi) { const mid = (lo + hi) >> 1; if (closes[mid] <= S.T) lo = mid + 1; else hi = mid; }
    const p = lo;
    const partial = p < m && times[p] < S.T;

    let newPos;
    if (n > 0) {
      if (p >= m) return { ok: false, reason: 'end' };
      newPos = Math.min(m, p + n);
    } else {
      newPos = Math.max(1, p + n + (partial ? 1 : 0));
      if (newPos === p && !partial) return { ok: false, reason: 'start' };
    }
    S.T = closes[newPos - 1];

    if (n > 0) {
      const r = syncForward();
      if (r === 'reload') redeliverAll();               // primer avance sin datos entregados: redelivery completa
    } else {
      scheduleRedeliver(90);                              // retrocesos seguidos se agrupan en una sola redelivery
    }
    emit('state');
    return { ok: true, atEnd: newPos >= m };
  }

  /** Entrega al gráfico lo que pasó a ser visible (velas nuevas y velas que terminaron de formarse). */
  function syncForward() {
    const sess = S.sessions.get(S.sessionId);
    if (!sess || !sess.ws) return 'reload';
    const frames = [];
    const updDict = {}, newDict = {};
    const newTimes = [], updTimes = [];
    let needReload = false;
    const main = mainSeries(sess);
    const mainInfo = visInfo(main);

    for (const ser of sess.series.values()) {
      if (!ser.delivered.size) { if (ser === main || ser.full.size) return 'reload'; continue; }  // todavía no cargó: que recargue
      const info = visInfo(ser);
      const visSet = new Set();
      const nb = [], ub = [];
      for (const b of info.list) {
        visSet.add(b.t);
        const prev = ser.delivered.get(b.t);
        if (prev === undefined) nb.push({ i: b.i, v: b.v });
        else if (prev !== sig(b.v)) ub.push({ i: b.i, v: b.v });
      }
      for (const t of ser.delivered.keys()) if (!visSet.has(t)) needReload = true;
      const meta = (extra) => Object.assign({ ns: { d: '', indexes: 'nochange' }, t: ser.turn }, ser.lbs ? { lbs: ser.lbs } : {}, extra);
      if (ub.length) { updDict[ser.key] = meta({ s: ub }); if (ser === main) ub.forEach((b) => updTimes.push(b.v[0])); }
      if (nb.length) { newDict[ser.key] = meta({ s: nb }); if (ser === main) nb.forEach((b) => newTimes.push(b.v[0])); }
      for (const b of ub) ser.delivered.set(b.v[0], sig(b.v));
      for (const b of nb) ser.delivered.set(b.v[0], sig(b.v));
    }
    if (needReload) return 'reload';

    // estudios (indicadores): solo filas de velas completas que acaban de entregarse
    const stTimes = new Set([...newTimes, ...updTimes]);
    for (const st of sess.studies.values()) {
      const rows = [];
      for (const t of stTimes) { if (t < mainInfo.cutoff) { const r = st.rows.get(t); if (r) rows.push(r); } }
      if (rows.length) newDict[st.key] = { st: rows, ns: { d: '', indexes: 'nochange' }, t: st.turn };
    }

    if (Object.keys(updDict).length) frames.push(JSON.stringify({ m: 'du', p: [sess.id, updDict] }));
    if (Object.keys(newDict).length) {
      const times = newTimes.slice().sort((a, b) => a - b);
      const tsInfo = {
        index: times.length ? (sess.tsIdx.has(times[0]) ? sess.tsIdx.get(times[0]) : (mainBarIndex(main, times[0]))) : 0,
        zoffset: 0, changes: times,
        marks: times.map((t, k) => { const m = sess.marks.get(t); return m ? [m[0], t, k] : null; }).filter(Boolean),
        index_diff: [], last_session_switches: {},
      };
      frames.push(JSON.stringify({ m: 'timescale_update', p: [sess.id, newDict, tsInfo] }));
    }
    if (frames.length) { S.stats.injected += frames.length; NS.hook.inject(sess.ws, frames); }
    return 'ok';
  }
  function mainBarIndex(ser, t) { const r = ser.full.get(t); return r ? r.i : 0; }

  /* ───────────── redelivery completa (sintética) ───────────── */
  /**
   * Construye un set COMPLETO de frames (timescale_update + du de estudios) desde el store local,
   * con índice 0 y solo las velas visibles según el reloj T. Esto elimina físicamente el futuro:
   * no depende de que el servidor reenvíe el rango correcto, ni de su índice de timescale.
   */
  /** Captura (ANTES del reset) las velas visibles y estudios desde el store. Devuelve una vista serializable. */
  function snapshotView(sess) {
    const main = mainSeries(sess);
    if (!main || !main.full.size) {
      console.warn('[TVBT] snapshotView: series=', sess.series.size, 'mainFull=', main ? main.full.size : 'null');
      return null;
    }
    const mainInfo = visInfo(main);
    const times = mainInfo.list.map((b) => b.t);
    const series = [];
    for (const ser of sess.series.values()) {
      if (!ser.full.size) continue;
      const info = visInfo(ser);
      series.push({ key: ser.key, s: info.list.map((b, idx) => ({ i: idx, v: b.v })), isMain: ser === main });
      // sincronizar delivered con lo que vamos a entregar
      const visSet = new Set(info.list.map((b) => b.t));
      for (const t of Array.from(ser.delivered.keys())) if (!visSet.has(t)) ser.delivered.delete(t);
      for (const b of info.list) ser.delivered.set(b.t, sig(b.v));
    }
    if (!series.length) { console.warn('[TVBT] snapshotView: dict vacío (series presentes pero sin full).'); return null; }

    const studies = {};
    for (const st of sess.studies.values()) {
      const rows = [];
      for (const t of times) { if (t < mainInfo.cutoff) { const r = st.rows.get(t); if (r) rows.push(r); } }
      if (rows.length) studies[st.key] = { st: rows, turn: st.turn };
    }
    return { times, series, studies };
  }

  /** Serializa la vista en frames usando el turn/node ACTUALES (post-reset). */
  function framesFromView(sess, view) {
    const main = mainSeries(sess) || { key: view.series[0].key, turn: 's1' };
    const dict = {};
    for (const item of view.series) {
      const ser = sess.series.get(item.key);
      const turn = ser ? ser.turn : 's1';
      const node = ser ? ser.node : null;
      const lbs = item.isMain && S.active ? { bar_close_time: S.T } : (ser && ser.lbs ? ser.lbs : null);
      dict[item.key] = Object.assign({ s: item.s, ns: { d: '', indexes: [] }, t: turn }, node ? { node } : {}, lbs ? { lbs } : {});
    }
    const tsInfo = { index: 0, zoffset: 0, changes: view.times, marks: [], index_diff: [], last_session_switches: {} };
    // Imitar la secuencia REAL del servidor: series_loading → timescale_update → du → series_completed.
    const frames = [
      JSON.stringify({ m: 'series_loading', p: [sess.id, main.key, main.turn] }),
      JSON.stringify({ m: 'timescale_update', p: [sess.id, dict, tsInfo] }),
    ];
    const studyDict = {};
    for (const [key, st] of Object.entries(view.studies)) {
      studyDict[key] = { st: st.st, ns: { d: '', indexes: 'nochange' }, t: st.turn };
    }
    if (Object.keys(studyDict).length) frames.push(JSON.stringify({ m: 'du', p: [sess.id, studyDict] }));
    frames.push(JSON.stringify({ m: 'series_completed', p: [sess.id, main.key, 'streaming', main.turn, {}] }));
    return frames;
  }

  /** Aplica la vista actual: limpia el gráfico y le inyecta el set completo filtrado desde el store. */
  function redeliverAll() {
    if (!S.active) return;
    const sess = S.sessions.get(S.sessionId);
    if (!sess || !sess.ws) { requestReload(0); return; }

    // SNAPSHOT ANTES del reset: resetData() re-suscribe al servidor (cambia turn, reemplaza el store por el rango visible).
    const view = snapshotView(sess);
    if (!view) {
      console.warn('[TVBT] redeliverAll: store vacío al cortar. Esperá a que el gráfico termine de cargar y reintentá (o corré __tvbt.diag()).');
      requestReload(0);
      return;
    }
    const deliveredSnap = new Map();
    for (const ser of sess.series.values()) deliveredSnap.set(ser.key, new Map(ser.delivered));

    // Suprimir lo que reenvíe el servidor (resetData/toggle re-solicita y su timescale parcial chocaría con el nuestro).
    S.suppress = true;
    clearTimeout(S.suppressTimer);
    S.suppressTimer = setTimeout(() => { S.suppress = false; }, 8000);

    setLoading(true);
    const cleared = NS.tvapi.reset();
    if (!cleared) NS.tvapi.reload();      // plan B: toggle de TF (también reenvía, queda suprimido)

    clearTimeout(S.injectTimer);
    const delay = cleared ? 100 : 1600;
    S.injectTimer = setTimeout(() => {
      if (!S.active) { console.warn('[TVBT] redeliverAll: se canceló la inyección (backtest salió).'); setLoading(false); return; }   // salió antes de inyectar
      // El reset limpió `delivered`; lo restauramos desde el snapshot para que syncForward siga haciendo deltas.
      for (const ser of sess.series.values()) {
        const snap = deliveredSnap.get(ser.key);
        if (snap) ser.delivered = new Map(snap);
      }
      // Serializar AHORA con el turn/node actuales (post-reset), no con los del snapshot.
      const frames = framesFromView(sess, view);
      try {
        if (sess.ws && frames && frames.length) { NS.hook.inject(sess.ws, frames); S.stats.injected += frames.length; console.log('[TVBT] redeliverAll: inyectados', frames.length, 'frames.'); }
        else console.warn('[TVBT] redeliverAll: sin frames para inyectar (ws=', !!sess.ws, 'frames=', frames && frames.length, ').');
      } catch (e) { S.stats.errors++; console.error('[TVBT] redeliverAll inject:', e); }
      // resetData() suele volver a la vista reciente; scrollear al corte para que se vea el rango filtrado.
      if (view.times.length) {
        try {
          const c = NS.tvapi.chart();
          if (c && typeof c.setVisibleRange === 'function') {
            const last = view.times[view.times.length - 1];
            const from = view.times[Math.max(0, view.times.length - 80)];
            c.setVisibleRange({ from, to: last });
          }
        } catch (e) { /* ignorar */ }
      }
      setLoading(false);
      emit('state');
    }, delay);
  }
  function scheduleRedeliver(delay) {
    clearTimeout(S.redeliverTimer);
    S.redeliverTimer = setTimeout(redeliverAll, delay);
  }

  /* ───────────── recarga ───────────── */
  function requestReload(delay) {
    S.reloadPending = true;
    clearTimeout(S.reloadTimer);
    S.reloadTimer = setTimeout(async () => {
      S.reloadPending = false;
      setLoading(true);
      const how = await NS.tvapi.reload();
      if (!how) {
        setLoading(false);
        emit('toast', { type: 'error', text: 'No pude forzar la recarga del gráfico. Cambiá de timeframe una vez y listo (o corré __tvbt.diag()).' });
      }
    }, delay);
    emit('state');
  }

  function setStrict(v) { S.strict = !!v; if (S.active) requestReload(0); emit('state'); }

  /** Info para la UI. */
  function info() {
    const out = { active: S.active, loading: S.loading || S.reloadPending, strict: S.strict, T: S.T,
                  res: null, lastOpen: null, remaining: 0, tz: null, symbol: null };
    const m = pickMain();
    const sess = S.active ? S.sessions.get(S.sessionId) : (m && m.sess);
    const ser = sess && mainSeries(sess);
    if (ser) {
      out.res = ser.res;
      if (sess.symInfo.has(ser.symId)) { const si = sess.symInfo.get(ser.symId) || {}; out.tz = si.timezone || null; out.symbol = si.full_name || si.name || null; }
      if (S.active && ser.full.size) {
        const vi = visInfo(ser);
        out.lastOpen = vi.list.length ? vi.list[vi.list.length - 1].t : null;
        out.remaining = Math.max(0, sortedTimes(ser).length - vi.list.length);
      }
    }
    return out;
  }

  NS.engine = { on, emit, onIncoming, onOutgoing, cutAtOpenTime, exit, step, info, locate, pickMain, mainSeries,
                requestReload, setStrict, visInfo, session, sortedTimes, redeliverAll, snapshotView, framesFromView };
})();
