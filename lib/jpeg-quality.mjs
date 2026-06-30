// JPEG quality estimation with no external dependency.
//
// Reads the DQT quantization table(s) and applies ImageMagick's quality heuristic
// (coders/jpeg.c) — encoder-agnostic, matching `magick identify -format %Q` within ±1
// across the full 1–100 range (validated against magick on synthetic sweeps and real-world
// JPEGs from multiple encoders). Lets the converter's fast path avoid ImageMagick entirely.

import { readFileSync } from 'node:fs';

const HASH = [
  1020,1015,932,848,780,735,702,679,660,645,632,623,613,607,600,594,589,585,581,571,
  555,542,529,514,494,474,457,439,424,410,397,386,373,364,351,341,334,324,317,309,
  299,294,287,279,274,267,262,257,251,247,243,237,232,227,222,217,213,207,202,198,
  192,188,183,177,173,168,163,157,153,148,143,139,132,128,125,119,115,108,104,99,
  94,90,84,79,74,70,64,59,55,49,45,40,34,30,25,20,15,11,6,4,0];
const SUMS = [
  32640,32635,32266,31495,30665,29804,29146,28599,28104,27670,27225,26725,26210,25716,25240,
  24789,24373,23946,23572,22846,21801,20842,19949,19121,18386,17651,16998,16349,15800,15247,
  14783,14321,13859,13535,13081,12702,12423,12056,11779,11513,11135,10955,10676,10392,10208,
  9928,9747,9564,9369,9193,9017,8822,8639,8458,8270,8084,7896,7710,7527,7347,7156,6977,6788,
  6607,6422,6236,6054,5867,5684,5495,5305,5128,4945,4751,4638,4442,4248,4065,3888,3698,3509,
  3326,3139,2957,2775,2586,2405,2216,2037,1846,1666,1483,1297,1109,927,735,554,375,201,128,0];
const HASH1 = [
  510,505,422,380,355,338,326,318,311,305,300,297,293,291,288,286,284,283,281,280,
  279,278,277,273,262,251,243,233,225,218,211,205,198,193,186,181,177,172,168,164,
  158,156,152,148,145,142,139,136,133,131,129,126,123,120,118,115,113,110,107,105,
  102,100,97,94,92,89,87,83,81,79,76,74,70,68,66,63,61,57,55,52,50,48,44,42,39,37,
  34,31,29,26,24,21,18,16,13,11,8,6,3,2,0];
const SUMS1 = [
  16320,16315,15946,15277,14655,14073,13623,13230,12859,12560,12240,11861,11456,11081,10714,
  10360,10027,9679,9368,9056,8680,8331,7995,7668,7376,7084,6823,6562,6345,6125,5939,5756,
  5571,5421,5240,5086,4976,4829,4719,4616,4463,4393,4280,4166,4092,3980,3909,3835,3755,3688,
  3621,3541,3467,3396,3323,3247,3170,3096,3021,2952,2874,2804,2727,2657,2583,2509,2437,2362,
  2290,2211,2136,2068,1996,1915,1858,1773,1692,1620,1552,1477,1398,1326,1251,1179,1109,1031,
  961,884,814,736,667,592,518,441,369,292,221,151,86,64,0];

/** Parse the DQT quantization tables out of a JPEG buffer. Returns an array of 64-int tables. */
export function readQuantTables(buf) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return [];  // not a JPEG
  const tables = [];
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD9) break;                              // EOI
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }  // standalone markers
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (m === 0xDB) {                                   // DQT (may pack several tables)
      let p = i + 4; const end = i + 2 + len;
      while (p < end) {
        const pq = buf[p] >> 4, tq = buf[p] & 0x0F; p++;
        const t = [];
        for (let k = 0; k < 64; k++) { t.push(pq ? ((buf[p] << 8) | buf[p + 1]) : buf[p]); p += pq ? 2 : 1; }
        tables[tq] = t;
      }
    }
    if (m === 0xDA) break;                              // SOS — image data follows
    i += 2 + len;
  }
  return tables.filter(Boolean);
}

/** Estimate JPEG quality (1–100) from quantization tables, or null if unparseable. */
export function jpegQualityFromTables(qt) {
  if (!qt || qt.length === 0) return null;
  let sum = 0;
  for (const t of qt) for (const v of t) sum += v;
  let hash, sums, qvalue;
  if (qt.length >= 2 && qt[1]) {
    qvalue = qt[0][2] + qt[0][53] + qt[1][0] + qt[1][63];
    hash = HASH; sums = SUMS;
  } else {
    qvalue = qt[0][2] + qt[0][53];
    hash = HASH1; sums = SUMS1;
  }
  for (let k = 0; k < 100; k++) {
    if (qvalue < hash[k] && sum < sums[k]) continue;
    return k + 1;
  }
  return 100;
}

/** Read a JPEG file and estimate its quality (1–100), or null if it can't be parsed. */
export function jpegQualityFromBytes(path) {
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  return jpegQualityFromTables(readQuantTables(buf));
}
