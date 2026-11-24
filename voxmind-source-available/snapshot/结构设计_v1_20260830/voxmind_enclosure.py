#!/usr/bin/env python3
"""VoxMind EVT_V1 v9 sellable-prototype enclosure.

Coordinate system:
  X = PCB long edge (100 mm), Y = PCB short edge (55 mm), Z = front.
  PCB lower-left is at (5, 5); PCB bottom face is Z=0.

The source is intentionally parametric.  It produces STEP for editing/quoting,
STL for JLC3DP, and one STEP assembly.  Values marked VERIFY_ON_FIRST_ARTICLE
must be checked on the physical assembled PCB before ordering more than one set.
"""

from pathlib import Path
import math
import cadquery as cq
from cadquery import exporters
import trimesh


ROOT = Path(__file__).resolve().parent
OUT_STEP = ROOT / "STEP"
OUT_STL = ROOT / "STL"

# ---- Locked v9 geometry (EasyEDA live PCB, 2026-08-30) ---------------------
PCB_W = 100.0
PCB_H = 55.0
PCB_T = 1.6
PCB_X = 5.0
PCB_Y = 5.0

# Product envelope.  The extra 5 mm around the board carries screw towers,
# impact wall and the alignment tongue; it does not require PCB mounting holes.
CASE_W = 110.0
CASE_H = 65.0
CORNER_R = 7.0
WALL = 2.2
BOTTOM_Z = -14.2
TOP_Z = 13.2
SEAM_Z = 0.0

# Official Waveshare 2inch Capacitive Touch LCD rigid-body envelope.
# Full 58.8 x 37.1 x 10.15 mm STEP includes the flexible cable sweep.
DISPLAY_BODY_W = 48.22
DISPLAY_BODY_H = 35.02
DISPLAY_BODY_T = 5.1
# Shifted from the purely visual (70.0, 32.5) centre after checking the live
# v9 assembled STEP.  This clears J1/J5 and the 5.5 mm-tall J6 worst-case
# envelope by at least 2.0 mm while keeping the display visually balanced with
# the three-key column.
DISPLAY_CENTER = (68.0, 34.2)
DISPLAY_WINDOW_W = 42.0       # active area is 40.8 mm; 0.6 mm reveal each side
DISPLAY_WINDOW_H = 31.8       # active area is 30.6 mm; 0.6 mm reveal each side
DISPLAY_FRONT_Z = 12.0        # 1.2 mm protective bezel above glass

# v9 top-side controls translated from PCB coordinates by (+5, +5).
BUTTON_X = PCB_X + 24.0
BUTTON_YS = [PCB_Y + 11.82, PCB_Y + 27.62, PCB_Y + 43.12]
BUTTON_NAMES = ["OK", "BACK", "REC"]
MIC_PORTS = [(PCB_X + 28.956, PCB_Y + 24.003),
             (PCB_X + 31.623, PCB_Y + 2.794)]
LED_PORT = (PCB_X + 32.131, PCB_Y + 18.415)

# Edge openings from v9 placed footprints.  Z extents include first-article
# margin because package body height is not encoded in the EasyEDA 2D dump.
USB_Y = PCB_Y + 27.52
SIM_Y = PCB_Y + 30.20

# Nominal protected 503450 pouch; tray permits protection PCB and swelling.
BATTERY_W = 51.5
BATTERY_H = 35.5
BATTERY_T = 5.6
BATTERY_CENTER = (31.25, 42.25)

SCREW_XY = [(3.5, 3.5), (CASE_W - 3.5, 3.5),
            (3.5, CASE_H - 3.5), (CASE_W - 3.5, CASE_H - 3.5)]
PCB_CORNER_XY = [(PCB_X + 2.0, PCB_Y + 2.0),
                 (PCB_X + PCB_W - 2.0, PCB_Y + 2.0),
                 (PCB_X + 2.0, PCB_Y + PCB_H - 2.0),
                 (PCB_X + PCB_W - 2.0, PCB_Y + PCB_H - 2.0)]
PCB_CORNER_RELIEF_R = 3.0
PCB_HOOK_Z = 1.90
# JLC3DP's PA12 production rule flags features below 1.0 mm.  Keep the
# retaining flange at 1.3 mm and move the complete cap down by 0.50 mm so its
# top face and switch-contact datum remain unchanged from the verified v9 fit.
BUTTON_FLANGE_T = 1.30
BUTTON_FLANGE_D = 12.0
BUTTON_ORIGIN_Z = 9.85
BUTTON_STEM_LENGTH = 6.15
TPU_BUMPER_WALL = 2.20


def rounded_prism(w, h, z_len, radius, z0=0.0, center=(CASE_W / 2, CASE_H / 2)):
    """Axis-aligned prism with rounded vertical corners."""
    obj = (cq.Workplane("XY")
           .box(w, h, z_len, centered=(True, True, False))
           .edges("|Z").fillet(radius)
           .translate((center[0], center[1], z0)))
    return obj


def box_at(x0, y0, z0, dx, dy, dz):
    return (cq.Workplane("XY")
            .box(dx, dy, dz, centered=(False, False, False))
            .translate((x0, y0, z0)))


def cyl_at(x, y, z0, diameter, height):
    return (cq.Workplane("XY", origin=(x, y, z0))
            .circle(diameter / 2).extrude(height))


def ring_prism(outer_w, outer_h, inner_w, inner_h, z_len, radius, z0, center):
    outer = rounded_prism(outer_w, outer_h, z_len, radius, z0, center)
    inner = rounded_prism(inner_w, inner_h, z_len + 0.4,
                          max(0.5, radius - (outer_w - inner_w) / 2),
                          z0 - 0.2, center)
    return outer.cut(inner)


def make_bottom_shell():
    outer = rounded_prism(CASE_W, CASE_H, -BOTTOM_Z, CORNER_R, BOTTOM_Z)
    cavity = rounded_prism(CASE_W - 2 * WALL, CASE_H - 2 * WALL,
                           -BOTTOM_Z - 1.8 + 0.5,
                           CORNER_R - WALL, BOTTOM_Z + 1.8)
    part = outer.cut(cavity)

    # Screw columns remain wholly outside the PCB rectangular envelope.
    for x, y in SCREW_XY:
        part = part.union(cyl_at(x, y, BOTTOM_Z + 1.8, 5.0, -BOTTOM_Z - 1.8))
        part = part.cut(cyl_at(x, y, BOTTOM_Z - 0.2, 2.4, -BOTTOM_Z + 1.0))
        part = part.cut(cyl_at(x, y, BOTTOM_Z - 0.2, 4.4, 2.3))

    # PCB underside ledges: 0.8 mm bite under rounded board-edge corners.
    # No component is used as a load bearing surface.
    ledges = [
        (PCB_X + 3, PCB_Y - 0.2, 12, 1.2),
        (PCB_X + PCB_W - 15, PCB_Y - 0.2, 12, 1.2),
        (PCB_X + 3, PCB_Y + PCB_H - 1.0, 12, 1.2),
        (PCB_X + PCB_W - 15, PCB_Y + PCB_H - 1.0, 12, 1.2),
    ]
    for x, y, dx, dy in ledges:
        part = part.union(box_at(x, y, -1.0, dx, dy, 1.0))

    # Snap retention for the PCB.  PA12 flexes; do not use these thin arms in
    # brittle standard resin.  The top hooks capture Z=1.6 with 0.25 mm slack.
    clips = [
        (PCB_X + 14, PCB_Y - 2.1, 10, 1.5),
        (PCB_X + 76, PCB_Y - 2.1, 10, 1.5),
        (PCB_X + 14, PCB_Y + PCB_H + 0.6, 10, 1.5),
        (PCB_X + 76, PCB_Y + PCB_H + 0.6, 10, 1.5),
    ]
    for x, y, dx, dy in clips:
        part = part.union(box_at(x, y, -3.5, dx, dy, 5.45))
    # Small over-board hooks, deliberately shallow for removal with a spudger.
    # The live STEP board top is Z=1.694 mm; Z=1.90 leaves 0.206 mm assembly
    # clearance instead of relying on a forced interference fit.
    part = part.union(box_at(PCB_X + 14, PCB_Y - 0.6, PCB_HOOK_Z, 10, 0.9, 0.80))
    part = part.union(box_at(PCB_X + 76, PCB_Y - 0.6, PCB_HOOK_Z, 10, 0.9, 0.80))
    part = part.union(box_at(PCB_X + 14, PCB_Y + PCB_H - 0.3, PCB_HOOK_Z, 10, 0.9, 0.80))
    part = part.union(box_at(PCB_X + 76, PCB_Y + PCB_H - 0.3, PCB_HOOK_Z, 10, 0.9, 0.80))

    # Tie each clip and its adjacent underside ledge back into the shell wall.
    # Earlier versions left a 0.4-0.7 mm air gap, which exported as eight loose
    # shells even though the assembly preview looked correct.
    for x in (PCB_X + 14, PCB_X + 76):
        part = part.union(box_at(x, 2.0, -1.0, 10.0, 3.1, 1.0))
        part = part.union(box_at(x, 59.9, -1.0, 10.0, 3.1, 1.0))

    # 503450 battery tray: a low perimeter fence keeps the pouch off soldered
    # parts.  Add 0.5 mm Poron foam below and 1 mm foam above in real assembly.
    bx = BATTERY_CENTER[0] - BATTERY_W / 2
    by = BATTERY_CENTER[1] - BATTERY_H / 2
    tray_z = BOTTOM_Z + 1.8
    fence_h = 1.6
    part = part.union(box_at(bx - 0.8, by - 0.8, tray_z, BATTERY_W + 1.6, 0.8, fence_h))
    part = part.union(box_at(bx - 0.8, by + BATTERY_H, tray_z, BATTERY_W + 1.6, 0.8, fence_h))
    part = part.union(box_at(bx - 0.8, by, tray_z, 0.8, BATTERY_H, fence_h))
    part = part.union(box_at(bx + BATTERY_W, by, tray_z, 0.8, BATTERY_H, fence_h))

    # Internal wire guides leading toward J1 at the top-right of the PCB.
    for x, y in [(59.5, 54.0), (82.0, 54.0), (101.0, 48.0)]:
        part = part.union(cyl_at(x, y, tray_z, 3.2, 2.0).cut(cyl_at(x, y, tray_z - .1, 1.5, 2.2)))

    # USB-C side aperture (left) and Nano-SIM service aperture (right).
    part = part.cut(box_at(-1.0, USB_Y - 5.5, -5.0, 8.0, 11.0, 6.8))
    part = part.cut(box_at(CASE_W - 7.0, SIM_Y - 7.7, -5.3, 8.0, 15.4, 6.4))

    # Back label datum (laser label/QR), plus four 6 mm adhesive foot recesses.
    part = part.cut(box_at(25.0, 20.5, BOTTOM_Z - 0.05, 60.0, 24.0, 0.35))
    for x, y in [(12, 12), (98, 12), (12, 53), (98, 53)]:
        part = part.cut(cyl_at(x, y, BOTTOM_Z - 0.05, 6.2, 0.45))

    return part


def make_top_shell():
    outer = rounded_prism(CASE_W, CASE_H, TOP_Z, CORNER_R, 0.0)
    cavity = rounded_prism(CASE_W - 2 * WALL, CASE_H - 2 * WALL,
                           TOP_Z - 2.2 + 0.4,
                           CORNER_R - WALL, -0.2)
    part = outer.cut(cavity)

    # Top screw pilot towers.  M2 thread-forming screws enter from the back.
    for x, y in SCREW_XY:
        part = part.union(cyl_at(x, y, 0.0, 5.0, 6.0))
        part = part.cut(cyl_at(x, y, -0.2, 1.65, 6.4))

    # The 5 mm screw towers approach the four rounded PCB corners to 0.475 mm
    # in the exact assembled STEP.  Shave only the board-facing tower arcs to
    # provide a 1.0 mm nominal tolerance corridor without weakening the M2
    # pilot walls on their outer sides.
    for x, y in PCB_CORNER_XY:
        part = part.cut(cyl_at(x, y, -1.4,
                               2 * PCB_CORNER_RELIEF_R, 8.0))

    # Alignment tongue: 0.35 mm radial clearance to bottom cavity.
    tongue = ring_prism(CASE_W - 2 * WALL - 0.7,
                        CASE_H - 2 * WALL - 0.7,
                        CASE_W - 2 * WALL - 2.0,
                        CASE_H - 2 * WALL - 2.0,
                        1.6, CORNER_R - WALL - 0.35, -1.2,
                        (CASE_W / 2, CASE_H / 2))
    part = part.union(tongue)
    # The alignment tongue passes the four bottom screw columns; clear those
    # four local arcs so the two shells never rely on forced interference.
    for x, y in SCREW_XY:
        part = part.cut(cyl_at(x, y, -1.3, 5.5, 1.3))
    # The four removable PCB clips also cross the tongue's Z band.
    for x in (PCB_X + 13.5, PCB_X + 75.5):
        part = part.cut(box_at(x, PCB_Y - 2.5, -1.3, 11.0, 2.2, 1.8))
        part = part.cut(box_at(x, PCB_Y + PCB_H + 0.2, -1.3, 11.0, 2.3, 1.8))
    # The clip clearances above can isolate two long 0.65 mm tongue slivers.
    # Remove only those floating centre spans; the connected corner/side
    # tongue segments still provide XY alignment.
    part = part.cut(box_at(29.4, 2.45, -1.3, 51.2, 0.9, 1.9))
    part = part.cut(box_at(29.4, 61.7, -1.3, 51.2, 0.9, 1.9))

    # Display pocket and protected viewing window.  Screen is bonded from the
    # inside with 0.5 mm 3M 9495LE/VHB frame tape.
    sx, sy = DISPLAY_CENTER
    body_pocket = rounded_prism(DISPLAY_BODY_W + 0.8, DISPLAY_BODY_H + 0.8,
                                1.5, 1.6, 10.7, (sx, sy))
    window = rounded_prism(DISPLAY_WINDOW_W, DISPLAY_WINDOW_H,
                           3.0, 1.4, 11.7, (sx, sy))
    part = part.cut(body_pocket).cut(window)

    # Button openings.  Separate retained caps go in from the inside.
    for y in BUTTON_YS:
        part = part.cut(cyl_at(BUTTON_X, y, 10.4, 8.6, 3.3))

    # Two microphone acoustic ports and shallow internal mesh pockets.
    for x, y in MIC_PORTS:
        part = part.cut(cyl_at(x, y, 10.5, 1.6, 3.2))
        part = part.cut(cyl_at(x, y, 10.4, 6.0, 0.45))

    # WS2812 light-pipe opening and internal seating counterbore.
    lx, ly = LED_PORT
    part = part.cut(cyl_at(lx, ly, 10.4, 3.2, 3.3))
    part = part.cut(cyl_at(lx, ly, 10.3, 4.2, 0.6))

    # Complete the upper half of the left USB opening.  SIM stays in bottom.
    part = part.cut(box_at(-1.0, USB_Y - 5.5, -0.5, 8.0, 11.0, 3.4))

    # LTE coax exit channel into the right-wall antenna zone, kept internal.
    part = part.cut(box_at(91.0, 39.5, 1.0, 17.0, 2.2, 2.0))

    return part


def make_button_cap(kind="OK"):
    # Local origin is the actuator axis; Z=0 is the underside of retaining flange.
    head_d = 8.0 if kind != "REC" else 8.2
    flange = cyl_at(0, 0, 0.0, BUTTON_FLANGE_D, BUTTON_FLANGE_T)
    neck = cyl_at(0, 0, BUTTON_FLANGE_T, head_d, 3.15)
    # The real switch actuator top is Z=3.644 mm.  In the assembled position
    # (button origin Z=9.85), 6.15 mm leaves ~0.056 mm pre-travel: no rattle,
    # but still no preload on the tactile switch.  The exterior top datum is
    # unchanged because the thicker flange is offset inward by the same 0.5 mm.
    stem = cyl_at(0, 0, -BUTTON_STEM_LENGTH, 3.6,
                  BUTTON_STEM_LENGTH)
    cap = flange.union(neck).union(stem)
    if kind == "REC":
        # Tactile locator dimple: the REC key is recognizable without looking.
        cap = cap.cut(cyl_at(0, 0, 3.72, 2.2, 0.35))
    elif kind == "BACK":
        # Shallow off-centre notch distinguishes BACK from OK by touch.
        cap = cap.cut(box_at(-2.6, -0.45, 3.72, 2.6, 0.9, 0.35))
    # OCC may retain a tiny cutter fragment as a second solid after the
    # tactile marking subtraction.  A button is intentionally one body.
    solids = cap.solids().vals()
    return cq.Workplane(obj=max(solids, key=lambda s: s.Volume()))


def make_lightpipe():
    # Print in transparent resin.  Sand the PCB-facing end flat after printing.
    stem = cyl_at(0, 0, 0.0, 2.4, 7.6)
    flange = cyl_at(0, 0, 7.0, 4.0, 0.8)
    lens = cyl_at(0, 0, 7.6, 3.0, 1.0)
    return stem.union(flange).union(lens)


def make_display_gasket():
    # 0.6 mm TPU prototype for splash/dust control.  For production replace
    # with die-cut 3M 9495LE/VHB + black PET mask using the same outline.
    outer = rounded_prism(DISPLAY_BODY_W + 0.2, DISPLAY_BODY_H + 0.2,
                          0.6, 1.4, 0, DISPLAY_CENTER)
    inner = rounded_prism(DISPLAY_WINDOW_W + 0.6, DISPLAY_WINDOW_H + 0.6,
                          1.0, 1.2, -0.2, DISPLAY_CENTER)
    return outer.cut(inner)


def make_tpu_bumper():
    # Stretch-on 95A TPU perimeter bumper.  The 0.4 mm nominal interference
    # keeps it retained without adhesive; first article decides +/-0.3 mm.
    # 2.2 mm radial wall clears JLC3DP's 1.6 mm engineering-plastic minimum
    # with 0.6 mm process margin.  Inner/stretch geometry remains unchanged.
    outer_extra = 0.4 + 2 * TPU_BUMPER_WALL
    outer = rounded_prism(CASE_W + outer_extra, CASE_H + outer_extra, 21.0,
                          CORNER_R + outer_extra / 2, -10.5)
    inner = rounded_prism(CASE_W + 0.4, CASE_H + 0.4, 21.4,
                          CORNER_R + 0.2, -10.7)
    part = outer.cut(inner)
    part = part.cut(box_at(-3.0, USB_Y - 6.5, -6.0, 8.0, 13.0, 8.0))
    part = part.cut(box_at(CASE_W - 5.0, SIM_Y - 8.5, -6.5, 8.0, 17.0, 8.0))
    return part


def make_pcb_mockup():
    pcb = rounded_prism(PCB_W, PCB_H, PCB_T, 2.0, 0.0,
                        (PCB_X + PCB_W / 2, PCB_Y + PCB_H / 2))
    # Mechanical obstacle envelopes only; not an electrical 3D export.
    # C32 bottom D8x10, ML307C bottom, ESP32 top and three top switches.
    pcb = pcb.union(cyl_at(PCB_X + 77.3, PCB_Y + 8.1, -10.0, 8.2, 10.0))
    pcb = pcb.union(box_at(PCB_X + 54.52, PCB_Y + 3.01, -2.4, 16.88, 17.96, 2.4))
    pcb = pcb.union(box_at(PCB_X + 34.06, PCB_Y + 0.62, PCB_T, 19.0, 26.2, 3.2))
    for y in BUTTON_YS:
        pcb = pcb.union(box_at(BUTTON_X - 2.8, y - 1.7, PCB_T, 5.6, 3.4, 2.5))
    return pcb


def make_battery_mockup():
    return rounded_prism(BATTERY_W, BATTERY_H, BATTERY_T, 1.8,
                         BOTTOM_Z + 4.0,
                         BATTERY_CENTER)


def make_display_mockup():
    sx, sy = DISPLAY_CENTER
    body = rounded_prism(DISPLAY_BODY_W, DISPLAY_BODY_H, DISPLAY_BODY_T,
                         1.2, DISPLAY_FRONT_Z - DISPLAY_BODY_T, (sx, sy))
    active = rounded_prism(40.8, 30.6, 0.25, 0.8,
                           DISPLAY_FRONT_Z, (sx, sy))
    return body.union(active)


def export_part(name, part, stl=True):
    OUT_STEP.mkdir(parents=True, exist_ok=True)
    OUT_STL.mkdir(parents=True, exist_ok=True)
    exporters.export(part, str(OUT_STEP / f"{name}.step"))
    if stl:
        stl_path = OUT_STL / f"{name}.stl"
        exporters.export(part, str(stl_path),
                         tolerance=0.04, angularTolerance=0.08)
        # Normalize triangle orientation for JLC/Forface slicers.  CadQuery's
        # mesh is geometrically valid, but mixed OCC face orientation can be
        # reported as reverse triangles by downstream STL-only checkers.
        mesh = trimesh.load_mesh(stl_path, process=True)
        components = mesh.split(only_watertight=False)
        if name.startswith("VoxMind_button_") and len(components) > 1:
            # BACK/REC tactile marking cuts can leave the removed tool as a
            # tiny closed mesh in OCC's STL tessellation.  It is not a part.
            mesh = max(components, key=lambda m: abs(m.volume))
        mesh.remove_unreferenced_vertices()
        mesh.merge_vertices()
        trimesh.repair.fix_normals(mesh, multibody=False)
        mesh.export(stl_path)


def main():
    bottom = make_bottom_shell()
    top = make_top_shell()
    button_ok = make_button_cap("OK")
    button_back = make_button_cap("BACK")
    button_rec = make_button_cap("REC")
    lightpipe = make_lightpipe()
    gasket = make_display_gasket()
    bumper = make_tpu_bumper()
    pcb = make_pcb_mockup()
    battery = make_battery_mockup()
    display = make_display_mockup()

    export_part("VoxMind_bottom_PA12", bottom)
    export_part("VoxMind_top_PA12", top)
    export_part("VoxMind_button_OK_PA12", button_ok)
    export_part("VoxMind_button_BACK_PA12", button_back)
    export_part("VoxMind_button_REC_PA12", button_rec)
    export_part("VoxMind_lightpipe_clear_resin", lightpipe)
    export_part("VoxMind_display_gasket_TPU", gasket)
    export_part("VoxMind_bumper_TPU95A", bumper)
    export_part("VoxMind_PCB_mechanical_mockup", pcb)
    export_part("VoxMind_battery_503450_mockup", battery)
    export_part("Waveshare_2inch_display_rigid_mockup", display)

    # Closed assembly for interference review and quoting.
    assy = cq.Assembly(name="VoxMind_EVT_V1_enclosure")
    assy.add(bottom, name="bottom_shell", color=cq.Color(0.12, 0.14, 0.17))
    assy.add(top, name="top_shell", color=cq.Color(0.18, 0.20, 0.24))
    assy.add(pcb, name="pcb_mechanical", color=cq.Color(0.05, 0.35, 0.16))
    assy.add(battery, name="battery_503450", color=cq.Color(0.72, 0.72, 0.76))
    assy.add(display, name="display", color=cq.Color(0.03, 0.08, 0.12))
    for kind, y, cap in zip(BUTTON_NAMES, BUTTON_YS,
                            [button_ok, button_back, button_rec]):
        assy.add(cap, name=f"button_{kind}",
                 loc=cq.Location(cq.Vector(BUTTON_X, y, BUTTON_ORIGIN_Z)),
                 color=cq.Color(0.85, 0.15 if kind == "REC" else 0.45, 0.15))
    assy.add(lightpipe, name="lightpipe",
             loc=cq.Location(cq.Vector(LED_PORT[0], LED_PORT[1], 3.2)),
             color=cq.Color(0.7, 0.9, 1.0, 0.55))
    assy.save(str(OUT_STEP / "VoxMind_enclosure_complete_assembly.step"))

    # Exploded assembly: same parts, easy to inspect in JLC/FreeCAD/Fusion.
    exploded = cq.Assembly(name="VoxMind_EVT_V1_exploded")
    exploded.add(bottom.translate((0, 0, -8)), name="bottom_shell")
    exploded.add(pcb, name="pcb_mechanical")
    exploded.add(display.translate((0, 0, 8)), name="display")
    exploded.add(top.translate((0, 0, 18)), name="top_shell")
    exploded.save(str(OUT_STEP / "VoxMind_enclosure_exploded.step"))

    print("Generated STEP/STL enclosure package in", ROOT)


if __name__ == "__main__":
    main()
