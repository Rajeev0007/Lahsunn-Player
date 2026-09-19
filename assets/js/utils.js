/* ============================================================
   Loru Player — utils.js
   DOM helpers, formatting, storage, toasts
   ============================================================ */
window.Loru = window.Loru || {};

(function (L) {
  'use strict';

  /* ---------------- DOM ---------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /**
   * Create an element.
   * el('div.card', { onclick }, [child, 'text'])
   */
  function el(spec, attrs, children) {
    const [tagPart, ...classes] = String(spec).split('.');
    const node = document.createElement(tagPart || 'div');
    if (classes.length) node.className = classes.join(' ');

    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof Node)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className += (node.className ? ' ' : '') + v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    } else if (attrs !== undefined && children === undefined) {
      children = attrs;
    }

    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return node;
    if (Array.isArray(children)) { children.forEach((c) => append(node, c)); return node; }
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return node;
  }

  /** Inline <svg><use href="#i-name"> */
  function icon(name, cls = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ---------------- Formatting ---------------- */
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function formatTotal(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h > 0) return `${h} hr ${m} min`;
    return `${m || 1} min`;
  }

  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(num);
  }

  function pluralize(n, word, plural) {
    return `${n} ${n === 1 ? word : (plural || word + 's')}`;
  }

  function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  /* ---------------- Misc ---------------- */
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function debounce(fn, wait = 250) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function throttle(fn, wait = 100) {
    let last = 0, timer;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) { last = now; fn.apply(this, args); }
      else if (!timer) {
        timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(this, args); }, remaining);
      }
    };
  }

  /** Stable hue (0-359) derived from any string. */
  function hueFor(seed) {
    let h = 0;
    const str = String(seed || 'loru');
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  /** Deterministic gradient from any string — used for artwork fallbacks. */
  function gradientFor(seed) {
    const h = hueFor(seed);
    return `linear-gradient(135deg, hsl(${h} 72% 52%), hsl(${(h + 58) % 360} 76% 44%))`;
  }

  /* ---------------- Storage ---------------- */
  const NS = 'loru:';
  const storage = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(NS + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
    remove(key) { try { localStorage.removeItem(NS + key); } catch (e) {} },
    clearAll() {
      try {
        Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k));
      } catch (e) {}
    },
    session: {
      get(key, fallback = null) {
        try {
          const raw = sessionStorage.getItem(NS + key);
          return raw === null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
      },
      set(key, value) { try { sessionStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) {} },
      remove(key) { try { sessionStorage.removeItem(NS + key); } catch (e) {} },
    },
  };

  /* ---------------- Network ---------------- */
  async function fetchJSON(url, options = {}) {
    const { timeout = 12000, ...rest } = options;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        try { err.payload = await res.json(); } catch (e) {}
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  async function readClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
    } catch (e) {}
    return null;
  }

  /* ---------------- Toasts ---------------- */
  function toast(titleOrOpts, opts = {}) {
    const cfg = typeof titleOrOpts === 'string' ? { title: titleOrOpts, ...opts } : (titleOrOpts || {});
    const { title = '', text = '', kind = 'info', timeout = 4200, action } = cfg;
    const stack = $('#toastStack');
    if (!stack) return () => {};

    const iconName = kind === 'error' ? 'info' : kind === 'success' ? 'check' : 'sparkle';
    const node = el('div.toast', { dataset: { kind }, role: 'status' }, [
      el('span.toast__icon', icon(iconName)),
      el('div.toast__body', [
        el('div.toast__title', { text: title }),
        text ? el('div.toast__text', { text }) : null,
      ]),
      action ? el('button.toast__action', {
        type: 'button',
        onclick: () => { close(); action.onClick && action.onClick(); },
      }, action.label) : null,
    ]);

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 260);
    }

    stack.appendChild(node);
    while (stack.children.length > 4) stack.firstElementChild.remove();
    if (timeout) setTimeout(close, timeout);
    return close;
  }

  /* ---------------- Image helpers ---------------- */
  /** Set artwork with graceful fallback to a generated gradient. */
  function setArt(artEl, src, seed) {
    if (!artEl) return;
    const img = artEl.tagName === 'IMG' ? artEl : artEl.querySelector('img');
    const holder = artEl.tagName === 'IMG' ? artEl.parentElement : artEl;
    if (holder) {
      const ph = holder.querySelector('.art__placeholder');
      if (ph) ph.style.background = gradientFor(seed || src || 'loru');
    }
    if (!img) return;
    if (!src) { img.removeAttribute('src'); return; }
    img.onerror = () => { img.removeAttribute('src'); img.onerror = null; };
    if (img.getAttribute('src') !== src) img.src = src;
  }

  /* ---------------- Pointer-driven slider ---------------- */
  /**
   * Wire a .slider element for pointer + keyboard control.
   * onChange(ratio 0..1, committed: boolean)
   */
  function bindSlider(root, { onChange, onCommit, step = 0.05 } = {}) {
    if (!root) return { set() {} };
    const fill = root.querySelector('.slider__fill');
    const thumb = root.querySelector('.slider__thumb');
    let dragging = false;
    let current = 0;

    function paint(ratio) {
      current = clamp(ratio, 0, 1);
      const pct = (current * 100).toFixed(3) + '%';
      if (fill) fill.style.width = pct;
      if (thumb) thumb.style.left = pct;
      root.setAttribute('aria-valuenow', Math.round(current * 100));
    }

    function ratioFromEvent(e) {
      const rect = root.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      return clamp(rect.width ? x / rect.width : 0, 0, 1);
    }

    function down(e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      root.classList.add('is-dragging');
      root.setPointerCapture && e.pointerId !== undefined && root.setPointerCapture(e.pointerId);
      const r = ratioFromEvent(e);
      paint(r);
      onChange && onChange(r, false);
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      const r = ratioFromEvent(e);
      paint(r);
      onChange && onChange(r, false);
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      root.classList.remove('is-dragging');
      onCommit ? onCommit(current) : onChange && onChange(current, true);
    }

    root.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    root.addEventListener('keydown', (e) => {
      const map = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step };
      if (e.key in map) {
        e.preventDefault();
        const r = clamp(current + map[e.key], 0, 1);
        paint(r);
        onCommit ? onCommit(r) : onChange && onChange(r, true);
      } else if (e.key === 'Home') { paint(0); (onCommit || onChange)(0, true); }
      else if (e.key === 'End') { paint(1); (onCommit || onChange)(1, true); }
    });

    return {
      set(ratio) { if (!dragging) paint(ratio); },
      get() { return current; },
      get dragging() { return dragging; },
    };
  }

  /* ---------------- Export ---------------- */
  Object.assign(L, {
    $, $$, el, append, icon, clear, escapeHtml,
    formatTime, formatTotal, formatCount, pluralize, relativeTime,
    clamp, uid, debounce, throttle, gradientFor, hueFor,
    storage, fetchJSON, copyToClipboard, readClipboard,
    toast, setArt, bindSlider,
  });
})(window.Loru);
