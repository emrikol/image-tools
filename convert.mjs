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
 * Options:
 *   --calibration <path>   Path to calibration.json (default: same dir as script)
 *   --quality-window <n>   ± quality points to fuzz around calibrated value (default: 5)
 *   --ssim-tolerance <n>   Allow SSIMULACRA2 score to drop this much below baseline (default: 1.0)
 *   --keep-both            Output both WebP and AVIF even if one wins
 *   --report               Print full results table
 *   --contact-sheet        Write <stem>-compare.png: original JPEG vs best WebP vs best
 *                          AVIF at full size, captioned with size + SSIMULACRA2 score
 */

import { execFile }                             from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'fs';
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
  ['--calibration', '--quality-window', '--ssim-tolerance', '--type']
    .map(f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; })
    .filter(Boolean)
);
const positional = args.filter(a => !a.startsWith('--') && !namedFlagValues.has(a));

const INPUT          = positional[0] ?? null;
const OUTPUT_DIR     = positional[1] ?? dirname(INPUT || '.');
const QUALITY_WINDOW = parseInt(getArg('--quality-window', '5'));
const SSIM_TOLERANCE = parseFloat(getArg('--ssim-tolerance', '1.0'));
const KEEP_BOTH       = hasFlag('--keep-both');
const REPORT          = hasFlag('--report');
const KEEP_ARTIFACTS  = hasFlag('--keep-image-artifacts');  // preserve tmp dir for reuse
const TYPE_OVERRIDE   = getArg('--type', 'auto');  // auto|photo|illustration|line-art|mixed|pixel-art
const NO_LAP = hasFlag('--no-lap');  // disable Laplacian calibration
const CONTACT_SHEET = hasFlag('--contact-sheet') || hasFlag('--compare');  // visual JPEG/WebP/AVIF comparison PNG

if (!INPUT || !existsSync(INPUT)) {
  console.error('Usage: node convert.mjs <input.jpg> [output-dir] [--type auto] [--no-lap] [--keep-both] [--contact-sheet] [--keep-image-artifacts] [--report]');
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

  if (NO_LAP) {
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

async function exec(cmd, args) {
  try {
    return await execFileAsync(cmd, args, { encoding: 'utf8' }).catch(e => e);
  } catch {
    return { stdout: '', stderr: '' };
  }
}

async function measureQuality(ref, compressed) {
  // ssimulacra2 only reads PNG/JPEG — decode AVIF/WebP to PNG before measuring.
  let cmpPng = compressed;
  let tmpPng  = null;
  if (/\.(avif|webp)$/i.test(compressed)) {
    tmpPng = compressed + '._ssim.png';
    await exec('magick', ['convert', compressed, tmpPng]);
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

async function detectJpegQuality(path) {
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
  console.error('No calibration files found. Run calibrate.mjs first.');
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

// 3. Encode baseline WebP at calibrated quality, measure score → floor
const baselinePath  = join(TMP, `${stem}_baseline.webp`);
await encodeWebP(INPUT, calibWebP, 50, 60, baselinePath);
const baselineScore = await measureQuality(INPUT, baselinePath);
const scoreFloor    = baselineScore - SSIM_TOLERANCE;
console.log(`Baseline score: ${baselineScore?.toFixed(2)}  Floor: ${scoreFloor?.toFixed(2)}\n`);

// 4. Fuzz WebP
const origSize = fileSize(INPUT);
const webpResults = [];

process.stdout.write('Fuzzing WebP ');
const webpQualities = Array.from(
  { length: QUALITY_WINDOW * 2 + 1 },
  (_, i) => Math.min(100, Math.max(1, calibWebP - QUALITY_WINDOW + i))
).filter((v, i, a) => a.indexOf(v) === i);

for (const q of webpQualities) {
  for (const sns of WEBP_SNS) {
    for (const f of WEBP_FILTER) {
      const out   = join(TMP, `${stem}_webp_q${q}_s${sns}_f${f}.webp`);
      await encodeWebP(INPUT, q, sns, f, out);
      const size  = fileSize(out);
      const score = await measureQuality(INPUT, out);
      if (score !== null && score >= scoreFloor) {
        webpResults.push({ q, sns, f, size, score, out });
      }
      process.stdout.write('.');
    }
  }
}
console.log();

// 5. Fuzz AVIF
const avifResults = [];

process.stdout.write('Fuzzing AVIF ');
const avifQualities = Array.from(
  { length: QUALITY_WINDOW * 2 + 1 },
  (_, i) => Math.min(100, Math.max(1, calibAVIF - QUALITY_WINDOW + i))
).filter((v, i, a) => a.indexOf(v) === i);

for (const q of avifQualities) {
  const out   = join(TMP, `${stem}_avif_q${q}.avif`);
  await encodeAVIF(INPUT, q, out);
  const size  = fileSize(out);
  const score = await measureQuality(INPUT, out);
  if (score !== null && score >= scoreFloor) {
    avifResults.push({ q, size, score, out });
  }
  process.stdout.write('.');
}
console.log('\n');

// 6. Pick winners
webpResults.sort((a, b) => a.size - b.size);
avifResults.sort((a, b) => a.size - b.size);

const bestWebP = webpResults[0] ?? null;
const bestAVIF = avifResults[0] ?? null;

// 7. Report
function kb(bytes) { return (bytes / 1024).toFixed(1) + 'KB'; }
function pct(a, b) { return (((b - a) / b) * 100).toFixed(1) + '%'; }

console.log(`Original JPEG:  ${kb(origSize)}`);
if (bestWebP) console.log(`Best WebP:      ${kb(bestWebP.size)}  (${pct(bestWebP.size, origSize)} smaller)  q=${bestWebP.q} sns=${bestWebP.sns} f=${bestWebP.f}  score=${bestWebP.score.toFixed(2)}`);
if (bestAVIF) console.log(`Best AVIF:      ${kb(bestAVIF.size)}  (${pct(bestAVIF.size, origSize)} smaller)  q=${bestAVIF.q}  score=${bestAVIF.score.toFixed(2)}`);

if (REPORT) {
  console.log('\n── WebP results (meeting score floor, sorted by size) ───');
  for (const r of webpResults.slice(0, 10)) {
    console.log(`  ${kb(r.size).padStart(8)}  q=${r.q} sns=${r.sns} f=${r.f}  score=${r.score.toFixed(2)}`);
  }
  console.log('\n── AVIF results ─────────────────────────────────────────');
  for (const r of avifResults) {
    console.log(`  ${kb(r.size).padStart(8)}  q=${r.q}  score=${r.score.toFixed(2)}`);
  }
}

// 8. Copy winners to output dir
const overallWinner = (!bestWebP) ? bestAVIF :
                      (!bestAVIF) ? bestWebP :
                      bestWebP.size <= bestAVIF.size ? bestWebP : bestAVIF;

if (!overallWinner) {
  console.error('\nNo valid encodings found. Try increasing --quality-window or --ssim-tolerance (score drop budget).');
  process.exit(1);
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
  const tiles = [];
  tiles.push({
    path: INPUT,
    label: `ORIGINAL JPEG  ·  q${jpegQ}  ·  ${contentType}\n${kb(origSize)}   (reference, floor ${scoreFloor.toFixed(2)})`,
  });
  if (bestWebP) tiles.push({
    path: bestWebP.out,
    label: `WebP  ·  q${bestWebP.q} sns${bestWebP.sns} f${bestWebP.f}${overallWinner === bestWebP ? '   ✓ WINNER' : ''}\n`
         + `${kb(bestWebP.size)}  (${pct(bestWebP.size, origSize)} smaller)   ·   SSIMULACRA2 ${bestWebP.score.toFixed(2)}`,
  });
  if (bestAVIF) tiles.push({
    path: bestAVIF.out,
    label: `AVIF  ·  q${bestAVIF.q}${overallWinner === bestAVIF ? '   ✓ WINNER' : ''}\n`
         + `${kb(bestAVIF.size)}  (${pct(bestAVIF.size, origSize)} smaller)   ·   SSIMULACRA2 ${bestAVIF.score.toFixed(2)}`,
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
  console.log(`  ${readdirSync(TMP).length} files — reuse with a different curve set by pointing --output-dir here`);
}
