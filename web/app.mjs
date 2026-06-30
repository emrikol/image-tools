// image-tools web demo — fast-mode conversion entirely in the browser.
// Reuses the project's portable logic (lib/) + WASM encoders (jSquash). No upload.

import { interpolate } from '../lib/curves.mjs';
import { jpegQualityFromBuffer } from '../lib/jpeg-quality.mjs';

// Encoding runs in a Web Worker so the WASM codecs never block the UI thread (no freeze).
const worker = new Worker(new URL('./encode-worker.mjs', import.meta.url), { type: 'module' });
let rpcId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, ok, buf, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  ok ? p.resolve(buf) : p.reject(new Error(error || 'encode failed'));
};
worker.onerror = () => {
  for (const p of pending.values()) p.reject(new Error('worker error'));
  pending.clear();
};
const rpc = (msg, transfer = []) =>
  new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
// Hand the decoded pixels to the worker once per image (copy, so the main thread keeps its own).
function workerLoad(imageData) {
  const data = new Uint8ClampedArray(imageData.data);
  return rpc({ type: 'load', width: imageData.width, height: imageData.height, data }, [
    data.buffer,
  ]);
}
const workerEncode = (format, quality, speed) => rpc({ type: 'encode', format, quality, speed });

const MAX_EDGE = 2000; // cap working dimension for a snappy demo
const AVIF_SPEED = 6; // WASM-friendly (CLI uses --speed 0 for slightly smaller files)

const $ = (id) => document.getElementById(id);
const fmtKB = (b) => (b / 1024).toFixed(1) + ' KB';
const pct = (a, src) => ((src - a) / src) * 100;

let curves = null;
let state = null; // { name, imageData, srcBytes, jpegQ, type, results }

// ─── boot ──────────────────────────────────────────────────────────────────
const status = $('status');
function setStatus(msg, isErr = false, busy = false) {
  status.hidden = !msg;
  status.classList.toggle('err', isErr);
  status.textContent = msg || '';
  if (msg && busy)
    status.insertAdjacentHTML('afterbegin', '<span class="spin" aria-hidden="true"></span>');
}

fetch('./curves.json')
  .then((r) => r.json())
  .then((c) => {
    curves = c;
  })
  .catch(() => setStatus('Could not load calibration curves.', true));

// ─── input wiring ────────────────────────────────────────────────────────────
const drop = $('drop'),
  fileInput = $('file');
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});
['dragenter', 'dragover'].forEach((e) =>
  drop.addEventListener(e, (ev) => {
    ev.preventDefault();
    drop.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((e) =>
  drop.addEventListener(e, (ev) => {
    ev.preventDefault();
    drop.classList.remove('drag');
  }),
);
drop.addEventListener('drop', (ev) => {
  const f = ev.dataTransfer.files[0];
  if (f) handleFile(f);
});
drop.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') fileInput.click();
});
$('again').addEventListener('click', reset);

// "Try a sample image" — load a bundled license-clean JPEG and run it through the pipeline.
$('sample').addEventListener('click', async () => {
  try {
    setStatus('Loading sample…');
    const blob = await (await fetch('./sample.jpg')).blob();
    handleFile(new File([blob], 'sample.jpg', { type: 'image/jpeg' }));
  } catch {
    setStatus('Could not load the sample image.', true);
  }
});

document.querySelectorAll('.seg-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (state && btn.dataset.type !== state.type) {
      setType(btn.dataset.type);
      encodeAndRender();
    }
  }),
);

function reset() {
  if (state?.srcBlobUrl) URL.revokeObjectURL(state.srcBlobUrl);
  for (const k of ['webp', 'avif'])
    if (dlUrls[k]) {
      URL.revokeObjectURL(dlUrls[k]);
      delete dlUrls[k];
    }
  state = null;
  $('result').hidden = true;
  drop.hidden = false;
  $('sample').hidden = false;
  $('charts').hidden = true;
  setStatus('');
  fileInput.value = '';
}

// ─── pipeline ─────────────────────────────────────────────────────────────────
async function handleFile(file) {
  try {
    if (!curves) {
      setStatus('Still loading curves — try again in a second.', true);
      return;
    }
    if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) {
      setStatus('Please choose a JPEG (.jpg/.jpeg) — that’s what this converts.', true);
      return;
    }
    setStatus('Decoding…', false, true);
    const srcBytes = new Uint8Array(await file.arrayBuffer());
    const jpegQ = jpegQualityFromBuffer(srcBytes);
    if (jpegQ === null) {
      setStatus('That file isn’t a readable JPEG.', true);
      return;
    }

    // Decode (honoring EXIF orientation) → ImageData, capped for snappiness.
    const bmp = await createImageBitmap(new Blob([srcBytes], { type: 'image/jpeg' }), {
      imageOrientation: 'from-image',
    });
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale),
      h = Math.round(bmp.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const type = classify(imageData);
    if (state?.srcBlobUrl) URL.revokeObjectURL(state.srcBlobUrl); // free the previous run's URL
    state = {
      name: file.name,
      imageData,
      srcBytes,
      srcBlobUrl: URL.createObjectURL(file),
      fullW: bmp.width,
      fullH: bmp.height,
      w,
      h,
      jpegQ,
      type,
      results: {},
      sweep: null,
    };

    drop.hidden = true;
    $('sample').hidden = true;
    $('result').hidden = false;
    $('m-name').textContent = file.name;
    $('m-dims').textContent =
      `${bmp.width}×${bmp.height}${scale < 1 ? ` · preview ${w}×${h}` : ''}`;
    $('m-q').textContent = `JPEG q${jpegQ}`;
    setType(type);
    await workerLoad(imageData); // hand pixels to the worker once
    await encodeAndRender();
  } catch (e) {
    console.error(e);
    setStatus('Something went wrong decoding that image.', true);
  }
}

function setType(type) {
  state.type = type;
  document
    .querySelectorAll('.seg-btn')
    .forEach((b) => b.classList.toggle('on', b.dataset.type === type));
}

async function encodeAndRender() {
  setStatus('Encoding WebP + AVIF…', false, true);
  const { jpegQ, type } = state;
  const webpQ = clamp(interpolate(curves[type], jpegQ, 'webp_q'));
  const avifQ = clamp(interpolate(curves[type], jpegQ, 'avif_q'));
  state.webpQ = webpQ;
  state.avifQ = avifQ;

  // reset card states (spinner while the worker encodes)
  for (const k of ['webp', 'avif']) {
    $(`s-${k}`).innerHTML = '<span class="spin"></span>';
    $(`d-${k}`).textContent = 'encoding…';
    $(`dl-${k}`).hidden = true;
  }
  $('s-jpeg').textContent = fmtKB(state.srcBytes.length);
  $('compare').hidden = true;
  $('winner').hidden = true;
  $('again').hidden = true;

  const [webp, avif] = await Promise.all([
    workerEncode('webp', webpQ)
      .then((buf) => ({ buf, q: `q${webpQ}` }))
      .catch(err),
    workerEncode('avif', avifQ, AVIF_SPEED)
      .then((buf) => ({ buf, q: `q${avifQ}` }))
      .catch(err),
  ]);
  setStatus('');
  state.results = { webp, avif };
  renderCard('webp', webp);
  renderCard('avif', avif);
  renderWinner();
  $('again').hidden = false;
  buildCharts(); // fire-and-forget; renders graph 1 instantly, graph 2 after a quality sweep
}
function err(e) {
  console.error(e);
  return null;
}

const dlUrls = {}; // fmt -> object URL, revoked when replaced
function stem(name) {
  return name.replace(/\.[^.]+$/, '');
}

function renderCard(fmt, res) {
  const sizeEl = $(`s-${fmt}`),
    subEl = $(`d-${fmt}`),
    dl = $(`dl-${fmt}`);
  if (!res || !res.buf) {
    sizeEl.textContent = 'failed';
    subEl.textContent = 'encoder error';
    if (dl) dl.hidden = true;
    return;
  }
  const bytes = res.buf.byteLength,
    p = pct(bytes, state.srcBytes.length);
  sizeEl.textContent = fmtKB(bytes);
  const cls = p >= 0 ? 'down' : 'up';
  subEl.innerHTML = `${res.q} · <span class="${cls}">${p >= 0 ? '−' : '+'}${Math.abs(p).toFixed(0)}%</span> vs JPEG`;
  if (dl) {
    if (dlUrls[fmt]) URL.revokeObjectURL(dlUrls[fmt]);
    dlUrls[fmt] = URL.createObjectURL(new Blob([res.buf], { type: `image/${fmt}` }));
    dl.href = dlUrls[fmt];
    dl.download = `${stem(state.name)}.${fmt}`;
    dl.hidden = false;
  }
}

function renderWinner() {
  const { webp, avif } = state.results;
  const cands = [
    ['webp', webp],
    ['avif', avif],
  ].filter(([, r]) => r && r.buf);
  document.querySelectorAll('.card').forEach((c) => c.classList.remove('winner-card'));
  document.querySelectorAll('.badge.win').forEach((b) => (b.hidden = true));
  const winEl = $('winner');
  winEl.hidden = false;
  winEl.classList.remove('kept');

  if (!cands.length) {
    winEl.textContent = 'Encoding failed in this browser.';
    return;
  }
  cands.sort((a, b) => a[1].buf.byteLength - b[1].buf.byteLength);
  const [fmt, res] = cands[0];
  const src = state.srcBytes.length;

  if (res.buf.byteLength >= src) {
    winEl.classList.add('kept');
    winEl.innerHTML = `The JPEG is already smaller — <b>keep the original</b>. (No bloat: a real converter wouldn’t replace it.)`;
    return;
  }
  $(`card-${fmt}`).classList.add('winner-card');
  $(`card-${fmt}`).querySelector('.badge.win').hidden = false;
  winEl.innerHTML = `<b>${fmt.toUpperCase()} wins</b> — ${fmtKB(res.buf.byteLength)}, ${pct(res.buf.byteLength, src).toFixed(0)}% smaller than the JPEG at matched quality.`;
  showCompare(fmt, res.buf);
}

// ─── before/after comparison ──────────────────────────────────────────────────
let cmpUrl = null;
function showCompare(fmt, buf) {
  const fig = $('compare');
  fig.hidden = false;
  if (cmpUrl) URL.revokeObjectURL(cmpUrl);
  cmpUrl = URL.createObjectURL(new Blob([buf], { type: `image/${fmt}` }));
  $('cmp-after').src = cmpUrl;
  $('cmp-before').src = state.srcBlobUrl;
  $('cmp-tag-r').textContent = fmt.toUpperCase();
  $('cmp-after').onload = () => {
    sizeCompare();
    setSlider(50);
  };
}
function sizeCompare() {
  const stage = $('compare').querySelector('.cmp-stage');
  $('cmp-before').style.width = stage.clientWidth + 'px';
}
function setSlider(p) {
  p = Math.max(0, Math.min(100, p));
  $('cmp-clip').style.width = p + '%';
  $('cmp-handle').style.left = p + '%';
  $('cmp-handle').setAttribute('aria-valuenow', Math.round(p));
}
(function wireSlider() {
  const stage = () => $('compare').querySelector('.cmp-stage');
  let dragging = false;
  const move = (clientX) => {
    const r = stage().getBoundingClientRect();
    setSlider(((clientX - r.left) / r.width) * 100);
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cmp-stage')) {
      dragging = true;
      move(e.clientX);
    }
  });
  document.addEventListener('pointermove', (e) => {
    if (dragging) move(e.clientX);
  });
  document.addEventListener('pointerup', () => {
    dragging = false;
  });
  $('cmp-handle').addEventListener('keydown', (e) => {
    const cur = parseFloat($('cmp-clip').style.width) || 50;
    if (e.key === 'ArrowLeft') setSlider(cur - 4);
    if (e.key === 'ArrowRight') setSlider(cur + 4);
  });
  window.addEventListener('resize', () => {
    if (!$('compare').hidden) sizeCompare();
  });
})();

// ─── per-image charts (hand-rolled inline SVG — no chart library) ───────────────
const C_WEBP = '#38bdf8',
  C_AVIF = '#2dd4bf',
  C_JPEG = '#f59e0b',
  C_REF = '#64748b',
  C_GRID = '#2a3340',
  C_TXT = '#9aa7b4';

function lineChart({
  xMin,
  xMax,
  yMin,
  yMax,
  series = [],
  hlines = [],
  markers = [],
  xLabel,
  yLabel,
  yFmt = (v) => Math.round(v),
  legend = [],
  aria = '',
}) {
  const W = 560,
    H = 300,
    P = { l: 54, r: 16, t: 28, b: 38 };
  const x0 = P.l,
    y0 = H - P.b,
    x1 = W - P.r,
    y1 = P.t;
  const X = (v) => x0 + ((v - xMin) / (xMax - xMin)) * (x1 - x0);
  const Y = (v) => y0 - ((v - yMin) / (yMax - yMin)) * (y0 - y1);
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria || xLabel)}">`;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4,
      y = Y(v);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${C_GRID}"/>`;
    s += `<text x="${x0 - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${C_TXT}" font-size="11">${esc(yFmt(v))}</text>`;
  }
  for (let i = 0; i <= 5; i++) {
    const v = xMin + ((xMax - xMin) * i) / 5,
      x = X(v);
    s += `<text x="${x.toFixed(1)}" y="${y0 + 18}" text-anchor="middle" fill="${C_TXT}" font-size="11">${Math.round(v)}</text>`;
  }
  s += `<text x="${((x0 + x1) / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" fill="${C_TXT}" font-size="11">${esc(xLabel)}</text>`;
  s += `<text x="14" y="${((y0 + y1) / 2).toFixed(0)}" text-anchor="middle" fill="${C_TXT}" font-size="11" transform="rotate(-90 14 ${((y0 + y1) / 2).toFixed(0)})">${esc(yLabel)}</text>`;
  for (const h of hlines) {
    const y = Y(h.y);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${h.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    if (h.label)
      s += `<text x="${x1}" y="${(y - 5).toFixed(1)}" text-anchor="end" fill="${h.color}" font-size="11">${esc(h.label)}</text>`;
  }
  for (const ser of series) {
    const pts = ser.points
      .filter((p) => p[1] != null && isFinite(p[1]))
      .map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`)
      .join(' ');
    if (pts)
      s += `<polyline points="${pts}" fill="none" stroke="${ser.color}" stroke-width="${ser.dashed ? 1.4 : 2.2}"${ser.dashed ? ' stroke-dasharray="5 5"' : ''}/>`;
  }
  for (const m of markers) {
    const x = X(m.x),
      y = Y(m.y);
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${m.color}" stroke="#0d1117" stroke-width="1.5"/>`;
    if (m.label)
      s += `<text x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}" fill="${m.color}" font-size="11" font-weight="600">${esc(m.label)}</text>`;
  }
  let lx = x0 + 2;
  for (const l of legend) {
    s += `<rect x="${lx}" y="${y1 - 18}" width="11" height="11" rx="2" fill="${l.color}"/>`;
    s += `<text x="${lx + 15}" y="${y1 - 9}" fill="#e6edf3" font-size="11">${esc(l.label)}</text>`;
    lx += 15 + l.label.length * 6.4 + 14;
  }
  return s + `</svg>`;
}

function buildCharts() {
  $('charts').hidden = false;
  buildCurveChart();
  buildSizeChart();
}

// Graph 1 — calibration curve for the detected type, with this image's point marked.
function buildCurveChart() {
  const curve = curves[state.type] || [];
  const { jpegQ, webpQ, avifQ, type } = state;
  $('chart-curve-cap').textContent = `Where your image lands on the ${type} calibration curve`;
  $('chart-curve').innerHTML = lineChart({
    xMin: 0,
    xMax: 100,
    yMin: 0,
    yMax: 100,
    xLabel: 'source JPEG quality',
    yLabel: 'matched WebP / AVIF quality',
    aria: `Calibration curve for ${type}; your image is JPEG quality ${jpegQ}`,
    series: [
      {
        points: [
          [0, 0],
          [100, 100],
        ],
        color: C_REF,
        dashed: true,
      }, // 1:1 reference
      { points: curve.map((p) => [p.jpeg_q, p.webp_q]), color: C_WEBP },
      { points: curve.map((p) => [p.jpeg_q, p.avif_q]), color: C_AVIF },
      {
        points: [
          [jpegQ, 0],
          [jpegQ, 100],
        ],
        color: C_REF,
        dashed: true,
      }, // your JPEG quality
    ],
    markers: [
      { x: jpegQ, y: webpQ, color: C_WEBP, label: `WebP q${webpQ}` },
      { x: jpegQ, y: avifQ, color: C_AVIF, label: `AVIF q${avifQ}` },
    ],
    legend: [
      { color: C_WEBP, label: 'WebP' },
      { color: C_AVIF, label: 'AVIF' },
      { color: C_REF, label: '1:1' },
    ],
  });
}

// Graph 2 — encode this image across a quality sweep; size vs quality, JPEG baseline + chosen point.
const SWEEP_FINE = [20, 30, 40, 50, 60, 70, 80, 90, 95];
const SWEEP_COARSE = [25, 40, 55, 70, 85, 95]; // fewer points for large images → snappier sweep
async function buildSizeChart() {
  const cap = $('chart-size-cap');
  const quals = state.w * state.h > 1.5e6 ? SWEEP_COARSE : SWEEP_FINE;
  const building = (n) => {
    cap.innerHTML = `<span class="spin" aria-hidden="true"></span>Your image: file size vs encoder quality — building… ${n}/${quals.length}`;
  };
  if (!state.sweep) {
    // cache the sweep so a type toggle doesn't re-encode
    const webp = [],
      avif = [];
    let done = 0;
    building(0);
    for (const q of quals) {
      const [w, a] = await Promise.all([
        workerEncode('webp', q)
          .then((b) => b.byteLength)
          .catch(() => null),
        workerEncode('avif', q, AVIF_SPEED)
          .then((b) => b.byteLength)
          .catch(() => null),
      ]);
      if (w != null) webp.push([q, w / 1024]);
      if (a != null) avif.push([q, a / 1024]);
      building(++done);
    }
    state.sweep = { webp, avif };
  }
  cap.textContent = 'Your image: file size vs encoder quality';
  const { webp, avif } = state.sweep;
  const jpegKB = state.srcBytes.length / 1024;
  const ymax = Math.max(jpegKB, ...webp.map((p) => p[1]), ...avif.map((p) => p[1]), 1) * 1.08;
  const markers = [];
  if (state.results.webp?.buf)
    markers.push({
      x: state.webpQ,
      y: state.results.webp.buf.byteLength / 1024,
      color: C_WEBP,
      label: `chosen q${state.webpQ}`,
    });
  if (state.results.avif?.buf)
    markers.push({
      x: state.avifQ,
      y: state.results.avif.buf.byteLength / 1024,
      color: C_AVIF,
      label: `q${state.avifQ}`,
    });
  $('chart-size').innerHTML = lineChart({
    xMin: quals[0],
    xMax: 100,
    yMin: 0,
    yMax: ymax,
    xLabel: 'encoder quality',
    yLabel: 'file size (KB)',
    aria: 'Your image: file size versus encoder quality, with the JPEG size as a baseline',
    series: [
      { points: webp, color: C_WEBP },
      { points: avif, color: C_AVIF },
    ],
    hlines: [{ y: jpegKB, color: C_JPEG, label: `JPEG q${state.jpegQ}: ${jpegKB.toFixed(0)} KB` }],
    markers,
    legend: [
      { color: C_WEBP, label: 'WebP' },
      { color: C_AVIF, label: 'AVIF' },
      { color: C_JPEG, label: 'JPEG' },
    ],
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────────
function clamp(q) {
  return Math.min(100, Math.max(1, Math.round(q ?? 80)));
}

// In-browser content type — the entropy classifier ported from the CLI (classify.mjs).
// Photo↔illustration is decided by luminance-histogram entropy: photos fill the histogram
// (continuous tone + sensor noise → high entropy), flat-fill illustrations are peaky (low).
// Line-art is caught first by near-zero saturation + strong ink edges. ENTROPY_THRESHOLD was
// validated against the labeled sets at ~92% (calibration/validate-browser-classifier.mjs).
// It differs from the CLI's 0.70 because that is tuned to ImageMagick's %[entropy] normalization;
// this is a normalized Rec601 luminance-histogram entropy. Auto-selected; user-overridable.
const ENTROPY_THRESHOLD = 0.87;
function classify(imageData) {
  const { data, width, height } = imageData;

  // Luminance-histogram entropy over all pixels (photo ↔ illustration).
  const hist = new Array(256).fill(0);
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    hist[Math.min(255, Math.round(L))]++;
  }
  let H = 0;
  for (const c of hist)
    if (c) {
      const p = c / total;
      H -= p * Math.log2(p);
    }
  const entropy = H / 8; // normalize by log2(256)

  // Saturation + Sobel edge density on a ~200px sample (line-art).
  const step = Math.max(1, Math.floor(width / 200));
  let satSum = 0,
    n = 0;
  const lum = [];
  const cols = Math.ceil(width / step),
    rows = Math.ceil(height / step);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255,
        g = data[i + 1] / 255,
        b = data[i + 2] / 255;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b),
        l = (mx + mn) / 2;
      satSum += mx === mn ? 0 : l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
      lum.push(0.299 * r + 0.587 * g + 0.114 * b);
      n++;
    }
  }
  const satMean = satSum / n;
  let edges = 0,
    cnt = 0;
  const at = (cx, cy) => lum[cy * cols + cx];
  for (let cy = 1; cy < rows - 1; cy++) {
    for (let cx = 1; cx < cols - 1; cx++) {
      const gx =
        at(cx - 1, cy - 1) +
        2 * at(cx - 1, cy) +
        at(cx - 1, cy + 1) -
        at(cx + 1, cy - 1) -
        2 * at(cx + 1, cy) -
        at(cx + 1, cy + 1);
      const gy =
        at(cx - 1, cy - 1) +
        2 * at(cx, cy - 1) +
        at(cx + 1, cy - 1) -
        at(cx - 1, cy + 1) -
        2 * at(cx, cy + 1) -
        at(cx + 1, cy + 1);
      if (Math.hypot(gx, gy) > 0.25) edges++;
      cnt++;
    }
  }
  const edge = cnt ? edges / cnt : 0;

  if (satMean < 0.08 && edge > 0.1) return 'line-art'; // near-grayscale + strong ink edges
  return entropy < ENTROPY_THRESHOLD ? 'illustration' : 'photo';
}
