#!/usr/bin/env python3
"""
plot-savings.py — render assets/savings.png from assets/savings-data.json (run measure-sizes.mjs first).

  calibration/venv/bin/python calibration/plot-savings.py

The payoff chart: how much smaller WebP/AVIF come out vs the JPEG, at the SAME visual quality,
by content type and starting JPEG quality. Plain and practitioner-facing.
"""
import json
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.join(os.path.dirname(__file__), "..")
TYPES = [("photo", "#3b82f6"), ("illustration", "#22c55e"), ("line-art", "#f97316")]
BG, FG, GRID = "#0d1117", "#e6edf3", "#30363d"

with open(os.path.join(ROOT, "assets", "savings-data.json")) as f:
    data = json.load(f)


def panel(ax, key, title):
    ax.set_facecolor(BG)
    ax.axhline(0, color="#6e7681", lw=1.0)
    for ctype, color in TYPES:
        rows = data[ctype]
        ax.plot([r["jpeg_q"] for r in rows], [r[key] for r in rows],
                color=color, lw=2.4, marker="o", ms=4, label=ctype)
    ax.set_title(title, color=FG, fontsize=14, pad=10, fontweight="bold")
    ax.set_xlabel("quality of your JPEGs", color=FG, fontsize=11)
    ax.set_xlim(20, 90)
    ax.grid(True, color=GRID, lw=0.6)
    for s in ax.spines.values(): s.set_color(GRID)
    ax.tick_params(colors=FG, labelsize=9)
    ax.yaxis.set_major_formatter(lambda v, _: f"{v:.0f}%")


fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 5.4), facecolor=BG, sharey=True)
panel(a1, "webp_pct", "Switch to WebP")
panel(a2, "avif_pct", "Switch to AVIF")
a1.set_ylabel("smaller than the JPEG", color=FG, fontsize=11)
a2.legend(facecolor="#161b22", edgecolor=GRID, labelcolor=FG, fontsize=10, loc="upper right")
fig.suptitle("How much smaller — same image, same quality, modern format",
             color=FG, fontsize=16, fontweight="bold", y=0.98)
fig.text(0.5, 0.005, "Each point: the file shrinks this much with no visible quality loss. "
         "Higher = bigger win. AVIF wins most; flat artwork shrinks the most.",
         ha="center", color="#9aa7b4", fontsize=10)
fig.tight_layout(rect=[0, 0.03, 1, 0.95])

out = os.path.join(ROOT, "assets", "savings.png")
fig.savefig(out, dpi=144, facecolor=BG)
print(f"wrote {out}")
