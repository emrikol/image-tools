// lib/convert.mjs — the conversion engine, usable as a library.
//
//   import { convert } from 'image-tools/lib/convert.mjs';
//   const result = await convert('photo.jpg', { verify: true, floor: 80 });
//   // result.winner === 'avif', result.avif.buffer is the bytes to write, etc.
//
// Pure compute: no console output, no files written. It encodes candidates to a private temp
// dir, reads the winners into Buffers, cleans up, and returns a structured result. The CLI
// (convert.mjs) handles arg parsing, printing, writing, batch, and the contact sheet.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { classifyImage } from '../classify.mjs';
import { jpegQualityFromBuffer } from './jpeg-quality.mjs';
import { interpolate } from './curves.mjs';

const execFileAsync = promisify(execFile);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');  // where the curves live

const WEBP_SNS = [20, 40, 60, 80];     // spatial noise shaping
const WEBP_FILTER = [20, 40, 60, 80];  // deblocking filter strength
const AVIF_SPEED = 0;                   // slowest = best compression (matches calibration)

const clampQ = (q) => Math.min(100, Math.max(1, Math.round(q ?? 80)));
const fileSize = (p) => { try { return readFileSync(p).length; } catch { return Infinity; } };

async function exec(cmd, a) {
  try { return await execFileAsync(cmd, a, { encoding: 'utf8' }).catch(e => e); }
  catch { return { stdout: '', stderr: '' }; }
}

async function encodeWebP(src, quality, sns, filter, out) {
  await exec('cwebp', ['-q', String(quality), '-m', '6', '-sns', String(sns), '-f', String(filter), '-quiet', src, '-o', out]);
}
async function encodeAVIF(src, quality, out) {
  await exec('avifenc', ['-q', String(quality), '--speed', String(AVIF_SPEED), src, out]);
}

// SSIMULACRA2 of (ref JPEG, compressed) — decodes AVIF/WebP via avifdec/dwebp (magick fallback).
async function measureQuality(ref, compressed) {
  let cmpPng = compressed, tmpPng = null;
  if (/\.avif$/i.test(compressed)) {
    tmpPng = compressed + '._ssim.png';
    await exec('avifdec', ['--quiet', compressed, tmpPng]);
    if (!existsSync(tmpPng)) await exec('magick', ['convert', compressed, tmpPng]);
    cmpPng = tmpPng;
  } else if (/\.webp$/i.test(compressed)) {
    tmpPng = compressed + '._ssim.png';
    await exec('dwebp', ['-quiet', compressed, '-o', tmpPng]);
    if (!existsSync(tmpPng)) await exec('magick', ['convert', compressed, tmpPng]);
    cmpPng = tmpPng;
  }
  try {
    const r = await exec('ssimulacra2', [ref, cmpPng]);
    const m = (r.stdout || r.stderr || '').match(/(-?[\d.]+)/);
    return m ? parseFloat(parseFloat(m[1]).toFixed(4)) : null;
  } finally { if (tmpPng) { try { unlinkSync(tmpPng); } catch {} } }
}

export async function detectJpegQuality(path) {
  let q = null;
  try { q = jpegQualityFromBuffer(readFileSync(path)); } catch {}
  if (q !== null) return q;
  const r = await exec('magick', ['identify', '-verbose', path]);
  const m = (r.stdout || r.stderr || '').match(/Quality:\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// Load every {metric}-calibration-{type}.json under calibrationDir (mixed→photo, ssimOnly,
// + an explicit extra file). Returns [{metric, curve, path}].
export function loadCalibrations(type, { calibrationDir = PKG_ROOT, ssimOnly = false, extraCalibration = null } = {}) {
  if (type === 'mixed') type = 'photo';  // conservative fallback (photo needs the highest quality)
  const read = (f, dir = calibrationDir) => {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!Array.isArray(d.curve)) return null;
      return { metric: d.metric ?? f, curve: d.curve, path: f };
    } catch { return null; }
  };
  if (ssimOnly) {
    const p = existsSync(join(calibrationDir, `ssimulacra2-calibration-${type}.json`))
      ? `ssimulacra2-calibration-${type}.json` : `ssimulacra2-calibration-photo.json`;
    const c = read(p);
    return c ? [c] : [];
  }
  const loaded = [];
  for (const f of readdirSync(calibrationDir).filter(f => f.endsWith(`-calibration-${type}.json`))) {
    const c = read(f); if (c) loaded.push(c);
  }
  if (extraCalibration && existsSync(extraCalibration)) {
    const c = read(extraCalibration, ''); if (c) loaded.push({ ...c, path: extraCalibration });
  }
  return loaded;
}

/**
 * Convert a JPEG. Returns a structured result; writes nothing.
 * opts: { type='auto', verify=false, floor=80, ssimOnly=false, calibrationDir, extraCalibration,
 *         onProgress } .  onProgress(event) gets {type:'info'|'search', message?, ...}.
 */
export async function convert(input, opts = {}) {
  const {
    type = 'auto', verify = false, floor = 80, ssimOnly = false, dryRun = false,
    calibrationDir = PKG_ROOT, extraCalibration = null, onProgress = () => {},
  } = opts;

  // 0. content type
  let contentType = type, confidence = 'manual';
  if (type === 'auto') {
    const c = await classifyImage(input);
    contentType = c.type ?? 'mixed'; confidence = c.confidence;
  }
  onProgress({ type: 'classified', contentType, confidence });
  if (contentType === 'pixel-art') {
    return { input, contentType, confidence, pixelArt: true, winner: null, keptOriginal: false };
  }

  // 1. JPEG quality
  const jpegQ = await detectJpegQuality(input);
  if (jpegQ === null) { const e = new Error(`Not a readable JPEG: ${input}`); e.code = 'ENOTJPEG'; throw e; }
  onProgress({ type: 'quality', jpegQ });

  // 2. calibrated qualities (max across curves)
  const curves = loadCalibrations(contentType, { calibrationDir, ssimOnly, extraCalibration });
  if (curves.length === 0) { const e = new Error(`No calibration curves for "${contentType}"`); e.code = 'ENOCURVES'; throw e; }
  let calibWebP = 1, calibAVIF = 1;
  const perCurve = [];
  for (const c of curves) {
    const wq = interpolate(c.curve, jpegQ, 'webp_q');
    const aq = interpolate(c.curve, jpegQ, 'avif_q');
    perCurve.push({ metric: c.metric, webp_q: wq, avif_q: aq, path: c.path });
    if (wq != null) calibWebP = Math.max(calibWebP, wq);
    if (aq != null) calibAVIF = Math.max(calibAVIF, aq);
  }
  calibWebP = clampQ(calibWebP); calibAVIF = clampQ(calibAVIF);
  onProgress({ type: 'curves', curves: perCurve, calibWebP, calibAVIF });
  onProgress({ type: 'mode', mode: verify ? 'verify' : 'fast', floor: verify ? floor : null });

  const origSize = fileSize(input);
  if (dryRun) {
    return { input, contentType, confidence, pixelArt: false, jpegQ, dryRun: true,
             mode: verify ? 'verify' : 'fast', floor: verify ? floor : null,
             curves: perCurve, calibWebP, calibAVIF, origSize, winner: null, keptOriginal: false };
  }
  const TMP = join(tmpdir(), 'imgconv-' + randomBytes(4).toString('hex'));
  mkdirSync(TMP, { recursive: true });
  const webpResults = [], avifResults = [];

  try {
    if (!verify) {
      const wout = join(TMP, `w${calibWebP}.webp`);
      await encodeWebP(input, calibWebP, 50, 60, wout);
      webpResults.push({ quality: calibWebP, sns: 50, filter: 60, size: fileSize(wout), score: null, path: wout, met: null });
      const aout = join(TMP, `a${calibAVIF}.avif`);
      await encodeAVIF(input, calibAVIF, aout);
      avifResults.push({ quality: calibAVIF, sns: null, filter: null, size: fileSize(aout), score: null, path: aout, met: null });
    } else {
      const lowest = async (label, encodeAtQ) => {
        let lo = 1, hi = 100, best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const r = await encodeAtQ(mid);
          onProgress({ type: 'search', format: label, q: mid, score: r.score });
          if (r.score !== null && r.score >= floor) { best = r; hi = mid - 1; } else { lo = mid + 1; }
        }
        if (best) return { ...best, met: true };
        return { ...(await encodeAtQ(100)), met: false };
      };
      const avif = await lowest('avif', async (q) => {
        const out = join(TMP, `a${q}.avif`); await encodeAVIF(input, q, out);
        return { quality: q, sns: null, filter: null, size: fileSize(out), score: await measureQuality(input, out), path: out };
      });
      if (avif.score === null) { const e = new Error('Cannot measure (ssimulacra2 missing?)'); e.code = 'ENOSSIM'; throw e; }
      avifResults.push(avif);
      const webp = await lowest('webp', async (q) => {
        const out = join(TMP, `w${q}_50_60.webp`); await encodeWebP(input, q, 50, 60, out);
        return { quality: q, sns: 50, filter: 60, size: fileSize(out), score: await measureQuality(input, out), path: out };
      });
      webpResults.push(webp);
      if (webp.met) {
        for (const sns of WEBP_SNS) for (const f of WEBP_FILTER) {
          const out = join(TMP, `w${webp.quality}_${sns}_${f}.webp`);
          await encodeWebP(input, webp.quality, sns, f, out);
          const score = await measureQuality(input, out);
          if (score !== null && score >= floor) webpResults.push({ quality: webp.quality, sns, filter: f, size: fileSize(out), score, path: out, met: true });
        }
      }
    }

    webpResults.sort((a, b) => a.size - b.size);
    avifResults.sort((a, b) => a.size - b.size);
    const bWebP = webpResults[0] ?? null;
    const bAVIF = avifResults[0] ?? null;
    const pick = (!bWebP) ? bAVIF : (!bAVIF) ? bWebP : (bWebP.size <= bAVIF.size ? bWebP : bAVIF);
    const winner = !pick ? null : (pick === bAVIF ? 'avif' : 'webp');

    // attach buffers to the best of each format (so the caller can write without temp files)
    const withBuf = (r) => r ? { quality: r.quality, sns: r.sns, filter: r.filter, size: r.size, score: r.score, met: r.met, buffer: readFileSync(r.path) } : null;
    const webp = withBuf(bWebP), avif = withBuf(bAVIF);

    return {
      input, contentType, confidence, pixelArt: false, jpegQ,
      mode: verify ? 'verify' : 'fast', floor: verify ? floor : null,
      curves: perCurve, calibWebP, calibAVIF, origSize,
      webp, avif,
      webpCandidates: webpResults.map(({ quality, sns, filter, size, score }) => ({ quality, sns, filter, size, score })),
      avifCandidates: avifResults.map(({ quality, size, score }) => ({ quality, size, score })),
      winner,
      keptOriginal: !!pick && pick.size >= origSize,
    };
  } finally {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
}
