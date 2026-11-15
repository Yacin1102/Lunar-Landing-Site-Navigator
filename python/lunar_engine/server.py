"""The live API: skylines for any point of the service region (Contract 7).

Role
    Server. The elevation maps are too large to send to a browser, so the web
    app asks this server for the skyline of a custom point. It needs the maps
    but not SPICE, and it computes only skylines (spec section 11).

Endpoints
    ``GET /api/health``
        Whether the server runs, whether it reads real terrain, the service
        region, and the accepted and default request values.
    ``GET /api/skyline?lat=..&lon=..[&mast_m=..][&az_step_deg=..]``
        A skyline record, exactly as in ``skylines/{id}.json`` (made by the
        same function, :func:`lunar_engine.records.skyline_record`).

How a request is handled, in plain words
    1. Every parameter is checked. A missing or malformed value, or one out of
       range, is refused with HTTP 400; a point outside the service region,
       or one whose skyline would need terrain beyond the maps, with HTTP 422.
       Nothing is guessed or silently corrected, and unknown parameters are
       refused too.
    2. The point is rounded to 5 decimals of a degree (at most about 0.6 m
       along a meridian), and a point closer to the pole than that is moved to
       latitude -89.99999 so that north is defined. The record reports the
       point actually used.
    3. The answer is looked up in a cache, or computed and stored there.

    Every refusal has the body ``{"version": 1, "ok": false, "error": {"code",
    "param", "message"}}`` (``docs/schemas/api_error.schema.json``).

Units: degrees and metres.
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .elevation import CoverageError, ElevationSource
from .records import RecordContractError, skyline_record

DEFAULT_AZ_STEP_DEG = 0.1
#: Accepted wedge widths, degrees. All divide 360.
ALLOWED_AZ_STEPS_DEG = (0.05, 0.1, 0.2, 0.25, 0.5, 1.0)
DEFAULT_MAST_M = 2.0
MAX_MAST_M = 100.0
#: Decimals of a degree kept for a requested point.
COORD_DECIMALS = 5
#: Points closer to the pole are moved to this latitude.
POLE_NUDGE_LAT = -89.99999
#: The service region of the real data (80 S to the pole).
SERVICE_REGION = {"lat_min": -90.0, "lat_max": -80.0}
#: Web origins allowed to call the API from a browser (the Vite dev server).
DEFAULT_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
ALLOWED_PARAMS = {"lat", "lon", "mast_m", "az_step_deg"}


class RequestError(Exception):
    """A request the server refuses. Carries the HTTP status and error body fields."""

    def __init__(self, status: int, code: str, message: str, param: str | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.param = status, code, message, param


def error_body(code: str, message: str, param: str | None = None) -> dict:
    """The body of a refused request (``api_error`` schema)."""
    error = {"code": code, "message": message}
    if param is not None:
        error["param"] = param
    return {"version": 1, "ok": False, "error": error}


def _number(query, name: str, default: float | None = None) -> float:
    """Read one numeric query parameter, refusing anything that is not a finite number.

    A parameter given twice is refused rather than guessed. The result is
    never ``-0.0`` (``+ 0.0`` turns it into ``0.0``), so the same point always
    gives the same record.
    """
    if hasattr(query, "getlist") and len(query.getlist(name)) > 1:
        raise RequestError(400, "invalid_value", f"'{name}' is given more than once", name)
    raw = query.get(name)
    if raw is None:
        if default is None:
            raise RequestError(400, "missing_parameter", f"'{name}' is required", name)
        return default
    try:
        value = float(raw)
    except ValueError:
        raise RequestError(400, "invalid_value", f"'{name}' must be a number, got {raw!r}", name)
    if not math.isfinite(value):
        raise RequestError(400, "invalid_value", f"'{name}' must be a finite number, got {raw!r}", name)
    return value + 0.0


def parse_skyline_request(query, service_region: dict) -> tuple[float, float, float, float]:
    """Check and round the parameters of ``/api/skyline``.

    Args:
        query: the request's query parameters (a mapping of strings).
        service_region: ``{"lat_min", "lat_max"}``, degrees.

    Returns:
        ``(lat, lon, mast_m, az_step_deg)``: the point actually used.

    Raises:
        RequestError: for any invalid request.
    """
    unknown = sorted(set(query.keys()) - ALLOWED_PARAMS)
    if unknown:
        raise RequestError(400, "invalid_value", f"unknown parameter {unknown[0]!r}; accepted: "
                           + ", ".join(sorted(ALLOWED_PARAMS)), unknown[0])
    lat = _number(query, "lat")
    lon = _number(query, "lon")
    mast = _number(query, "mast_m", DEFAULT_MAST_M)
    step = _number(query, "az_step_deg", DEFAULT_AZ_STEP_DEG)
    if not -90.0 <= lat <= 90.0:
        raise RequestError(400, "invalid_value", f"'lat' must be between -90 and 90, got {lat}", "lat")
    if not -180.0 <= lon <= 180.0:
        raise RequestError(400, "invalid_value",
                           f"'lon' must be between -180 and 180 (east positive), got {lon}", "lon")
    if not 0.0 <= mast <= MAX_MAST_M:
        raise RequestError(400, "invalid_value", f"'mast_m' must be between 0 and {MAX_MAST_M:g} m, "
                           f"got {mast}", "mast_m")
    allowed = [s for s in ALLOWED_AZ_STEPS_DEG if abs(s - step) < 1e-12]
    if not allowed:
        raise RequestError(400, "invalid_value", f"'az_step_deg' must be one of "
                           + ", ".join(f"{s:g}" for s in ALLOWED_AZ_STEPS_DEG) + f", got {step}",
                           "az_step_deg")
    if not service_region["lat_min"] <= lat <= service_region["lat_max"]:
        raise RequestError(422, "out_of_region", f"latitude {lat} is outside the service region "
                           f"({service_region['lat_min']:g} to {service_region['lat_max']:g})", "lat")
    lat = round(lat, COORD_DECIMALS) + 0.0
    lon = round(lon, COORD_DECIMALS) + 0.0
    if lon >= 180.0:
        lon = -180.0                                  # one meridian, one name
    if lat < POLE_NUDGE_LAT:
        lat = POLE_NUDGE_LAT
    return lat, lon, mast, allowed[0]


def create_app(source: ElevationSource, service_region: dict | None = None,
               origins=DEFAULT_ORIGINS, cache_size: int = 256,
               compute: Callable = skyline_record) -> FastAPI:
    """Build the API around a terrain source.

    Args:
        source: the terrain (real or synthetic).
        service_region: points the API accepts; default ``SERVICE_REGION``.
        origins: web origins allowed by CORS.
        cache_size: how many answers to keep.
        compute: the record function; only tests replace it.
    """
    region = dict(service_region or SERVICE_REGION)
    app = FastAPI(title="Lunar Landing Site Evaluator: skyline API", version="1")
    app.add_middleware(CORSMiddleware, allow_origins=list(origins), allow_methods=["GET"],
                       allow_headers=["*"])
    cache: OrderedDict = OrderedDict()
    lock = threading.Lock()
    app.state.cache = cache
    app.state.computed = 0

    @app.exception_handler(RequestError)
    def refused(request: Request, error: RequestError):
        return JSONResponse(error_body(error.code, error.message, error.param), status_code=error.status)

    @app.exception_handler(StarletteHTTPException)
    def http_error(request: Request, error: StarletteHTTPException):
        # FastAPI's own replies (unknown path, wrong method) in the api_error shape.
        code = "not_found" if error.status_code == 404 else "invalid_value"
        return JSONResponse(error_body(code, f"{error.detail}: {request.method} {request.url.path}"),
                            status_code=error.status_code)

    @app.exception_handler(Exception)
    def failed(request: Request, error: Exception):
        # Last resort. Route errors are turned into RequestError inside the
        # route instead, so that their replies pass through CORS and the
        # browser can read them.
        return JSONResponse(error_body("internal", f"internal error: {type(error).__name__}"),
                            status_code=500)

    @app.get("/api/health")
    def health():
        return {"version": 1, "ok": True, "real_terrain": bool(source.is_real),
                "service_region": region, "az_step_deg_default": DEFAULT_AZ_STEP_DEG,
                "az_step_deg_allowed": list(ALLOWED_AZ_STEPS_DEG),
                "mast_m_default": DEFAULT_MAST_M, "mast_m_max": MAX_MAST_M}

    @app.get("/api/skyline")
    def skyline(request: Request):
        key = parse_skyline_request(request.query_params, region)
        with lock:
            if key in cache:
                cache.move_to_end(key)
                return cache[key]
        try:
            record = compute(source, *key)
        except CoverageError as error:
            raise RequestError(422, "out_of_region", f"no skyline can be proven here: {error}")
        except RecordContractError as error:
            raise RequestError(500, "internal", f"internal error: {error}")
        except ValueError as error:
            raise RequestError(400, "invalid_value", str(error))
        except Exception as error:      # noqa: BLE001 - reported to the caller, never hidden
            raise RequestError(500, "internal", f"internal error: {type(error).__name__}")
        with lock:
            cache[key] = record
            app.state.computed += 1
            while len(cache) > cache_size:
                cache.popitem(last=False)
        return record

    return app
