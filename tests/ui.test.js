const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = require('path').join(__dirname, '..') + '/';
const html = `<!doctype html><html class="theme-dark"><head></head><body style="background-color: rgb(19,23,34)">
<div id="header-toolbar"><div class="grp"><div id="header-toolbar-replay" class="wrapper-q"><button class="button-r isInteractive" data-name="replay" aria-label="Replay" aria-pressed="false"><span class="icon-s"><svg width="28" height="28" viewBox="0 0 28 28" class="icon-t"><path d="M1 1h2"/></svg></span><span class="text-u">Replay</span></button></div></div></div>
<div id="pane"><canvas id="c1"></canvas></div></body></html>`;
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://www.tradingview.com/chart/abc/' });
const w = dom.window;
class FakeWS extends w.EventTarget { constructor(u) { super(); } send(d) {} }
w.WebSocket = FakeWS;
// geometría del gráfico
const rect = { left: 40, top: 100, right: 1040, bottom: 700, width: 1000, height: 600 };
w.HTMLCanvasElement.prototype.getBoundingClientRect = function () { return rect; };
w.document.elementsFromPoint = (x, y) => (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? [w.document.getElementById('c1')] : []);
// TradingViewApi falso
let crossCb = null, resetCalls = 0;
w.TradingViewApi = { activeChart: () => ({
  resolution: () => '5', symbol: () => 'TEST:X', getVisibleRange: () => ({ from: 0, to: 1e10 }),
  crossHairMoved: () => ({ subscribe: (o, f) => { crossCb = f; }, unsubscribe: () => { crossCb = null; } }),
  resetData: () => { resetCalls++; netReload(); },
}) };
for (const f of ['src/core/protocol.js', 'src/core/engine.js', 'src/core/tvapi.js', 'src/core/hook.js', 'src/ui/ui.js', 'src/main.js']) w.eval(fs.readFileSync(root + f, 'utf8'));
const css = fs.readFileSync(root + 'src/ui/ui.css', 'utf8'); const st = w.document.createElement('style'); st.textContent = css; w.document.head.appendChild(st);

const NS = w.__TVBT, P = NS.protocol, S = NS.state, E = NS.engine;
const J = JSON.stringify, CS = 'cs_u';
const ws = new w.WebSocket('wss://x');
const client = { bars: new Map() };
ws.addEventListener('message', (ev) => { for (const f of P.split(ev.data) || []) { if (f[0] !== '{') continue; const o = JSON.parse(f); if (o.m === 'timescale_update' || o.m === 'du') for (const d of Object.values(o.p[1])) if (d.s) for (const b of d.s) client.bars.set(b.i, b.v); } });
const T0 = 1700000000 - (1700000000 % 300);
const bars = Array.from({ length: 400 }, (_, k) => [T0 + k * 300, 1 + k, 2 + k, k, 1.5 + k, 1]);
function netReload() { client.bars = new Map(); ws.send(P.join([J({ m: 'modify_series', p: [CS, 'sds_1', 's' + Math.random(), 'sds_sym_1', '5', ''] })]));
  const ev = new w.MessageEvent('message', { data: P.join([J({ m: 'timescale_update', p: [CS, { sds_1: { s: bars.map((v, i) => ({ i, v })), ns: { d: '', indexes: [] }, t: 's2' } }, { index: 0, zoffset: 0, changes: bars.map((b) => b[0]), marks: [], index_diff: [] }] }), J({ m: 'series_completed', p: [CS, 'sds_1', 'streaming', 's2', {}] })]) });
  ws.dispatchEvent(ev); }
ws.send(P.join([J({ m: 'chart_create_session', p: [CS, ''] }), J({ m: 'resolve_symbol', p: [CS, 'sds_sym_1', '={"symbol":"TEST:X"}'] }), J({ m: 'create_series', p: [CS, 'sds_1', 's1', 'sds_sym_1', '5', 300, ''] })]));
ws.dispatchEvent(new w.MessageEvent('message', { data: P.join([J({ m: 'timescale_update', p: [CS, { sds_1: { s: bars.map((v, i) => ({ i, v })), ns: { d: '', indexes: [] }, t: 's1' } }, { index: 0, zoffset: 0, changes: bars.map((b) => b[0]), marks: [], index_diff: [] }] }), J({ m: 'series_completed', p: [CS, 'sds_1', 'streaming', 's1', {}] })]) }));
assert.strictEqual(client.bars.size, 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(50);
  // 1) botón nativo clonado en la barra
  const btn = w.document.getElementById('tvbt-toolbar-btn');
  assert(btn, 'botón insertado'); assert.strictEqual(btn.previousElementSibling.id, 'header-toolbar-replay', 'queda justo después de Replay');
  assert(btn.textContent.includes('Backtest') && !btn.textContent.includes('Replay'));
  assert(btn.querySelector('svg circle'), 'ícono de tijera');
  assert(!w.document.querySelectorAll('#header-toolbar-replay').length || w.document.querySelectorAll('#header-toolbar-replay').length === 1, 'sin ids duplicados');
  assert(btn.querySelector('button').getAttribute('aria-label') === 'Backtest');
  console.log('✓ botón insertado en la barra superior con el estilo (clases) del botón nativo');

  // 2) modo selección
  btn.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert(w.document.documentElement.classList.contains('tvbt-selecting'), 'cursor tijera activo');
  assert(crossCb, 'suscripto al crosshair');
  const pick = bars[250][0];
  const move = (x) => { crossCb({ time: pick }); w.dispatchEvent(Object.assign(new w.MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 300 }))); };
  move(500);
  const veil = w.document.getElementById('tvbt-veil');
  assert.strictEqual(veil.style.display, 'block'); assert.strictEqual(veil.style.left, '500px'); assert.strictEqual(veil.style.width, '540px', 'velo desde el cursor hasta el borde derecho del panel');
  assert.strictEqual(veil.style.top, '100px'); assert.strictEqual(veil.style.height, '600px');
  console.log('✓ vista previa: velo semitransparente desde el cursor hasta el final del panel (', veil.style.left, '→ ancho', veil.style.width, ')');
  move(520); assert.strictEqual(veil.style.left, '520px', 'el velo sigue al mouse');

  // 3) click en la vela
  const target = w.document.getElementById('c1');
  w.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, clientX: 520, clientY: 300 }));
  target.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, clientX: 520, clientY: 300 }));
  target.dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, clientX: 520, clientY: 300 }));
  await sleep(120);
  assert(S.active, 'backtest activo'); assert(resetCalls >= 1, 'se pidió recarga a TV');
  assert.strictEqual(client.bars.size, 251, 'el gráfico quedó con 251 velas (hasta la elegida)');
  assert(!w.document.documentElement.classList.contains('tvbt-selecting'));
  const panel = w.document.getElementById('tvbt-panel');
  await sleep(40);
  assert(panel.classList.contains('tvbt-show'), 'panel visible');
  assert.strictEqual(panel.querySelector('[data-r="tf"]').textContent, '5m', 'timeframe real del gráfico');
  console.log('✓ click: corte en la vela elegida →', client.bars.size, 'velas; panel muestra TF =', panel.querySelector('[data-r="tf"]').textContent, '| hora:', panel.querySelector('[data-r="time"]').textContent, '|', panel.querySelector('[data-r="rem"]').textContent);

  // 4) botones del panel
  const click = (act) => panel.querySelector(`[data-act="${act}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  click('f1'); assert.strictEqual(client.bars.size, 252);
  click('f10'); assert.strictEqual(client.bars.size, 262);
  click('b1'); click('b1'); await sleep(250); assert.strictEqual(client.bars.size, 260);
  click('b10'); await sleep(250); assert.strictEqual(client.bars.size, 250);
  console.log('✓ botones: +1, +10, -1, -1, -10 → velas exactas:', client.bars.size);

  // 5) teclado + autoplay
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.strictEqual(client.bars.size, 251, 'flecha derecha = +1');
  panel.querySelector('[data-r="speed"]').value = '20'; panel.querySelector('[data-r="speed"]').dispatchEvent(new w.Event('change'));
  click('play'); await sleep(430); click('play');
  const grown = client.bars.size - 251; assert(grown >= 5 && grown <= 12, 'autoplay a 20x avanzó ' + grown);
  console.log('✓ autoplay 20x: +' + grown + ' velas en ~430ms, una por tick');

  // 6) salir
  const lenBefore = client.bars.size; click('close'); await sleep(120);
  assert(!S.active); assert.strictEqual(client.bars.size, 400); assert(!panel.classList.contains('tvbt-show'));
  console.log('✓ salir: vuelven las 400 velas y se oculta el panel');
  console.log('UI TESTS OK'); process.exit(0);
})().catch((e) => { console.error('FALLÓ', e); process.exit(1); });
