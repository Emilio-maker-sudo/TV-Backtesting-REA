/**
 * TV Backtester · protocol.js
 * Framing del WebSocket de TradingView y utilidades de resolución.
 * Cada mensaje del socket contiene uno o más frames:  ~m~<largo>~m~<payload>
 * (largo = unidades UTF-16 del payload; los heartbeats son "~h~<n>").
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});

  /** Devuelve el array de payloads, o null si el string no está enmarcado. */
  function split(raw) {
    const out = [];
    let i = 0;
    while (i < raw.length) {
      if (raw.charCodeAt(i) !== 126 || raw.substr(i, 3) !== '~m~') return null;
      const j = raw.indexOf('~m~', i + 3);
      if (j < 0) return null;
      const len = parseInt(raw.slice(i + 3, j), 10);
      if (!(len >= 0)) return null;
      out.push(raw.substr(j + 3, len));
      i = j + 3 + len;
    }
    return out;
  }

  function join(payloads) {
    let s = '';
    for (const p of payloads) s += '~m~' + p.length + '~m~' + p;
    return s;
  }

  /** Duración nominal de una resolución de TradingView, en segundos. */
  function resSeconds(res) {
    res = String(res == null ? '' : res);
    if (/^\d+$/.test(res)) return parseInt(res, 10) * 60;      // minutos: "1","5","60","240"
    const m = /^(\d*)([A-Z])$/.exec(res);                        // "15S","D","1D","W","3M"
    if (!m) return null;
    const n = m[1] === '' ? 1 : parseInt(m[1], 10);
    switch (m[2]) {
      case 'S': return n;
      case 'D': return n * 86400;
      case 'W': return n * 604800;
      case 'M': return n * 2592000;
      default: return null;
    }
  }

  function resLabel(res) {
    res = String(res == null ? '' : res);
    if (!res) return '—';
    if (/^\d+$/.test(res)) {
      const n = parseInt(res, 10);
      if (n % 60 === 0) return n / 60 + 'h';
      return n + 'm';
    }
    const m = /^(\d*)([A-Z])$/.exec(res);
    if (!m) return res;
    const n = m[1] === '' ? 1 : parseInt(m[1], 10);
    if (m[2] === 'M' && n % 12 === 0) return n / 12 + 'Y';
    return n + (m[2] === 'S' ? 's' : m[2]);
  }

  NS.protocol = { split, join, resSeconds, resLabel };
})();
