#!/usr/bin/env python3
"""Reproducible mesh and closed-assembly interference checks."""

from pathlib import Path
import json
import sys
import trimesh
from OCP.STEPControl import STEPControl_Reader
import cadquery as cq

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import voxmind_enclosure as v  # noqa: E402


REAL_PCB_STEP = ROOT / "参考模型" / "VoxMind_EVT_V1_v9_real_assembled.step"


def load_real_pcb():
    """Load the EasyEDA live assembled STEP without flattening its 445 solids."""
    reader = STEPControl_Reader()
    if reader.ReadFile(str(REAL_PCB_STEP)).name != "IFSelect_RetDone":
        raise RuntimeError(f"Cannot read {REAL_PCB_STEP}")
    reader.TransferRoots()
    return cq.Shape(reader.OneShape()).translate((v.PCB_X, v.PCB_Y, 0))


def j6_worst_case_envelope():
    """Proxy for the only mechanically significant EasyEDA-missing model.

    J6 is XY-PH2.0-2PWT at PCB (93.6, 47.643).  The 8.2 x 9.2 mm XY
    footprint envelope is intentionally larger than the 7.9 x 7.6 mm body;
    5.65 mm covers the published 5.5 +/-0.15 mm height.
    """
    return v.box_at(v.PCB_X + 93.6 - 4.1,
                    v.PCB_Y + 47.643 - 4.6,
                    1.693687, 8.2, 9.2, 5.65)


def main():
    real_pcb = load_real_pcb()
    j6_proxy = j6_worst_case_envelope()
    parts = {
        "bottom": v.make_bottom_shell(),
        "top": v.make_top_shell(),
        "pcb": v.make_pcb_mockup(),
        "battery": v.make_battery_mockup(),
        "display": v.make_display_mockup(),
    }
    pairs = [
        ("bottom", "top"),
        ("bottom", "pcb"),
        ("top", "pcb"),
        ("battery", "pcb"),
        ("battery", "bottom"),
        ("display", "top"),
        ("display", "pcb"),
    ]
    interference = []
    for a, b in pairs:
        common = parts[a].intersect(parts[b])
        volume = sum(s.Volume() for s in common.solids().vals())
        distance = parts[a].val().distance(parts[b].val())
        interference.append({
            "pair": f"{a}/{b}",
            "intersection_mm3": round(volume, 6),
            "min_distance_mm": round(distance, 4),
        })

    real_pairs = [
        ("bottom/real_v9_pcb", parts["bottom"].val(), real_pcb),
        ("top/real_v9_pcb", parts["top"].val(), real_pcb),
        ("battery/real_v9_pcb", parts["battery"].val(), real_pcb),
        ("display/real_v9_pcb", parts["display"].val(), real_pcb),
        ("display/J6_5p65mm_proxy", parts["display"].val(), j6_proxy.val()),
        ("top/J6_5p65mm_proxy", parts["top"].val(), j6_proxy.val()),
    ]
    real_checks = []
    for name, a, b in real_pairs:
        common = a.intersect(b)
        volume = sum(s.Volume() for s in common.Solids())
        real_checks.append({
            "pair": name,
            "intersection_mm3": round(volume, 6),
            "min_distance_mm": round(a.distance(b), 4),
        })

    button_checks = []
    for kind, y in zip(v.BUTTON_NAMES, v.BUTTON_YS):
        cap = v.make_button_cap(kind).translate(
            (v.BUTTON_X, y, v.BUTTON_ORIGIN_Z))
        for target_name, target in (("top", parts["top"].val()),
                                    ("real_v9_pcb", real_pcb)):
            common = cap.val().intersect(target)
            volume = sum(s.Volume() for s in common.Solids())
            button_checks.append({
                "pair": f"button_{kind}/{target_name}",
                "intersection_mm3": round(volume, 6),
                "min_distance_mm": round(cap.val().distance(target), 4),
            })

    meshes = []
    for path in sorted((ROOT / "STL").glob("*.stl")):
        model = trimesh.load_mesh(path, process=True)
        components = model.split(only_watertight=False)
        meshes.append({
            "file": path.name,
            "watertight": bool(model.is_watertight),
            "winding": bool(model.is_winding_consistent),
            "connected_components": len(components),
            "volume_mm3": round(abs(float(model.volume)), 2),
            "bounds_mm": [[round(float(x), 2) for x in row]
                          for row in model.bounds],
            "faces": int(len(model.faces)),
        })

    report = {
        "mesh_checks": meshes,
        "assembly_interference_checks": interference,
        "live_v9_step_checks": real_checks,
        "button_fit_checks": button_checks,
        "manufacturing_min_features_mm": {
            "PA12_button_retaining_flange": v.BUTTON_FLANGE_T,
            "PA12_button_min_radial_lip": (v.BUTTON_FLANGE_D - 8.2) / 2,
            "TPU_bumper_radial_wall": v.TPU_BUMPER_WALL,
        },
        "all_meshes_pass": all(x["watertight"] and x["winding"]
                                and x["connected_components"] == 1
                                for x in meshes),
        "all_unexpected_intersections_zero": all(
            x["intersection_mm3"] == 0
            for x in interference + real_checks + button_checks),
        "live_v9_clearance_pass": (
            next(x for x in real_checks if x["pair"] == "top/real_v9_pcb")["min_distance_mm"] >= 0.8
            and next(x for x in real_checks if x["pair"] == "battery/real_v9_pcb")["min_distance_mm"] >= 1.0
            and next(x for x in real_checks if x["pair"] == "display/real_v9_pcb")["min_distance_mm"] >= 2.0
            and next(x for x in real_checks if x["pair"] == "display/J6_5p65mm_proxy")["min_distance_mm"] >= 2.0
        ),
    }
    (ROOT / "mesh_validation.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if (not report["all_meshes_pass"]
            or not report["all_unexpected_intersections_zero"]
            or not report["live_v9_clearance_pass"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
