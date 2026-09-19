/* ============================================================
   Loru Player — visualizer.js
   Canvas spectrum. Uses the real WebAudio analyser when the stream
   is CORS-clean; otherwise draws a smooth synthetic waveform so the
   UI never looks broken.
   ============================================================ */
(function (L) {
  'use strict';

  const { store, engine } = L;

  let canvas = null;
  let ctx = null;
  let raf = null;
  let bins = new Float32Array(48);
  let phase = 0;

  function attach(el) {
    canvas = el;
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', L.debounce(resize, 200));
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    if (ctx) ctx.scale(dpr, dpr);
  }

  function accentColors() {
    const css = getComputedStyle(document.documentElement);
    return [
      css.getPropertyValue('--accent-1').trim() || '#8b5cf6',
      css.getPropertyValue('--accent-2').trim() || '#22d3ee',
    ];
  }

  function sampleReal(data) {
    const analyser = engine.analyser;
    if (!analyser) return false;
    try {
      const raw = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(raw);
      let sum = 0;
      const step = Math.max(1, Math.floor(raw.length / data.length));
      for (let i = 0; i < data.length; i++) {
        let acc = 0;
        for (let j = 0; j < step; j++) acc += raw[i * step + j] || 0;
        const v = (acc / step) / 255;
        sum += v;
        data[i] = v;
      }
      return sum > 0.02;
    } catch (e) { return false; }
  }

  function sampleSynthetic(data) {
    phase += 0.045;
    const energy = store.state.playing ? 1 : 0.18;
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      const wave =
        Math.sin(phase * 1.1 + t * 7.5) * 0.36 +
        Math.sin(phase * 0.63 + t * 13.2) * 0.26 +
        Math.sin(phase * 1.9 + t * 3.1) * 0.2;
      const envelope = Math.pow(1 - t, 0.75) * 0.9 + 0.12;
      const target = Math.max(0.04, (0.48 + wave * 0.5) * envelope * energy);
      data[i] += (target - data[i]) * 0.18;
    }
  }

  function draw() {
    raf = requestAnimationFrame(draw);
    if (!ctx || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (!w || !h) return;

    if (!sampleReal(bins)) sampleSynthetic(bins);

    ctx.clearRect(0, 0, w, h);

    const [c1, c2] = accentColors();
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;

    const count = bins.length;
    const gap = Math.max(2, w / count * 0.34);
    const barW = Math.max(2, (w - gap * (count - 1)) / count);

    for (let i = 0; i < count; i++) {
      const v = Math.min(1, bins[i]);
      const barH = Math.max(2, v * h * 0.96);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      const r = Math.min(barW / 2, 3);
      roundRect(ctx, x, y, barW, barH, r);
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
    c.fill();
  }

  function start() {
    if (raf || !canvas) return;
    if (!store.state.settings.showVisualizer) return;
    resize();
    draw();
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (ctx && canvas) {
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
    }
  }

  L.visualizer = { attach, start, stop, resize, get running() { return !!raf; } };
})(window.Loru);
