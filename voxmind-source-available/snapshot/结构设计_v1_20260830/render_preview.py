#!/usr/bin/env python3
"""Render repeatable review images from the generated STL parts."""

from pathlib import Path
import numpy as np
import trimesh
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection


ROOT = Path(__file__).resolve().parent
STL = ROOT / "STL"
PREVIEW = ROOT / "预览"


def mesh(name, shift=(0, 0, 0)):
    m = trimesh.load_mesh(STL / name, process=True)
    m.apply_translation(shift)
    return m


def add_mesh(ax, m, color, alpha=1.0, edge=None):
    poly = Poly3DCollection(m.triangles, linewidths=0.05)
    poly.set_facecolor(color)
    poly.set_alpha(alpha)
    poly.set_edgecolor(edge or color)
    ax.add_collection3d(poly)


def style(ax, bounds, elev, azim):
    lo, hi = bounds
    center = (lo + hi) / 2
    span = max(hi - lo) * 0.58
    ax.set_xlim(center[0] - span, center[0] + span)
    ax.set_ylim(center[1] - span, center[1] + span)
    ax.set_zlim(center[2] - span, center[2] + span)
    ax.set_box_aspect((1, 1, 0.55))
    ax.view_init(elev=elev, azim=azim)
    ax.set_axis_off()


def render_closed():
    items = [
        (mesh("VoxMind_bottom_PA12.stl"), "#252b35", 1.0),
        (mesh("VoxMind_top_PA12.stl"), "#3a4350", 1.0),
        (mesh("Waveshare_2inch_display_rigid_mockup.stl"), "#071821", 1.0),
        (mesh("VoxMind_button_OK_PA12.stl", (29, 16.82, 10.35)), "#d9a826", 1.0),
        (mesh("VoxMind_button_BACK_PA12.stl", (29, 32.62, 10.35)), "#d9a826", 1.0),
        (mesh("VoxMind_button_REC_PA12.stl", (29, 48.12, 10.35)), "#d7413c", 1.0),
    ]
    fig = plt.figure(figsize=(13, 8), dpi=180, facecolor="#f5f3ee")
    ax = fig.add_subplot(111, projection="3d", facecolor="#f5f3ee")
    for m, c, a in items:
        add_mesh(ax, m, c, a)
    all_bounds = np.array([m.bounds for m, _, _ in items])
    style(ax, np.array([all_bounds[:, 0].min(0), all_bounds[:, 1].max(0)]), 58, -57)
    ax.set_title("VoxMind EVT_V1 · sellable-prototype enclosure", fontsize=17, pad=8)
    fig.tight_layout(pad=0)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    fig.savefig(PREVIEW / "VoxMind_enclosure_closed.png", bbox_inches="tight", pad_inches=0.06)
    plt.close(fig)


def render_exploded():
    items = [
        (mesh("VoxMind_bottom_PA12.stl", (0, 0, -10)), "#252b35", 1.0),
        (mesh("VoxMind_battery_503450_mockup.stl", (0, 0, -5)), "#aeb5bd", 1.0),
        (mesh("VoxMind_PCB_mechanical_mockup.stl", (0, 0, 5)), "#17844b", 1.0),
        (mesh("Waveshare_2inch_display_rigid_mockup.stl", (0, 0, 17)), "#071821", 1.0),
        (mesh("VoxMind_top_PA12.stl", (0, 0, 30)), "#3a4350", 0.82),
    ]
    fig = plt.figure(figsize=(13, 10), dpi=180, facecolor="#f5f3ee")
    ax = fig.add_subplot(111, projection="3d", facecolor="#f5f3ee")
    for m, c, a in items:
        add_mesh(ax, m, c, a)
    all_bounds = np.array([m.bounds for m, _, _ in items])
    style(ax, np.array([all_bounds[:, 0].min(0), all_bounds[:, 1].max(0)]), 30, -55)
    ax.set_title("VoxMind EVT_V1 · exploded mechanical stack", fontsize=17, pad=8)
    fig.tight_layout(pad=0)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    fig.savefig(PREVIEW / "VoxMind_enclosure_exploded.png", bbox_inches="tight", pad_inches=0.06)
    plt.close(fig)


if __name__ == "__main__":
    render_closed()
    render_exploded()
    print("Rendered previews in", PREVIEW)
