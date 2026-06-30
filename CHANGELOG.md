# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project uses [SemVer](https://semver.org/).

## [0.1.0] — 2026-06-30

First public release: content-aware JPEG → WebP/AVIF conversion plus the calibration data and
tooling behind it.

### Converter (`convert.mjs` / `lib/convert.mjs`)

- **Fast mode (default):** encodes at the calibrated quality from the shipped curves and ships the
  smaller of WebP/AVIF. Needs only `cwebp` + `avifenc` — no Python, ImageMagick, or ssimulacra2.
- **`--verify` mode:** binary-searches the lowest quality clearing an absolute SSIMULACRA2 floor
  vs the source (`--floor`, default 80). Classification-independent.
- **Never bloats:** if no encoding beats the source JPEG, the original is kept.
- **Batch mode:** point at a directory to convert every JPEG in parallel, each in an isolated
  process so one bad image can't crash the run.
- **Input robustness:** CMYK and EXIF-rotated JPEGs are normalized via ImageMagick before
  encoding; grayscale and progressive JPEGs work as-is.
- **`--contact-sheet`:** full-size JPEG vs WebP vs AVIF comparison PNG with sizes + scores.
- **`--dry-run`**, **`--keep-both`**, **`--type`**, **`--ssim-only`**.
- **Library API:** `import { convert } from './lib/convert.mjs'` — pure compute returning Buffers.
- JPEG quality read directly from the file (pure-JS DQT reader, matches `magick %Q` ±1).

### Classifier (`classify.mjs`)

- Content-type detection (photo / illustration / line-art / pixel-art) using **histogram entropy**
  as the photo↔illustration discriminator plus a full-resolution color count — **~91% accuracy**
  on the labeled sets (up from ~46% with the original edge/saturation rules).

### Calibration data

- Pre-computed quality-equivalence curves for **10 perceptual metrics × 3 content types** at
  **1% (step-1) resolution** (ssimulacra2, butteraugli, dssim, xpsnr, ms_ssim, lpips, dists, fsim,
  vif, entropy_diff); vmaf kept as a coarse line-art-only curve by design.
- Encoder-version provenance recorded in each curve's `toolchain` metadata.
- Generator and validation tooling isolated under [`calibration/`](calibration/) (not needed to
  use the converter): `calibrate.mjs`, `measure_perceptual.py` (persistent-worker batch mode),
  `classify-eval.mjs`, `fetch-datasets.mjs`, `check-encoders.mjs`, and the chart scripts.

### Web demo (`web/`)

- Zero-upload, in-browser converter (jSquash WASM encoders + the shipped curves): drag a JPEG,
  auto-classify, encode WebP/AVIF, compare with a slider. Deploys to GitHub Pages.

### Quality

- Test suite (`node --test`, 27 tests) + GitHub Actions CI on Ubuntu and macOS.
- ESLint (flat config) + CI lint job.
- README with hero comparison, plain-language savings + quality-curve charts; GPL-3.0 licensed.

### Known limitations

- The classifier still mislabels _painterly_ illustrations as photos; errors skew conservative
  and `--verify` is classification-independent.
- Calibration datasets are small (24 photo / 25 illustration / 19 line-art) and the
  illustration/line-art sets are not redistributable.

[0.1.0]: https://github.com/emrikol/image-tools/releases/tag/v0.1.0
