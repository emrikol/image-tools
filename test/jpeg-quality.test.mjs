import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { jpegQualityFromBuffer, readQuantTables, jpegQualityFromTables } from '../lib/jpeg-quality.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const jpegQualityFromBytes = (p) => jpegQualityFromBuffer(readFileSync(p));

// Each fixture encodes its true quality in the filename (e.g. color-q75.jpg). The reader must
// land within ±1 of it (matches ImageMagick's %Q; ±1 is negligible for smooth-curve lookup).
test('jpegQualityFromBytes matches encoded quality (±1) on fixtures', () => {
  const jpgs = readdirSync(FIX).filter(f => f.endsWith('.jpg'));
  assert.ok(jpgs.length >= 4, 'expected fixtures present');
  for (const f of jpgs) {
    const expected = Number(f.match(/q(\d+)/)[1]);
    const got = jpegQualityFromBytes(join(FIX, f));
    assert.notEqual(got, null, `${f}: should parse`);
    assert.ok(Math.abs(got - expected) <= 1, `${f}: expected ~${expected}, got ${got}`);
  }
});

test('color JPEGs expose 2 quant tables, grayscale exposes 1', () => {
  const color = readQuantTables(readFileSync(join(FIX, 'color-q75.jpg')));
  const gray = readQuantTables(readFileSync(join(FIX, 'gray-q80.jpg')));
  assert.equal(color.length, 2, 'color should have luma + chroma tables');
  assert.equal(gray.length, 1, 'grayscale should have a single table');
});

test('returns null for non-JPEG input', () => {
  assert.equal(jpegQualityFromBytes(fileURLToPath(import.meta.url)), null);
  assert.equal(jpegQualityFromTables([]), null);
  assert.equal(jpegQualityFromTables(null), null);
});

test('quality is bounded 1..100', () => {
  for (const f of readdirSync(FIX).filter(f => f.endsWith('.jpg'))) {
    const q = jpegQualityFromBytes(join(FIX, f));
    assert.ok(q >= 1 && q <= 100, `${f}: ${q} out of range`);
  }
});
