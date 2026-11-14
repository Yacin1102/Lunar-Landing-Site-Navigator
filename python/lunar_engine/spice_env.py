"""Loading the SPICE kernels and converting times at the edge.

Role
    The one place that knows which kernel files the engine uses and how the
    outside world's time (UTC milliseconds since 1970, shared rules) becomes
    SPICE's own time scale (TDB seconds past the J2000 epoch, called ET).
    Everything else in the engine works in UTC milliseconds and never sees ET.

Which kernels, and why: ``python/DATA.md``.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import numpy as np
import spiceypy as spice

KERNEL_DIR = Path(__file__).resolve().parents[1] / "kernels"

#: Kernels every product is built with, in load order.
BUILD_KERNELS = ("naif0012.tls", "pck00011.tpc", "moon_de440_250416.tf",
                 "moon_pa_de440_200625.bpc", "de440.bsp")

#: Same, but with the newer DE442 ephemeris. For comparison only.
DE442_KERNELS = ("naif0012.tls", "pck00011.tpc", "moon_de440_250416.tf",
                 "moon_pa_de440_200625.bpc", "de442.bsp")

#: Adds the DE421 Moon orientation, which defines the frame ``MOON_ME_DE421``
#: (the exact frame of the LOLA maps). The old frame kernel is loaded first so
#: that the name ``MOON_ME`` still means the DE440 one. For comparison only.
WITH_DE421_FRAME = ("naif0012.tls", "pck00011.tpc", "moon_080317.tf",
                    "moon_pa_de421_1900-2050.bpc", "moon_de440_250416.tf",
                    "moon_pa_de440_200625.bpc", "de440.bsp")

#: The J2000 epoch, 2000-01-01 12:00:00, as UTC milliseconds since 1970.
J2000_UNIX_MS = 946_728_000_000


@contextmanager
def loaded(kernels=BUILD_KERNELS):
    """Load a set of kernels for the duration of a ``with`` block.

    SPICE keeps loaded kernels in one global pool, so the pool is emptied
    before and after to keep runs independent of each other.

    Args:
        kernels: file names inside ``python/kernels/``, in load order.
    """
    spice.kclear()
    try:
        for name in kernels:
            spice.furnsh(str(KERNEL_DIR / name))
        yield
    finally:
        spice.kclear()


def et_from_utc_ms(t_ms) -> np.ndarray:
    """Convert UTC milliseconds since 1970 to SPICE ET (TDB seconds past J2000).

    How: count UTC seconds from the J2000 epoch, then add the difference
    between TDB and UTC that SPICE computes from the leap-second kernel (about
    69.18 s in this period). Unix time and SPICE's "UTC seconds past J2000"
    both count 86,400 seconds per day, so they differ by a constant.

    Args:
        t_ms: scalar or array of UTC times, milliseconds since 1970-01-01.

    Returns:
        ET in seconds, same shape (a 0-d array for a scalar). A leap-second
        kernel must be loaded.
    """
    utc_s = (np.asarray(t_ms, dtype=float) - J2000_UNIX_MS) / 1000.0
    delta = np.vectorize(lambda s: spice.deltet(float(s), "UTC"), otypes=[float])(utc_s)
    return utc_s + delta
