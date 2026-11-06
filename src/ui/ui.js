/**
 * TV Backtester · ui.js
 *  - Botón "Backtest" en la barra superior de TradingView (clonando el estilo del botón nativo).
 *  - Modo selección: cursor de tijera + velo semitransparente sobre lo que se va a cortar.
 *  - Panel de control: ±1, ±10, play/pausa, velocidad, timeframe actual, salir.
 */
(function () {
  'use strict';
  const NS = (window.__TVBT = window.__TVBT || {});
  const E = () => NS.engine, A = () => NS.tvapi, S = () => NS.state, P = () => NS.protocol;

  const svg = (inner, sw) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const SCISSORS_PATH = '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.2 7.5 20 17M8.2 16.5 20 7"/>';
  const ICON = {
    scissors: svg(SCISSORS_PATH, 1.7),
    play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
    pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>'),
    next: svg('<path d="M6 5l9 7-9 7z" fill="currentColor" stroke="none"/><path d="M18 5v14"/>'),
    prev: svg('<path d="M18 5l-9 7 9 7z" fill="currentColor" stroke="none"/><path d="M6 5v14"/>'),
    shield: svg('<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  };

  const U = {
    selecting: false, playing: false, speed: 1, playTimer: null,
    crosshairTime: null, unsubCross: null, down: null,
    panel: null, veil: null, line: null, badge: null, toasts: null,
    btn: null, floatBtn: null, anchorTries: 0, raf: 0,
  };

  /* ───────────── utilidades ───────────── */
  const el = (tag, attrs, html) => { const n = document.createElement(tag); if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]); if (html != null) n.innerHTML = html; return n; };
  const inUI = (t) => !!(t && t.closest && t.closest('.tvbt-ui, #tvbt-toolbar-btn, #tvbt-float'));

  function isDark() {
    try {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor || '');
      if (m) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
    } catch (e) { /* ignorar */ }
    return document.documentElement.classList.contains('theme-dark');
  }
  function paneBg() {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--tv-color-pane-background').trim();
      if (v) return v;
    } catch (e) { /* ignorar */ }
    return isDark() ? '#131722' : '#ffffff';
  }
  function applyTheme() { const th = isDark() ? 'dark' : 'light'; [U.panel, U.badge, U.line, U.floatBtn, U.toasts].forEach((n) => n && n.setAttribute('data-tvbt-theme', th)); }

  /** Rect del área de velas bajo el puntero (el canvas grande de un panel del gráfico). */
  function paneRectAt(x, y) {
    let best = null, area = 0;
    for (const n of document.elementsFromPoint(x, y)) {
      if (n.tagName !== 'CANVAS') continue;
      const r = n.getBoundingClientRect(), a = r.width * r.height;
      if (a > area) { area = a; best = r; }
    }
    return best && best.width > 150 && best.height > 100 ? best : null;
  }

  function fmt(t, res) {
    if (t == null) return '—';
    const info = E().info();
    const sec = P().resSeconds(res || info.res) || 60;
    const opts = sec >= 86400 ? { day: '2-digit', month: 'short', year: 'numeric' }
      : { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    try { return new Intl.DateTimeFormat('es-AR', Object.assign({}, opts, info.tz ? { timeZone: info.tz } : {})).format(t * 1000); }
    catch (e) { return new Date(t * 1000).toLocaleString(); }
  }

  function toast(text, type, ms) {
    if (!U.toasts) { U.toasts = el('div', { id: 'tvbt-toasts', class: 'tvbt-ui' }); document.body.appendChild(U.toasts); applyTheme(); }
    const t = el('div', { class: 'tvbt-toast' + (type === 'error' ? ' tvbt-error' : '') }); t.textContent = text;
    U.toasts.appendChild(t);
    setTimeout(() => t.remove(), ms || 3500);
  }

  /* ───────────── botón en la barra de TradingView ───────────── */
  function findAnchor() {
    const sels = ['#header-toolbar-replay', '[data-name="replay"]', '#header-toolbar-indicators', '[data-name="open-indicators-dialog"]', '#header-toolbar-intervals'];
    for (const s of sels) { const n = document.querySelector(s); if (n) return n; }
    return null;
  }

  function buildToolbarButton(anchor) {
    const root = anchor.cloneNode(true);
    root.id = 'tvbt-toolbar-btn';
    root.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    root.querySelectorAll('[data-name]').forEach((n) => n.removeAttribute('data-name'));
    root.removeAttribute('data-name');
    const btn = root.matches('button') ? root : (root.querySelector('button') || root);
    const tip = 'Backtest: cortar el gráfico con la tijera';
    btn.setAttribute('aria-label', 'Backtest'); btn.setAttribute('title', tip); btn.setAttribute('data-tooltip', tip);
    btn.removeAttribute('aria-pressed'); btn.removeAttribute('aria-disabled'); btn.removeAttribute('disabled');
    const old = root.querySelector('svg');
    const holder = document.createElement('div'); holder.innerHTML = ICON.scissors;
    const ico = holder.firstElementChild;
    if (old) {
      ico.setAttribute('width', old.getAttribute('width') || '28'); ico.setAttribute('height', old.getAttribute('height') || '28');
      if (old.getAttribute('class')) ico.setAttribute('class', old.getAttribute('class'));
      old.replaceWith(ico);
    } else { ico.setAttribute('width', '24'); ico.setAttribute('height', '24'); btn.prepend(ico); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let tn;
    while ((tn = walker.nextNode())) { if (tn.nodeValue.trim()) { tn.nodeValue = 'Backtest'; break; } }
    root.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onToolbarClick(); }, true);
    return root;
  }

  function ensureButton() {
    if (!document.body) return;
    if (U.btn && document.contains(U.btn)) return;
    const anchor = findAnchor();
    if (anchor) {
      U.btn = buildToolbarButton(anchor);
      anchor.insertAdjacentElement('afterend', U.btn);
      if (U.floatBtn) { U.floatBtn.remove(); U.floatBtn = null; }
      refresh();
      return;
    }
    // sin barra encontrada: botón flotante de respaldo (después de unos intentos)
    if (++U.anchorTries > 12 && !U.floatBtn) {
      U.floatBtn = el('button', { id: 'tvbt-float', class: 'tvbt-ui', title: 'Backtest' }, ICON.scissors + '<span>Backtest</span>');
      U.floatBtn.addEventListener('click', onToolbarClick);
      document.body.appendChild(U.floatBtn); applyTheme(); refresh();
    }
  }

  function onToolbarClick() {
    if (U.selecting) return cancelSelect();
    startSelect();
  }

  /* ───────────── selección con tijera ───────────── */
  function startSelect() {
    if (S().active) E().exit();
    pause();
    U.selecting = true; U.crosshairTime = null; U.down = null;
    document.documentElement.classList.add('tvbt-selecting');
    if (!U.veil) {
      U.veil = el('div', { id: 'tvbt-veil' });
      U.line = el('div', { id: 'tvbt-cutline', class: 'tvbt-ui' });
      U.badge = el('div', { id: 'tvbt-badge', class: 'tvbt-ui' }, ICON.scissors + '<span></span>');
      document.body.append(U.veil, U.line, U.badge);
    }
    U.veil.style.background = paneBg();
    applyTheme();
    U.unsubCross = A().onCrosshair((p) => { if (p && typeof p.time === 'number') U.crosshairTime = p.time; });
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('click', onClickBlock, true);
    window.addEventListener('keydown', onSelectKey, true);
    toast('Elegí la vela donde querés cortar · Esc para cancelar', 'info', 4500);
    refresh();
  }

  function endSelect() {
    U.selecting = false;
    document.documentElement.classList.remove('tvbt-selecting');
    if (U.unsubCross) { U.unsubCross(); U.unsubCross = null; }
    [U.veil, U.line, U.badge].forEach((n) => { if (n) n.style.display = 'none'; });
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onSelectKey, true);
    setTimeout(() => window.removeEventListener('click', onClickBlock, true), 80);   // el click llega después del pointerup
    refresh();
  }
  function cancelSelect() { endSelect(); }

  function onMove(e) {
    if (!U.selecting) return;
    const r = inUI(e.target) ? null : paneRectAt(e.clientX, e.clientY);
    if (!r) { U.veil.style.display = U.line.style.display = U.badge.style.display = 'none'; return; }
    const x = Math.min(Math.max(e.clientX, r.left), r.right);
    Object.assign(U.veil.style, { display: 'block', left: x + 'px', top: r.top + 'px', width: Math.max(0, r.right - x) + 'px', height: r.height + 'px' });
    Object.assign(U.line.style, { display: 'block', left: x + 'px', top: r.top + 'px', height: r.height + 'px' });
    const info = E().info();
    U.badge.querySelector('span').textContent = fmt(U.crosshairTime, info.res) + (info.res ? '  ·  ' + P().resLabel(info.res) : '');
    const bw = 190, left = Math.min(Math.max(r.left + 8, x - bw - 10), r.right - bw - 8);
    Object.assign(U.badge.style, { display: 'flex', left: left + 'px', top: (r.top + 10) + 'px' });
  }

  function onDown(e) {
    if (!U.selecting || inUI(e.target)) { U.down = null; return; }
    const r = paneRectAt(e.clientX, e.clientY);
    U.down = r ? { x: e.clientX, y: e.clientY, rect: r } : null;
  }

  function onUp(e) {
    if (!U.selecting || !U.down) return;
    const d = U.down; U.down = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;        // fue un arrastre (paneo), no un click
    commitSelect(e.clientX, d.rect);
  }

  function onClickBlock(e) {
    if (inUI(e.target)) return;
    if (paneRectAt(e.clientX, e.clientY)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  }

  function onSelectKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelSelect(); } }

  /** Respaldo si el crosshair no entregó la hora: estima por índice de vela dentro del rango visible. */
  function estimateTime(x, rect) {
    const m = E().pickMain(), vr = A().visibleRange();
    if (!m || !vr) return null;
    let from = vr.from, to = vr.to;
    if (from > 1e11) { from /= 1000; to /= 1000; }        // getVisibleRange puede venir en ms
    const times = E().sortedTimes(m.ser).filter((t) => t >= from && t <= to);
    if (!times.length) return null;
    const f = Math.min(0.999, Math.max(0, (x - rect.left) / rect.width));
    return times[Math.floor(f * times.length)];
  }

  function commitSelect(x, rect) {
    if (S().loading) { toast('Cargando datos… probá de nuevo en un segundo.'); return; }
    let t = U.crosshairTime;
    if (t == null) t = estimateTime(x, rect);
    if (t == null) { toast('No pude leer la vela bajo el cursor. Mové el mouse sobre una vela y hacé click.', 'error'); return; }
    if (t > 1e11) t = Math.round(t / 1000);               // crosshair puede venir en ms en lugar de s
    const r = E().cutAtOpenTime(t);
    if (!r.ok) { toast(r.reason, 'error'); return; }
    endSelect();
    toast('Corte en ' + fmt(r.open) + ' · el futuro ya no existe en el gráfico', 'info', 3500);
  }

  /* ───────────── panel de control ───────────── */
  function buildPanel() {
    const p = el('div', { id: 'tvbt-panel', class: 'tvbt-ui' }, `
      <div class="tvbt-grip" title="Mover">⋮⋮</div>
      <div class="tvbt-info">
        <div class="tvbt-row1"><span class="tvbt-tf" data-r="tf">—</span><span class="tvbt-time" data-r="time">—</span><span class="tvbt-spin"></span></div>
        <div class="tvbt-rem" data-r="rem"></div>
      </div>
      <div class="tvbt-sep"></div>
      <button data-act="b10" title="Retroceder 10 velas (Shift + ←)">${ICON.prev}<span>10</span></button>
      <button data-act="b1" title="Retroceder 1 vela (←)">${ICON.prev}<span>1</span></button>
      <button data-act="play" class="tvbt-play" title="Reproducir / pausar (Espacio)">${ICON.play}</button>
      <button data-act="f1" title="Avanzar 1 vela (→)"><span>1</span>${ICON.next}</button>
      <button data-act="f10" title="Avanzar 10 velas (Shift + →)"><span>10</span>${ICON.next}</button>
      <div class="tvbt-sep"></div>
      <select data-r="speed" title="Velocidad de reproducción">
        ${[0.5, 1, 2, 5, 10, 20, 50].map((v) => `<option value="${v}"${v === 1 ? ' selected' : ''}>${v}x</option>`).join('')}
      </select>
      <div class="tvbt-sep"></div>
      <button data-act="strict" title="Modo estricto: oculta los dibujos de indicadores (pueden mostrar el futuro)">${ICON.shield}</button>
      <button data-act="reselect" title="Elegir otra vela">${ICON.scissors}</button>
      <button data-act="close" class="tvbt-close" title="Salir del backtest">${ICON.close}</button>`);

    p.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      switch (b.dataset.act) {
        case 'b10': step(-10); break;
        case 'b1': step(-1); break;
        case 'f1': step(1); break;
        case 'f10': step(10); break;
        case 'play': U.playing ? pause() : play(); break;
        case 'strict': E().setStrict(!S().strict); toast(S().strict ? 'Modo estricto: dibujos de indicadores ocultos' : 'Modo estricto desactivado: los dibujos de indicadores pueden mostrar el futuro'); break;
        case 'reselect': startSelect(); break;
        case 'close': pause(); E().exit(); break;
        default:
      }
    });
    p.querySelector('[data-r="speed"]').addEventListener('change', (e) => { U.speed = parseFloat(e.target.value); e.target.blur(); });

    // arrastrar por el "grip"
    const grip = p.querySelector('.tvbt-grip');
    grip.addEventListener('pointerdown', (e) => {
      const r = p.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      grip.setPointerCapture(e.pointerId);
      const move = (ev) => { p.style.transform = 'none'; p.style.bottom = 'auto'; p.style.left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 60) + 'px'; p.style.top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40) + 'px'; };
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    });
    document.body.appendChild(p);
    return p;
  }

  /* ───────────── reproducción ───────────── */
  function step(n) {
    const r = E().step(n);
    if (!r.ok && r.reason === 'end') toast('Llegaste a la última vela disponible.');
    if (!r.ok && r.reason === 'start') toast('No hay más velas hacia atrás en la historia cargada.');
    if (r.ok && r.atEnd && n > 0) { pause(); }
    return r;
  }
  function play() {
    if (U.playing || !S().active) return;
    U.playing = true; refresh(); tick();
  }
  function pause() { U.playing = false; clearTimeout(U.playTimer); refresh(); }
  function tick() {
    if (!U.playing) return;
    const r = E().step(1);
    if (!r.ok && r.reason === 'loading') { U.playTimer = setTimeout(tick, 120); return; }
    if (!r.ok) { pause(); if (r.reason === 'end') toast('Llegaste a la última vela disponible.'); return; }
    if (r.atEnd) { pause(); toast('Llegaste a la última vela disponible.'); return; }
    U.playTimer = setTimeout(tick, 1000 / U.speed);
  }

  /* ───────────── teclado ───────────── */
  window.addEventListener('keydown', (e) => {
    if (!S().active || U.selecting) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight': step(e.shiftKey ? 10 : 1); break;
      case 'ArrowLeft': step(e.shiftKey ? -10 : -1); break;
      case ' ': U.playing ? pause() : play(); break;
      default: return;
    }
    e.preventDefault(); e.stopPropagation();
  }, true);

  /* ───────────── refresco de UI ───────────── */
  function refresh() {
    if (U.raf) return;
    U.raf = requestAnimationFrame(() => { U.raf = 0; render(); });
  }

  function render() {
    if (!document.body) return;
    const s = S(), info = E().info();
    const on = s.active || U.selecting;
    [U.btn, U.floatBtn].forEach((b) => b && b.classList.toggle('tvbt-on', on));
    if (!s.active) U.playing && pause();

    if (s.active) {
      if (!U.panel) { U.panel = buildPanel(); applyTheme(); }
      U.panel.classList.add('tvbt-show');
      U.panel.classList.toggle('tvbt-busy', info.loading);
      const res = info.res || A().resolution();
      U.panel.querySelector('[data-r="tf"]').textContent = P().resLabel(res);
      U.panel.querySelector('[data-r="time"]').textContent = fmt(info.lastOpen, res);
      U.panel.querySelector('[data-r="rem"]').textContent = info.remaining ? info.remaining + ' velas por delante' : 'última vela disponible';
      U.panel.querySelector('[data-act="play"]').innerHTML = U.playing ? ICON.pause : ICON.play;
      U.panel.querySelectorAll('[data-act="b10"],[data-act="b1"],[data-act="f1"],[data-act="f10"]').forEach((b) => { b.disabled = false; });
      U.panel.querySelector('[data-act="f1"]').disabled = U.panel.querySelector('[data-act="f10"]').disabled = !info.remaining;
      U.panel.querySelector('[data-act="strict"]').classList.toggle('tvbt-on', s.strict);
    } else if (U.panel) {
      U.panel.classList.remove('tvbt-show');
    }
  }

  /* ───────────── arranque ───────────── */
  function init() {
    const css = "html.tvbt-selecting, html.tvbt-selecting * { cursor: url(\"data:image/svg+xml;utf8," +
      encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
        "<g stroke='#000' stroke-width='4.4'>" + SCISSORS_PATH.replace(/"/g, "'") + "</g><g stroke='#fff' stroke-width='2'>" + SCISSORS_PATH.replace(/"/g, "'") + "</g></svg>") +
      "\") 14 14, crosshair !important; }\nhtml.tvbt-selecting .tvbt-ui, html.tvbt-selecting .tvbt-ui *, html.tvbt-selecting #tvbt-toolbar-btn, html.tvbt-selecting #tvbt-toolbar-btn * { cursor: pointer !important; }";
    const st = el('style', { id: 'tvbt-cursor-style' }); st.textContent = css; document.head.appendChild(st);

    E().on('state', refresh);
    E().on('toast', (m) => toast(m.text, m.type, 6000));
    setInterval(() => { ensureButton(); applyTheme(); }, 1000);
    ensureButton();
  }

  NS.ui = { init, toast, startSelect, cancelSelect, play, pause, step, refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
