#!/usr/bin/env node
/**
 * check-encoders.mjs — encoder-version provenance.
 *
 *   node calibration/check-encoders.mjs           # print the current encoder versions
 *   node calibration/check-encoders.mjs --stamp   # record them into each calibration JSON
 *
 * The calibration numbers depend on the exact encoders (different libaom/libwebp builds give
 * different sizes). captureVersions() is also embedded by calibrate.mjs when generating curves,
 * so freshly-generated curves are self-documenting.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function probe(cmd, a, re) {
  try {
    const out = execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(re);
    return m ? m[1] : out.split('\n')[0].trim();
  } catch { return null; }
}

export function captureVersions() {
  return {
    cwebp: probe('cwebp', ['-version'], /([\d.]+)/),
    avifenc: probe('avifenc', ['--version'], /Version:\s*([\d.]+)/),
    aom: probe('avifenc', ['--version'], /aom \[enc\/dec\]:\s*([\d.]+)/),
    ssimulacra2: probe('ssimulacra2', ['--version'], /([\d.]+)/) ?? 'unversioned',
  };
}

if (process.argv[1]?.endsWith('check-encoders.mjs')) {
  const v = captureVersions();
  console.log('Current encoders:');
  for (const [k, val] of Object.entries(v)) console.log(`  ${k.padEnd(12)} ${val ?? '(not found)'}`);

  if (process.argv.includes('--stamp')) {
    const files = readdirSync(ROOT).filter(f => /-calibration-.*\.json$/.test(f));
    let n = 0;
    for (const f of files) {
      const d = JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
      // Curves regenerated on/after the 2026-06-30 step-1 densification use the current toolchain;
      // the older ssimulacra2 curves predate it (earlier libavif/aom, not precisely recorded).
      d.toolchain = (d.generated && d.generated >= '2026-06-30')
        ? { ...v, stamped: 'current' }
        : { note: 'generated 2026-03-12 with an earlier libavif/aom (pre-3.14); versions not recorded' };
      const { curve, ...rest } = d;
      writeFileSync(join(ROOT, f), JSON.stringify({ ...rest, toolchain: d.toolchain, curve }, null, 2) + '\n');
      n++;
    }
    console.log(`\nStamped toolchain into ${n} calibration files.`);
  }
}
