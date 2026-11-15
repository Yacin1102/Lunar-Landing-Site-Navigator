"""Tests for the Sun and Earth visibility check, and the final proof on the real products.

Two kinds:

* **Made-up skylines and Sun positions** with answers known by hand: the
  disc above, below and straddling the skyline, a disc spanning several
  wedges, and a wedge of the skyline whose error makes the answer uncertain.
* **The real products** in ``web/public/data/`` (committed files, so these
  need no downloaded data): the four permanently shadowed floors are never
  certainly sunlit, and the connecting ridge and Shackleton rim agree with
  Gläser et al. (2018). Only published figures are tested; the other sites'
  shares are reported in docs/ACCURACY.md (no published figure exists for
  those exact points).
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from lunar_engine import contracts, illumination, sites
from lunar_engine.ephemeris import SUN_RADIUS_KM, site_vector_km
from lunar_engine.geometry import enu_frame

SUN_KM = 1.496e8
SUN_R_DEG = float(np.degrees(np.arcsin(SUN_RADIUS_KM / SUN_KM)))       # 0.2665 degrees


def flat_record(skyline=0.0, err=0.01, step=1.0):
    n = int(round(360 / step))
    return {"lat": -89.0, "lon": 30.0, "elev_m": 0.0, "mast_m": 2.0, "az_step_deg": step,
            "skyline_deg": [skyline] * n, "skyline_err_deg": [err] * n}


def sun_rows(record, az_el):
    """Moon-centre Sun vectors that put the Sun at the given (azimuth, elevation) from the eye."""
    east, north, up = enu_frame(record["lat"], record["lon"])
    eye = site_vector_km(record["lat"], record["lon"], record["elev_m"], record["mast_m"])
    out = []
    for az, el in az_el:
        a, e = np.radians(az), np.radians(el)
        direction = np.cos(e) * (np.sin(a) * east + np.cos(a) * north) + np.sin(e) * up
        out.append(eye + SUN_KM * direction)
    return np.array(out)


def test_disc_above_below_and_on_a_flat_skyline():
    record = flat_record()
    rows = sun_rows(record, [(100.0, 5.0), (100.0, -5.0), (100.0, 0.0), (100.0, -0.2), (100.0, -0.3)])
    visible, hidden = illumination.disc_visibility(rows, record, SUN_RADIUS_KM)
    # Centre at 0: top 0.27 is above 0.01 -> visible. Centre at -0.2: top 0.067 -> visible.
    # Centre at -0.3: top -0.033, below -0.01 everywhere -> hidden.
    assert visible.tolist() == [True, False, True, True, False]
    assert hidden.tolist() == [False, True, False, False, True]


def test_the_error_bound_makes_a_grazing_sun_uncertain():
    record = flat_record(err=0.5)
    rows = sun_rows(record, [(200.0, 0.0), (200.0, 0.4), (200.0, -0.9)])
    visible, hidden = illumination.disc_visibility(rows, record, SUN_RADIUS_KM)
    # Top at 0.27 lies inside [-0.5, 0.5]: neither proven. Top 0.67 > 0.5: visible. Top -0.63 < -0.5: hidden.
    assert visible.tolist() == [False, True, False]
    assert hidden.tolist() == [False, False, True]
    v = illumination.visibility(rows, record, SUN_RADIUS_KM)
    assert (v.visible, v.hidden, v.uncertain, v.hours) == pytest.approx((1 / 3, 1 / 3, 1 / 3, 3))


def test_hidden_needs_every_wedge_the_disc_spans():
    """A notch in one neighbouring wedge keeps the disc from being proven hidden."""
    record = flat_record(skyline=2.0, err=0.01, step=0.1)
    record["skyline_deg"][1001] = -5.0                      # wedge at azimuth 100.1, inside the disc
    rows = sun_rows(record, [(100.0, 0.0), (110.0, 0.0)])
    visible, hidden = illumination.disc_visibility(rows, record, SUN_RADIUS_KM)
    assert visible.tolist() == [False, False]
    assert hidden.tolist() == [False, True]


def test_azimuth_wraps_through_north():
    record = flat_record(skyline=10.0, err=0.01, step=0.5)
    record["skyline_deg"][0] = -5.0                          # only the wedge centred on north is low
    rows = sun_rows(record, [(359.9, 1.0), (0.1, 1.0), (1.0, 1.0)])
    visible, _ = illumination.disc_visibility(rows, record, SUN_RADIUS_KM)
    assert visible.tolist() == [True, True, False]


# --------------------------------------------------------------------------
# The real products
# --------------------------------------------------------------------------

DATA = sites.SITES_PATH.parent

#: Gläser et al. 2018, Table 1 (surface level, 20 years): solar visibility,
#: the share of time any part of the Sun is visible, in percent.
GLASER_SOLAR_VISIBILITY = {"connecting_ridge": 81.3, "shackleton_rim": 85.5}


@pytest.fixture(scope="module")
def real():
    if not (DATA / "manifest.json").exists():
        pytest.fail("web/public/data has no manifest: run python/scripts/build_products.py")
    label = json.loads((DATA / "ephem.json").read_text(encoding="utf-8"))
    rows = np.fromfile(DATA / "ephem.bin", dtype="<f4").reshape(label["count"], 6).astype(float)
    out = {}
    for site in sites.load_sites():
        record = json.loads((DATA / "skylines" / f"{site['id']}.json").read_text(encoding="utf-8"))
        out[site["id"]] = (site, illumination.sun_and_earth(rows, record))
    return out


def test_the_real_data_folder_meets_every_contract():
    assert contracts.data_folder_problems(DATA) == []
    assert json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))["data_kind"] == "real"


def test_permanently_shadowed_floors_are_never_certainly_sunlit(real):
    for sid, (site, (sun, _)) in real.items():
        if site["category"] == "psr":
            assert sun.visible == 0.0, (sid, sun)


@pytest.mark.parametrize("sid", sorted(GLASER_SOLAR_VISIBILITY))
def test_ridge_and_rim_agree_with_glaser_2018(real, sid):
    """Gläser's share lies inside ours, widened by 5 percentage points.

    Ours is a bracket: at least ``visible`` and at most ``visible +
    uncertain``. The 5 points allow for the different period (13 against
    20 years) and the eye 2 m above the ground against Gläser's surface level.
    """
    _, (sun, _) = real[sid]
    published = GLASER_SOLAR_VISIBILITY[sid] / 100
    assert sun.visible - 0.05 <= published <= sun.visible + sun.uncertain + 0.05, (sid, sun)
