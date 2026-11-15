"""Tests for the curated site list (Contract 2).

Three kinds:

* **The list itself** (no data needed): it matches its schema, has 10 sites
  with unique ids, all in the service region, all in documented categories,
  with contrasting conditions (sunlit ridges and shadowed floors, near-side
  and far-side longitudes); its flags agree with the files on disk; and
  ``python/sites_sources.md`` gives a source for every coordinate exactly as
  written in ``sites.json``.
* **The checking and flag code** on small made-up lists.
* **The real maps** (skipped until on disk): the ground at each site looks
  like what its source describes, and the LCROSS impact point lies at the
  height Marshall et al. (2011) measured.

Coordinates are never repeated here: they are read from ``sites.json``,
the only place they exist (spec section 6).
"""

from __future__ import annotations

import copy
import json
import math
import re

import pytest

import download_data
from lunar_engine import contracts, lola, sites

SOURCES_MD = download_data.PYTHON_DIR / "sites_sources.md"


@pytest.fixture(scope="module")
def site_list():
    return json.loads(sites.SITES_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def by_id(site_list):
    return {site["id"]: site for site in site_list["sites"]}


# --------------------------------------------------------------------------
# The list itself
# --------------------------------------------------------------------------

def test_the_site_list_is_correct(site_list):
    assert sites.site_list_problems(site_list) == []
    assert len(site_list["sites"]) == 10


def test_the_sites_cover_contrasting_conditions(site_list):
    """Spec section 6: sunlit ridges and shadowed floors, near and far side."""
    categories = [s["category"] for s in site_list["sites"]]
    assert categories.count("high_illumination") >= 3
    assert categories.count("psr") >= 3
    longitudes = [abs(s["lon"]) for s in site_list["sites"]]
    assert any(lon <= 45 for lon in longitudes), "a near-side site (Earth usually in view)"
    assert any(lon >= 120 for lon in longitudes), "a far-side site (Earth usually hidden)"
    assert any(60 <= lon <= 100 for lon in longitudes), "a limb site"


def test_the_flags_agree_with_the_files_on_disk(tmp_path):
    folder = sites.SITES_PATH.parent
    listed = json.loads(sites.SITES_PATH.read_text(encoding="utf-8"))
    for site in listed["sites"]:
        for flag, files in sites.product_files(folder, site["id"]).items():
            assert site[flag] == all(f.exists() for f in files), (site["id"], flag)


def test_every_coordinate_has_its_source_recorded(site_list):
    """Each site has a section in sites_sources.md quoting lat and lon exactly as in sites.json."""
    text = SOURCES_MD.read_text(encoding="utf-8")
    sections = dict(re.findall(r"^## `([a-z0-9_-]+)`.*?$(.*?)(?=^## |\Z)", text, flags=re.M | re.S))
    assert sorted(sections) == sorted(s["id"] for s in site_list["sites"])
    for site in site_list["sites"]:
        body = sections[site["id"]]
        used = re.search(r"^\*\*Used:\*\* latitude (\S+), longitude (\S+)$", body, flags=re.M)
        assert used, f"{site['id']}: no 'Used:' line"
        assert (float(used.group(1)), float(used.group(2))) == (site["lat"], site["lon"]), site["id"]
        assert "**Source:**" in body, site["id"]
        converted = re.search(r"Longitude \*converted\* from (\S+) E", body)
        if converted:                                                  # 0..360 east -> -180..180
            assert round(float(converted.group(1)) - 360.0, 9) == site["lon"], site["id"]
    assert len(re.findall(r"Longitude \*converted\* from", text)) == 2
    for category in sites.CATEGORIES:
        assert f"`{category}`" in text, f"category {category} is not documented"


# --------------------------------------------------------------------------
# The checking and flag code
# --------------------------------------------------------------------------

def test_problems_are_found(tmp_path, site_list):
    def problems(change):
        broken = copy.deepcopy(site_list)
        change(broken["sites"])
        return sites.site_list_problems(broken)

    assert problems(lambda s: s[1].update(id=s[0]["id"])) == [f"site id {site_list['sites'][0]['id']} is used more than once"]
    assert problems(lambda s: s[2].update(lat=-79.5)) == [f"{site_list['sites'][2]['id']}: latitude -79.5 is outside the service region"]
    assert problems(lambda s: s[3].update(category="ridge")) == [f"{site_list['sites'][3]['id']}: category 'ridge' is not documented"]
    assert problems(lambda s: s[4].update(lon=200.0))                 # schema: longitude above 180
    assert problems(lambda s: s.pop())                                 # schema: 9 sites
    bad = copy.deepcopy(site_list)
    bad["sites"][0]["lat"] = -70.0
    (tmp_path / "sites.json").write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError, match="outside the service region"):
        sites.load_sites(tmp_path / "sites.json")
    assert len(sites.load_sites()) == 10


def test_flags_follow_the_files(tmp_path, site_list):
    (tmp_path / "sites.json").write_text(json.dumps(site_list, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    original = (tmp_path / "sites.json").read_bytes()
    assert sites.update_flags(tmp_path) == []
    assert (tmp_path / "sites.json").read_bytes() == original, "nothing changed, nothing written"

    sid = site_list["sites"][0]["id"]
    files = sites.product_files(tmp_path, sid)
    for path in files["has_terrain"]:
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"x")
    assert sites.update_flags(tmp_path) == [f"{sid}: has_terrain set to true"]
    written = json.loads((tmp_path / "sites.json").read_text(encoding="utf-8"))
    assert written["sites"][0]["has_terrain"] is True and written["sites"][0]["has_shade_grid"] is False
    assert list(written["sites"][0]) == list(site_list["sites"][0]), "field order kept"

    files["has_shade_grid"][0].parent.mkdir(exist_ok=True)
    files["has_shade_grid"][0].write_bytes(b"x")                    # an interrupted shade build
    before = (tmp_path / "sites.json").read_bytes()
    with pytest.raises(ValueError, match="has_shade_grid files are missing"):
        sites.update_flags(tmp_path)
    assert (tmp_path / "sites.json").read_bytes() == before

    for path in files["has_terrain"]:
        path.unlink()
    files["has_shade_grid"][0].unlink()
    assert sites.update_flags(tmp_path) == [f"{sid}: has_terrain set to false"]


def test_the_data_folder_check_accepts_the_list(tmp_path, site_list):
    """The whole-folder check finds nothing wrong with the sites (other products come later)."""
    problems = contracts.data_folder_problems(sites.SITES_PATH.parent, allow_missing_ephem=True)
    assert [p for p in problems if "sites.json" in p and "manifest.json" not in p] == []


# --------------------------------------------------------------------------
# The real maps
# --------------------------------------------------------------------------

#: What each site's source describes, checked on the map. Diameters of the
#: craters whose rim must surround a floor site are from the USGS Gazetteer of
#: Planetary Nomenclature (Shackleton 20.92 km, Haworth 51.42 km, Faustini
#: 42.48 km, Cabeus 100.58 km).
SHAPES = {
    "connecting_ridge": "top", "shackleton_rim": "top", "peak_near_shackleton": "top",
    "de_gerlache_rim": "top", "malapert_massif": "top", "mons_mouton_im2": "plateau",
    "shackleton_floor": ("floor", 20.92), "haworth_floor": ("floor", 51.42),
    "faustini_floor": ("floor", 42.48), "cabeus_lcross": ("floor", 100.58),
}


@pytest.fixture(scope="module")
def real_source():
    return lola.open_lola(download_data.PYTHON_DIR / "dem", log=lambda m: None)


def test_every_site_has_a_described_shape(by_id):
    assert sorted(SHAPES) == sorted(by_id)


@pytest.mark.realdata("full")
@pytest.mark.parametrize("sid", sorted(SHAPES))
def test_the_ground_at_each_site_matches_its_source(real_source, by_id, sid):
    """A small coordinate error near the pole can move a site from a ridge into a crater (spec 6).

    * A ridge crest, rim or peak ("top"): within 60 m of the highest ground
      within 1 km, and at least 150 m above the middle of the ground within 3 km.
    * A plateau: as flat as a landing site (slope under 6 degrees), near the
      highest ground within 1 km and above the middle of the ground within 3 km.
    * A crater floor: within 350 m of the lowest ground within 3 km, and the
      rim at least 1500 m higher within 0.6 crater diameters.
    """
    site = by_id[sid]
    shape = SHAPES[sid]
    t = sites.terrain_summary(real_source, site["lat"], site["lon"])
    d = t["discs"]
    assert t["map"].startswith("LDEM_83S_10MPP"), "every site is on the 10 m map"
    if shape == "top":
        assert d[1_000.0]["max_m"] <= 60 and d[3_000.0]["median_m"] <= -150, t
    elif shape == "plateau":
        assert t["slope_deg"] < 6 and d[1_000.0]["max_m"] <= 60 and d[3_000.0]["median_m"] <= -50, t
    else:
        rim_radius = 0.6 * shape[1] * 1000
        grid = next(g for g in real_source.grids if rim_radius / g.spec.pixel_m <= 2000)
        wide = sites.terrain_summary(real_source, site["lat"], site["lon"], (rim_radius,), grid=grid)
        assert d[3_000.0]["min_m"] >= -350 and wide["discs"][rim_radius]["max_m"] >= 1500, (t, wide)


@pytest.mark.realdata("full")
def test_the_lcross_impact_point_is_at_the_measured_height(real_source, by_id):
    """Marshall et al. 2011: altitude -3,825 +/- 10 m (1 sigma) on the 1737.4 km sphere."""
    site = by_id["cabeus_lcross"]
    height = real_source.height(site["lat"], site["lon"])
    sigma = math.hypot(10.0, real_source.height_error(site["lat"], site["lon"]))
    print(f"LCROSS point: map {height:.1f} m, measured -3825 +/- 10 m")
    assert abs(height - (-3825.0)) <= 3 * sigma
