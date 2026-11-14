"""First checks on the downloaded NASA files themselves.

These need the real data, so each is skipped until its group has arrived
(see ``conftest.py``). They only establish that the files are what the plan
assumes; reading the maps correctly is tested with the elevation reader.
"""

from __future__ import annotations

import pytest

import download_data as dd

#: Timetable span from spec section 5, as UTC calendar strings.
TIMETABLE_START_UTC = "2026-11-16T00:00:00"
TIMETABLE_END_UTC = "2040-01-01T00:00:00"


def _paths(group: str):
    return [dd.PYTHON_DIR / f["dest"] for f in dd.load_manifest() if f["group"] == group]


@pytest.mark.realdata("kernels")
def test_build_kernels_load_and_cover_the_timetable():
    """The build kernels give MOON_ME and Sun/Earth positions for 2026 to 2040."""
    import spiceypy as spice

    names = ["naif0012.tls", "pck00011.tpc", "moon_de440_250416.tf",
             "moon_pa_de440_200625.bpc", "de440.bsp"]
    spice.kclear()
    try:
        for name in names:
            spice.furnsh(str(dd.PYTHON_DIR / "kernels" / name))
        assert spice.namfrm("MOON_ME") != 0, "the frame kernel does not define MOON_ME"
        for utc in (TIMETABLE_START_UTC, TIMETABLE_END_UTC):
            et = spice.str2et(utc)
            for body in ("SUN", "EARTH"):
                position_km, _ = spice.spkpos(body, et, "MOON_ME", "LT+S", "MOON")
                distance_km = float(spice.vnorm(position_km))
                low, high = (1.45e8, 1.55e8) if body == "SUN" else (3.5e5, 4.1e5)
                assert low < distance_km < high, f"{body} at {utc}: {distance_km} km"
    finally:
        spice.kclear()


@pytest.mark.realdata("coarse")
@pytest.mark.parametrize("path", _paths("coarse"), ids=lambda p: p.name)
def test_coarse_map_opens(path):
    """Each coarse map opens as a single-band raster in a projected system."""
    import rasterio

    with rasterio.open(path) as raster:
        assert raster.count == 1
        assert raster.crs is not None and raster.crs.is_projected
        assert raster.width == raster.height > 1000


@pytest.mark.realdata("full")
@pytest.mark.parametrize("path", _paths("full"), ids=lambda p: p.name)
def test_full_resolution_map_opens(path):
    """Each full-resolution map opens as a single-band raster in a projected system."""
    import rasterio

    with rasterio.open(path) as raster:
        assert raster.count == 1
        assert raster.crs is not None and raster.crs.is_projected
        assert raster.width == raster.height > 10000
