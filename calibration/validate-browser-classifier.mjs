#!/usr/bin/env node
/**
 * validate-browser-classifier.mjs — derive & validate the web demo's entropy threshold.
 *
 *   node calibration/validate-browser-classifier.mjs
 *
 * The web demo (web/app.mjs) can't run the CLI's ImageMagick-based classifier, so it uses a
 * browser-computable **luminance-histogram entropy** to separate photo from illustration. The
 * CLI's threshold (0.70) is tuned to ImageMagick's %[entropy] normalization and does NOT transfer,
 * so the demo's threshold has to be derived against the labeled sets — that's what this does.
 *
 * It mirrors the demo's metric exactly: decode to sRGB, Rec601 luma, 256-bin histogram, Shannon
 * entropy normalized by log2(256). It then reports per-class ranges and the threshold that best
 * separates photo (high entropy) from illustration (low). Result: threshold ≈ 0.87, ~92% on the
 * labeled sets (and ~90% verified in-browser on the real createImageBitmap decode path).
 *
 * Requires ImageMagick + the (gitignored) test-images/ sets. Archival, like the rest of this dir.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETS = {
  photo: 'test-images/kodak',
  illustration: 'test-images/illustrations',
  'line-art': 'test-images/line-art',
};

function entropyOf(path) {
  const raw = execFileSync(
    'magick',
    [path, '-resize', '512x512', '-colorspace', 'sRGB', '-depth', '8', 'RGB:-'],
    { maxBuffer: 1 << 28 },
  );
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    hist[Math.min(255, Math.round(0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]))]++;
    n++;
  }
  let H = 0;
  for (const c of hist)
    if (c) {
      const p = c / n;
      H -= p * Math.log2(p);
    }
  return H / 8;
}

const data = {};
for (const [type, dir] of Object.entries(SETS)) {
  const abs = join(ROOT, dir);
  data[type] = readdirSync(abs)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .map((f) => entropyOf(join(abs, f)));
}
const stat = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.floor(s.length * p)].toFixed(3);
  return `n=${s.length}  min=${s[0].toFixed(3)}  p25=${q(0.25)}  median=${q(0.5)}  p75=${q(0.75)}  max=${s[s.length - 1].toFixed(3)}`;
};
for (const [t, v] of Object.entries(data)) console.log(`${t.padEnd(13)} ${stat(v)}`);

const photo = data.photo,
  illus = data.illustration;
let best = { acc: 0, th: 0 };
for (let th = 0.3; th <= 0.98; th += 0.002) {
  const acc =
    (photo.filter((v) => v >= th).length + illus.filter((v) => v < th).length) /
    (photo.length + illus.length);
  if (acc > best.acc) best = { acc, th };
}
console.log(
  `\nBest photo/illustration threshold = ${best.th.toFixed(3)}  →  ${(best.acc * 100).toFixed(1)}% accuracy`,
);
console.log(`(this is the ENTROPY_THRESHOLD baked into web/app.mjs)`);
