import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, lineChart } from '../web/pure.mjs';

// Build a synthetic ImageData-like object: { data: Uint8ClampedArray, width, height }.
function img(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

// ── classifier (locks the validated entropy discriminator into CI) ──
test('classify: a uniform color fill is an illustration (zero entropy)', () => {
  assert.equal(classify(img(64, 64, () => [100, 150, 200])), 'illustration');
});

test('classify: a full-range smooth luminance ramp is a photo (high entropy)', () => {
  // 256-wide grayscale ramp → uniform histogram → entropy ≈ 1.0, edges low (smooth)
  assert.equal(classify(img(256, 32, (x) => [x, x, x])), 'photo');
});

test('classify: grayscale high-frequency noise is line-art (no saturation, strong edges)', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff;
  const v = () => {
    const c = rnd() < 0.5 ? 0 : 255;
    return [c, c, c];
  };
  assert.equal(classify(img(120, 120, v)), 'line-art');
});

// ── inline-SVG chart builder ──
test('lineChart emits a valid <svg> with a polyline and the aria label', () => {
  const svg = lineChart({
    xMin: 0,
    xMax: 100,
    yMin: 0,
    yMax: 100,
    xLabel: 'x',
    yLabel: 'y',
    aria: 'test chart',
    series: [
      {
        points: [
          [0, 0],
          [50, 50],
          [100, 100],
        ],
        color: '#fff',
      },
    ],
  });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.match(svg, /<polyline/);
  assert.match(svg, /aria-label="test chart"/);
});

test('lineChart drops null / non-finite points from a series', () => {
  const svg = lineChart({
    xMin: 0,
    xMax: 10,
    yMin: 0,
    yMax: 10,
    xLabel: 'x',
    yLabel: 'y',
    series: [
      {
        points: [
          [0, 0],
          [5, null],
          [10, 10],
        ],
        color: '#fff',
      },
    ],
  });
  const pts = svg
    .match(/points="([^"]*)"/)[1]
    .trim()
    .split(' ');
  assert.equal(pts.length, 2, 'the null point is filtered out');
});

test('lineChart escapes < and & in labels', () => {
  const svg = lineChart({ xMin: 0, xMax: 1, yMin: 0, yMax: 1, xLabel: 'a < b & c', yLabel: 'y' });
  assert.match(svg, /a &lt; b &amp; c/);
});
