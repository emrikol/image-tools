#!/usr/bin/env node
/**
 * calibrate.mjs
 *
 * Generates JPEG → WebP / AVIF quality equivalence curves for any set of
 * quality metrics. Multiple datasets (content types) are processed in one
 * combined run with a single ETA.
 *
 * ─── How it works ──────────────────────────────────────────────────────────────
 *
 * For each reference image at each JPEG quality step:
 *   1. Encode the lossless PNG → JPEG at quality Q
 *   2. Encode → WebP at quality Q  (same Q, all formats)
 *   3. Encode → AVIF at quality Q  (same Q, all formats)
 *
 * All encodings are cached to disk (--cache-dir). On subsequent runs for new
 * metrics, encoding is skipped — only the metric measurements are re-run.
 *
 * For each metric:
 *   - Measure metric(ref, JPEG_Q) = target score for each JPEG quality
 *   - Measure metric(ref, WebP_Q) and metric(ref, AVIF_Q) for all Q
 *   - Find the minimum WebP/AVIF quality whose score meets the JPEG target
 *     (interpolating between step intervals)
 *   - Average results across all images → write calibration JSON
 *
 * This is more efficient than binary search (30 encodings per image at step=10
 * vs 170 for binary search) and produces reusable artifacts — any new metric
 * can be calibrated against the same cached encodings without re-encoding.
 *
 * ─── Metrics ───────────────────────────────────────────────────────────────────
 *
 *   ssimulacra2     Best overall perceptual quality (higher = better, -inf..100).
 *                   Applies visual masking — tolerates errors in textured regions.
 *                   Install: build libjxl with -DJPEGXL_ENABLE_DEVTOOLS=ON.
 *
 *   ms_ssim         Multi-Scale Structural Similarity (higher = better, 0..1).
 *                   Extends SSIM across multiple resolution scales. More robust than
 *                   single-scale SSIM. Available via ffmpeg libavfilter.
 *
 *   vmaf            Netflix VMAF perceptual quality score (higher = better, 0..100).
 *                   Ensemble model combining VIF, DLM, and motion.
 *                   ⚠ DISABLED: VMAF saturates at 100.0 starting at JPEG Q20–Q30 for
 *                   photo and illustration content, causing webp_q=100 for 80–90% of
 *                   the quality range. The resulting calibration files are useless as
 *                   a signal (convert.mjs takes the max across all curves, so a stuck
 *                   webp_q=100 forces maximum quality on every conversion). Only
 *                   line-art avoids saturation; that file is kept. Do not include vmaf
 *                   in --metrics for photo or illustration datasets.
 *
 *   lpips           Learned Perceptual Image Patch Similarity (lower = better, 0..1).
 *                   AlexNet-based deep features. Correlates well with human judgments,
 *                   especially on synthetic/illustration content.
 *                   Install: pip install lpips
 *
 *   dists           Deep Image Structure and Texture Similarity (lower = better, 0..1).
 *                   Tolerates texture resampling (same texture, different phase).
 *                   Install: pip install DISTS-pytorch
 *
 *   fsim            Feature Similarity Index (higher = better, 0..1).
 *                   Gradient magnitude + phase congruency across scales.
 *                   Install: pip install piq
 *
 *   vif             Visual Information Fidelity (higher = better, >0).
 *                   Wavelet-domain statistical information fidelity.
 *                   Install: pip install piq
 *
 *   butteraugli     Google psychovisual distance (lower = better, 0 = identical).
 *                   XYB color space, multi-scale HF/UHF channels. Best at barely-visible
 *                   artifacts. Install: build libjxl with -DJPEGXL_ENABLE_DEVTOOLS=ON.
 *
 *   dssim           Structural dissimilarity (lower = better, 0 = identical).
 *                   Fast, ~91% human judgment agreement. Install: brew install dssim
 *
 *   xpsnr           Extended Perceptually-Weighted PSNR (higher = better, dB).
 *                   Weights smooth-region errors more than textured — complements
 *                   SSIMULACRA2. Install: brew install ffmpeg (included in recent builds).
 *
 *   cvvdp           ColorVideoVDP JOD score (higher = better, 0 = same, negative = worse).
 *                   Best for color artifacts. Slow (Python subprocess).
 *                   Install: pip install cvvdp
 *
 *   entropy_diff    Multi-scale local entropy difference (lower = better, 0 = identical).
 *                   Inspired by SpEED-QA. Compares local variance-entropy at 3 spatial
 *                   scales via Python/scipy. Captures texture/grain preservation.
 *
 * ─── Note on SpEED-QA / RRED ───────────────────────────────────────────────────
 *
 * SpEED-QA (Bampis 2017) and RRED (Soundararajan & Bovik 2012) are not available
 * as Python packages. The official SpEED-QA release is MATLAB-only
 * (github.com/christosbampis/SpEED-QA_release). Image-domain RRED has no Python
 * port. scikit-video has ST-RRED but only for video. entropy_diff and fsim/vif
 * serve as practical substitutes until Python implementations exist.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   node calibrate.mjs \
 *     --dataset type:image-dir:output-dir [--dataset ...] \
 *     --metrics ssimulacra2,ms_ssim,butteraugli,dssim,xpsnr,lpips,dists,fsim,vif,entropy_diff \
 *     # note: vmaf omitted — saturates for photo/illustration (see metric notes above) \
 *     [--step N] [--concurrency N] [--cache-dir ./encoding-cache]
 *
 * Options:
 *   --dataset t:d:o  Dataset: content-type:image-dir:output-dir. Repeat for each type.
 *                    One calibration JSON per metric is written to output-dir.
 *   --metrics M,...  Comma-separated list of metrics (default: ssimulacra2)
 *   --step N         Sample every Nth JPEG quality 1..100 (default: 1 = all)
 *   --concurrency N  Parallel workers (default: all logical CPU cores)
 *   --avif-jobs N    Threads per avifenc process (default: 1; raise for few large images)
 *   --cache-dir DIR  Directory to cache encodings (default: ./encoding-cache).
 *                    Encodings are reused across runs — delete to force re-encode.
 *   --overwrite      Replace existing calibration files instead of merging into them.
 *   --encode-only    Encode all images and stop. No metric measurement.
 *                    Use to pre-populate the cache, then run metrics separately.
 *
 * Note: avifenc always runs at speed 0 (maximum compression effort) to match convert.mjs.
 *
 * ─── Examples ──────────────────────────────────────────────────────────────────
 *
 *   # Full run — all useful metrics, step=10 for speed, reuse cache on re-runs
 *   node calibrate.mjs \
 *     --dataset photo:test-images/kodak:. \
 *     --dataset illustration:test-images/illustrations:. \
 *     --dataset line-art:test-images/line-art:. \
 *     --metrics ssimulacra2,ms_ssim,butteraugli,dssim,xpsnr,lpips,dists,fsim,vif,entropy_diff \
 *     # note: vmaf omitted — saturates for photo/illustration (see metric notes above) \
 *     --step 10 --concurrency 8
 *
 *   # Add a new metric later — encoding cache is reused, only measurement runs
 *   node calibrate.mjs \
 *     --dataset photo:test-images/kodak:. \
 *     --metrics lpips,dists \
 *     --step 10 --concurrency 8
 *
 * ─── Incremental densification ─────────────────────────────────────────────────
 *
 * Calibration files are merged by default — new data points are added to existing
 * files; existing points at the same jpeg_q are overwritten with the new averages.
 * This lets you fill in the curve progressively without re-running everything:
 *
 *   # Pass 1 — coarse skeleton (Q10,Q20,...,Q100)
 *   node calibrate.mjs --dataset photo:... --metrics ssimulacra2 --step 10 --cache-dir ./cache
 *
 *   # Pass 2 — double resolution (adds Q5,Q15,...,Q95)
 *   node calibrate.mjs --dataset photo:... --metrics ssimulacra2 --step 5  --cache-dir ./cache
 *
 *   # Pass 3 — fill a specific range at full resolution
 *   node calibrate.mjs --dataset photo:... --metrics ssimulacra2 --step 1  --cache-dir ./cache
 *
 * Each pass merges into the existing file. convert.mjs interpolates between
 * whatever points are present — more points = more accurate interpolation.
 * Pass --overwrite to discard existing data and start fresh.
 */

import { execFile, spawn } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { createInterface } from 'readline';
import { availableParallelism } from 'os';

const execFileAsync = promisify(execFile);
const __dirname    = dirname(fileURLToPath(import.meta.url));
const AVIF_SPEED   = 0;  // always max compression; must match convert.mjs

// ─── CLI args ─────────────────────────────────────────────────────────────────

function getAllArgs(flag) {
  const result = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) result.push(process.argv[i + 1]);
  }
  return result;
}
function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}

const METRIC_NAMES = (getArg('--metrics', 'ssimulacra2')).split(',').map(s => s.trim());
const STEP         = parseInt(getArg('--step', '1'));
// Default concurrency = all logical cores. The workload is CPU-bound process
// parallelism: single-threaded encoders/measurers (avifenc pinned to --avif-jobs
// threads, Python workers pinned to 1 torch thread), so N≈cores saturates without
// oversubscription. RAM is not the limit (~0.7 GB per Python worker).
const CONCURRENCY  = parseInt(getArg('--concurrency', String(availableParallelism())));
// Threads per avifenc process. 1 = rely on process-level parallelism (best total
// throughput for many small images); raise it if encoding few large images.
const AVIF_JOBS    = parseInt(getArg('--avif-jobs', '1'));
const CACHE_DIR    = resolve(getArg('--cache-dir', join(__dirname, 'encoding-cache')));
const OVERWRITE    = process.argv.includes('--overwrite');
const ENCODE_ONLY  = process.argv.includes('--encode-only');

const datasetSpecs = getAllArgs('--dataset').map(spec => {
  const parts = spec.split(':');
  if (parts.length < 3) { console.error(`Invalid --dataset: "${spec}" — expected type:image-dir:output-dir`); process.exit(1); }
  const [type, imageDir, ...rest] = parts;
  return { type, imageDir, outputDir: rest.join(':') };
});

if (datasetSpecs.length === 0) {
  console.error('Usage: node calibrate.mjs --dataset type:image-dir:output-dir [--dataset ...] [--metrics m1,m2,...] [--step N] [--concurrency N] [--cache-dir DIR]');
  process.exit(1);
}

// JPEG qualities to sample
const JPEG_QUALITIES = Array.from({ length: 100 }, (_, i) => i + 1)
  .filter(q => q % STEP === 0 || q === 1);

// ─── encoding helpers ─────────────────────────────────────────────────────────

async function toRGB(src, out) {
  if (existsSync(out)) return;  // cached
  await execFileAsync('magick', ['convert', src, '-strip', '-flatten', '-colorspace', 'sRGB', '-type', 'TrueColor', out]);
}
async function encodeJPEG(src, quality, out) {
  if (existsSync(out)) return;  // cached
  await execFileAsync('magick', ['convert', src, '-quality', String(quality), out]);
}
async function encodeWebP(src, quality, out) {
  if (existsSync(out)) return;  // cached
  await execFileAsync('cwebp', ['-q', String(quality), '-m', '6', '-quiet', src, '-o', out]);
}
async function encodeAVIF(src, quality, out) {
  if (existsSync(out)) return;  // cached
  await execFileAsync('avifenc', ['-q', String(quality), '--speed', String(AVIF_SPEED), '--jobs', String(AVIF_JOBS), src, out]);
}

// ─── PNG decode helper (for tools that can't read AVIF/WebP natively) ─────────

async function withPng(encodedPath, fn) {
  if (!/\.(avif|webp)$/i.test(encodedPath)) return fn(encodedPath);
  const tmpPng = encodedPath + '._cmp.png';
  try {
    await execFileAsync('magick', ['convert', encodedPath, tmpPng]);
    return await fn(tmpPng);
  } catch { return null; }
  finally { try { unlinkSync(tmpPng); } catch {} }
}

// ─── metric measurement functions ─────────────────────────────────────────────

async function measureSSIM(ref, encoded) {
  return withPng(encoded, async (cmpPath) => {
    const result = await execFileAsync('ssimulacra2', [ref, cmpPath], { encoding: 'utf8' }).catch(e => e);
    const output = result.stdout || result.stderr || '';
    const match  = output.match(/(-?[\d.]+)/);
    const score  = match ? parseFloat(match[1]) : null;
    if (score === null || score > 100.5) return null;
    return parseFloat(score.toFixed(4));
  });
}

async function measureButteraugli(ref, encoded) {
  return withPng(encoded, async (cmpPath) => {
    const result = await execFileAsync('butteraugli_main', [ref, cmpPath], { encoding: 'utf8' }).catch(e => e);
    const output = result.stdout || result.stderr || '';
    const match  = output.match(/([\d.]+)/);
    if (!match) return null;
    const val = parseFloat(match[1]);
    return isFinite(val) ? parseFloat(val.toFixed(4)) : null;
  });
}

async function measureDSSIM(ref, encoded) {
  return withPng(encoded, async (cmpPath) => {
    const result = await execFileAsync('dssim', [ref, cmpPath], { encoding: 'utf8' }).catch(e => e);
    const output = result.stdout || result.stderr || '';
    const match  = output.match(/^([\d.e+-]+)/m);
    if (!match) return null;
    return parseFloat(parseFloat(match[1]).toFixed(6));
  });
}

async function measureXPSNR(ref, encoded) {
  const result = await execFileAsync('ffmpeg', [
    '-hide_banner', '-i', ref, '-i', encoded,
    '-lavfi', '[0:v][1:v]xpsnr', '-f', 'null', '-',
  ], { encoding: 'utf8' }).catch(e => e);
  const output  = result.stdout || result.stderr || '';
  const weighted = output.match(/weighted[:\s]+([\d.]+)/i);
  const yOnly    = output.match(/\by[:\s]+([\d.]+)/i);
  const match    = weighted || yOnly;
  if (!match) return null;
  const val = parseFloat(match[1]);
  return isFinite(val) ? parseFloat(val.toFixed(4)) : null;
}

async function measureCVVDP(ref, encoded) {
  // Uses venv/bin/cvvdp — higher=better (JOD: 0 = same quality, negative = worse)
  const CVVDP = join(__dirname, 'venv/bin/cvvdp');
  return withPng(encoded, async (cmpPath) => {
    const result = await execFileAsync(CVVDP, [
      '-t', cmpPath, '-r', ref, '-d', 'standard_4k', '-q',
    ], { encoding: 'utf8' }).catch(e => e);
    const output = result.stdout || result.stderr || '';
    const jod = output.match(/JOD[=:\s]*([-\d.]+)/i) || output.match(/([-\d.]+)\s*JOD/i);
    if (!jod) return null;
    return parseFloat(parseFloat(jod[1]).toFixed(4));
  });
}

async function measureVMAF(ref, encoded) {
  // Uses standalone 'vmaf' binary from libvmaf (brew install libvmaf).
  // Requires y4m input — convert ref + encoded via ffmpeg to temp files.
  // higher=better, 0..100.
  // All temp paths are based on `encoded` (not `ref`) so concurrent calls
  // for the same reference image don't collide on the same filenames.
  const tmpRef  = encoded + '._vmaf_ref.y4m';
  const tmpDst  = encoded + '._vmaf_dst.y4m';
  const logFile = encoded + '._vmaf.json';
  try {
    await Promise.all([
      execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', ref,     '-pix_fmt', 'yuv420p', '-y', tmpRef]),
      execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', encoded, '-pix_fmt', 'yuv420p', '-y', tmpDst]),
    ]);
    await execFileAsync('vmaf', [
      '-r', tmpRef, '-d', tmpDst,
      '--model', 'version=vmaf_v0.6.1',
      '--json', '-o', logFile, '-q',
    ], { encoding: 'utf8' }).catch(e => e);
    if (!existsSync(logFile)) return null;
    const data  = JSON.parse(readFileSync(logFile, 'utf8'));
    const score = data?.pooled_metrics?.vmaf?.mean ?? data?.frames?.[0]?.metrics?.vmaf;
    return score != null && isFinite(score) ? parseFloat(score.toFixed(4)) : null;
  } finally {
    for (const f of [tmpRef, tmpDst, logFile]) { try { unlinkSync(f); } catch {} }
  }
}

const VENV_PYTHON = join(__dirname, 'venv/bin/python');
const PY_SCRIPT   = join(__dirname, 'measure_perceptual.py');

// ─── persistent Python worker pool ────────────────────────────────────────────
//
// PyTorch metrics used to spawn a fresh `python measure_perceptual.py <metric> …`
// per measurement — re-importing torch (~1s) and reloading the model every time
// (~120k times at step 1). Instead we keep a pool of long-lived `serve` workers
// per metric: the model loads once, then each worker streams "ref<TAB>cmp\n" in /
// one float per line out. Each worker pins torch to 1 thread so N≈cores workers
// saturate the CPU without oversubscription.

class PyWorker {
  constructor(metric) {
    this.proc = spawn(VENV_PYTHON, [PY_SCRIPT, 'serve', metric], {
      env: { ...process.env,
             OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
             VECLIB_MAXIMUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
             PYTHONWARNINGS: 'ignore', TQDM_DISABLE: '1' },
      stdio: ['pipe', 'pipe', 'inherit'],  // worker stderr → ours (warnings/errors)
    });
    this.pending = [];  // FIFO of resolvers; worker answers in order
    this.alive   = true;
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => { const r = this.pending.shift(); if (r) r(line); });
    this.proc.on('exit', () => { this.alive = false; while (this.pending.length) this.pending.shift()(''); });
  }
  measure(ref, cmp) {
    if (!this.alive) return Promise.resolve('');
    return new Promise((res) => { this.pending.push(res); this.proc.stdin.write(`${ref}\t${cmp}\n`); });
  }
  close() { try { this.proc.stdin.end(); } catch {} }
}

class PyPool {
  constructor(metric, size) { this.workers = Array.from({ length: size }, () => new PyWorker(metric)); }
  async measure(ref, cmp) {
    // Send to the least-loaded worker for even balancing under runPool's gating.
    let w = this.workers[0];
    for (const x of this.workers) if (x.pending.length < w.pending.length) w = x;
    const v = parseFloat(await w.measure(ref, cmp));
    return isFinite(v) ? v : null;
  }
  close() { for (const w of this.workers) w.close(); }
}

const pyPools = new Map();  // metric → PyPool (lazy; one active metric at a time)
function getPyPool(metric) {
  if (!pyPools.has(metric)) pyPools.set(metric, new PyPool(metric, CONCURRENCY));
  return pyPools.get(metric);
}
function closeAllPyPools() {
  for (const p of pyPools.values()) p.close();
  pyPools.clear();
}

async function measurePython(metric, ref, encoded) {
  // PyTorch metrics (MS-SSIM, LPIPS, DISTS, FSIM, VIF, entropy_diff). Routes through
  // a persistent per-metric worker pool. Expects lossless PNG inputs (withPng decodes).
  return withPng(encoded, async (cmpPath) => {
    const val = await getPyPool(metric).measure(ref, cmpPath);
    return val === null ? null : parseFloat(val.toFixed(6));
  });
}

async function measureMSSSIM(ref, encoded) {
  // MS-SSIM via piq (Python). ffmpeg has no msssim filter.
  return measurePython('ms_ssim', ref, encoded);
}

async function measureEntropyDiff(ref, encoded) {
  // Multi-scale local entropy difference via Python/scipy.
  // (ImageMagick -statistic Entropy was removed in recent builds.)
  return measurePython('entropy_diff', ref, encoded);
}

// ─── metric definitions ───────────────────────────────────────────────────────
//
// higherIsBetter: true  → find minimum WebP/AVIF quality where score >= jpeg_score
// higherIsBetter: false → find minimum WebP/AVIF quality where score <= jpeg_score
//
// prepareRef(rgbRef) → per-image context passed to measure(); null = skip image
// measure(ref, encoded, ctx) → numeric score, or null on failure

const METRICS = {
  ssimulacra2: {
    name: 'ssimulacra2', scoreField: 'score', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureSSIM(ref, encoded); },
  },
  butteraugli: {
    name: 'butteraugli', scoreField: 'butteraugli_dist', higherIsBetter: false,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureButteraugli(ref, encoded); },
  },
  dssim: {
    name: 'dssim', scoreField: 'dssim', higherIsBetter: false,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureDSSIM(ref, encoded); },
  },
  xpsnr: {
    name: 'xpsnr', scoreField: 'xpsnr_db', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureXPSNR(ref, encoded); },
  },
  cvvdp: {
    name: 'cvvdp', scoreField: 'cvvdp_jod', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureCVVDP(ref, encoded); },
  },
  ms_ssim: {
    name: 'ms_ssim', scoreField: 'ms_ssim', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureMSSSIM(ref, encoded); },
  },
  // vmaf: DISABLED — saturates at 100.0 from JPEG Q20 (illustration) and Q30 (photo),
  // causing webp_q=100 across 80–90% of the quality range for those content types.
  // Since convert.mjs takes the max across all curves, including vmaf for photo or
  // illustration forces WebP Q100 on nearly every conversion, making it useless.
  // The line-art file (vmaf-calibration-line-art.json) is unaffected and kept.
  // To regenerate line-art only: --dataset line-art:... --metrics vmaf
  // vmaf: {
  //   name: 'vmaf', scoreField: 'vmaf', higherIsBetter: true,
  //   async prepareRef(_ref)            { return {}; },
  //   async measure(ref, encoded, _ctx) { return measureVMAF(ref, encoded); },
  // },
  lpips: {
    name: 'lpips', scoreField: 'lpips', higherIsBetter: false,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measurePython('lpips', ref, encoded); },
  },
  dists: {
    name: 'dists', scoreField: 'dists', higherIsBetter: false,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measurePython('dists', ref, encoded); },
  },
  fsim: {
    name: 'fsim', scoreField: 'fsim', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measurePython('fsim', ref, encoded); },
  },
  vif: {
    name: 'vif', scoreField: 'vif', higherIsBetter: true,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measurePython('vif', ref, encoded); },
  },
  entropy_diff: {
    name: 'entropy_diff', scoreField: 'entropy_diff', higherIsBetter: false,
    async prepareRef(_ref)            { return {}; },
    async measure(ref, encoded, _ctx) { return measureEntropyDiff(ref, encoded); },
  },
};

// Validate requested metrics
for (const name of METRIC_NAMES) {
  if (!METRICS[name]) {
    console.error(`Unknown metric: "${name}". Available: ${Object.keys(METRICS).join(', ')}`);
    process.exit(1);
  }
}
const activeMetrics = METRIC_NAMES.map(n => METRICS[n]);

// ─── find equivalent quality by interpolation ─────────────────────────────────
//
// Given scores at each sampled quality (qualityScores: [{q, score}, ...]),
// find the lowest quality whose score meets the target.
// Interpolates between step intervals for sub-step accuracy.

function findEquivQuality(qualityScores, targetScore, higherIsBetter) {
  const sorted = [...qualityScores].sort((a, b) => a.q - b.q);

  for (let i = 0; i < sorted.length; i++) {
    const { q, score } = sorted[i];
    if (score === null) continue;

    const meets = higherIsBetter ? score >= targetScore : score <= targetScore;
    if (!meets) continue;

    // Found the first quality that meets target. Interpolate with previous point.
    if (i === 0) return q;
    const prev = sorted[i - 1];
    if (prev.score === null) return q;

    // Linear interpolation between prev.q and q
    const scoreRange = score - prev.score;
    if (Math.abs(scoreRange) < 1e-9) return q;
    const t = (targetScore - prev.score) / scoreRange;
    return Math.min(100, Math.max(1, Math.round(prev.q + t * (q - prev.q))));
  }

  return 100;  // target never reached — use maximum quality
}

// ─── progress bar ─────────────────────────────────────────────────────────────

function makeProgress(totalTicks, doneTicks) {
  if (!process.stderr.isTTY) return { tick: () => {}, done: () => {} };
  const BAR_WIDTH = 30;
  let completed   = doneTicks;
  const start     = Date.now();
  const times     = [];
  return {
    tick() {
      completed++;
      const elapsed = Date.now() - start;
      const newDone = completed - doneTicks;
      if (newDone > 0) { times.push(elapsed / newDone); if (times.length > 20) times.shift(); }
      const avg    = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      const remain = totalTicks - completed;
      const eta    = avg ? Math.round((avg * remain) / 1000) : 0;
      const etaStr = !avg ? '...' : eta >= 3600
        ? `${Math.floor(eta/3600)}h${Math.floor((eta%3600)/60)}m`
        : eta >= 60 ? `${Math.floor(eta/60)}m${eta%60}s` : `${eta}s`;
      const pct    = Math.round((completed / totalTicks) * 100);
      const filled = Math.round((completed / totalTicks) * BAR_WIDTH);
      const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      process.stderr.write(`\r[${bar}] ${completed}/${totalTicks}  ${pct}%  ETA ${etaStr}  `);
    },
    done() { process.stderr.write('\n'); },
  };
}

// ─── concurrency pool ─────────────────────────────────────────────────────────

async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let   next    = 0;
  async function worker() {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ─── phase 1: encode one image ────────────────────────────────────────────────
//
// Returns imageInfo: { label, dsType, imageCache, rgbRef }
// All encodings are written to imageCache and cached — safe to call repeatedly.

async function encodeImage(pngPath, label, dsType, imageCache) {
  mkdirSync(imageCache, { recursive: true });
  const rgbRef = join(imageCache, 'rgb.png');
  await toRGB(pngPath, rgbRef);
  for (const q of JPEG_QUALITIES) {
    await encodeJPEG(rgbRef, q, join(imageCache, `jpeg-q${q}.jpg`));
    await encodeWebP(rgbRef,  q, join(imageCache, `webp-q${q}.webp`));
    await encodeAVIF(rgbRef,  q, join(imageCache, `avif-q${q}.avif`));
    encodeProgress.tick();
  }
  return { label, dsType, imageCache, rgbRef };
}

// ─── phase 2: measure one metric across all images ────────────────────────────
//
// Builds a flat list of (image, quality, format) measurement tasks and runs
// them through a pool of exactly CONCURRENCY workers — one metric at a time,
// so only one class of subprocess is running simultaneously.
//
// Returns: { [label]: { jpeg_q → row } } for use by averageCurves.

async function measureMetric(m, imageInfos) {
  // Pre-compute per-image ctx (prepareRef). Sequential and fast.
  const ctxByLabel = {};
  for (const info of imageInfos) {
    const ctx = await m.prepareRef(info.rgbRef);
    if (ctx === null) {
      process.stderr.write(`\n  skip ${m.name} for ${info.label} (prepareRef=null)\n`);
    } else {
      ctxByLabel[info.label] = ctx;
    }
  }

  // Flat scores store: scores[label][fmt][q] = value
  const scores = {};
  for (const info of imageInfos) {
    if (!ctxByLabel[info.label]) continue;
    scores[info.label] = { jpeg: {}, webp: {}, avif: {} };
  }

  // Build flat task list: one task per (image × quality × format)
  const tasks = [];
  for (const info of imageInfos) {
    const ctx = ctxByLabel[info.label];
    if (!ctx) continue;
    const s = scores[info.label];
    for (const q of JPEG_QUALITIES) {
      tasks.push(async () => { s.jpeg[q] = await m.measure(info.rgbRef, join(info.imageCache, `jpeg-q${q}.jpg`), ctx); measureProgress.tick(); });
      tasks.push(async () => { s.webp[q] = await m.measure(info.rgbRef, join(info.imageCache, `webp-q${q}.webp`), ctx); measureProgress.tick(); });
      tasks.push(async () => { s.avif[q] = await m.measure(info.rgbRef, join(info.imageCache, `avif-q${q}.avif`), ctx); measureProgress.tick(); });
    }
  }

  await runPool(tasks, CONCURRENCY);

  // Compute per-image findEquivQuality rows
  const imageResults = {};
  for (const info of imageInfos) {
    if (!scores[info.label]) continue;
    const s = scores[info.label];
    const rows = [];
    for (const jpegQ of JPEG_QUALITIES) {
      const target = s.jpeg[jpegQ];
      if (target === null || target === undefined) continue;
      rows.push({
        jpeg_q:         jpegQ,
        [m.scoreField]: target,
        webp_q:         findEquivQuality(JPEG_QUALITIES.map(q => ({ q, score: s.webp[q] })), target, m.higherIsBetter),
        avif_q:         findEquivQuality(JPEG_QUALITIES.map(q => ({ q, score: s.avif[q] })), target, m.higherIsBetter),
      });
    }
    imageResults[info.label] = rows;
  }
  return imageResults;
}

// ─── average curves ───────────────────────────────────────────────────────────

// imageResults: { [label]: rows[] }  (output of measureMetric)
function averageCurves(imageResults, metricName) {
  const m = METRICS[metricName];
  const byJpegQ = {};

  for (const rows of Object.values(imageResults)) {
    for (const row of rows) {
      if (!byJpegQ[row.jpeg_q]) byJpegQ[row.jpeg_q] = { scores: [], webp: [], avif: [] };
      if (row[m.scoreField] != null) byJpegQ[row.jpeg_q].scores.push(row[m.scoreField]);
      if (row.webp_q !== null) byJpegQ[row.jpeg_q].webp.push(row.webp_q);
      if (row.avif_q !== null) byJpegQ[row.jpeg_q].avif.push(row.avif_q);
    }
  }

  const avg = v => v.length ? parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)) : null;
  return Object.entries(byJpegQ)
    .map(([jq, d]) => ({
      jpeg_q:         parseInt(jq),
      [m.scoreField]: avg(d.scores),
      webp_q:         avg(d.webp) !== null ? Math.round(avg(d.webp)) : null,
      avif_q:         avg(d.avif) !== null ? Math.round(avg(d.avif)) : null,
    }))
    .sort((a, b) => a.jpeg_q - b.jpeg_q);
}

// ─── merge curve helper ───────────────────────────────────────────────────────
//
// Merges a newly computed curve into an existing calibration file.
// New data points (by jpeg_q) overwrite existing ones; all other existing
// points are kept. This allows incremental densification:
//   Run 1: --step 10  → Q10,Q20,...,Q100
//   Run 2: --step 5   → adds Q5,Q15,...  (existing Q10/Q20/... updated with new averages)
//   Run 3: --step 1 on a specific range → fills every point in that range
//
// Pass --overwrite to skip merging and replace the file entirely.

function mergeCurve(existingPath, newCurve, scoreField) {
  if (OVERWRITE || !existsSync(existingPath)) return newCurve;
  try {
    const existing = JSON.parse(readFileSync(existingPath, 'utf8'));
    if (!Array.isArray(existing.curve)) return newCurve;

    const byQ = new Map(existing.curve.map(r => [r.jpeg_q, r]));
    for (const row of newCurve) byQ.set(row.jpeg_q, row);  // new points win
    return [...byQ.values()].sort((a, b) => a.jpeg_q - b.jpeg_q);
  } catch {
    return newCurve;
  }
}

// ─── load datasets ────────────────────────────────────────────────────────────

const datasets = [];
for (const spec of datasetSpecs) {
  if (!existsSync(spec.imageDir)) { console.error(`Image dir not found: ${spec.imageDir}`); process.exit(1); }
  mkdirSync(spec.outputDir, { recursive: true });

  const images = readdirSync(spec.imageDir)
    .filter(f => /\.png$/i.test(f))
    .sort()
    .map(f => ({ path: join(spec.imageDir, f), label: f.replace(/\.png$/i, '') }));

  if (images.length === 0) { console.error(`No PNG files in ${spec.imageDir}`); process.exit(1); }

  datasets.push({ ...spec, images });
}

// ─── main ─────────────────────────────────────────────────────────────────────

const totalImages = datasets.reduce((s, ds) => s + ds.images.length, 0);

console.log(`\nCalibration — metrics: ${METRIC_NAMES.join(', ')}`);
console.log(`step: ${STEP}  concurrency: ${CONCURRENCY}  avif-speed: ${AVIF_SPEED}${ENCODE_ONLY ? '  [encode-only]' : ''}`);
console.log(`cache: ${CACHE_DIR}\n`);
for (const ds of datasets) {
  console.log(`  ${ds.type.padEnd(14)} ${ds.images.length} images  →  ${ds.outputDir}`);
}
console.log();

const start = Date.now();

// ── Phase 1: encode ──────────────────────────────────────────────────────────
// Encodes all images at all quality steps. Cached — skips existing files.

const encodeTicks   = totalImages * JPEG_QUALITIES.length;
const encodeProgress = makeProgress(encodeTicks, 0);

const encodeTasks = [];
for (const ds of datasets) {
  for (const { path, label } of ds.images) {
    const imageCache = join(CACHE_DIR, ds.type, label);
    encodeTasks.push(() => encodeImage(path, label, ds.type, imageCache));
  }
}

const imageInfos = await runPool(encodeTasks, CONCURRENCY);
encodeProgress.done();

if (ENCODE_ONLY) {
  console.log(`\nEncodings ready at: ${CACHE_DIR}`);
  console.log(`Run without --encode-only to measure metrics.`);
  process.exit(0);
}

// ── Phase 2: measure — one metric at a time ──────────────────────────────────
// Each metric gets its own progress bar and runs with exactly CONCURRENCY
// workers total. No parallel Python processes from different metrics.

const measureTicks    = totalImages * JPEG_QUALITIES.length * 3;  // per metric
let   measureProgress = { tick: () => {}, done: () => {} };       // placeholder

for (const m of activeMetrics) {
  process.stderr.write(`\n[${m.name}]\n`);
  measureProgress = makeProgress(measureTicks, 0);

  const imageResults = await measureMetric(m, imageInfos);
  measureProgress.done();

  // Write one calibration file per dataset for this metric
  for (const ds of datasets) {
    const dsImageResults = Object.fromEntries(
      Object.entries(imageResults).filter(([label]) =>
        ds.images.some(img => img.label === label)
      )
    );

    const averaged = averageCurves(dsImageResults, m.name);
    const filename = `${m.name}-calibration-${ds.type}.json`;
    const outPath  = join(ds.outputDir, filename);

    const merged  = mergeCurve(outPath, averaged, m.scoreField);
    const isMerge = !OVERWRITE && existsSync(outPath);

    const output = {
      '$schema':        'calibration-schema',
      metric:           m.name,
      higher_is_better: m.higherIsBetter,
      content_type:     ds.type,
      description:      `JPEG→WebP/AVIF quality equivalence for ${ds.type} content using ${m.name}. Step ${STEP}, AVIF speed 0.`,
      generated:        new Date().toISOString(),
      images:           Object.keys(dsImageResults).length,
      step:             STEP,
      data_points:      merged.length,
      encoders:         { cwebp: 'cwebp -m 6', avifenc: `avifenc --speed ${AVIF_SPEED}` },
      curve:            merged,
    };

    writeFileSync(outPath, JSON.stringify(output, null, 2));

    const mergeTag = isMerge ? ` (merged → ${merged.length} pts)` : ` (${merged.length} pts)`;
    console.log(`  ${ds.type.padEnd(14)} →  ${filename}${mergeTag}`);
    console.log(`  JPEG │ ${m.scoreField.padEnd(14)} │  WebP  │  AVIF`);
    console.log(`───────┼─${'─'.repeat(m.scoreField.length + 1)}──┼────────┼───────`);
    for (const row of averaged) {
      const sv = row[m.scoreField];
      console.log(`  ${String(row.jpeg_q).padStart(3)}  │  ${String(sv ?? '—').padStart(m.scoreField.length)}  │  ${String(row.webp_q ?? '—').padStart(4)}  │  ${String(row.avif_q ?? '—').padStart(4)}`);
    }
  }

  // Free this metric's Python worker pool before starting the next metric, so only
  // one metric's models are resident at a time.
  closeAllPyPools();
}

const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
console.log(`\nDone in ${elapsed}m`);
console.log(`Encodings cached at: ${CACHE_DIR}`);
