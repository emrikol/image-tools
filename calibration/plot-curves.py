#!/usr/bin/env python3
"""
plot-curves.py — render the calibration curves to assets/curves.png for the README.

  calibration/venv/bin/python calibration/plot-curves.py

Plots JPEG quality (x) vs the equivalent WebP/AVIF quality (y) that matches it perceptually
(SSIMULACRA2), one line per content type. The gap between the lines and the 1:1 diagonal is the
whole point: the same JPEG quality maps to very different WebP/AVIF settings by content type.
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.join(os.path.dirname(__file__), "..")
TYPES = [("photo", "#3b82f6"), ("illustration", "#22c55e"), ("line-art", "#f97316")]
BG, FG, GRID = "#0d1117", "#e6edf3", "#30363d"


def load(metric, ctype):
    with open(os.path.join(ROOT, f"{metric}-calibration-{ctype}.json")) as f:
        curve = json.load(f)["curve"]
    xs = [r["jpeg_q"] for r in curve]
    return xs, curve


def panel(ax, field, title):
    ax.set_facecolor(BG)
    ax.plot([1, 100], [1, 100], "--", color="#6e7681", lw=1.2, label="1:1 (no change)", zorder=1)
    for ctype, color in TYPES:
        xs, curve = load("ssimulacra2", ctype)
        ys = [r[field] for r in curve]
        pts = [(x, y) for x, y in zip(xs, ys, strict=False) if y is not None]
        ax.plot(
            [p[0] for p in pts], [p[1] for p in pts], color=color, lw=2.4, label=ctype, zorder=3
        )
    ax.set_title(title, color=FG, fontsize=14, pad=10, fontweight="bold")
    ax.set_xlabel("input JPEG quality", color=FG, fontsize=11)
    ax.set_xlim(10, 100)
    ax.set_ylim(1, 100)  # clip the degenerate q1–9 region
    ax.set_aspect("equal", adjustable="box")
    ax.grid(True, color=GRID, lw=0.6)
    for s in ax.spines.values():
        s.set_color(GRID)
    ax.tick_params(colors=FG, labelsize=9)


fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 5.6), facecolor=BG)
panel(a1, "webp_q", "→ equivalent WebP quality")
panel(a2, "avif_q", "→ equivalent AVIF quality")
a1.set_ylabel("quality needed to match", color=FG, fontsize=11)
leg = a2.legend(facecolor="#161b22", edgecolor=GRID, labelcolor=FG, fontsize=10, loc="lower right")
fig.suptitle(
    "The same JPEG quality means a different WebP/AVIF setting for each kind of image",
    color=FG,
    fontsize=15,
    fontweight="bold",
    y=0.98,
)
fig.text(
    0.5,
    0.005,
    "Lower line = shrinks more easily. Photos sit highest; flat artwork and "
    "line-art sit lower. (Quality matched so the images look the same to the eye.)",
    ha="center",
    color="#9aa7b4",
    fontsize=10,
)
fig.tight_layout(rect=[0, 0.03, 1, 0.95])

out = os.path.join(ROOT, "assets", "curves.png")
os.makedirs(os.path.dirname(out), exist_ok=True)
fig.savefig(out, dpi=144, facecolor=BG)
print(f"wrote {out}")
