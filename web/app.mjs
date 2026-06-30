// image-tools web demo — fast-mode conversion entirely in the browser.
// Reuses the project's portable logic (lib/) + WASM encoders (jSquash). No upload.

import { interpolate } from '../lib/curves.mjs';
import { jpegQualityFromBuffer } from '../lib/jpeg-quality.mjs';
import { encode as encodeWebp } from 'https://esm.sh/@jsquash/webp@1.5.0';
import { encode as encodeAvif } from 'https://esm.sh/@jsquash/avif@2.1.0';

const MAX_EDGE = 2000;        // cap working dimension for a snappy demo
const AVIF_SPEED = 6;         // WASM-friendly (CLI uses --speed 0 for slightly smaller files)

const $ = (id) => document.getElementById(id);
const fmtKB = (b) => (b / 1024).toFixed(1) + ' KB';
const pct = (a, src) => ((src - a) / src) * 100;

let curves = null;
let state = null;   // { name, imageData, srcBytes, jpegQ, type, results }

// ─── boot ──────────────────────────────────────────────────────────────────
const status = $('status');
function setStatus(msg, isErr = false) {
  status.hidden = !msg; status.textContent = msg || ''; status.classList.toggle('err', isErr);
}

fetch('./curves.json').then(r => r.json()).then(c => { curves = c; })
  .catch(() => setStatus('Could not load calibration curves.', true));

// ─── input wiring ────────────────────────────────────────────────────────────
const drop = $('drop'), fileInput = $('file');
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach(e => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (f) handleFile(f); });
drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') fileInput.click(); });
$('again').addEventListener('click', reset);

// "Try a sample image" — load a bundled license-clean JPEG and run it through the pipeline.
$('sample').addEventListener('click', async () => {
  try {
    setStatus('Loading sample…');
    const blob = await (await fetch('./sample.jpg')).blob();
    handleFile(new File([blob], 'sample.jpg', { type: 'image/jpeg' }));
  } catch { setStatus('Could not load the sample image.', true); }
});

document.querySelectorAll('.seg-btn').forEach(btn =>
  btn.addEventListener('click', () => { if (state && btn.dataset.type !== state.type) { setType(btn.dataset.type); encodeAndRender(); } }));

function reset() {
  state = null; $('result').hidden = true; drop.hidden = false; $('sample').hidden = false; setStatus(''); fileInput.value = '';
}

// ─── pipeline ─────────────────────────────────────────────────────────────────
async function handleFile(file) {
  try {
    if (!curves) { setStatus('Still loading curves — try again in a second.', true); return; }
    if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) {
      setStatus('Please choose a JPEG (.jpg/.jpeg) — that’s what this converts.', true); return;
    }
    setStatus('Decoding…');
    const srcBytes = new Uint8Array(await file.arrayBuffer());
    const jpegQ = jpegQualityFromBuffer(srcBytes);
    if (jpegQ === null) { setStatus('That file isn’t a readable JPEG.', true); return; }

    // Decode (honoring EXIF orientation) → ImageData, capped for snappiness.
    const bmp = await createImageBitmap(new Blob([srcBytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const type = classify(imageData);
    state = { name: file.name, imageData, srcBytes, srcBlobUrl: URL.createObjectURL(file),
              fullW: bmp.width, fullH: bmp.height, w, h, jpegQ, type, results: {} };

    drop.hidden = true; $('sample').hidden = true; $('result').hidden = false;
    $('m-name').textContent = file.name;
    $('m-dims').textContent = `${bmp.width}×${bmp.height}${scale < 1 ? ` · preview ${w}×${h}` : ''}`;
    $('m-q').textContent = `JPEG q${jpegQ}`;
    setType(type);
    await encodeAndRender();
  } catch (e) {
    console.error(e);
    setStatus('Something went wrong decoding that image.', true);
  }
}

function setType(type) {
  state.type = type;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b.dataset.type === type));
}

async function encodeAndRender() {
  setStatus('');
  const { imageData, jpegQ, type } = state;
  const webpQ = clamp(interpolate(curves[type], jpegQ, 'webp_q'));
  const avifQ = clamp(interpolate(curves[type], jpegQ, 'avif_q'));

  // reset card states
  for (const k of ['webp', 'avif']) { $(`s-${k}`).textContent = '…'; $(`d-${k}`).textContent = 'encoding…'; }
  $('s-jpeg').textContent = fmtKB(state.srcBytes.length);
  $('compare').hidden = true; $('winner').hidden = true; $('again').hidden = true;

  const [webp, avif] = await Promise.all([
    encodeWebp(imageData, { quality: webpQ }).then(buf => ({ buf, q: `q${webpQ}` })).catch(err),
    encodeAvif(imageData, { quality: avifQ, speed: AVIF_SPEED }).then(buf => ({ buf, q: `q${avifQ}` })).catch(err),
  ]);
  state.results = { webp, avif };
  renderCard('webp', webp); renderCard('avif', avif);
  renderWinner();
  $('again').hidden = false;
}
function err(e) { console.error(e); return null; }

function renderCard(fmt, res) {
  const sizeEl = $(`s-${fmt}`), subEl = $(`d-${fmt}`);
  if (!res || !res.buf) { sizeEl.textContent = 'failed'; subEl.textContent = 'encoder error'; return; }
  const bytes = res.buf.byteLength, p = pct(bytes, state.srcBytes.length);
  sizeEl.textContent = fmtKB(bytes);
  const cls = p >= 0 ? 'down' : 'up';
  subEl.innerHTML = `${res.q} · <span class="${cls}">${p >= 0 ? '−' : '+'}${Math.abs(p).toFixed(0)}%</span> vs JPEG`;
}

function renderWinner() {
  const { webp, avif } = state.results;
  const cands = [['webp', webp], ['avif', avif]].filter(([, r]) => r && r.buf);
  document.querySelectorAll('.card').forEach(c => c.classList.remove('winner-card'));
  document.querySelectorAll('.badge.win').forEach(b => b.hidden = true);
  const winEl = $('winner'); winEl.hidden = false; winEl.classList.remove('kept');

  if (!cands.length) { winEl.textContent = 'Encoding failed in this browser.'; return; }
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
  const fig = $('compare'); fig.hidden = false;
  if (cmpUrl) URL.revokeObjectURL(cmpUrl);
  cmpUrl = URL.createObjectURL(new Blob([buf], { type: `image/${fmt}` }));
  $('cmp-after').src = cmpUrl;
  $('cmp-before').src = state.srcBlobUrl;
  $('cmp-tag-r').textContent = fmt.toUpperCase();
  $('cmp-after').onload = () => { sizeCompare(); setSlider(50); };
}
function sizeCompare() {
  const stage = $('compare').querySelector('.cmp-stage');
  $('cmp-before').style.width = stage.clientWidth + 'px';
}
function setSlider(p) {
  p = Math.max(0, Math.min(100, p));
  $('cmp-clip').style.width = p + '%';
  $('cmp-handle').style.left = p + '%';
}
(function wireSlider() {
  const stage = () => $('compare').querySelector('.cmp-stage');
  let dragging = false;
  const move = (clientX) => { const r = stage().getBoundingClientRect(); setSlider(((clientX - r.left) / r.width) * 100); };
  document.addEventListener('pointerdown', (e) => { if (e.target.closest('.cmp-stage')) { dragging = true; move(e.clientX); } });
  document.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
  document.addEventListener('pointerup', () => { dragging = false; });
  $('cmp-handle').addEventListener('keydown', (e) => {
    const cur = parseFloat($('cmp-clip').style.width) || 50;
    if (e.key === 'ArrowLeft') setSlider(cur - 4);
    if (e.key === 'ArrowRight') setSlider(cur + 4);
  });
  window.addEventListener('resize', () => { if (!$('compare').hidden) sizeCompare(); });
})();

// ─── helpers ───────────────────────────────────────────────────────────────────
function clamp(q) { return Math.min(100, Math.max(1, Math.round(q ?? 80))); }

// In-browser content-type guess. Computes saturation + a Sobel edge density on a downscaled
// copy, mirroring classify.mjs's rule structure. Auto-selected, but the user can override.
function classify(imageData) {
  const { data, width, height } = imageData;
  // sample to ~200px wide for speed
  const step = Math.max(1, Math.floor(width / 200));
  let satSum = 0, n = 0;
  const lum = []; const cols = Math.ceil(width / step), rows = Math.ceil(height / step);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      satSum += mx === mn ? 0 : (l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn));
      lum.push(0.299 * r + 0.587 * g + 0.114 * b); n++;
    }
  }
  const satMean = satSum / n;
  // Sobel edge density: fraction of sampled pixels with strong gradient.
  let edges = 0, cnt = 0;
  const at = (cx, cy) => lum[cy * cols + cx];
  for (let cy = 1; cy < rows - 1; cy++) {
    for (let cx = 1; cx < cols - 1; cx++) {
      const gx = at(cx - 1, cy - 1) + 2 * at(cx - 1, cy) + at(cx - 1, cy + 1)
               - at(cx + 1, cy - 1) - 2 * at(cx + 1, cy) - at(cx + 1, cy + 1);
      const gy = at(cx - 1, cy - 1) + 2 * at(cx, cy - 1) + at(cx + 1, cy - 1)
               - at(cx - 1, cy + 1) - 2 * at(cx, cy + 1) - at(cx + 1, cy + 1);
      if (Math.hypot(gx, gy) > 0.25) edges++;
      cnt++;
    }
  }
  const edge = cnt ? edges / cnt : 0;
  // thresholds tuned for this sobel metric (looser than classify.mjs's canny scale)
  if (satMean < 0.08 && edge > 0.10) return 'line-art';
  if (edge < 0.06 && satMean < 0.45) return 'illustration';
  return 'photo';
}
