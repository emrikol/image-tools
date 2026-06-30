#!/usr/bin/env node
/**
 * convert.mjs
 *
 * Converts a JPEG to the smallest possible WebP and AVIF at equivalent
 * perceptual quality, using a calibrated quality curve and parameter fuzzing.
 *
 * Usage:
 *   node convert.mjs <input.jpg> [output-dir] [options]
 *
 * Modes:
 *   (default)              FAST: encode straight at the calibrated quality from the frozen
 *                          curves. Needs only cwebp + avifenc (no ssimulacra2, no ImageMagick).
 *   --verify               Binary-search the lowest quality whose encode clears an absolute
 *                          SSIMULACRA2 floor vs the source JPEG (classification-independent).
 *                          Needs ssimulacra2 + avifdec/dwebp (or ImageMagick) to score.
 *
 * Options:
 *   --calibration <path>   Path to calibration.json (default: same dir as script)
 *   --floor <n>            [--verify] absolute SSIMULACRA2 floor vs the source JPEG (default: 80;
 *                          higher = stricter fidelity / larger files)
 *   --keep-both            Output both WebP and AVIF even if one wins
 *   --ssim-only            Use only the ssimulacra2 curve; ignore the other metric curves
 *   --report               Print full results table
 *   --contact-sheet        Write <stem>-compare.png: original JPEG vs best WebP vs best
 *                          AVIF at full size, captioned with size + SSIMULACRA2 score
 */

import { execFile }                             from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, basename, extname }     from 'path';
import { tmpdir }                               from 'os';
import { promisify }                            from 'util';
import { randomBytes }                          from 'crypto';
import { fileURLToPath }                        from 'url';
import { classifyImage }                        from './classify.mjs';

const execFileAsync = promisify(execFile);
const __dirname     = dirname(fileURLToPath(import.meta.url));

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag, defaultVal) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : defaultVal;
}
function hasFlag(flag) { return args.includes(flag); }

// Collect named-flag values so we can exclude them from positional args
const namedFlagValues = new Set(
  ['--calibration', '--quality-window', '--ssim-tolerance', '--floor', '--type']
    .map(f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; })
    .filter(Boolean)
);
const positional = args.filter(a => !a.startsWith('--') && !namedFlagValues.has(a));

const INPUT          = positional[0] ?? null;
const OUTPUT_DIR     = positional[1] ?? dirname(INPUT || '.');
const QUALITY_WINDOW = parseInt(getArg('--quality-window', '5'));  // (legacy; unused by the floor search)
// Absolute SSIMULACRA2 floor vs the source JPEG for --verify (content-independent, so
// "equivalent quality" means the same thing on every image). 80 ≈ high-fidelity reproduction
// while still compressing well; raise toward 85–88 for stricter fidelity (larger files).
// --ssim-tolerance is accepted for back-compat but no longer used.
const FLOOR = parseFloat(getArg('--floor', '80'));
const KEEP_BOTH       = hasFlag('--keep-both');
const REPORT          = hasFlag('--report');
const KEEP_ARTIFACTS  = hasFlag('--keep-image-artifacts');  // preserve tmp dir for reuse
const TYPE_OVERRIDE   = getArg('--type', 'auto');  // auto|photo|illustration|line-art|mixed|pixel-art
// Use only the ssimulacra2 curve, ignoring the other metric curves. (--no-lap is the
// old, misleading name — kept as a deprecated alias.)
const SSIM_ONLY = hasFlag('--ssim-only') || hasFlag('--no-lap');
const CONTACT_SHEET = hasFlag('--contact-sheet') || hasFlag('--compare');  // visual JPEG/WebP/AVIF comparison PNG
const VERIFY = hasFlag('--verify');  // fuzz + enforce a per-image SSIMULACRA2 floor (default: fast curve-only)

if (!INPUT || !existsSync(INPUT)) {
  console.error('Usage: node convert.mjs <input.jpg> [output-dir] [--verify [--floor N]] [--type auto] [--ssim-only] [--keep-both] [--contact-sheet] [--keep-image-artifacts] [--report]');
  process.exit(1);
}

// ─── calibration loading ──────────────────────────────────────────────────────

// Auto-discover all calibration files for a content type.
// Loads every {metric}-calibration-{type}.json in the script directory.
// Falls back to {metric}-calibration-mixed.json for metrics that have no type-specific file.
// --calibration <path> explicitly adds an extra curve (useful for testing one-offs).
function loadCalibrations(type) {
  // 'mixed' has no dedicated calibration files. Fall back to the photo curves —
  // photo is the conservative choice (it requires the highest WebP/AVIF quality of
  // the three content types, so it won't under-encode an ambiguous image).
  if (type === 'mixed') {
    console.log('No mixed-specific calibration — falling back to photo curves.');
    type = 'photo';
  }

  if (SSIM_ONLY) {
    // Only load the primary SSIMULACRA2 curve; skip all others
    const ssimPath = join(__dirname, `ssimulacra2-calibration-${type}.json`);
    const fallback  = join(__dirname, `ssimulacra2-calibration-photo.json`);
    const path = existsSync(ssimPath) ? ssimPath : existsSync(fallback) ? fallback : null;
    if (!path) return [];
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return [{ metric: data.metric ?? 'ssimulacra2', description: data.description ?? '', curve: data.curve, path }];
  }

  const suffix      = `-calibration-${type}.json`;
  const mixedSuffix = `-calibration-mixed.json`;
  const all         = readdirSync(__dirname).filter(f => f.endsWith('.json'));

  const loaded    = [];
  const byMetric  = new Map();  // metric → loaded

  function loadFile(f, descSuffix = '') {
    try {
      const data = JSON.parse(readFileSync(join(__dirname, f), 'utf8'));
      if (!data.curve || !Array.isArray(data.curve)) return null;
      return {
        metric:         data.metric ?? f,
        higherIsBetter: data.higher_is_better ?? true,  // default to higher=better for legacy files
        description:    (data.description ?? '') + descSuffix,
        curve:          data.curve,
        path:           f,
      };
    } catch { return null; }
  }

  for (const f of all.filter(f => f.endsWith(suffix))) {
    const cal = loadFile(f);
    if (!cal) continue;
    byMetric.set(cal.metric, true);
    loaded.push(cal);
  }

  // For metrics that only have a mixed file, use it as fallback for unrecognized types
  if (type !== 'mixed') {
    for (const f of all.filter(f => f.endsWith(mixedSuffix))) {
      const cal = loadFile(f, ' (mixed fallback)');
      if (!cal || byMetric.has(cal.metric)) continue;
      loaded.push(cal);
    }
  }

  // Honour explicit --calibration override (adds to the set)
  const explicit = getArg('--calibration', null);
  if (explicit && existsSync(explicit)) {
    const cal = loadFile(explicit);
    if (cal) loaded.push(cal);
  }

  return loaded;
}

// ─── cwebp / avifenc parameter grids ─────────────────────────────────────────

const WEBP_SNS     = [20, 40, 60, 80];          // spatial noise shaping
const WEBP_FILTER  = [20, 40, 60, 80];          // deblocking filter strength
const AVIF_SPEED   = 0;                          // slowest = best compression

// ─── helpers ──────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), 'convert-' + randomBytes(4).toString('hex'));
mkdirSync(TMP, { recursive: true });
if (KEEP_ARTIFACTS) console.log(`Artifacts dir: ${TMP}`);

// Clean up the temp working dir on any exit (normal, error, or early exit),
// unless --keep-image-artifacts was requested. Runs synchronously in the exit hook.
process.on('exit', () => {
  if (!KEEP_ARTIFACTS) { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
});

async function exec(cmd, args) {
  try {
    return await execFileAsync(cmd, args, { encoding: 'utf8' }).catch(e => e);
  } catch {
    return { stdout: '', stderr: '' };
  }
}

async function measureQuality(ref, compressed) {
  // ssimulacra2 only reads PNG/JPEG — decode AVIF/WebP to PNG first. Use the encoders'
  // own decoders (avifdec/dwebp, which ship alongside avifenc/cwebp); fall back to magick.
  let cmpPng = compressed;
  let tmpPng  = null;
  if (/\.avif$/i.test(compressed)) {
    tmpPng = compressed + '._ssim.png';
    let r = await exec('avifdec', ['--quiet', compressed, tmpPng]);
    if (!existsSync(tmpPng)) await exec('magick', ['convert', compressed, tmpPng]);
    cmpPng = tmpPng;
  } else if (/\.webp$/i.test(compressed)) {
    tmpPng = compressed + '._ssim.png';
    await exec('dwebp', ['-quiet', compressed, '-o', tmpPng]);
    if (!existsSync(tmpPng)) await exec('magick', ['convert', compressed, tmpPng]);
    cmpPng = tmpPng;
  }
  try {
    const result = await exec('ssimulacra2', [ref, cmpPng]);
    const output = result.stdout || result.stderr || '';
    const match  = output.match(/(-?[\d.]+)/);
    return match ? parseFloat(parseFloat(match[1]).toFixed(4)) : null;
  } finally {
    if (tmpPng) { try { unlinkSync(tmpPng); } catch {} }
  }
}

function fileSize(path) {
  try { return readFileSync(path).length; } catch { return Infinity; }
}

async function encodeWebP(src, quality, sns, filter, out) {
  await exec('cwebp', [
    '-q', String(quality),
    '-m', '6',
    '-sns', String(sns),
    '-f', String(filter),
    '-quiet', src, '-o', out,
  ]);
}

async function encodeAVIF(src, quality, out) {
  await exec('avifenc', ['-q', String(quality), '--speed', String(AVIF_SPEED), src, out]);
}

// ─── JPEG quality estimation (no external dependency) ─────────────────────────
//
// Reads the DQT quantization table(s) and applies ImageMagick's quality heuristic
// (coders/jpeg.c) — encoder-agnostic, matches `magick identify -format %Q` within ±1
// across the full 1–100 range (validated). Lets the fast path avoid ImageMagick entirely.

const JPEG_HASH = [
  1020,1015,932,848,780,735,702,679,660,645,632,623,613,607,600,594,589,585,581,571,
  555,542,529,514,494,474,457,439,424,410,397,386,373,364,351,341,334,324,317,309,
  299,294,287,279,274,267,262,257,251,247,243,237,232,227,222,217,213,207,202,198,
  192,188,183,177,173,168,163,157,153,148,143,139,132,128,125,119,115,108,104,99,
  94,90,84,79,74,70,64,59,55,49,45,40,34,30,25,20,15,11,6,4,0];
const JPEG_SUMS = [
  32640,32635,32266,31495,30665,29804,29146,28599,28104,27670,27225,26725,26210,25716,25240,
  24789,24373,23946,23572,22846,21801,20842,19949,19121,18386,17651,16998,16349,15800,15247,
  14783,14321,13859,13535,13081,12702,12423,12056,11779,11513,11135,10955,10676,10392,10208,
  9928,9747,9564,9369,9193,9017,8822,8639,8458,8270,8084,7896,7710,7527,7347,7156,6977,6788,
  6607,6422,6236,6054,5867,5684,5495,5305,5128,4945,4751,4638,4442,4248,4065,3888,3698,3509,
  3326,3139,2957,2775,2586,2405,2216,2037,1846,1666,1483,1297,1109,927,735,554,375,201,128,0];
const JPEG_HASH1 = [
  510,505,422,380,355,338,326,318,311,305,300,297,293,291,288,286,284,283,281,280,
  279,278,277,273,262,251,243,233,225,218,211,205,198,193,186,181,177,172,168,164,
  158,156,152,148,145,142,139,136,133,131,129,126,123,120,118,115,113,110,107,105,
  102,100,97,94,92,89,87,83,81,79,76,74,70,68,66,63,61,57,55,52,50,48,44,42,39,37,
  34,31,29,26,24,21,18,16,13,11,8,6,3,2,0];
const JPEG_SUMS1 = [
  16320,16315,15946,15277,14655,14073,13623,13230,12859,12560,12240,11861,11456,11081,10714,
  10360,10027,9679,9368,9056,8680,8331,7995,7668,7376,7084,6823,6562,6345,6125,5939,5756,
  5571,5421,5240,5086,4976,4829,4719,4616,4463,4393,4280,4166,4092,3980,3909,3835,3755,3688,
  3621,3541,3467,3396,3323,3247,3170,3096,3021,2952,2874,2804,2727,2657,2583,2509,2437,2362,
  2290,2211,2136,2068,1996,1915,1858,1773,1692,1620,1552,1477,1398,1326,1251,1179,1109,1031,
  961,884,814,736,667,592,518,441,369,292,221,151,86,64,0];

function jpegQualityFromBytes(path) {
  let b;
  try { b = readFileSync(path); } catch { return null; }
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null;  // not a JPEG
  const tables = [];
  let i = 2;
  while (i < b.length - 1) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xD9) break;
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xDB) {  // DQT (may pack several tables)
      let p = i + 4; const end = i + 2 + len;
      while (p < end) {
        const pq = b[p] >> 4, tq = b[p] & 0x0F; p++;
        const t = [];
        for (let k = 0; k < 64; k++) { t.push(pq ? ((b[p] << 8) | b[p + 1]) : b[p]); p += pq ? 2 : 1; }
        tables[tq] = t;
      }
    }
    if (m === 0xDA) break;  // start of scan — image data follows
    i += 2 + len;
  }
  const qt = tables.filter(Boolean);
  if (qt.length === 0) return null;
  let sum = 0;
  for (const t of qt) for (const v of t) sum += v;
  let hash, sums, qvalue;
  if (qt.length >= 2 && qt[1]) {
    qvalue = qt[0][2] + qt[0][53] + qt[1][0] + qt[1][63];
    hash = JPEG_HASH; sums = JPEG_SUMS;
  } else {
    qvalue = qt[0][2] + qt[0][53];
    hash = JPEG_HASH1; sums = JPEG_SUMS1;
  }
  for (let k = 0; k < 100; k++) {
    if (qvalue < hash[k] && sum < sums[k]) continue;
    return k + 1;
  }
  return 100;
}

async function detectJpegQuality(path) {
  const q = jpegQualityFromBytes(path);
  if (q !== null) return q;
  // Fallback for non-standard JPEGs: ImageMagick, if available.
  const result = await exec('magick', ['identify', '-verbose', path]);
  const output = result.stdout || result.stderr || '';
  const match  = output.match(/Quality:\s*(\d+)/);
  return match ? parseInt(match[1]) : null;
}

// ─── calibration curve interpolation ─────────────────────────────────────────

function interpolate(curve, jpegQ, field) {
  // Find surrounding data points and linearly interpolate
  const sorted = [...curve].sort((a, b) => a.jpeg_q - b.jpeg_q);
  const lo = [...sorted].reverse().find(r => r.jpeg_q <= jpegQ && r[field] !== null);
  const hi = sorted.find(r => r.jpeg_q >= jpegQ && r[field] !== null);
  if (!lo && !hi) return null;
  if (!lo) return hi[field];
  if (!hi) return lo[field];
  if (lo.jpeg_q === hi.jpeg_q) return lo[field];
  const t = (jpegQ - lo.jpeg_q) / (hi.jpeg_q - lo.jpeg_q);
  return Math.round(lo[field] + t * (hi[field] - lo[field]));
}

// ─── main ──────────────────────────────────────────────────────────────────────

const stem = basename(INPUT, extname(INPUT));
mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`\nInput:  ${INPUT}`);

// 0. Classify content type and resolve calibration curve
let contentType = TYPE_OVERRIDE;
if (contentType === 'auto') {
  const classification = await classifyImage(INPUT);
  contentType = classification.type ?? 'mixed';
  console.log(`Detected type: ${contentType} (confidence: ${classification.confidence})`);
} else {
  console.log(`Content type: ${contentType} (manual override)`);
}

if (contentType === 'pixel-art') {
  console.log('Pixel-art detected — lossy encoding not recommended. Use oxipng/optipng on the original PNG instead.');
  process.exit(0);
}

// 1. Detect JPEG quality
const jpegQ = await detectJpegQuality(INPUT);
if (jpegQ === null) { console.error('Could not detect JPEG quality.'); process.exit(1); }
console.log(`JPEG quality: ${jpegQ}`);

// 2. Load all calibration curves and take the max quality across all
const calibrations = loadCalibrations(contentType);
if (calibrations.length === 0) {
  console.error(`No calibration curves found for content type "${contentType}". Expected {metric}-calibration-${contentType}.json alongside this script (they ship with the repo).`);
  process.exit(1);
}

let calibWebP = 1, calibAVIF = 1;
for (const cal of calibrations) {
  const wq = interpolate(cal.curve, jpegQ, 'webp_q');
  const aq = interpolate(cal.curve, jpegQ, 'avif_q');
  console.log(`${cal.metric.padEnd(16)} — WebP: q=${String(wq ?? '—').padStart(3)}  AVIF: q=${String(aq ?? '—').padStart(3)}  (${cal.path})`);
  if (wq !== null) calibWebP = Math.max(calibWebP, wq);
  if (aq !== null) calibAVIF = Math.max(calibAVIF, aq);
}
if (calibrations.length > 1) {
  console.log(`${'Using (max)'.padEnd(16)} — WebP: q=${calibWebP}  AVIF: q=${calibAVIF}`);
}

// 3. Encode candidates.
//    FAST (default): one encode each at the calibrated quality — no measurement, so it needs
//      only cwebp + avifenc. Trusts the frozen curves.
//    --verify: establish a per-image SSIMULACRA2 floor from a baseline encode, then fuzz the
//      encoder parameters and keep only candidates that clear the floor.
const origSize    = fileSize(INPUT);
const clampQ      = (q) => Math.min(100, Math.max(1, Math.round(q)));
const webpResults = [];
const avifResults = [];
let   scoreFloor  = null;

if (!VERIFY) {
  console.log('Mode: fast (curve-only). Pass --verify for per-image SSIMULACRA2 fuzzing.\n');
  const wq   = clampQ(calibWebP);
  const wout = join(TMP, `${stem}_webp_q${wq}.webp`);
  await encodeWebP(INPUT, wq, 50, 60, wout);
  webpResults.push({ q: wq, sns: 50, f: 60, size: fileSize(wout), score: null, out: wout });

  const aq   = clampQ(calibAVIF);
  const aout = join(TMP, `${stem}_avif_q${aq}.avif`);
  await encodeAVIF(INPUT, aq, aout);
  avifResults.push({ q: aq, size: fileSize(aout), score: null, out: aout });
} else {
  // VERIFY — binary-search the lowest quality whose re-encode clears the absolute SSIMULACRA2
  // floor vs the source JPEG. Classification-independent (the calibrated quality from the curves
  // is just a hint here; the floor is the guarantee). Score is monotonic in quality, so binary
  // search finds the smallest passing encode in ~7 steps instead of fuzzing a fixed window.
  scoreFloor = FLOOR;
  console.log(`Mode: verify. Absolute SSIMULACRA2 floor vs source JPEG: ${FLOOR.toFixed(1)}\n`);

  async function lowestQualityMeetingFloor(label, encodeAtQ) {
    process.stdout.write(`Searching ${label} `);
    let lo = 1, hi = 100, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await encodeAtQ(mid);
      process.stdout.write('.');
      if (r.score !== null && r.score >= FLOOR) { best = r; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    if (best) { console.log(`  → q${best.q} (score ${best.score.toFixed(2)})`); return { ...best, met: true }; }
    const r = await encodeAtQ(100);  // floor unreachable — best effort at max quality
    console.log(`  → floor unreachable; q100 (score ${r.score == null ? 'n/a' : r.score.toFixed(2)})`);
    return { ...r, met: false };
  }

  const avif = await lowestQualityMeetingFloor('AVIF', async (q) => {
    const out = join(TMP, `${stem}_avif_q${q}.avif`);
    await encodeAVIF(INPUT, q, out);
    return { q, sns: null, f: null, size: fileSize(out), score: await measureQuality(INPUT, out), out };
  });
  if (avif.score === null) {
    console.error('\nCould not measure encodes — is `ssimulacra2` installed? Omit --verify for fast (curve-only) mode.');
    process.exit(1);
  }
  avifResults.push(avif);

  const webp = await lowestQualityMeetingFloor('WebP', async (q) => {
    const out = join(TMP, `${stem}_webp_q${q}_s50_f60.webp`);
    await encodeWebP(INPUT, q, 50, 60, out);
    return { q, sns: 50, f: 60, size: fileSize(out), score: await measureQuality(INPUT, out), out };
  });
  webpResults.push(webp);
  if (webp.met) {
    // At the floor-meeting quality, fuzz spatial-noise-shaping / filter to shrink further.
    process.stdout.write('Tuning WebP ');
    for (const sns of WEBP_SNS) {
      for (const f of WEBP_FILTER) {
        const out   = join(TMP, `${stem}_webp_q${webp.q}_s${sns}_f${f}.webp`);
        await encodeWebP(INPUT, webp.q, sns, f, out);
        const score = await measureQuality(INPUT, out);
        if (score !== null && score >= FLOOR) webpResults.push({ q: webp.q, sns, f, size: fileSize(out), score, out });
        process.stdout.write('.');
      }
    }
    console.log();
  }
  if (!avif.met || !webp.met) {
    console.log(`\n⚠  Floor ${FLOOR.toFixed(1)} not reachable for ${[!avif.met && 'AVIF', !webp.met && 'WebP'].filter(Boolean).join(' & ')} below q100 — using best effort.`);
  }
  console.log();
}

// 6. Pick winners
webpResults.sort((a, b) => a.size - b.size);
avifResults.sort((a, b) => a.size - b.size);

const bestWebP = webpResults[0] ?? null;
const bestAVIF = avifResults[0] ?? null;

// 7. Report
function kb(bytes) { return (bytes / 1024).toFixed(1) + 'KB'; }
function pct(a, b) { return (((b - a) / b) * 100).toFixed(1) + '%'; }
function scoreStr(s) { return s == null ? 'n/a (fast)' : `score=${s.toFixed(2)}`; }

console.log(`Original JPEG:  ${kb(origSize)}`);
if (bestWebP) console.log(`Best WebP:      ${kb(bestWebP.size)}  (${pct(bestWebP.size, origSize)} smaller)  q=${bestWebP.q} sns=${bestWebP.sns} f=${bestWebP.f}  ${scoreStr(bestWebP.score)}`);
if (bestAVIF) console.log(`Best AVIF:      ${kb(bestAVIF.size)}  (${pct(bestAVIF.size, origSize)} smaller)  q=${bestAVIF.q}  ${scoreStr(bestAVIF.score)}`);

if (REPORT) {
  console.log('\n── WebP results (sorted by size) ───');
  for (const r of webpResults.slice(0, 10)) {
    console.log(`  ${kb(r.size).padStart(8)}  q=${r.q} sns=${r.sns} f=${r.f}  ${scoreStr(r.score)}`);
  }
  console.log('\n── AVIF results ─────────────────────────────────────────');
  for (const r of avifResults) {
    console.log(`  ${kb(r.size).padStart(8)}  q=${r.q}  ${scoreStr(r.score)}`);
  }
}

// 8. Copy winner to output dir
const overallWinner = (!bestWebP) ? bestAVIF :
                      (!bestAVIF) ? bestWebP :
                      bestWebP.size <= bestAVIF.size ? bestWebP : bestAVIF;

if (!overallWinner) {
  console.error('\nNo valid encodings produced.');
  process.exit(1);
}

// Never make the file bigger: if the best encoding isn't smaller than the source JPEG, keep
// the original. (A migration tool must never bloat — surface it honestly instead.)
if (overallWinner.size >= origSize && !KEEP_BOTH) {
  console.log(`\n⚠  No encoding beat the source JPEG (${kb(origSize)}) at floor ${FLOOR.toFixed(1)} — keeping the original JPEG.`);
  console.log(`   (Lower the bar with --floor <n>, or force a write with --keep-both.)`);
  process.exit(0);
}

const winnerExt  = overallWinner === bestAVIF ? 'avif' : 'webp';
const winnerPath = join(OUTPUT_DIR, `${stem}.${winnerExt}`);
writeFileSync(winnerPath, readFileSync(overallWinner.out));

console.log(`\n✓ Winner: ${winnerPath}  (${kb(overallWinner.size)}, ${pct(overallWinner.size, origSize)} smaller than JPEG)`);

if (KEEP_BOTH) {
  if (bestWebP && overallWinner !== bestWebP) {
    const p = join(OUTPUT_DIR, `${stem}.webp`);
    writeFileSync(p, readFileSync(bestWebP.out));
    console.log(`  Also saved: ${p}`);
  }
  if (bestAVIF && overallWinner !== bestAVIF) {
    const p = join(OUTPUT_DIR, `${stem}.avif`);
    writeFileSync(p, readFileSync(bestAVIF.out));
    console.log(`  Also saved: ${p}`);
  }
}

// 9. Optional: full-size visual comparison sheet.
//    Shows the original JPEG next to the WebP and AVIF that our calibrated curves +
//    SSIMULACRA2 floor judge perceptually equivalent — i.e. the smallest encodings the
//    statistics say look the same as the JPEG. Lets a human sanity-check that claim.
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

async function buildContactSheet() {
  const ss = (s) => (s == null ? '' : `   ·   SSIMULACRA2 ${s.toFixed(2)}`);
  const refNote = scoreFloor == null ? 'reference, fast mode' : `reference, floor ${scoreFloor.toFixed(2)}`;
  const tiles = [];
  tiles.push({
    path: INPUT,
    label: `ORIGINAL JPEG  ·  q${jpegQ}  ·  ${contentType}\n${kb(origSize)}   (${refNote})`,
  });
  if (bestWebP) tiles.push({
    path: bestWebP.out,
    label: `WebP  ·  q${bestWebP.q} sns${bestWebP.sns} f${bestWebP.f}${overallWinner === bestWebP ? '   ✓ WINNER' : ''}\n`
         + `${kb(bestWebP.size)}  (${pct(bestWebP.size, origSize)} smaller)${ss(bestWebP.score)}`,
  });
  if (bestAVIF) tiles.push({
    path: bestAVIF.out,
    label: `AVIF  ·  q${bestAVIF.q}${overallWinner === bestAVIF ? '   ✓ WINNER' : ''}\n`
         + `${kb(bestAVIF.size)}  (${pct(bestAVIF.size, origSize)} smaller)${ss(bestAVIF.score)}`,
  });

  // Adaptive layout: landscape images stack vertically (each full width, easy top-to-bottom
  // compare); portrait images sit side by side.
  const dims = await exec('magick', ['identify', '-format', '%w %h', INPUT]);
  const [w, h] = (dims.stdout || '').trim().split(/\s+/).map(Number);
  const landscape = (w && h) ? w >= h : true;
  const tile = landscape ? `1x${tiles.length}` : `${tiles.length}x1`;

  const sheetPath  = join(OUTPUT_DIR, `${stem}-compare.png`);
  const bodyPath   = join(TMP, `${stem}_compare_body.png`);
  const headerPath = join(TMP, `${stem}_compare_header.png`);
  const font = FONT_CANDIDATES.find(p => existsSync(p));

  // 1. Montage the full-size tiles. No -title here: montage clips a title wider than the
  //    canvas, so the header is built separately and stacked on top (step 2).
  const mArgs = ['montage'];
  for (const t of tiles) mArgs.push('-label', t.label, t.path);
  mArgs.push(
    '-tile', tile,
    '-geometry', '+14+12',   // '+x+y' with no WxH = full size, no downscaling
    '-background', 'white',
    '-fill', '#111111',
    '-pointsize', '18',
  );
  if (font) mArgs.push('-font', font);
  mArgs.push(bodyPath);
  const r = await exec('magick', mArgs);

  if (!existsSync(bodyPath)) {
    console.error(`\n⚠  Could not build comparison sheet: ${(r.stderr || r.message || 'unknown error').split('\n')[0]}`);
    return;
  }

  // 2. Build a width-matched header that auto-wraps (caption:) so it never clips, then
  //    append it above the montage body.
  const bodyW = parseInt(((await exec('magick', ['identify', '-format', '%w', bodyPath])).stdout || '').trim()) || 0;
  const titleText = `${basename(INPUT)}    ·    perceptually-matched  JPEG / WebP / AVIF    ·    content: ${contentType}`;
  if (bodyW > 0) {
    const hArgs = ['-background', '#f2f2f2', '-fill', '#111111'];
    if (font) hArgs.push('-font', font);
    hArgs.push('-pointsize', '24', '-size', `${bodyW}x`, '-gravity', 'center', `caption:${titleText}`, headerPath);
    await exec('magick', hArgs);
  }
  if (existsSync(headerPath)) {
    await exec('magick', [headerPath, bodyPath, '-background', 'white', '-append', sheetPath]);
  }
  if (!existsSync(sheetPath)) await exec('magick', [bodyPath, sheetPath]);  // fallback: body only

  if (existsSync(sheetPath)) {
    console.log(`\n🖼  Comparison sheet: ${sheetPath}`);
  } else {
    console.error(`\n⚠  Could not build comparison sheet.`);
  }
}

if (CONTACT_SHEET) await buildContactSheet();

if (KEEP_ARTIFACTS) {
  console.log(`\nArtifacts preserved at: ${TMP}`);
  console.log(`  ${readdirSync(TMP).length} files (encoded candidates + comparison sheet)`);
}
