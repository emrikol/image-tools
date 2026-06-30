import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  jpegQualityFromBuffer,
  readQuantTables,
  jpegQualityFromTables,
  jpegMeta,
} from '../lib/jpeg-quality.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const jpegQualityFromBytes = (p) => jpegQualityFromBuffer(readFileSync(p));

// Each fixture encodes its true quality in the filename (e.g. color-q75.jpg). The reader must
// land within ±1 of it (matches ImageMagick's %Q; ±1 is negligible for smooth-curve lookup).
test('jpegQualityFromBytes matches encoded quality (±1) on fixtures', () => {
  const jpgs = readdirSync(FIX).filter((f) => f.endsWith('.jpg'));
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
  for (const f of readdirSync(FIX).filter((f) => f.endsWith('.jpg'))) {
    const q = jpegQualityFromBytes(join(FIX, f));
    assert.ok(q >= 1 && q <= 100, `${f}: ${q} out of range`);
  }
});

test('jpegMeta defaults to RGB/upright and reads grayscale fixtures', () => {
  const color = jpegMeta(readFileSync(join(FIX, 'color-q75.jpg')));
  assert.equal(color.components, 3);
  assert.equal(color.orientation, 1);
  assert.equal(jpegMeta(readFileSync(join(FIX, 'gray-q80.jpg'))).components, 1);
});

test('jpegMeta reads EXIF orientation (synthetic little-endian buffer)', () => {
  const buf = Buffer.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe1,
    0x00,
    0x22, // APP1, length 34
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // TIFF little-endian, IFD @ 8
    0x01,
    0x00, // 1 entry
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x06,
    0x00,
    0x00,
    0x00, // Orientation = 6
    0x00,
    0x00,
    0x00,
    0x00, // next IFD
    0xff,
    0xd9, // EOI
  ]);
  assert.equal(jpegMeta(buf).orientation, 6);
});

test('jpegMeta reads CMYK component count (synthetic SOF0)', () => {
  const buf = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x14,
    0x08,
    0x00,
    0x10,
    0x00,
    0x10,
    0x04, // SOF0: 16x16, 4 components (CMYK)
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // 4 component specs (12 bytes)
    0xff,
    0xd9,
  ]);
  assert.equal(jpegMeta(buf).components, 4);
});
