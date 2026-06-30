#!/usr/bin/env node
/**
 * fetch-datasets.mjs — download the public Kodak photo set for reproducing the `photo` curves.
 *
 *   node calibration/fetch-datasets.mjs            # → test-images/kodak/kodim01..24.png
 *
 * The illustration and line-art sets used in the shipped calibration are third-party content
 * and are NOT redistributable, so they can't be auto-fetched — bring your own (flat-color
 * artwork; black-and-white ink/pencil art) under test-images/illustration and test-images/line-art.
 * The Kodak set (24 lossless 768×512 photographs) is the standard, freely-mirrored benchmark.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test-images', 'kodak');
const BASE = 'https://r0k.us/graphics/kodak/kodak';

mkdirSync(OUT, { recursive: true });
console.log(`Fetching the Kodak set → ${OUT}`);

let got = 0, skipped = 0, failed = 0;
for (let i = 1; i <= 24; i++) {
  const name = `kodim${String(i).padStart(2, '0')}.png`;
  const dest = join(OUT, name);
  if (existsSync(dest)) { skipped++; process.stdout.write('·'); continue; }
  try {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    got++; process.stdout.write('✓');
  } catch (e) {
    failed++; process.stdout.write('✗');
    process.stderr.write(`\n  ${name}: ${e.message}\n`);
  }
}
console.log(`\nDone: ${got} downloaded, ${skipped} already present, ${failed} failed.`);
if (failed) process.exit(1);
