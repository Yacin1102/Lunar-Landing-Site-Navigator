"""How often the Sun and the Earth are visible from a site, from its skyline.

Role
    The final proof (PR 11): the share of time each curated site sees the
    Sun and the Earth over the whole timetable, to compare with published
    illumination studies. It uses only the products the web app receives
    (the timetable and the skyline), so it also checks those products
    together.

How it works, in plain words
    For every hourly timetable row, the body's direction from the site's eye
    is found the way the browser finds it: subtract the eye's position from
    the Moon-centre vector, then read azimuth and elevation in the site's
    east/north/up frame. The body's disc is compared with the skyline
    interval ``skyline_deg +/- skyline_err_deg`` of the wedges it spans:

    * **certainly visible**: the top of the disc, at the disc's own azimuth,
      is above the top of the interval of the wedge there. Some of the disc
      is then visible whatever the true terrain within the bound.
    * **certainly hidden**: the top of the disc is below the bottom of the
      interval in every wedge the disc spans.
    * **uncertain**: neither.

    This is the decided "lit / blocked / uncertain" rule (docs/PROGRESS.md,
    interpretation 11), applied on the disc's top edge only, which never
    claims more than the full rule.

Units: degrees, km for the timetable, metres for heights.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .ephemeris import EARTH_RADIUS_KM, SUN_RADIUS_KM, site_vector_km
from .geometry import az_el_in_frame, enu_frame


@dataclass(frozen=True)
class Visibility:
    """Shares of the timetable's hours, each 0 to 1; the three add up to 1."""

    visible: float
    hidden: float
    uncertain: float
    hours: int


def disc_visibility(rows_km: np.ndarray, record: dict, radius_km: float) -> tuple[np.ndarray, np.ndarray]:
    """Per row: is some of the disc certainly visible, is all of it certainly hidden?

    Args:
        rows_km: Moon-centre vectors of the body, shape ``(count, 3)``, km, ``MOON_ME``.
        record: a skyline record (Contract 3).
        radius_km: the body's radius, km.

    Returns:
        Two boolean arrays ``(visible, hidden)`` of length ``count``.
    """
    lat, lon = record["lat"], record["lon"]
    east, north, up = enu_frame(lat, lon)
    d = np.asarray(rows_km, dtype=float) - site_vector_km(lat, lon, record["elev_m"], record["mast_m"])
    azimuth, elevation = az_el_in_frame(d, east, north, up)
    radius_deg = np.degrees(np.arcsin(radius_km / np.linalg.norm(d, axis=-1)))
    top = elevation + radius_deg

    step = record["az_step_deg"]
    sky = np.asarray(record["skyline_deg"], dtype=float)
    err = np.asarray(record["skyline_err_deg"], dtype=float)
    n = len(sky)
    high, low = sky + err, sky - err
    # Entry k covers azimuths within half a step of k * step (interpretation 3).
    centre = np.rint(azimuth / step).astype(int) % n
    visible = top > high[centre]

    # Every wedge the disc spans. Its azimuth half-width is exactly
    # asin(sin r / cos el), never less than r / cos el (found by review); a disc
    # reaching the zenith spans every azimuth.
    ratio = np.sin(np.radians(radius_deg)) / np.maximum(np.cos(np.radians(elevation)), 1e-12)
    half = np.where(ratio >= 1.0, 180.0, np.degrees(np.arcsin(np.minimum(ratio, 1.0))))
    first = np.floor((azimuth - half) / step + 0.5).astype(int)
    last = np.floor((azimuth + half) / step + 0.5).astype(int)
    span = int((last - first).max()) + 1
    lowest = np.full(len(top), np.inf)
    for k in range(span):
        index = first + k
        inside = index <= last
        lowest = np.where(inside, np.minimum(lowest, low[index % n]), lowest)
    hidden = top < lowest
    return visible, hidden


def visibility(rows_km: np.ndarray, record: dict, radius_km: float) -> Visibility:
    """Shares of hours in which the body is certainly visible, certainly hidden, or uncertain."""
    visible, hidden = disc_visibility(rows_km, record, radius_km)
    count = len(visible)
    return Visibility(float(visible.mean()), float(hidden.mean()),
                      float(1.0 - visible.mean() - hidden.mean()), count)


def sun_and_earth(ephem_rows: np.ndarray, record: dict) -> tuple[Visibility, Visibility]:
    """Sun and Earth visibility over a timetable (Contract 1 rows, km)."""
    return (visibility(ephem_rows[:, 0:3], record, SUN_RADIUS_KM),
            visibility(ephem_rows[:, 3:6], record, EARTH_RADIUS_KM))
