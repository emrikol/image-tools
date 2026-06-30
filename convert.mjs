#!/usr/bin/env node
/**
 * convert.mjs — CLI for the content-aware JPEG → WebP/AVIF converter.
 *
 * Thin wrapper over lib/convert.mjs (the engine). Handles arg parsing, the preflight tool
 * check, batch/directory mode, printing, writing the winner, and the optional comparison sheet.
 *
 * Usage:
 *   node convert.mjs <input.jpg|dir> [output-dir] [options]
 *
 * Modes:
 *   (default)        FAST: encode at the calibrated quality from the frozen curves
 *                    (needs only cwebp + avifenc).
 *   --verify         Binary-search the lowest quality that clears an absolute SSIMULACRA2
 *                    floor vs the source (needs ssimulacra2 + avifdec/dwebp or ImageMagick).
 *
 * Options:
 *   --floor <n>      [--verify] absolute SSIMULACRA2 floor (default 80; higher = stricter)
 *   --type <t>       auto|photo|illustration|line-art|mixed|pixel-art (default auto)
 *   --calibration <path>   add an extra calibration curve
 *   --ssim-only      use only the ssimulacra2 curve  (--no-lap = deprecated alias)
 *   --keep-both      write both WebP and AVIF
 *   --contact-sheet  also write <stem>-compare.png  (--compare alias)
 *   --dry-run        report the plan without encoding
 *   --report         print the full candidate table
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir, availableParallelism } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { convert } from './lib/convert.mjs';

const execFileAsync = promisify(execFile);

// ─── args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const hasFlag = (flag) => args.includes(flag);
const namedVals = new Set(['--calibration', '--floor', '--type', '--quality-window', '--ssim-tolerance']
  .map(f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; }).filter(Boolean));
const positional = args.filter(a => !a.startsWith('--') && !namedVals.has(a));

const INPUT = positional[0] ?? null;
const OUTPUT_DIR = positional[1] ?? dirname(INPUT || '.');
const FLOOR = parseFloat(getArg('--floor', '80'));
const TYPE = getArg('--type', 'auto');
const SSIM_ONLY = hasFlag('--ssim-only') || hasFlag('--no-lap');
const KEEP_BOTH = hasFlag('--keep-both');
const CONTACT_SHEET = hasFlag('--contact-sheet') || hasFlag('--compare');
const VERIFY = hasFlag('--verify');
const DRY_RUN = hasFlag('--dry-run');
const REPORT = hasFlag('--report');
const EXTRA_CALIBRATION = getArg('--calibration', null);

if (!INPUT || !existsSync(INPUT)) {
  console.error('Usage: node convert.mjs <input.jpg|dir> [output-dir] [--verify [--floor N]] [--type auto] [--ssim-only] [--keep-both] [--contact-sheet] [--dry-run] [--report]');
  process.exit(1);
}

// ─── preflight ────────────────────────────────────────────────────────────────
const onPath = (bin) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };
function requireTools() {
  const missing = [];
  if (!DRY_RUN) for (const t of ['cwebp', 'avifenc']) if (!onPath(t)) missing.push(t);
  if (VERIFY && !DRY_RUN && !onPath('ssimulacra2')) missing.push('ssimulacra2');
  if (missing.length) {
    console.error(`Missing required tool(s) on PATH: ${missing.join(', ')}`);
    console.error('Install: brew install webp libavif   (or: apt install webp libavif-bin)');
    if (missing.includes('ssimulacra2')) console.error('ssimulacra2 comes from a libjxl build with devtools; or drop --verify to use fast mode.');
    process.exit(1);
  }
}

const kb = (b) => (b / 1024).toFixed(1) + 'KB';
const pct = (a, b) => (((b - a) / b) * 100).toFixed(1) + '%';
const scoreStr = (s) => (s == null ? 'n/a (fast)' : `score=${s.toFixed(2)}`);
const convertOpts = { type: TYPE, verify: VERIFY, floor: FLOOR, ssimOnly: SSIM_ONLY, dryRun: DRY_RUN, extraCalibration: EXTRA_CALIBRATION };

// ─── batch: a directory of JPEGs (each in an isolated child process) ───────────
async function runBatch(dir) {
  const files = readdirSync(dir).filter(f => /\.jpe?g$/i.test(f)).sort();
  if (!files.length) { console.error(`No .jpg/.jpeg files in ${dir}`); process.exit(1); }
  requireTools();
  const childFlags = [];
  if (VERIFY) childFlags.push('--verify');
  childFlags.push('--floor', String(FLOOR));
  if (TYPE !== 'auto') childFlags.push('--type', TYPE);
  if (SSIM_ONLY) childFlags.push('--ssim-only');
  if (KEEP_BOTH) childFlags.push('--keep-both');
  if (CONTACT_SHEET) childFlags.push('--contact-sheet');
  if (DRY_RUN) childFlags.push('--dry-run');
  const self = fileURLToPath(import.meta.url);
  const runChild = (inPath) => new Promise((res) => {
    const p = spawn(process.execPath, [self, inPath, OUTPUT_DIR, ...childFlags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', (code) => res({ code, out }));
  });
  console.log(`Batch: ${files.length} JPEG(s) in ${dir}  (${VERIFY ? 'verify' : 'fast'} mode, ${availableParallelism()} parallel)\n`);
  let idx = 0, converted = 0, kept = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), files.length) }, async () => {
    while (idx < files.length) {
      const f = files[idx++];
      const { code, out } = await runChild(join(dir, f));
      const win = out.match(/✓ Winner:.*\((\d[\d.]*KB, [\d.]+% smaller[^)]*)\)/);
      if (code !== 0) { failed++; console.log(`  ✗ ${f}  (failed; rerun without batch to see why)`); }
      else if (/keeping the original/i.test(out)) { kept++; console.log(`  • ${f}  → kept original (no smaller encode)`); }
      else if (win) { converted++; console.log(`  ✓ ${f}  → ${win[1]}`); }
      else { converted++; console.log(`  ✓ ${f}`); }
    }
  }));
  console.log(`\nDone: ${converted} converted, ${kept} kept, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

// ─── single-file conversion ────────────────────────────────────────────────────
async function runSingle() {
  requireTools();
  const stem = basename(INPUT, extname(INPUT));
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`\nInput:  ${INPUT}`);

  // live progress, printed in natural order as the engine reaches each stage
  let curFmt = null;
  const onProgress = (e) => {
    if (e.type === 'classified') {
      console.log(e.confidence === 'manual'
        ? `Content type: ${e.contentType} (manual override)`
        : `Detected type: ${e.contentType} (confidence: ${e.confidence})`);
    } else if (e.type === 'quality') {
      console.log(`JPEG quality: ${e.jpegQ}`);
    } else if (e.type === 'curves') {
      for (const c of e.curves) console.log(`${c.metric.padEnd(16)} — WebP: q=${String(c.webp_q ?? '—').padStart(3)}  AVIF: q=${String(c.avif_q ?? '—').padStart(3)}  (${c.path})`);
      if (e.curves.length > 1) console.log(`${'Using (max)'.padEnd(16)} — WebP: q=${e.calibWebP}  AVIF: q=${e.calibAVIF}`);
    } else if (e.type === 'mode' && !DRY_RUN) {
      console.log(`Mode: ${e.mode === 'verify' ? `verify (floor ${FLOOR.toFixed(1)})` : 'fast (curve-only)'}\n`);
    } else if (e.type === 'search') {
      if (e.format !== curFmt) { if (curFmt) console.log(); process.stdout.write(`Searching ${e.format.toUpperCase()} `); curFmt = e.format; }
      process.stdout.write('.');
    }
  };

  let r;
  try {
    r = await convert(INPUT, { ...convertOpts, onProgress });
  } catch (e) {
    if (e.code === 'ENOTJPEG') console.error(`Could not read a JPEG quantization table from ${basename(INPUT)} — is it a JPEG? (This tool converts JPEGs.)`);
    else if (e.code === 'ENOCURVES') console.error(`No calibration curves found for this content type — expected {metric}-calibration-*.json beside the script (they ship with the repo).`);
    else if (e.code === 'ENOSSIM') console.error('Could not measure encodes — is `ssimulacra2` installed? Omit --verify for fast (curve-only) mode.');
    else console.error(`Conversion failed: ${e.message}`);
    process.exit(1);
  }
  if (curFmt) console.log('\n');

  if (r.pixelArt) {
    console.log('Pixel-art detected — lossy encoding not recommended. Use oxipng/optipng on the original PNG instead.');
    return;
  }
  if (r.dryRun) {
    console.log(`\n[dry run] would target WebP q${r.calibWebP} / AVIF q${r.calibAVIF}` +
                `${VERIFY ? `, searching to SSIMULACRA2 floor ${FLOOR.toFixed(1)}` : ''} — no files written.`);
    return;
  }

  console.log(`Original JPEG:  ${kb(r.origSize)}`);
  if (r.webp) console.log(`Best WebP:      ${kb(r.webp.size)}  (${pct(r.webp.size, r.origSize)} smaller)  q=${r.webp.quality} sns=${r.webp.sns} f=${r.webp.filter}  ${scoreStr(r.webp.score)}`);
  if (r.avif) console.log(`Best AVIF:      ${kb(r.avif.size)}  (${pct(r.avif.size, r.origSize)} smaller)  q=${r.avif.quality}  ${scoreStr(r.avif.score)}`);

  if (REPORT) {
    console.log('\n── WebP results (sorted by size) ───');
    for (const c of r.webpCandidates.slice(0, 10)) console.log(`  ${kb(c.size).padStart(8)}  q=${c.quality} sns=${c.sns} f=${c.filter}  ${scoreStr(c.score)}`);
    console.log('\n── AVIF results ─────────────────────────────────────────');
    for (const c of r.avifCandidates) console.log(`  ${kb(c.size).padStart(8)}  q=${c.quality}  ${scoreStr(c.score)}`);
  }

  if (!r.winner) { console.error('\nNo valid encodings produced.'); process.exit(1); }

  // never bloat
  if (r.keptOriginal && !KEEP_BOTH) {
    console.log(`\n⚠  No encoding beat the source JPEG (${kb(r.origSize)})${VERIFY ? ` at floor ${FLOOR.toFixed(1)}` : ''} — keeping the original JPEG.`);
    console.log(`   (Lower the bar with --floor <n>, or force a write with --keep-both.)`);
    return;
  }

  const best = r.winner === 'avif' ? r.avif : r.webp;
  const winnerPath = join(OUTPUT_DIR, `${stem}.${r.winner}`);
  writeFileSync(winnerPath, best.buffer);
  console.log(`\n✓ Winner: ${winnerPath}  (${kb(best.size)}, ${pct(best.size, r.origSize)} smaller than JPEG)`);

  if (KEEP_BOTH) {
    if (r.webp && r.winner !== 'webp') { const p = join(OUTPUT_DIR, `${stem}.webp`); writeFileSync(p, r.webp.buffer); console.log(`  Also saved: ${p}`); }
    if (r.avif && r.winner !== 'avif') { const p = join(OUTPUT_DIR, `${stem}.avif`); writeFileSync(p, r.avif.buffer); console.log(`  Also saved: ${p}`); }
  }

  if (CONTACT_SHEET) await buildContactSheet(r, stem);
}

// ─── comparison sheet ──────────────────────────────────────────────────────────
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];
async function exec(cmd, a) { try { return await execFileAsync(cmd, a, { encoding: 'utf8' }).catch(e => e); } catch { return { stdout: '', stderr: '' }; } }

async function buildContactSheet(r, stem) {
  const TMP = join(tmpdir(), 'sheet-' + randomBytes(4).toString('hex'));
  mkdirSync(TMP, { recursive: true });
  try {
    const ss = (s) => (s == null ? '' : `   ·   SSIMULACRA2 ${s.toFixed(2)}`);
    const tiles = [{ path: INPUT, label: `ORIGINAL JPEG  ·  q${r.jpegQ}  ·  ${r.contentType}\n${kb(r.origSize)}   (reference${r.floor != null ? `, floor ${r.floor.toFixed(2)}` : ', fast mode'})` }];
    if (r.webp) { const p = join(TMP, `${stem}.webp`); writeFileSync(p, r.webp.buffer); tiles.push({ path: p, label: `WebP  ·  q${r.webp.quality} sns${r.webp.sns} f${r.webp.filter}${r.winner === 'webp' ? '   ✓ WINNER' : ''}\n${kb(r.webp.size)}  (${pct(r.webp.size, r.origSize)} smaller)${ss(r.webp.score)}` }); }
    if (r.avif) { const p = join(TMP, `${stem}.avif`); writeFileSync(p, r.avif.buffer); tiles.push({ path: p, label: `AVIF  ·  q${r.avif.quality}${r.winner === 'avif' ? '   ✓ WINNER' : ''}\n${kb(r.avif.size)}  (${pct(r.avif.size, r.origSize)} smaller)${ss(r.avif.score)}` }); }

    const dims = await exec('magick', ['identify', '-format', '%w %h', INPUT]);
    const [w, h] = (dims.stdout || '').trim().split(/\s+/).map(Number);
    const tile = ((w && h) ? w >= h : true) ? `1x${tiles.length}` : `${tiles.length}x1`;
    const font = FONT_CANDIDATES.find(p => existsSync(p));
    const sheetPath = join(OUTPUT_DIR, `${stem}-compare.png`);
    const bodyPath = join(TMP, 'body.png'), headerPath = join(TMP, 'header.png');

    const mArgs = ['montage'];
    for (const t of tiles) mArgs.push('-label', t.label, t.path);
    mArgs.push('-tile', tile, '-geometry', '+14+12', '-background', 'white', '-fill', '#111111', '-pointsize', '18');
    if (font) mArgs.push('-font', font);
    mArgs.push(bodyPath);
    const mr = await exec('magick', mArgs);
    if (!existsSync(bodyPath)) { console.error(`\n⚠  Could not build comparison sheet: ${(mr.stderr || mr.message || 'unknown').split('\n')[0]}`); return; }

    const bodyW = parseInt(((await exec('magick', ['identify', '-format', '%w', bodyPath])).stdout || '').trim()) || 0;
    if (bodyW > 0) {
      const hArgs = ['-background', '#f2f2f2', '-fill', '#111111'];
      if (font) hArgs.push('-font', font);
      hArgs.push('-pointsize', '24', '-size', `${bodyW}x`, '-gravity', 'center',
        `caption:${basename(INPUT)}    ·    perceptually-matched  JPEG / WebP / AVIF    ·    content: ${r.contentType}`, headerPath);
      await exec('magick', hArgs);
    }
    if (existsSync(headerPath)) await exec('magick', [headerPath, bodyPath, '-background', 'white', '-append', sheetPath]);
    if (!existsSync(sheetPath)) await exec('magick', [bodyPath, sheetPath]);
    console.log(existsSync(sheetPath) ? `\n🖼  Comparison sheet: ${sheetPath}` : `\n⚠  Could not build comparison sheet.`);
  } finally { try { rmSync(TMP, { recursive: true, force: true }); } catch {} }
}

// ─── entry ──────────────────────────────────────────────────────────────────────
if (statSync(INPUT).isDirectory()) await runBatch(INPUT);
else await runSingle();
