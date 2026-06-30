#!/usr/bin/env node
/**
 * measure-sizes.mjs — measure real file-size savings for the README "savings" chart.
 *
 *   node calibration/measure-sizes.mjs            # → assets/savings-data.json
 *
 * For each content type, at sampled JPEG qualities, encodes every dataset image to JPEG@q and to
 * WebP/AVIF at the SSIMULACRA2-matched quality (from the calibration curves), and records the
 * average % smaller vs the JPEG. AVIF at --speed 0 to match the calibration/CLI.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { interpolate } from '../lib/curves.mjs';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { photo: 'test-images/kodak', illustration: 'test-images/illustrations', 'line-art': 'test-images/line-art' };
const QUALS = [20, 30, 40, 50, 60, 70, 80, 90];
const TMP = mkdtempSync(join(tmpdir(), 'sizes-'));
const size = (p) => statSync(p).size;

async function runPool(tasks, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; await tasks[k](); } }));
}

const out = {};
for (const [type, dir] of Object.entries(TYPES)) {
  const curve = JSON.parse(readFileSync(join(ROOT, `ssimulacra2-calibration-${type}.json`), 'utf8')).curve;
  const imgs = readdirSync(join(ROOT, dir)).filter(f => /\.png$/i.test(f)).map(f => join(ROOT, dir, f));
  out[type] = [];
  for (const q of QUALS) {
    const wq = Math.round(interpolate(curve, q, 'webp_q') ?? q);
    const aq = Math.round(interpolate(curve, q, 'avif_q') ?? q);
    const rows = [];
    const tasks = imgs.map((src, i) => async () => {
      const j = join(TMP, `${i}.jpg`), w = join(TMP, `${i}.webp`), a = join(TMP, `${i}.avif`);
      await exec('magick', [src, '-quality', String(q), j]);
      await exec('cwebp', ['-q', String(wq), '-m', '6', '-quiet', src, '-o', w]);
      await exec('avifenc', ['-q', String(aq), '--speed', '0', '--jobs', '1', src, a]);
      const jb = size(j);
      rows.push({ webp: 100 * (jb - size(w)) / jb, avif: 100 * (jb - size(a)) / jb });
    });
    await runPool(tasks, availableParallelism());
    const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    out[type].push({ jpeg_q: q, webp_pct: +avg('webp').toFixed(1), avif_pct: +avg('avif').toFixed(1) });
    process.stderr.write(`${type} q${q}: WebP ${avg('webp').toFixed(0)}% / AVIF ${avg('avif').toFixed(0)}% smaller\n`);
  }
}
mkdirSync(join(ROOT, 'assets'), { recursive: true });
writeFileSync(join(ROOT, 'assets', 'savings-data.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote assets/savings-data.json');
