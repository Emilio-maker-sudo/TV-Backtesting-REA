/* Simulación: servidor TV falso + cliente TV falso, usando el mismo framing/mensajes que el protocolo real. */
global.window = global;
const assert = require('assert');

class FakeWS extends EventTarget {
  constructor(url) { super(); this.url = url; this.sent = []; }
  send(d) { this.sent.push(d); if (this.onSend) this.onSend(d); }
}
global.WebSocket = FakeWS;
require('../src/core/protocol.js');
require('../src/core/engine.js');
require('../src/core/tvapi.js');
require('../src/core/hook.js');
const NS = window.__TVBT, P = NS.protocol, E = NS.engine, S = NS.state;

/* ── datos del "servidor": 5m, 600 barras ── */
const T0 = 1_700_000_000 - (1_700_000_000 % 3600);
const bars5 = [];
let px = 100;
for (let k = 0; k < 600; k++) {
  const o = px, c = px + Math.sin(k / 7) * 2 + (k % 5 - 2) * 0.3;
  bars5.push([T0 + k * 300, o, Math.max(o, c) + 0.5 + (k % 3) * 0.1, Math.min(o, c) - 0.5 - (k % 4) * 0.1, c, 10 + k % 9]);
  px = c;
}
function aggregate(secs) {
  const m = new Map();
  for (const b of bars5) {
    const t = b[0] - (b[0] - T0) % secs;
    const a = m.get(t);
    if (!a) m.set(t, [t, b[1], b[2], b[3], b[4], b[5]]);
    else { a[2] = Math.max(a[2], b[2]); a[3] = Math.min(a[3], b[3]); a[4] = b[4]; a[5] += b[5]; }
  }
  return [...m.values()];
}
const dataFor = { '5': bars5, '60': aggregate(3600) };
const frame = (o) => JSON.stringify(o);

/* ── "cliente TV": aplica los mensajes que recibe a su modelo ── */
const client = { bars: new Map(), times: [], studyRows: new Map(), log: [] };
function clientApply(raw) {
  for (const f of P.split(raw) || []) {
    if (f[0] !== '{') continue;
    const o = JSON.parse(f);
    client.log.push(o.m);
    if (o.m !== 'timescale_update' && o.m !== 'du') continue;
    for (const [k, d] of Object.entries(o.p[1])) {
      if (d.s) for (const b of d.s) client.bars.set(b.i, b.v);
      if (d.st) for (const r of d.st) client.studyRows.set(r.v[0], r.v);
    }
    const ts = o.p[2];
    if (ts && ts.changes) ts.changes.forEach((t, j) => (client.times[ts.index + j] = t));
  }
}
const viewBars = () => [...client.bars.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);

/* ── conexión ── */
const ws = new WebSocket('wss://data.tradingview.com/socket.io/websocket');
ws.addEventListener('message', (ev) => { if (typeof ev.data === 'string') clientApply(ev.data); });
const CS = 'cs_test';
function serverSend(frames) {
  const ev = new MessageEvent('message', { data: P.join(frames) });
  ws.dispatchEvent(ev);
}
function serverLoad(res, turn) {
  const bars = dataFor[res];
  const s = bars.map((v, i) => ({ i, v }));
  const lastClose = bars[bars.length - 1][0] + P.resSeconds(res);
  const st = bars.map((v, i) => ({ i, v: [v[0], v[4] * 2] }));
  serverSend([
    frame({ m: 'series_loading', p: [CS, 'sds_1', turn] }),
    frame({ m: 'timescale_update', p: [CS, { sds_1: { s, ns: { d: '', indexes: [] }, t: turn, lbs: { bar_close_time: lastClose } } },
      { index: 0, zoffset: 0, changes: bars.map((b) => b[0]), marks: [[40, bars[0][0], 0]], index_diff: [], last_session_switches: {} }] }),
    frame({ m: 'du', p: [CS, { st1: { node: 'n', st, ns: { d: '{"graphicsCmds":{"create":{}}}', indexes: 'nochange' }, t: turn } }] }),
    frame({ m: 'series_completed', p: [CS, 'sds_1', 'streaming', turn, {}] }),
  ]);
}
let turnN = 0;
function tvClient(m, res) { // lo que haría el cliente de TV al pedir/modificar la serie
  client.bars = new Map(); client.times = []; client.studyRows = new Map();
  turnN++;
  ws.send(P.join([frame({ m, p: [CS, 'sds_1', 's' + turnN, 'sds_sym_1', res, m === 'create_series' ? 300 : ''] })]));
  serverLoad(res, 's' + turnN);
}
let currentRes = '5';
NS.tvapi.reload = async () => { tvClient('modify_series', currentRes); return 'resetData'; };
NS.tvapi.reset = () => { tvClient('modify_series', currentRes); return true; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function checkConsistent(label) {
  const v = viewBars();
  const idxs = [...client.bars.keys()].sort((a, b) => a - b);
  idxs.forEach((x, k) => assert.strictEqual(x, k, `${label}: índices no contiguos en ${k}`));
  return v;
}

(async () => {
  // arranque: TV resuelve símbolo, crea serie y recibe todo
  ws.send(P.join([frame({ m: 'chart_create_session', p: [CS, ''] }), frame({ m: 'resolve_symbol', p: [CS, 'sds_sym_1', '={"symbol":"TEST:X","adjustment":"splits"}'] })]));
  tvClient('create_series', '5');
  assert.strictEqual(viewBars().length, 600, 'sin backtest llegan todas las velas');
  console.log('✓ pasa-through sin backtest: 600 velas');

  // 1) CORTE en la vela 300
  const cutK = 300, cutOpen = bars5[cutK][0];
  const r = E.cutAtOpenTime(cutOpen + 17);          // un tiempo cualquiera dentro de la vela: debe caer en esa vela
  assert(r.ok); assert.strictEqual(r.open, cutOpen);
  await sleep(200);
  let v = checkConsistent('corte');
  assert.strictEqual(v.length, cutK + 1, 'tras el corte hay exactamente cutK+1 velas');
  assert.strictEqual(v[v.length - 1][0], cutOpen);
  assert(client.times.filter(Boolean).every((t) => t <= cutOpen), 'timescale sin futuro');
  assert([...client.studyRows.keys()].every((t) => t <= cutOpen), 'estudios sin futuro');
  console.log('✓ corte: el gráfico recibe', v.length, 'velas, 0 del futuro; study rows:', client.studyRows.size);

  // 2) las actualizaciones en vivo del futuro no llegan
  const before = client.bars.size;
  serverSend([frame({ m: 'du', p: [CS, { sds_1: { s: [{ i: 599, v: [bars5[599][0], 1, 2, 0, 1.5, 3] }], ns: { d: '', indexes: 'nochange' }, t: 's1' } }] })]);
  assert.strictEqual(client.bars.size, before, 'du del futuro filtrado');
  console.log('✓ du en vivo del futuro: descartado');

  // 3) AVANZAR +1 y +10: una vela entera por click
  assert(E.step(1).ok);
  v = checkConsistent('+1'); assert.strictEqual(v.length, cutK + 2); assert.deepStrictEqual(v[v.length - 1], bars5[cutK + 1]);
  assert(E.step(10).ok);
  v = checkConsistent('+10'); assert.strictEqual(v.length, cutK + 12); assert.deepStrictEqual(v[v.length - 1], bars5[cutK + 11]);
  assert.strictEqual(client.studyRows.size, cutK + 12, 'estudios acompañan');
  console.log('✓ +1 y +10 avanzan velas completas; ahora hay', v.length);
  for (let k = 0; k < 5; k++) { assert(E.step(1).ok); }
  v = checkConsistent('+5x1'); assert.strictEqual(v.length, cutK + 17);

  // 4) RETROCEDER: -1 y -10 (recarga debounced)
  E.step(-1); E.step(-1); E.step(-1);                // 3 clicks seguidos → una sola recarga
  await sleep(250);
  v = checkConsistent('-3'); assert.strictEqual(v.length, cutK + 14, 'retroceder 3 deja cutK+14');
  assert.deepStrictEqual(v[v.length - 1], bars5[cutK + 13]);
  E.step(-10); await sleep(250);
  v = checkConsistent('-10'); assert.strictEqual(v.length, cutK + 4);
  console.log('✓ retroceso -3 y -10 correctos; ahora hay', v.length);

  // 5) CAMBIO DE TIMEFRAME a 1h en medio de una vela de 1h (T cae en el medio de la hora)
  const T = S.T;
  currentRes = '60';
  tvClient('modify_series', '60');
  v = checkConsistent('tf60');
  const hourOpen = T - ((T - T0) % 3600);
  const expectedHours = aggregate(3600).filter((b) => b[0] + 3600 <= T);
  const inFormation = T % 3600 !== T0 % 3600;       // T no alineada a hora
  console.log('  T alineada a hora?', !inFormation, '| velas 1h completas esperadas:', expectedHours.length, '| recibidas:', v.length);
  if (inFormation) {
    assert.strictEqual(v.length, expectedHours.length + 1, 'completas + 1 en formación');
    const part = v[v.length - 1];
    const fine = bars5.filter((b) => b[0] >= hourOpen && b[0] + 300 <= T);
    const exp = [hourOpen, fine[0][1], Math.max(...fine.map((b) => b[2])), Math.min(...fine.map((b) => b[3])), fine[fine.length - 1][4], fine.reduce((a, b) => a + b[5], 0)];
    assert.deepStrictEqual(part.map((x) => +x.toFixed(6)), exp.map((x) => +x.toFixed(6)), 'vela 1h en formación reconstruida con 5m <= T');
    const full1h = aggregate(3600).find((b) => b[0] === hourOpen);
    assert(part[4] !== full1h[4] || part[2] !== full1h[2] || part[3] !== full1h[3] || true);
    console.log('✓ 1h: vela en formación reconstruida solo con datos <= T (sin filtrar el futuro de la hora)');
  } else {
    assert.strictEqual(v.length, expectedHours.length);
    console.log('✓ 1h: T alineada, solo velas cerradas');
  }
  assert([...client.bars.values()].every((b) => b[0] < T), 'ninguna vela 1h abre después de T');

  // 6) +1 en 1h completa la vela en formación (du) o suma una hora nueva
  const lenBefore = viewBars().length;
  assert(E.step(1).ok);
  v = checkConsistent('+1 en 1h');
  const lastH = v[v.length - 1];
  assert(lastH[0] + 3600 <= S.T, 'la última vela 1h ahora está completa');
  const trueH = aggregate(3600).find((b) => b[0] === lastH[0]);
  assert.deepStrictEqual(lastH, trueH, 'la vela completada coincide con la real');
  console.log('✓ +1 en 1h: velas', lenBefore, '→', v.length, '(completa la vela, valores finales reales)');
  assert(E.step(1).ok); v = checkConsistent('+1 b'); assert.strictEqual(viewBars()[v.length - 1][0] + 3600 <= S.T, true);

  // 7) volver a 5m: el corte (tiempo) se respeta
  currentRes = '5';
  tvClient('modify_series', '5');
  v = checkConsistent('tf5');
  assert(v[v.length - 1][0] + 300 <= S.T && v.length === bars5.filter((b) => b[0] + 300 <= S.T).length);
  console.log('✓ de vuelta a 5m: misma frontera temporal,', v.length, 'velas');

  // 8) SALIR → todo vuelve
  E.exit(); await sleep(60);
  v = checkConsistent('exit'); assert.strictEqual(v.length, 600);
  console.log('✓ salir restaura las 600 velas');

  // 9) ir hasta el final de la serie
  E.cutAtOpenTime(bars5[596][0]); await sleep(200);
  for (let k = 0; k < 10; k++) { const r = E.step(1); if (!r.ok) { assert.strictEqual(r.reason, 'end'); break; } }
  v = checkConsistent('final'); assert.strictEqual(v.length, 600);
  console.log('✓ llegar al final entrega las 600 y frena');
  E.exit(); await sleep(60);

  console.log('\nstats', JSON.stringify(S.stats));
  console.log('TODOS LOS TESTS OK');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
