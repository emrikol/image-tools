# calibration/ — how the shipped curves were generated

**You do not need anything in this directory to use the converter.** The calibration curves
it produces are already generated and committed at the repo root (`*-calibration-*.json`).
`convert.mjs` / `classify.mjs` read those directly and require none of the heavy tooling here.

This directory is kept for **transparency and reproducibility** — it's the pipeline that
measured the JPEG→WebP/AVIF quality-equivalence curves. Running it is a one-time, multi-hour job.

## Contents

```
calibrate.mjs           Generates {metric}-calibration-{type}.json curves
measure_perceptual.py   PyTorch metrics shim (one-shot + persistent `serve` worker mode)
requirements.txt        Python deps for the PyTorch metrics
venv/                   Python virtualenv (gitignored; create per requirements.txt)
encoding-cache/         Cached encodings, regenerated on demand (gitignored)
```

## Extra dependencies (beyond the converter's)

The generator needs everything the converter does **plus**: `ssimulacra2`, `butteraugli_main`
(libjxl devtools), `dssim`, `ffmpeg`, ImageMagick, and the Python venv (torch, piq, lpips,
DISTS-pytorch — see `requirements.txt`).

```bash
python3 -m venv venv
venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
venv/bin/pip install -r requirements.txt
```

## Regenerating the curves (optional)

From the repo root, supply datasets and write the curves back to the root so the converter
picks them up:

```bash
node calibration/calibrate.mjs \
  --dataset photo:test-images/kodak:. \
  --dataset illustration:test-images/illustrations:. \
  --dataset line-art:test-images/line-art:. \
  --metrics ssimulacra2,butteraugli,dssim,xpsnr,ms_ssim,lpips,dists,fsim,vif,entropy_diff \
  --step 1
```

Defaults to all CPU cores (`--concurrency`) with single-threaded encoders (`--avif-jobs 1`);
PyTorch metrics run through persistent per-metric worker pools. See the script header for the
full metric list and flags. `vmaf` is intentionally excluded for photo/illustration (it
saturates and breaks the max-across-curves logic in the converter).
