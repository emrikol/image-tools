// web/pure.mjs — DOM-free logic for the demo, so it's unit-testable in Node.
// (The classifier and the chart builder are pure functions; app.mjs imports them.)

export const clamp = (q) => Math.min(100, Math.max(1, Math.round(q ?? 80)));

// ─── content-type classifier (ported + validated from the CLI) ──────────────────
// Photo↔illustration is decided by luminance-histogram entropy: photos fill the histogram
// (continuous tone + sensor noise → high entropy), flat-fill illustrations are peaky (low).
// Line-art is caught first by near-zero saturation + strong ink edges. ENTROPY_THRESHOLD was
// validated against the labeled sets at ~92% (calibration/validate-browser-classifier.mjs).
// It differs from the CLI's 0.70 because that is tuned to ImageMagick's %[entropy] normalization;
// this is a normalized Rec601 luminance-histogram entropy.
export const ENTROPY_THRESHOLD = 0.87;

export function classify(imageData) {
  const { data, width, height } = imageData;

  // Luminance-histogram entropy over all pixels (photo ↔ illustration).
  const hist = new Array(256).fill(0);
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const L = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    hist[Math.min(255, Math.round(L))]++;
  }
  let H = 0;
  for (const c of hist)
    if (c) {
      const p = c / total;
      H -= p * Math.log2(p);
    }
  const entropy = H / 8; // normalize by log2(256)

  // Saturation + Sobel edge density on a ~200px sample (line-art).
  const step = Math.max(1, Math.floor(width / 200));
  let satSum = 0,
    n = 0;
  const lum = [];
  const cols = Math.ceil(width / step),
    rows = Math.ceil(height / step);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255,
        g = data[i + 1] / 255,
        b = data[i + 2] / 255;
      const mx = Math.max(r, g, b),
        mn = Math.min(r, g, b),
        l = (mx + mn) / 2;
      satSum += mx === mn ? 0 : l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
      lum.push(0.299 * r + 0.587 * g + 0.114 * b);
      n++;
    }
  }
  const satMean = satSum / n;
  let edges = 0,
    cnt = 0;
  const at = (cx, cy) => lum[cy * cols + cx];
  for (let cy = 1; cy < rows - 1; cy++) {
    for (let cx = 1; cx < cols - 1; cx++) {
      const gx =
        at(cx - 1, cy - 1) +
        2 * at(cx - 1, cy) +
        at(cx - 1, cy + 1) -
        at(cx + 1, cy - 1) -
        2 * at(cx + 1, cy) -
        at(cx + 1, cy + 1);
      const gy =
        at(cx - 1, cy - 1) +
        2 * at(cx, cy - 1) +
        at(cx + 1, cy - 1) -
        at(cx - 1, cy + 1) -
        2 * at(cx, cy + 1) -
        at(cx + 1, cy + 1);
      if (Math.hypot(gx, gy) > 0.25) edges++;
      cnt++;
    }
  }
  const edge = cnt ? edges / cnt : 0;

  if (satMean < 0.08 && edge > 0.1) return 'line-art'; // near-grayscale + strong ink edges
  return entropy < ENTROPY_THRESHOLD ? 'illustration' : 'photo';
}

// ─── inline-SVG line chart (no chart library, no DOM) ────────────────────────────
export const C_WEBP = '#38bdf8',
  C_AVIF = '#2dd4bf',
  C_JPEG = '#f59e0b',
  C_REF = '#64748b',
  C_GRID = '#2a3340',
  C_TXT = '#9aa7b4';

export function lineChart({
  xMin,
  xMax,
  yMin,
  yMax,
  series = [],
  hlines = [],
  markers = [],
  xLabel,
  yLabel,
  yFmt = (v) => Math.round(v),
  legend = [],
  aria = '',
}) {
  const W = 560,
    H = 300,
    P = { l: 54, r: 16, t: 28, b: 38 };
  const x0 = P.l,
    y0 = H - P.b,
    x1 = W - P.r,
    y1 = P.t;
  const X = (v) => x0 + ((v - xMin) / (xMax - xMin)) * (x1 - x0);
  const Y = (v) => y0 - ((v - yMin) / (yMax - yMin)) * (y0 - y1);
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria || xLabel)}">`;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4,
      y = Y(v);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${C_GRID}"/>`;
    s += `<text x="${x0 - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="${C_TXT}" font-size="11">${esc(yFmt(v))}</text>`;
  }
  for (let i = 0; i <= 5; i++) {
    const v = xMin + ((xMax - xMin) * i) / 5,
      x = X(v);
    s += `<text x="${x.toFixed(1)}" y="${y0 + 18}" text-anchor="middle" fill="${C_TXT}" font-size="11">${Math.round(v)}</text>`;
  }
  s += `<text x="${((x0 + x1) / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" fill="${C_TXT}" font-size="11">${esc(xLabel)}</text>`;
  s += `<text x="14" y="${((y0 + y1) / 2).toFixed(0)}" text-anchor="middle" fill="${C_TXT}" font-size="11" transform="rotate(-90 14 ${((y0 + y1) / 2).toFixed(0)})">${esc(yLabel)}</text>`;
  for (const h of hlines) {
    const y = Y(h.y);
    s += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x1}" y2="${y.toFixed(1)}" stroke="${h.color}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    if (h.label)
      s += `<text x="${x1}" y="${(y - 5).toFixed(1)}" text-anchor="end" fill="${h.color}" font-size="11">${esc(h.label)}</text>`;
  }
  for (const ser of series) {
    const pts = ser.points
      .filter((p) => p[1] != null && isFinite(p[1]))
      .map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`)
      .join(' ');
    if (pts)
      s += `<polyline points="${pts}" fill="none" stroke="${ser.color}" stroke-width="${ser.dashed ? 1.4 : 2.2}"${ser.dashed ? ' stroke-dasharray="5 5"' : ''}/>`;
  }
  for (const m of markers) {
    const x = X(m.x),
      y = Y(m.y);
    s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${m.color}" stroke="#0d1117" stroke-width="1.5"/>`;
    if (m.label)
      s += `<text x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}" fill="${m.color}" font-size="11" font-weight="600">${esc(m.label)}</text>`;
  }
  let lx = x0 + 2;
  for (const l of legend) {
    s += `<rect x="${lx}" y="${y1 - 18}" width="11" height="11" rx="2" fill="${l.color}"/>`;
    s += `<text x="${lx + 15}" y="${y1 - 9}" fill="#e6edf3" font-size="11">${esc(l.label)}</text>`;
    lx += 15 + l.label.length * 6.4 + 14;
  }
  return s + `</svg>`;
}
