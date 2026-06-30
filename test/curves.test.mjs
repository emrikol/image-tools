import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { interpolate } from '../lib/curves.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('interpolate is linear between points and clamps at the ends', () => {
  const curve = [{ jpeg_q: 10, webp_q: 20 }, { jpeg_q: 20, webp_q: 40 }];
  assert.equal(interpolate(curve, 15, 'webp_q'), 30);   // midpoint
  assert.equal(interpolate(curve, 10, 'webp_q'), 20);   // exact
  assert.equal(interpolate(curve, 5, 'webp_q'), 20);    // below → clamp low
  assert.equal(interpolate(curve, 25, 'webp_q'), 40);   // above → clamp high
});

test('interpolate skips null field values', () => {
  const curve = [{ jpeg_q: 10, webp_q: null }, { jpeg_q: 20, webp_q: 40 }];
  assert.equal(interpolate(curve, 12, 'webp_q'), 40);   // only the non-null point applies
  assert.equal(interpolate([{ jpeg_q: 10, webp_q: null }], 10, 'webp_q'), null);
});

// ── shipped calibration data integrity ──
const calibFiles = readdirSync(ROOT).filter(f => /-calibration-.*\.json$/.test(f));

test('every shipped calibration file is well-formed', () => {
  assert.ok(calibFiles.length >= 30, `expected the calibration set, found ${calibFiles.length}`);
  for (const f of calibFiles) {
    const d = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    assert.equal(d.$schema, 'calibration-schema', `${f}: $schema`);
    assert.ok(typeof d.metric === 'string', `${f}: metric`);
    assert.ok(['photo', 'illustration', 'line-art', 'mixed'].includes(d.content_type), `${f}: content_type`);
    assert.ok(Array.isArray(d.curve) && d.curve.length > 0, `${f}: curve`);
    for (const row of d.curve) {
      assert.ok(row.jpeg_q >= 1 && row.jpeg_q <= 100, `${f}: jpeg_q ${row.jpeg_q}`);
      for (const k of ['webp_q', 'avif_q']) {
        const v = row[k];
        assert.ok(v === null || (v >= 1 && v <= 100), `${f}: ${k}=${v} at jpeg_q ${row.jpeg_q}`);
      }
    }
  }
});

test('curves trend upward with no corruption-sized backward jumps', () => {
  // Small ±1–10 wobbles are legitimate per-image averaging noise; a corrupted curve would
  // jump by tens. So bound the worst single-step DROP (catches corruption) and require the
  // overall trend to rise. Observed max drop across the real data is ~9.5.
  const maxAllowedDrop = 12;
  for (const f of calibFiles) {
    const d = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    for (const field of ['webp_q', 'avif_q']) {
      const vals = d.curve.filter(r => r[field] !== null).map(r => r[field]);
      if (vals.length < 2) continue;
      let maxDrop = 0;
      for (let i = 1; i < vals.length; i++) maxDrop = Math.max(maxDrop, vals[i - 1] - vals[i]);
      assert.ok(maxDrop <= maxAllowedDrop, `${f}: ${field} drops by ${maxDrop} (>${maxAllowedDrop}) — looks corrupt`);
      assert.ok(vals[vals.length - 1] >= vals[0], `${f}: ${field} trends downward overall`);
    }
  }
});

test('primary metrics are full 1–100 resolution; vmaf is the documented exception', () => {
  for (const f of calibFiles) {
    const d = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
    if (d.metric === 'vmaf') assert.ok(d.curve.length >= 2, `${f}: vmaf curve present`);
    else assert.equal(d.curve.length, 100, `${f}: expected 100 points, got ${d.curve.length}`);
  }
});
