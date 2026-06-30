# image-tools

Content-aware JPEG → WebP/AVIF conversion. Most quality tables assume your images look like
photographs — but a JPEG quality 80 *photo*, *illustration*, and *line-art* scan each need a
**different** WebP/AVIF quality to preserve equivalent perceptual quality. These tools measure
that difference per content type, then use it to convert each image to the smallest modern file
that still meets a perceptual-quality floor.

No hand-tuning, no per-image judgment calls. Point it at a JPEG, get back a smaller WebP or AVIF.

## How it works

1. **Classify** the image by content type (photo / illustration / line-art / pixel-art) from
   ImageMagick signal extraction.
2. **Look up** the calibrated WebP/AVIF quality equivalents for that content type and the input
   JPEG's detected quality.
3. **Fuzz** encoder parameters in a small window around the calibrated quality.
4. **Pick** the smallest output whose [SSIMULACRA2](https://github.com/cloudinary/ssimulacra2)
   score meets the floor set by the original.

## Requirements

- **Node.js** (ESM; no npm dependencies)
- **ImageMagick 7** (`magick`), **`cwebp`** (libwebp), **`avifenc`** (libavif),
  **`ssimulacra2`** (libjxl devtools) on your `PATH`
- For full calibration only: `butteraugli_main`, `dssim`, `ffmpeg`, `vmaf`, and the Python venv
  (`venv/bin/python` — torch, torchvision, piq, lpips, DISTS-pytorch, scipy)

On macOS most of these are available via Homebrew; `ssimulacra2`/`butteraugli_main` come from a
libjxl build with devtools enabled.

## Setup

Conversion and classification need **no installation** beyond the CLI tools above — clone and run.

The Python venv is only required to *regenerate* calibration curves for the PyTorch metrics:

```bash
python3 -m venv venv
venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
venv/bin/pip install -r requirements.txt
```

## Datasets

**Source images are not bundled** in this repo (they're large, and the illustration/line-art
sets are third-party content). The committed calibration JSONs contain only numbers, so you can
use `classify.mjs` / `convert.mjs` immediately without any images.

To re-run calibration you supply your own datasets under `test-images/<type>/`:
- **photo** — the [Kodak lossless set](https://r0k.us/graphics/kodak/) (24 public-domain-style benchmark PNGs)
- **illustration / line-art** — bring your own (flat-color artwork; black-and-white ink/pencil art)

## Usage

### Convert a JPEG

```bash
node convert.mjs input.jpg output-dir/                       # auto-detect content type
node convert.mjs input.jpg output-dir/ --type illustration   # override content type
node convert.mjs input.jpg output-dir/ --report              # print the full candidate table
node convert.mjs input.jpg output-dir/ --keep-both           # write both WebP and AVIF winners
node convert.mjs input.jpg output-dir/ --contact-sheet       # also write a visual comparison PNG
```

Useful flags: `--quality-window N` (fuzz width, default 5), `--ssim-tolerance N` (how far below
baseline a candidate may score, default 1.0), `--no-lap` (use only the SSIMULACRA2 curve),
`--contact-sheet` / `--compare` (write `<stem>-compare.png`: the original JPEG next to the
perceptually-matched WebP and AVIF at full size, captioned with file size + SSIMULACRA2 score, so
you can eyeball that the "equivalent quality" claim holds).

### Classify an image

```bash
node classify.mjs image.jpg                # single image -> JSON
node classify.mjs image.jpg --verbose      # include raw signal values
node classify.mjs *.png --batch            # JSON array, progress on stderr
```

### Generate calibration curves

A one-time, expensive job (AVIF runs at `--speed 0` for the true quality ceiling).

```bash
node calibrate.mjs \
  --dataset photo:test-images/kodak:. \
  --dataset illustration:test-images/illustrations:. \
  --dataset line-art:test-images/line-art:. \
  --metrics ssimulacra2,butteraugli,dssim,xpsnr,ms_ssim,lpips,dists,fsim,vif,entropy_diff \
  --step 1
```

Encodings are cached in `encoding-cache/`, so re-running (e.g. to add another `--metrics`)
reuses prior work. Add `--step 10` for a fast coarse pass; merge a finer pass later.

By default it uses every logical CPU core (`--concurrency`) with single-threaded encoders
(`--avif-jobs 1`) — benchmarked as the fastest layout for many small images. PyTorch metrics
run through persistent worker pools (the model loads once, not per measurement), which is what
makes a full step-1 run across all metrics finish in hours rather than overnight.

## Calibration data

`{metric}-calibration-{content-type}.json` — JPEG→WebP/AVIF quality lookup tables, one per
perceptual metric per content type. Schema and the full list of metrics are documented in
[`calibration-schema.md`](calibration-schema.md). `convert.mjs` loads every curve available for
a content type and takes the most conservative (highest) quality across them as its starting
point.

All curves are **full-resolution (every JPEG quality 1–100)** — ssimulacra2, butteraugli,
dssim, xpsnr, ms_ssim, lpips, dists, fsim, vif, and entropy_diff — across photo, illustration,
and line-art. The one exception is **vmaf**, kept as a coarse 11-point line-art-only curve
(it's intentionally disabled for photo/illustration; see the limitations below).

## Status & known limitations

This is a research toolkit, not a polished release. Current rough edges:

- **AVIF scoring requires a working ImageMagick AVIF (`heic`) delegate.** AVIF candidates are
  scored by decoding to PNG via `magick`; if a Homebrew `libheif` upgrade breaks that delegate,
  AVIF is silently dropped and only WebP is produced. Check with
  `magick -list format | grep -i avif` (should be `rw+`); fix with `brew reinstall imagemagick`.
- **`mixed` content type falls back to the photo curves.** An image the classifier can't
  confidently categorize is converted using the (conservative) photo calibration. Pass an
  explicit `--type` for best accuracy.
- **`vmaf` is calibrated for line-art only** and is otherwise disabled (it saturates at high
  quality and distorts the max-across-curves logic).
- **`laplacian-curves.json` is preliminary** (a single-image spot test) and is not currently
  consumed by the converter.
- Datasets are small (24 photo / 25 illustration / 19 line-art). The `DIV2K` set is staged for a
  larger future run but not yet wired in.

See [`CLAUDE.md`](CLAUDE.md) for the full as-built notes and gotchas, and
[`blog-post.md`](blog-post.md) for the methodology write-up.

## License

Calibration data is intended for release under CC0 (see `blog-post.md`). No license file is
present yet for the code.
