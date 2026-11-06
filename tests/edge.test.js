global.window = global;
const assert = require('assert');
class FakeWS extends EventTarget { constructor(u){super();this.sent=[];} send(d){this.sent.push(d);} }
global.WebSocket = FakeWS;
require('../src/core/protocol.js'); require('../src/core/engine.js'); require('../src/core/tvapi.js'); require('../src/core/hook.js');
const NS = window.__TVBT, P = NS.protocol, E = NS.engine, S = NS.state;
NS.tvapi.reload = async () => 'x';
const CS='cs_e';
const ws = new WebSocket('wss://x');
let received=[]; ws.addEventListener('message', ev=>{ received.push(ev.data); });
const dispatch = (frames)=>{ const ev=new MessageEvent('message',{data:P.join(frames)}); ws.dispatchEvent(ev); return ev; };
const J=JSON.stringify;
ws.send(P.join([J({m:'chart_create_session',p:[CS,'']}),J({m:'resolve_symbol',p:[CS,'sds_sym_1','={"symbol":"A"}']}),J({m:'create_series',p:[CS,'sds_1','s1','sds_sym_1','5',300,'']})]));
const T0=1700000000-(1700000000%300);
const mk=(a,b)=>{const s=[];for(let k=a;k<b;k++)s.push({i:k-a,v:[T0+k*300,1+k,2+k,0+k,1.5+k,1]});return s;};

// carga inicial (100..300) + heartbeat + du de estudio con dibujos, TODO en un mismo mensaje con varios frames
dispatch(['~h~1', J({m:'timescale_update',p:[CS,{sds_1:{s:mk(100,300),ns:{d:'',indexes:[]},t:'s1'}},{index:0,zoffset:0,changes:mk(100,300).map(b=>b.v[0]),marks:[],index_diff:[]}]}),
  J({m:'du',p:[CS,{st1:{st:mk(100,300).map(b=>({i:b.i,v:[b.v[0],5]})),ns:{d:'{"graphicsCmds":{}}',indexes:'nochange'},t:'s1'}}]}), J({m:'series_completed',p:[CS,'sds_1','streaming','s1',{}]})]);
assert.strictEqual(received.length,1);

// Activamos el backtest manualmente (corte en la vela 200 → close = open de la 201).
// Se evita cutAtOpenTime() porque dispara la redelivery sintética; acá probamos el FILTRO en vivo.
S.active=true; S.sessionId=CS; S.T=T0+201*300;
// simulamos la recarga: outgoing modify_series y reenvío del servidor
ws.send(P.join([J({m:'modify_series',p:[CS,'sds_1','s2','sds_sym_1','5','']})]));
received=[];
const ev=dispatch(['~h~2', J({m:'timescale_update',p:[CS,{sds_1:{s:mk(100,300),ns:{d:'',indexes:[]},t:'s2'}},{index:0,zoffset:0,changes:mk(100,300).map(b=>b.v[0]),marks:[[40,T0+250*300,150]],index_diff:[]}]}),
  J({m:'du',p:[CS,{st1:{st:mk(100,300).map(b=>({i:b.i,v:[b.v[0],5]})),ns:{d:'{"graphicsCmds":{}}',indexes:'nochange'},t:'s2'}}]}), J({m:'series_completed',p:[CS,'sds_1','streaming','s2',{}]})]);
const frames=P.split(received[0]);
assert.strictEqual(frames[0],'~h~2','heartbeat intacto');
const ts=JSON.parse(frames[1]); assert.strictEqual(ts.p[1].sds_1.s.length,101); assert.strictEqual(ts.p[2].changes.length,101); assert.strictEqual(ts.p[2].marks.length,0,'marks del futuro eliminados');
const du=JSON.parse(frames[2]); assert.strictEqual(du.p[1].st1.st.length,101); assert.strictEqual(du.p[1].st1.ns.d,'','modo estricto: dibujos vaciados');
assert.strictEqual(JSON.parse(frames[3]).m,'series_completed');
// largo de frame correcto
let i=0; for(const f of frames){ assert(received[0].includes('~m~'+f.length+'~m~'+f)); }
console.log('✓ multi-frame: heartbeat intacto, longitudes de frame recalculadas, marks/changes/estudios sin futuro, dibujos vaciados');

// historia hacia la izquierda (request_more_data): barras viejas pasan completas
received=[];
dispatch([J({m:'timescale_update',p:[CS,{sds_1:{s:[{i:-50,v:[T0+50*300,1,2,0,1,1]},{i:-49,v:[T0+51*300,1,2,0,1,1]}],ns:{d:'',indexes:[]},t:'s2'}},{index:-50,zoffset:0,changes:[T0+50*300,T0+51*300],marks:[],index_diff:[]}]})]);
assert.strictEqual(JSON.parse(P.split(received[0])[0]).p[1].sds_1.s.length,2);
console.log('✓ historia previa (scroll a la izquierda) pasa completa');

// un du con SOLO futuro se descarta por completo (el cliente no recibe nada)
received=[];
const ev2=dispatch([J({m:'du',p:[CS,{sds_1:{s:[{i:199,v:[T0+299*300,1,2,0,1,1]}],ns:{d:'',indexes:'nochange'},t:'s2'}}]})]);
assert.strictEqual(received.length,0,'ningún handler de TV se ejecuta'); 
console.log('✓ du solo-futuro: el gráfico no se entera');

// mensajes que no son datos pasan intactos
received=[]; dispatch([J({m:'qsd',p:['qs_x',{n:'A',s:'ok',v:{lp:1}}]})]); assert.strictEqual(received.length,1);
// JSON basura no rompe
received=[]; const bad='~m~5~m~{bad}'; ws.dispatchEvent(new MessageEvent('message',{data:bad})); assert.strictEqual(received[0],bad);
console.log('✓ frames ajenos y JSON inválido pasan sin tocar');

// mensaje no enmarcado
received=[]; ws.dispatchEvent(new MessageEvent('message',{data:'timescale_update raro'})); assert.strictEqual(received.length,1);
console.log('EDGE TESTS OK'); process.exit(0);
