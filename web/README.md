# web/ — browser demo

A zero-upload, in-browser version of the converter: drop a JPEG, get a smaller WebP/AVIF at the
same perceptual quality, plus two per-image graphs (where your image lands on the calibration
curve, and its own file-size-vs-quality sweep — the in-browser analogues of the README charts).
It reuses the project's portable logic (`../lib/jpeg-quality.mjs`, `../lib/curves.mjs`) plus WASM
encoders ([jSquash](https://github.com/jamsinclair/jSquash)), and the precomputed `curves.json`
(max-across-metrics, generated from the calibration data).

It runs **fast mode** (curve-only): detect JPEG quality from the file, auto-classify content type,
look up the calibrated WebP/AVIF quality, and encode both — shipping the smaller, never larger than
the source. The classifier is the CLI's **entropy** approach ported to the browser (luminance-
histogram entropy for photo↔illustration; ~90% on the labeled sets, verified in-browser — see
`calibration/validate-browser-classifier.mjs` for how the threshold was derived); content-type
buttons let you override. One simplification vs. the CLI, safe because the result is a _preview_:
the `--verify` SSIMULACRA2 floor isn't in the browser (no `ssimulacra2` WASM) and AVIF runs at a
faster speed than the CLI's `--speed 0`, so the demo's savings are a _conservative_ preview of what
the CLI achieves.

## Run locally

```bash
# from the repo root (so ../lib/ resolves)
python3 -m http.server 8765
# open http://localhost:8765/web/
```

## Deploy

The included GitHub Actions workflow (`.github/workflows/pages.yml`) publishes the repo to GitHub
Pages on push to `main`; the demo lives at `https://emrikol.github.io/image-tools/web/`. Enable Pages
(Settings → Pages → Source: GitHub Actions) once.
