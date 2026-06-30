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

### `laplacian_ratio`

Laplacian variance ratio: `encoded_laplacian / reference_laplacian`. Measures how much
high-frequency energy (texture, grain, fine detail) is preserved relative to the reference.
Ratio ≥ 1.0 means no texture loss; ratio < 0.90 indicates perceptible grain/texture loss.

Calibration: find the WebP/AVIF quality at which the Laplacian ratio matches the ratio
the JPEG achieves at each quality level. This ensures the encoded image preserves the
same texture density as the JPEG, not just the same perceptual score.

**Note:** `Q=100` cap in `webp_q` means the WebP codec cannot match JPEG's Laplacian
ratio at that quality level — WebP inherently smooths high-frequency content more than
JPEG at equivalent quality settings.

**Note:** Line-art images cause Laplacian overflow (near-binary B&W images produce
extremely large Laplacian values). Use `laplacian-calibration-mixed.json` as the fallback.

Additional curve fields: `lap_ratio` (the ratio the JPEG achieved at `jpeg_q`)

Best for: grain-sensitive photographs, textured artwork, content where smoothing is
unacceptable.

Current files:

- `laplacian-calibration-photo.json` — derived from 10-point spot test (kodim01)
- `laplacian-calibration-illustration.json` — derived from 10-point spot test
- `laplacian-calibration-mixed.json` — fallback for line-art and unknown types

**⚠ Preliminary data:** The Laplacian calibration files are currently derived from a
10-point spot test on a single reference image per type. A proper calibration
(`calibrate-laplacian.mjs`) should binary-search Laplacian equivalents across the full
dataset, same as the SSIMULACRA2 calibration. The current files are suitable for testing
but should not be considered final.

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
