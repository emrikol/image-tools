import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures');

function have(bin) {
  try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const ENCODERS = have('cwebp') && have('avifenc');
const skip = ENCODERS ? false : 'requires cwebp + avifenc on PATH';

function run(args) {
  return execFileSync('node', [join(ROOT, 'convert.mjs'), ...args], { encoding: 'utf8' });
}
function magic(path) {
  const b = readFileSync(path);
  if (b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.slice(4, 12).toString().includes('ftyp')) return 'avif';
  return 'unknown';
}

test('fast mode produces a valid, smaller file for compressible input', { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  run([join(FIX, 'smooth-q85.jpg'), out, '--type', 'photo']);
  const files = readdirSync(out).filter(f => /\.(webp|avif)$/.test(f));
  assert.equal(files.length, 1, 'should write exactly one winner');
  const winner = join(out, files[0]);
  assert.ok(['webp', 'avif'].includes(magic(winner)), 'winner is a real WebP/AVIF');
  assert.ok(readFileSync(winner).length < readFileSync(join(FIX, 'smooth-q85.jpg')).length, 'winner is smaller than source');
});

test('--keep-both writes both formats', { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  run([join(FIX, 'smooth-q85.jpg'), out, '--type', 'photo', '--keep-both']);
  const exts = new Set(readdirSync(out).map(f => f.split('.').pop()));
  assert.ok(exts.has('webp') && exts.has('avif'), 'both webp and avif present');
});

test('never-bloat: nothing written when no encode beats the source', { skip }, () => {
  // Incompressible noise at high quality won't beat the source; the guard should keep the original.
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const log = run([join(FIX, 'color-q95.jpg'), out, '--type', 'photo']);
  const files = readdirSync(out).filter(f => /\.(webp|avif)$/.test(f));
  if (files.length === 0) assert.match(log, /keeping the original/i);
  else assert.ok(readFileSync(join(out, files[0])).length < readFileSync(join(FIX, 'color-q95.jpg')).length);
});

test('reads JPEG quality without ImageMagick in fast mode', { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const log = run([join(FIX, 'color-q75.jpg'), out, '--type', 'photo']);
  assert.match(log, /JPEG quality:\s*7[45]/, 'detected ~q75 from the DQT');
});

test('--dry-run writes nothing and reports a plan', { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const log = run([join(FIX, 'smooth-q85.jpg'), out, '--type', 'photo', '--dry-run']);
  assert.match(log, /dry run/i);
  assert.equal(readdirSync(out).length, 0, 'no files written on dry run');
});

test('batch mode processes a directory and never crashes the run', { skip }, () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  const log = run([FIX, out, '--type', 'photo']);
  assert.match(log, /Done: \d+ converted, \d+ kept, 0 failed/, 'batch summary, no failures');
  assert.ok(readdirSync(out).length >= 1, 'at least one output written');
});

test('rejects a non-JPEG with a clear error', () => {
  const out = mkdtempSync(join(tmpdir(), 'imgtest-'));
  assert.throws(
    () => run([fileURLToPath(import.meta.url), out, '--type', 'photo']),
    /is it a JPEG|JPEG/i,
  );
});
