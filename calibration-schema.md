# Calibration File Schema

All calibration JSON files share a common schema. The `metric` field identifies how
equivalence was measured; `curve` contains the lookup table. `convert.mjs` loads any
number of calibration files and takes the maximum quality across all of them, ensuring
every quality constraint is simultaneously satisfied.

---

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `$schema` | `"calibration-schema"` | Identifies this file as a calibration file |
| `metric` | string | The quality metric used to define equivalence (see Metrics below) |
| `content_type` | string | Image content type this curve applies to: `photo`, `illustration`, `line-art`, `mixed` |
| `description` | string | Human-readable explanation of the dataset and methodology |
| `generated` | ISO date string | When the file was generated |
| `curve` | array | Quality lookup table — see Curve Entry below |

## Curve Entry

Each entry in `curve` corresponds to one JPEG quality level:

| Field | Type | Description |
|-------|------|-------------|
| `jpeg_q` | integer 1–100 | Input JPEG quality level |
| `webp_q` | integer 1–100 \| null | Minimum WebP quality to achieve equivalent quality |
| `avif_q` | integer 1–100 \| null | Minimum AVIF quality to achieve equivalent quality |
| *(metric fields)* | number \| null | Additional fields specific to the metric (e.g., `score`, `lap_ratio`) |

`null` means no valid encoding was found at that quality level for that format.

`100` as a quality value may indicate a **ceiling** — the format cannot fully match JPEG
at this quality level with the metric being measured. See metric-specific notes.

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `encoders` | object | Exact encoder CLI flags used during calibration |
| `toolchain` | object | Encoder versions the curve was generated with (`cwebp`, `avifenc`, `aom`, `ssimulacra2`) — for provenance/reproducibility, since sizes vary by encoder build. Recorded by `calibration/check-encoders.mjs`. |
| `images_done` | integer | Number of images calibrated |
| `images_total` | integer | Total images in the dataset |
| `raw` | array | Per-image results (omitted if file size is a concern) |
| `source` | string | For derived calibrations, path to the source data file |

---

## Metrics

### `ssimulacra2`

SSIMULACRA2 perceptual quality score. Range: −∞ to 100 (higher = better perceptual match).
Calibration: binary search finds the lowest WebP/AVIF quality whose SSIMULACRA2 score
matches the JPEG score at that quality level. Results are averaged across all images in
the dataset.

Additional curve fields: `score` (the SSIMULACRA2 score the JPEG achieved at `jpeg_q`)

Best for: overall perceptual quality, general-purpose use.

Current files:

- `ssimulacra2-calibration-photo.json` — 24 Kodak lossless PNGs
- `ssimulacra2-calibration-illustration.json` — 25 curated flat-color illustrations
- `ssimulacra2-calibration-line-art.json` — 19 curated B&W line-art images

---

### Other metrics

The remaining metrics — `butteraugli`, `dssim`, `xpsnr`, `ms_ssim`, `lpips`, `dists`,
`fsim`, `vif`, `entropy_diff` (and `vmaf`, line-art only) — share the same schema. Each
records its own value field (e.g. `butteraugli_dist`, `lpips`, `xpsnr_db`) alongside
`webp_q` / `avif_q`, and its direction is given by `higher_is_better`. All are calibrated
at step 1 (1–100) except `vmaf`, which is intentionally limited to a coarse line-art curve.
See `calibration/calibrate.mjs`'s metric registry for how each score is computed.

---

## How convert.mjs Uses Multiple Curves

For a given content type and input JPEG quality:

1. Load all available calibration files matching the content type
2. Interpolate `webp_q` and `avif_q` from each curve
3. Use `max(webp_q across all curves)` as the WebP quality center
4. Use `max(avif_q across all curves)` as the AVIF quality center
5. Fuzz ±`QUALITY_WINDOW` points around each center
6. Pick the smallest encoding whose SSIMULACRA2 score meets the quality floor

Adding a new calibration file is sufficient — no code changes required.
Drop `{metric}-calibration-{content_type}.json` into the image-tools directory.
