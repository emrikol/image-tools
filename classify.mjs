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
 *   --edge-threshold <n>   Edge density threshold for illustration vs photo (default: 0.025)
 *   --sat-threshold <n>    Saturation mean threshold for illustration (default: 0.35)
 *
 * Thresholds derived empirically from:
 *   Illustrations (teahouse game art): edge 0.012–0.025, sat 0.11–0.29
 *   Photos (Kodak dataset):            edge 0.017–0.107, sat 0.10–0.66
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

const EDGE_THRESHOLD = parseFloat(getArg('--edge-threshold', '0.025'));
const SAT_THRESHOLD  = parseFloat(getArg('--sat-threshold',  '0.35'));

// Collect positional args (image paths)
const namedFlagValues = new Set(
  ['--edge-threshold', '--sat-threshold']
    .map(f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; })
    .filter(Boolean)
);
const images = args.filter(a => !a.startsWith('--') && !namedFlagValues.has(a));

if (images.length === 0) {
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

function classify(edgeDensity, satMean, stdDev, entropy, colorCount16, width, height) {
  const maxDim = Math.max(width, height);

  // pixel-art: small/medium dimensions + extremely limited palette
  if (maxDim < 1024 && colorCount16 !== null && colorCount16 <= 8) {
    return { type: 'pixel-art', confidence: 'high' };
  }

  // line-art: B&W manga/comic — near-zero saturation + meaningful edge density
  if (satMean !== null && satMean < 0.05 && edgeDensity !== null && edgeDensity > 0.05) {
    return { type: 'line-art', confidence: 'high' };
  }

  // illustration: low edge density + moderate saturation (game art, anime backgrounds)
  if (edgeDensity !== null && edgeDensity < EDGE_THRESHOLD &&
      satMean !== null && satMean < SAT_THRESHOLD) {
    const confidence = (edgeDensity < 0.020 && satMean < 0.25) ? 'high' : 'medium';
    return { type: 'illustration', confidence };
  }

  // photo: higher edge density typical of natural imagery
  if (edgeDensity !== null && edgeDensity > 0.030) {
    const confidence = (edgeDensity > 0.050) ? 'high' : 'medium';
    return { type: 'photo', confidence };
  }

  // mixed: signals are ambiguous
  return { type: 'mixed', confidence: 'low' };
}

// ─── single image classification ──────────────────────────────────────────────

export async function classifyImage(path) {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);

  const [edgeDensity, satMean, stdDev, entropy, colorCount16, dims] = await Promise.all([
    measureEdgeDensity(path),
    measureSaturation(path),
    measureStdDev(path),
    measureEntropy(path),
    measureColorCount16(path),
    measureDimensions(path),
  ]);

  const { type, confidence } = classify(
    edgeDensity, satMean, stdDev, entropy, colorCount16,
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
