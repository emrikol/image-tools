#!/usr/bin/env node
/**
 * classify.mjs
 *
 * Classifies images into content types using ImageMagick signals:
 *   photo       — natural photographs (use Kodak calibration curve)
 *   illustration — color game/anime art, flat fills (use illustration curve)
 *   line-art    — B&W manga/comic pages with screentone (use line-art curve)
 *   pixel-art   — tiny sprites with indexed palette (recommend PNG lossless)
 *   mixed       — ambiguous; falls back to photo calibration
 *
 * Usage:
 *   node classify.mjs <image>                 # single image → JSON
 *   node classify.mjs <image> --verbose       # include raw signal values
 *   node classify.mjs *.png --batch           # JSON array, progress bar on stderr
 *   node classify.mjs *.png --batch > out.json # pipe: JSON on stdout, progress on stderr
 *
 * Options:
 *   --verbose              Include signal values in output
 *   --batch                Process multiple images, output JSON array
 *   --entropy-threshold <n> Histogram-entropy split for illustration vs photo (default: 0.70)
 *   --edge-threshold <n>   (legacy) accepted but no longer the primary photo/illustration signal
 *   --sat-threshold <n>    (legacy) accepted; saturation is still used for line-art detection
 *
 * Discriminator (what actually separates the classes, measured on the labeled sets):
 *   PHOTO        — continuous tone: histogram entropy is HIGH (photos: 0.72–0.95, almost all
 *                  >0.87). Sensor noise + gradients fill the histogram.
 *   ILLUSTRATION — flat fills + limited palette: histogram entropy is LOW (illustrations:
 *                  0.12–0.69 for 23/25, two detailed outliers at 0.82/0.88). Peaky histogram.
 *   The classes sit on opposite sides of entropy≈0.70 (midpoint of the adjacent-class gap:
 *   highest illustration 0.6912 → lowest photo 0.7155). Edge density (the old signal) does NOT
 *   separate them — painterly illustrations have photo-like edge density, which is why the old
 *   edge-based rule scored 8% on illustration.
 *   LINE-ART     — near-grayscale ink: saturation ≈ 0 with either strong edges or a tiny palette.
 *   PIXEL-ART    — tiny dimensions + ≤8-color reduced palette.
 *
 * NOTE: `entropy` (and `std_dev`) were previously computed but unused; entropy is now the
 * primary photo/illustration discriminator — no extra ImageMagick cost over the old version.
 */

import { execFile }                from 'child_process';
import { existsSync }              from 'fs';
import { promisify }               from 'util';

const execFileAsync = promisify(execFile);

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const BATCH   = args.includes('--batch');

function getArg(flag, defaultVal) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : defaultVal;
}

const ENTROPY_THRESHOLD = parseFloat(getArg('--entropy-threshold', '0.70'));
const EDGE_THRESHOLD    = parseFloat(getArg('--edge-threshold', '0.025')); // legacy, accepted
const SAT_THRESHOLD     = parseFloat(getArg('--sat-threshold',  '0.35'));  // legacy, accepted

// Collect positional args (image paths)
const namedFlagValues = new Set(
  ['--entropy-threshold', '--edge-threshold', '--sat-threshold']
    .map(f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; })
    .filter(Boolean)
);
const images = args.filter(a => !a.startsWith('--') && !namedFlagValues.has(a));

// Only when run directly as a CLI — importing classifyImage must have no side effects.
if (images.length === 0 && process.argv[1]?.endsWith('classify.mjs')) {
  console.error('Usage: node classify.mjs <image> [--verbose] [--batch]');
  process.exit(1);
}

// ─── signal extraction ────────────────────────────────────────────────────────

async function measureEdgeDensity(path) {
  // Canny edge detection — wider params (0x2+5%+20%) give better photo/illustration separation
  // Illustrations: 0.012–0.025 | Photos: 0.017–0.107
  try {
    const r = await execFileAsync(
      'magick', ['convert', path, '-canny', '0x2+5%+20%', '-format', '%[fx:mean]', 'info:'],
      { encoding: 'utf8' }
    );
    return parseFloat(r.stdout.trim()) || null;
  } catch { return null; }
}

async function measureSaturation(path) {
  // HSL saturation channel mean — helps split colorful photos from illustrations
  // Illustrations: 0.11–0.29 | Photos: 0.10–0.66 (wide range)
  try {
    const r = await execFileAsync(
      'magick', ['convert', path,
                 '-colorspace', 'HSL', '-channel', 'Saturation', '-separate',
                 '-format', '%[fx:mean]', 'info:'],
      { encoding: 'utf8' }
    );
    return parseFloat(r.stdout.trim()) ?? null;
  } catch { return null; }
}

async function measureStdDev(path) {
  // Overall standard deviation — supplementary signal
  try {
    const r = await execFileAsync(
      'magick', ['identify', '-format', '%[standard-deviation]', path],
      { encoding: 'utf8' }
    );
    return parseFloat(r.stdout.trim()) || null;
  } catch { return null; }
}

async function measureEntropy(path) {
  // Shannon entropy
  try {
    const r = await execFileAsync(
      'magick', ['identify', '-format', '%[entropy]', path],
      { encoding: 'utf8' }
    );
    return parseFloat(r.stdout.trim()) || null;
  } catch { return null; }
}

async function measureColorCount16(path) {
  // Unique colors at 16-palette reduction (no dither) — used only for pixel-art detection
  try {
    const r = await execFileAsync(
      'magick', ['convert', path, '+dither', '-colors', '16', '-format', '%k', 'info:'],
      { encoding: 'utf8' }
    );
    return parseInt(r.stdout.trim()) || null;
  } catch { return null; }
}

async function measureColorCount(path) {
  // Unique colors at FULL resolution — palette size. Photos hold tens of thousands;
  // illustrations hundreds–low thousands; line-art a few hundred. Used to recognise a
  // near-grayscale line-art page that has too few edges to trip the edge branch, and to
  // grade confidence. (%k counts exact unique colors.)
  try {
    const r = await execFileAsync(
      'magick', ['convert', path, '-format', '%k', 'info:'],
      { encoding: 'utf8' }
    );
    return parseInt(r.stdout.trim()) || null;
  } catch { return null; }
}

async function measureDimensions(path) {
  try {
    const r = await execFileAsync(
      'magick', ['identify', '-format', '%wx%h', path],
      { encoding: 'utf8' }
    );
    const [w, h] = r.stdout.trim().split('x').map(Number);
    return { width: w, height: h };
  } catch { return { width: 0, height: 0 }; }
}

// ─── classification logic ─────────────────────────────────────────────────────

function classify(edgeDensity, satMean, stdDev, entropy, colorCount16, colorCount, width, height) {
  const maxDim = Math.max(width, height);

  // 1. pixel-art: small/medium dimensions + extremely limited palette
  if (maxDim < 1024 && colorCount16 !== null && colorCount16 <= 8) {
    return { type: 'pixel-art', confidence: 'high' };
  }

  // 2. line-art: near-grayscale ink (saturation ≈ 0). Confirm it's really line-art via EITHER
  //    meaningful edge density (ink strokes) OR a tiny full-res palette (a mostly-white page
  //    with sparse ink trips few edges but has very few colors). Both guards keep near-grayscale
  //    illustrations (which have richer palettes) out of this bucket.
  if (satMean !== null && satMean < 0.05) {
    const hasEdges    = edgeDensity !== null && edgeDensity > 0.05;
    const tinyPalette = colorCount  !== null && colorCount  < 4096;
    if (hasEdges || tinyPalette) {
      const confidence = (colorCount !== null && colorCount < 512) ? 'high' : 'medium';
      return { type: 'line-art', confidence };
    }
  }

  // 3. illustration vs photo via histogram entropy. Flat fills + limited palettes make an
  //    illustration's histogram peaky (LOW entropy); a photo's continuous tone + sensor noise
  //    fills the histogram (HIGH entropy). This — not edge density — is what separates them.
  if (entropy !== null) {
    if (entropy < ENTROPY_THRESHOLD) {
      // strong illustration signal when the histogram is very peaky and/or palette is small
      const confidence = (entropy < 0.55 ||
                          (colorCount !== null && colorCount < 16000)) ? 'high' : 'medium';
      return { type: 'illustration', confidence };
    }
    const confidence = (entropy > 0.85) ? 'high' : 'medium';
    return { type: 'photo', confidence };
  }

  // 4. fallback (entropy unavailable): legacy edge-based heuristic
  if (edgeDensity !== null && edgeDensity < EDGE_THRESHOLD &&
      satMean !== null && satMean < SAT_THRESHOLD) {
    return { type: 'illustration', confidence: 'low' };
  }
  if (edgeDensity !== null && edgeDensity > 0.030) {
    return { type: 'photo', confidence: 'low' };
  }

  // mixed: signals are ambiguous / unavailable
  return { type: 'mixed', confidence: 'low' };
}

// ─── single image classification ──────────────────────────────────────────────

export async function classifyImage(path) {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);

  const [edgeDensity, satMean, stdDev, entropy, colorCount16, colorCount, dims] = await Promise.all([
    measureEdgeDensity(path),
    measureSaturation(path),
    measureStdDev(path),
    measureEntropy(path),
    measureColorCount16(path),
    measureColorCount(path),
    measureDimensions(path),
  ]);

  const { type, confidence } = classify(
    edgeDensity, satMean, stdDev, entropy, colorCount16, colorCount,
    dims.width, dims.height
  );

  const result = { file: path, type, confidence };

  if (VERBOSE) {
    result.signals = {
      edge_density:   edgeDensity,
      sat_mean:       satMean,
      std_dev:        stdDev,
      entropy:        entropy,
      color_count_16: colorCount16,
      color_count:    colorCount,
      width:          dims.width,
      height:         dims.height,
    };
  }

  return result;
}

// ─── progress bar (stderr, TTY only) ─────────────────────────────────────────

function makeProgress(total) {
  if (!process.stderr.isTTY || total <= 1) return { tick: () => {}, done: () => {} };

  const BAR_WIDTH = 32;
  let completed   = 0;
  const start     = Date.now();
  const times     = [];       // rolling window of per-image ms

  return {
    tick(label) {
      const now     = Date.now();
      const elapsed = now - start;
      times.push(elapsed / ++completed);
      if (times.length > 10) times.shift();

      const avgMs   = times.reduce((a, b) => a + b, 0) / times.length;
      const eta     = Math.round((avgMs * (total - completed)) / 1000);
      const pct     = Math.round((completed / total) * 100);
      const filled  = Math.round((completed / total) * BAR_WIDTH);
      const bar     = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      const etaStr  = eta > 0 ? `ETA ${eta}s` : 'done';

      process.stderr.write(
        `\r[${bar}] ${completed}/${total}  ${pct}%  avg ${(avgMs / 1000).toFixed(2)}s/img  ${etaStr}  `
      );
    },
    done() {
      process.stderr.write('\n');
    },
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

// Guard: only run as CLI when invoked directly
if (process.argv[1].endsWith('classify.mjs')) {
  if (BATCH) {
    if (process.stderr.isTTY) {
      process.stderr.write(`Classifying ${images.length} images...\n`);
    }

    const progress = makeProgress(images.length);
    const results  = [];

    for (const img of images) {
      try {
        const r = await classifyImage(img);
        results.push(r);
      } catch (e) {
        results.push({ file: img, type: null, confidence: null, error: e.message });
      }
      progress.tick(img);
    }

    progress.done();
    console.log(JSON.stringify(results, null, 2));
  } else {
    // Single image mode
    try {
      const result = await classifyImage(images[0]);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
