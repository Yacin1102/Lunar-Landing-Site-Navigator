"""The web engine's audit reference values are what the Python engine gives today.

``web/engine/tests/audit/fixtures/python_reference.json`` is the Python
reference method (``ephemeris.interpolate_rows`` and ``view_from_rows``) run on
the committed timetable. If the engine or the timetable changes, this test
fails until the file is rebuilt with ``python python/scripts/build_audit_fixtures.py``.
Needs no SPICE kernels and no maps.
"""

from __future__ import annotations

import json

import build_audit_fixtures


def test_committed_reference_equals_a_fresh_build(tmp_path, monkeypatch):
    committed = json.loads(build_audit_fixtures.OUTPUT.read_text(encoding="utf-8"))
    monkeypatch.setattr(build_audit_fixtures, "OUTPUT", tmp_path / "python_reference.json")
    assert build_audit_fixtures.main() == 0
    fresh = json.loads((tmp_path / "python_reference.json").read_text(encoding="utf-8"))
    assert fresh == committed


def test_reference_covers_both_ends_of_the_table_and_the_pole():
    cases = json.loads(build_audit_fixtures.OUTPUT.read_text(encoding="utf-8"))["cases"]
    names = " | ".join(c["name"] for c in cases)
    for needle in ("first interval", "last interval", "last row", "0.0001 degrees from the pole", "raised eye"):
        assert needle in names
    assert all(0.0 <= c["sun_az"] < 360.0 and 0.0 <= c["earth_az"] < 360.0 for c in cases)
