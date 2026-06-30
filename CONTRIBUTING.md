# Contributing to image-tools

> **This repository does not accept public contributions.** Pull requests are accepted only from
> collaborators explicitly added to the repo; PRs from anyone else are closed automatically. Issues
> are disabled, and the project is provided **as-is with no support** — see the
> [Support Policy](README.md#support-policy).
>
> If you'd like it to do something different, please **fork it** and continue under the
> [GPL-3.0 license](LICENSE). For redistributed, modified versions, please use a different project name
> to avoid confusion.

The rest of this file is for collaborators.

## Development

It's plain Node ESM — there's no build step.

- **Test:** `npm test` (Node's built-in runner). Encoder-dependent tests skip automatically if
  `cwebp` / `avifenc` aren't on `PATH`.
- **Lint:** `npm run lint` (ESLint — the only devDependency; run `npm install` first).
- **Run it:** `node convert.mjs <input.jpg> <out-dir>`. Fast mode needs only `cwebp` + `avifenc`;
  `--verify` additionally needs `ssimulacra2`.

## Things to know before changing code

- **`calibration/` is archival.** The curves are already generated and committed at the repo root;
  you never need to re-run the generator to work on the converter. See
  [`calibration/README.md`](calibration/README.md).
- **Keep encoder flags in sync** between `calibration/calibrate.mjs` and `lib/convert.mjs`
  (AVIF `--speed 0`, WebP `-m 6`) — if they drift, curves and conversions disagree.
- **Adding a metric** needs no code change: drop a `{metric}-calibration-{type}.json` at the root.

See [`CLAUDE.md`](CLAUDE.md) for the full as-built architecture and gotchas.
