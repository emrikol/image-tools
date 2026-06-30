# web/ — browser demo

A zero-upload, in-browser version of the converter: drop a JPEG, get a smaller WebP/AVIF at the
same perceptual quality. It reuses the project's portable logic (`../lib/jpeg-quality.mjs`,
`../lib/curves.mjs`) plus WASM encoders ([jSquash](https://github.com/jamsinclair/jSquash)),
and the precomputed `curves.json` (max-across-metrics, generated from the calibration data).

It runs **fast mode** (curve-only): detect JPEG quality from the file, auto-classify content type
(saturation + Sobel edge density; user-overridable), look up the calibrated WebP/AVIF quality, and
encode both — shipping the smaller, never larger than the source. The CLI's `--verify` floor isn't
in the browser (no `ssimulacra2` WASM), and AVIF runs at a faster speed than the CLI's `--speed 0`,
so the demo's savings are a conservative preview of what the CLI achieves.

## Run locally

```bash
# from the repo root (so ../lib/ resolves)
python3 -m http.server 8765
# open http://localhost:8765/web/
```

## Deploy

The included GitHub Actions workflow (`.github/workflows/pages.yml`) publishes the repo to GitHub
Pages on push to `main`; the demo lives at `https://OWNER.github.io/image-tools/web/`. Enable Pages
(Settings → Pages → Source: GitHub Actions) once.
