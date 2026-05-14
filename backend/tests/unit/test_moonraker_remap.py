"""Unit tests for moonraker.remap_slots — the gcode tool-change rewriter.

The slot-swap case (A→B and B→A) is the riskiest one: a naive single-pass
substitution would turn every T into the same slot. This file pins down the
two-pass placeholder behavior.
"""
from __future__ import annotations

from pathlib import Path

from app.services.moonraker import remap_slots


def test_remap_slots_empty_map_returns_input_unchanged():
    src = b"T0\nG1 X10\nT1\n"
    assert remap_slots(src, {}) == src


def test_remap_slots_identity_map_returns_input_unchanged():
    src = b"T0\nT1\nT2\n"
    assert remap_slots(src, {0: 0, 1: 1, 2: 2}) == src


def test_remap_slots_single_remap_t_at_line_start():
    src = b"G28\nT0\nG1 E1\nT2\n"
    out = remap_slots(src, {0: 3})
    assert b"\nT3\n" in out
    assert b"\nT2\n" in out  # untouched
    assert b"\nT0\n" not in out


def test_remap_slots_does_not_match_inside_words():
    src = b"; some text T0 inside\nM117 SET0\nT0\n"
    out = remap_slots(src, {0: 5})
    # The comment substring "T0" preceded by space should match (boundary), but
    # the parser uses `(?<=\s)|^` lookbehind — so "T0" after a space IS replaced.
    # We only care that `M117 SET0` is not corrupted (the trailing "0" is not a T-command).
    assert b"M117 SET0" in out
    assert b"T5" in out  # the standalone T0 was remapped


def test_remap_slots_a_b_swap_does_not_collide():
    """The classic test: swap slot 0 with slot 1. A single-pass replace would
    turn every T0/T1 into T1/T1 (or T0/T0). Two-pass placeholders fix it."""
    src = b"T0\nT1\nT0\nT1\n"
    out = remap_slots(src, {0: 1, 1: 0})
    assert out == b"T1\nT0\nT1\nT0\n"


def test_remap_slots_rewrites_m104_t_param():
    src = b"M104 S210 T0\nM109 T1 S205\nM116 T0\n"
    out = remap_slots(src, {0: 2, 1: 3})
    assert b"M104 S210 T2" in out
    assert b"M109 T3 S205" in out
    assert b"M116 T2" in out


def test_remap_slots_rewrites_snapmaker_extruder_macros():
    src = (
        b"SM_PRINT_EXTRUDER_PREHEAT EXTRUDER=0 TEMP=210\n"
        b"SM_PRINT_AUTO_FEED EXTRUDER=1\n"
        b"SM_PRINT_FLOW_CALIBRATE EXTRUDER=2\n"
    )
    out = remap_slots(src, {0: 3, 1: 2, 2: 1})
    assert b"EXTRUDER=3 TEMP=210" in out
    assert b"SM_PRINT_AUTO_FEED EXTRUDER=2" in out
    assert b"SM_PRINT_FLOW_CALIBRATE EXTRUDER=1" in out


def test_remap_slots_accepts_path_input(tmp_path: Path):
    p = tmp_path / "in.gcode"
    p.write_bytes(b"T0\nT1\n")
    out = remap_slots(p, {0: 1, 1: 0})
    assert out == b"T1\nT0\n"


def test_remap_slots_partial_map_leaves_unmapped_alone():
    src = b"T0\nT1\nT2\nT3\n"
    out = remap_slots(src, {0: 2, 2: 0})  # swap 0<->2; 1 and 3 untouched
    assert out == b"T2\nT1\nT0\nT3\n"
