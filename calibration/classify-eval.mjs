#!/usr/bin/env node
/**
 * classify-eval.mjs — measure classifier accuracy against labeled folders.
 *
 *   node calibration/classify-eval.mjs photo:test-images/kodak illustration:test-images/illustration ...
 *
 * Each arg is `expectedType:dir`. Prints a confusion matrix + overall accuracy so the
 * classifier's real-world behavior is quantified rather than assumed. (The shipped classifier
 * is tuned on clean archetypes and is weak on out-of-distribution real images; --verify in
 * convert.mjs is classification-independent and is the recommendation for ambiguous content.)
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyImage } from '../classify.mjs';

const specs = process.argv.slice(2).map(s => { const i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; });
if (!specs.length) {
  console.error('Usage: node calibration/classify-eval.mjs <expectedType:dir> [...]');
  process.exit(1);
}
const TYPES = ['photo', 'illustration', 'line-art', 'pixel-art', 'mixed'];
const matrix = {};   // expected → { predicted → count }
let correct = 0, total = 0;

for (const [expected, dir] of specs) {
  matrix[expected] ??= {};
  const imgs = readdirSync(dir).filter(f => /\.(png|jpe?g)$/i.test(f));
  for (const f of imgs) {
    let pred = 'error';
    try { pred = (await classifyImage(join(dir, f))).type ?? 'mixed'; } catch {}
    matrix[expected][pred] = (matrix[expected][pred] ?? 0) + 1;
    total++; if (pred === expected) correct++;
  }
}

// print confusion matrix
const cols = TYPES;
console.log('\nexpected \\ predicted   ' + cols.map(c => c.slice(0, 5).padStart(6)).join(' '));
for (const [exp, row] of Object.entries(matrix)) {
  const cells = cols.map(c => String(row[c] ?? 0).padStart(6)).join(' ');
  const n = Object.values(row).reduce((a, b) => a + b, 0);
  const hit = row[exp] ?? 0;
  console.log(`${exp.padEnd(22)}${cells}   (${hit}/${n} = ${(100 * hit / n).toFixed(0)}%)`);
}
console.log(`\nOverall: ${correct}/${total} = ${(100 * correct / total).toFixed(1)}% accuracy`);
