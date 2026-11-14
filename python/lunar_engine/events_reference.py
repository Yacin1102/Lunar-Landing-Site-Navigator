"""Known-correct rise and set times on a smooth Moon (Referee).

Role
    Produces the answers in ``events.json`` that the browser's event finder is
    tested against (spec section 10). Python never computes events for a
    user: this exists only to make test fixtures.

Definition (contract)
    The Moon is a smooth sphere of radius 1737.4 km with no terrain, and the
    eye is at ground level. A body **rises** at the moment the upper edge of
    its disc comes up through the level horizon and **sets** when the upper
    edge goes down through it. The upper edge is at the elevation of the
    disc's centre plus the disc's angular radius, so an event is a moment
    when ``edge elevation = centre elevation + asin(radius / distance)``
    passes through zero.

How it works, in plain words
    The edge elevation is evaluated every 10 minutes across the window. Where
    two neighbouring values have opposite signs there is exactly one event
    between them, pinned down by repeated halving to the nearest millisecond.
    At the pole the Sun can also graze the horizon without the 10-minute
    samples changing sign, so every local high and low point of the curve is
    located precisely as well, including in the first and last scan interval
    of the window; if it turns out to poke through zero, the two events
    either side of it are added. The smallest distance from zero of
    any such turning point is reported, so a window where an event would hang
    on a hair can be avoided when choosing fixtures.

Units: degrees; times in UTC milliseconds since 1970.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from . import ephemeris

BODY_RADIUS_KM = {"SUN": ephemeris.SUN_RADIUS_KM, "EARTH": ephemeris.EARTH_RADIUS_KM}


def direct_edge_elevation(body: str, lat_deg: float, lon_deg: float) -> Callable[[float], float]:
    """Upper-edge elevation of a body at a ground-level site, straight from SPICE.

    Returns:
        A function of UTC milliseconds giving degrees above the level horizon.
    """
    def edge(t_ms: float) -> float:
        _, elevation, distance = ephemeris.direct_view(body, lat_deg, lon_deg, 0.0, 0.0, t_ms)
        return elevation + ephemeris.angular_radius_deg(BODY_RADIUS_KM[body], distance)
    return edge


def _crossing(edge, lo_ms: float, hi_ms: float, f_lo: float) -> int:
    """Time between ``lo_ms`` and ``hi_ms`` where ``edge`` changes sign, to 1 ms."""
    while hi_ms - lo_ms > 1.0:
        mid = 0.5 * (lo_ms + hi_ms)
        f_mid = edge(mid)
        if (f_mid < 0) == (f_lo < 0):
            lo_ms, f_lo = mid, f_mid
        else:
            hi_ms = mid
    return int(round(0.5 * (lo_ms + hi_ms)))


def _turning_point(edge, a_ms: float, b_ms: float, sign: float) -> tuple[float, float]:
    """Locate the highest (sign=+1) or lowest (sign=-1) point between two times.

    Returns:
        ``(time_ms, value)`` to about one second.
    """
    while b_ms - a_ms > 1000.0:
        third = (b_ms - a_ms) / 3.0
        m1, m2 = a_ms + third, b_ms - third
        if sign * edge(m1) < sign * edge(m2):
            a_ms = m1
        else:
            b_ms = m2
    t = 0.5 * (a_ms + b_ms)
    return t, edge(t)


def find_events(edge: Callable[[float], float], start_ms: int, end_ms: int,
                scan_step_s: float = 600.0) -> dict:
    """Every rise and set of one body inside a time window.

    Args:
        edge: upper-edge elevation as a function of UTC milliseconds, degrees.
        start_ms, end_ms: the window, UTC milliseconds since 1970.
        scan_step_s: spacing of the first scan, seconds.

    Returns:
        ``{"rise_ms": [...], "set_ms": [...], "closest_graze_deg": x}``.
        Times are whole milliseconds in time order. ``closest_graze_deg`` is
        how near the curve's turning points came to zero without it mattering
        (infinity if there were none): a small value means the count of
        events in this window is fragile.
    """
    times = np.arange(start_ms, end_ms, scan_step_s * 1000.0)
    times = np.append(times, float(end_ms))
    values = np.array([edge(t) for t in times])

    # Split points: the scan times plus any turning point that crosses zero.
    points = list(zip(times.tolist(), values.tolist()))
    closest = float("inf")
    # The first and the last scan interval have no neighbour on one side, so
    # the three-sample test below cannot see a turning point there. Search
    # them directly; a result at least 2 s from both ends is a real one.
    for a, b in ((0, 1), (len(times) - 2, len(times) - 1)):
        for sign in (1.0, -1.0):
            t_turn, v_turn = _turning_point(edge, times[a], times[b], sign)
            if min(t_turn - times[a], times[b] - t_turn) > 2000.0:
                if (v_turn < 0) != (values[a] < 0) and (v_turn < 0) != (values[b] < 0):
                    points.append((t_turn, v_turn))
                else:
                    closest = min(closest, abs(v_turn))
    for i in range(1, len(times) - 1):
        left, mid, right = values[i - 1], values[i], values[i + 1]
        for sign in (1.0, -1.0):
            is_turn = sign * mid >= sign * left and sign * mid >= sign * right
            if is_turn and not (left == mid == right):
                t_turn, v_turn = _turning_point(edge, times[i - 1], times[i + 1], sign)
                if (v_turn < 0) != (mid < 0):
                    # The curve pokes through zero between two samples.
                    points.append((t_turn, v_turn))
                else:
                    closest = min(closest, abs(v_turn))
    points.sort(key=lambda p: p[0])

    rises, sets = [], []
    for (t_a, f_a), (t_b, f_b) in zip(points, points[1:]):
        if (f_a < 0) != (f_b < 0):
            t_event = _crossing(edge, t_a, t_b, f_a)
            (rises if f_a < 0 else sets).append(t_event)
    return {"rise_ms": rises, "set_ms": sets, "closest_graze_deg": closest}


def smooth_moon_events(lat_deg: float, lon_deg: float, start_ms: int, end_ms: int) -> dict:
    """The four event lists of one ``events.json`` case, plus the fragility figure.

    Kernels must be loaded.

    Returns:
        ``sunrise_ms``, ``sunset_ms``, ``earthrise_ms``, ``earthset_ms`` and
        ``closest_graze_deg`` (the smaller of the Sun's and the Earth's).
    """
    sun = find_events(direct_edge_elevation("SUN", lat_deg, lon_deg), start_ms, end_ms)
    earth = find_events(direct_edge_elevation("EARTH", lat_deg, lon_deg), start_ms, end_ms)
    return {
        "sunrise_ms": sun["rise_ms"], "sunset_ms": sun["set_ms"],
        "earthrise_ms": earth["rise_ms"], "earthset_ms": earth["set_ms"],
        "closest_graze_deg": min(sun["closest_graze_deg"], earth["closest_graze_deg"]),
    }
