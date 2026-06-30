import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convert, detectJpegQuality, loadCalibrations } from '../lib/convert.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const has = (b) => { try { execFileSync('sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = (has('cwebp') && has('avifenc')) ? false : 'requires cwebp + avifenc';
const skipVerify = (skip || !has('ssimulacra2')) ? 'requires cwebp + avifenc + ssimulacra2' : false;
const isWebp = (b) => b.slice(8, 12).toString() === 'WEBP';
const isAvif = (b) => b.slice(4, 12).toString().includes('ftyp');

test('loadCalibrations finds the shipped curves for a type', () => {
  const c = loadCalibrations('photo');
  assert.ok(c.length >= 10, `expected ~10 photo curves, got ${c.length}`);
  assert.ok(c.every(x => Array.isArray(x.curve)));
});

test('detectJpegQuality reads a fixture', async () => {
  assert.equal(await detectJpegQuality(join(FIX, 'color-q75.jpg')) <= 76, true);
});

test('convert() fast mode returns a winner buffer of the right format', { skip }, async () => {
  const r = await convert(join(FIX, 'smooth-q85.jpg'), { type: 'photo' });
  assert.equal(r.mode, 'fast');
  assert.ok(r.jpegQ >= 80, 'detected quality');
  assert.ok(['webp', 'avif'].includes(r.winner), 'has a winner');
  const best = r[r.winner];
  assert.ok(Buffer.isBuffer(best.buffer), 'winner carries a buffer');
  assert.ok(r.winner === 'webp' ? isWebp(best.buffer) : isAvif(best.buffer), 'buffer is the right format');
  assert.equal(best.size, best.buffer.length, 'size matches buffer');
});

test('convert() dry-run plans without encoding', { skip }, async () => {
  const r = await convert(join(FIX, 'smooth-q85.jpg'), { type: 'photo', dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.calibWebP >= 1 && r.calibWebP <= 100);
  assert.equal(r.webp, undefined, 'no buffers produced on dry run');
});

test('convert() never reports a bloated winner as a save', { skip }, async () => {
  const r = await convert(join(FIX, 'color-q95.jpg'), { type: 'photo' });
  const best = r[r.winner];
  if (r.keptOriginal) assert.ok(best.size >= r.origSize, 'keptOriginal implies not smaller');
  else assert.ok(best.size < r.origSize, 'a non-kept winner must be smaller than the source');
});

test('convert() verify mode meets the absolute floor', { skip: skipVerify }, async () => {
  const r = await convert(join(FIX, 'smooth-q85.jpg'), { type: 'photo', verify: true, floor: 80 });
  assert.equal(r.mode, 'verify');
  assert.equal(r.floor, 80);
  // the winning encode should clear the floor (or be flagged best-effort)
  const best = r[r.winner];
  assert.ok(best.score >= 80 || best.met === false, `winner score ${best.score} should clear floor 80`);
});

test('convert() emits progress events in order', { skip }, async () => {
  const seen = [];
  await convert(join(FIX, 'smooth-q85.jpg'), { type: 'photo', onProgress: (e) => seen.push(e.type) });
  assert.deepEqual(seen.slice(0, 4), ['classified', 'quality', 'curves', 'mode']);
});
