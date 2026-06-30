#!/usr/bin/env python3
"""
measure_perceptual.py — perceptual metrics for calibrate.mjs (Python/PyTorch).

Two modes:

  One-shot (backward compatible):
      measure_perceptual.py <metric> <ref.png> <cmp.png>
      → prints a single float to stdout.

  Serve (batch / persistent worker — avoids re-importing torch and reloading the
  model on every measurement):
      measure_perceptual.py serve <metric>
      → loads the metric's model ONCE, then reads request lines from stdin, one
        per measurement, formatted "<ref_path>\\t<cmp_path>\\n", and writes one
        float per line to stdout (flushed). EOF on stdin ends the worker.

Supported metrics:
  ms_ssim       Multi-Scale SSIM via piq (higher=better, 0..1)
  lpips         Learned Perceptual Image Patch Similarity (lower=better)
  dists         Deep Image Structure and Texture Similarity (lower=better)
  fsim          Feature Similarity Index via piq (higher=better, 0..1)
  vif           Visual Information Fidelity via piq (higher=better)
  entropy_diff  Multi-scale local entropy difference (lower=better)

Install (run once from repo root):
  python3.13 -m venv venv
  venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
  venv/bin/pip install lpips DISTS-pytorch IQA-pytorch piq cvvdp
"""

import sys
import os
import contextlib

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
os.environ.setdefault('TQDM_DISABLE', '1')

import torch
from PIL import Image
import torchvision.transforms.functional as F

torch.set_grad_enabled(False)


def load(path):
    return F.to_tensor(Image.open(path).convert('RGB')).unsqueeze(0)


def build(metric):
    """Return a compute(ref_path, cmp_path) -> float closure with any model loaded once."""
    if metric == 'ms_ssim':
        import piq
        return lambda r, c: piq.multi_scale_ssim(load(r), load(c), data_range=1.0).item()

    if metric == 'fsim':
        # Feature Similarity Index — gradient/phase congruency across scales.
        import piq
        return lambda r, c: piq.fsim(load(r), load(c), data_range=1.0).item()

    if metric == 'vif':
        # Visual Information Fidelity — statistical fidelity in a wavelet domain.
        import piq
        return lambda r, c: piq.vif_p(load(r), load(c), data_range=1.0).item()

    if metric == 'lpips':
        import lpips
        fn = lpips.LPIPS(net='alex', verbose=False)
        return lambda r, c: fn(load(r) * 2 - 1, load(c) * 2 - 1).item()  # lpips expects [-1, 1]

    if metric == 'dists':
        from DISTS_pytorch import DISTS
        fn = DISTS()
        return lambda r, c: fn(load(r), load(c)).item()

    if metric == 'entropy_diff':
        # Multi-scale local entropy difference (SpEED-QA inspired). scipy variance
        # approximation of local entropy at 3 spatial scales, on grayscale.
        import numpy as np
        from scipy.ndimage import uniform_filter

        def gray(path):
            return np.array(Image.open(path).convert('L')).astype(np.float64) / 255.0

        def local_entropy(g, radius):
            q = (g * 255).astype(np.uint8).astype(np.float64)
            size = radius * 2 + 1
            mean = uniform_filter(q, size=size)
            mean_sq = uniform_filter(q * q, size=size)
            var = np.maximum(mean_sq - mean ** 2, 0)
            return np.log1p(var)

        def compute(r, c):
            rg, cg = gray(r), gray(c)
            diffs = [float(np.mean(np.abs(local_entropy(rg, rad) - local_entropy(cg, rad))))
                     for rad in (5, 11, 21)]
            return sum(diffs) / len(diffs)

        return compute

    raise ValueError(f'Unknown metric: {metric}')


def main():
    torch.set_num_threads(1)  # one thread/process; calibrate.mjs runs many workers

    if len(sys.argv) >= 2 and sys.argv[1] == 'serve':
        metric = sys.argv[2]
        real_stdout = sys.stdout
        # Some libs print banners to stdout while loading — mute during build so the
        # protocol stream stays clean (only floats on real stdout).
        with contextlib.redirect_stdout(sys.stderr):
            compute = build(metric)
        # readline() (not `for line in sys.stdin`) — the iterator read-ahead buffer
        # would deadlock a request/response protocol.
        while True:
            line = sys.stdin.readline()
            if not line:
                break  # EOF
            line = line.rstrip('\n')
            if not line:
                continue
            parts = line.split('\t')
            try:
                v = compute(parts[0], parts[1])
            except Exception as e:  # noqa: BLE001 — never let one bad pair kill the worker
                sys.stderr.write(f'measure error ({metric}): {e}\n')
                v = float('nan')
            real_stdout.write(f'{float(v):.6f}\n')
            real_stdout.flush()
        return

    # One-shot mode
    metric, ref_path, cmp_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with contextlib.redirect_stdout(sys.stderr):
        compute = build(metric)
    print(f'{float(compute(ref_path, cmp_path)):.6f}')


if __name__ == '__main__':
    try:
        main()
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
