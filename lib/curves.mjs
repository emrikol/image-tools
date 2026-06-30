// Calibration-curve helpers (pure, no external dependencies).

/**
 * Linearly interpolate a field (e.g. 'webp_q' / 'avif_q') from a calibration curve at a given
 * JPEG quality. Clamps to the curve's endpoints. Returns null if the field is null throughout.
 */
export function interpolate(curve, jpegQ, field) {
  const sorted = [...curve].sort((a, b) => a.jpeg_q - b.jpeg_q);
  const lo = [...sorted]
    .reverse()
    .find((r) => r.jpeg_q <= jpegQ && r[field] !== null && r[field] !== undefined);
  const hi = sorted.find((r) => r.jpeg_q >= jpegQ && r[field] !== null && r[field] !== undefined);
  if (!lo && !hi) return null;
  if (!lo) return hi[field];
  if (!hi) return lo[field];
  if (lo.jpeg_q === hi.jpeg_q) return lo[field];
  const t = (jpegQ - lo.jpeg_q) / (hi.jpeg_q - lo.jpeg_q);
  return Math.round(lo[field] + t * (hi[field] - lo[field]));
}
