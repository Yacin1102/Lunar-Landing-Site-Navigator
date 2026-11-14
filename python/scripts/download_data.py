"""Download the NASA input data (SPICE kernels and LOLA elevation maps).

Role
    Fetches every file listed in ``python/data_files.json`` into
    ``python/kernels/`` and ``python/dem/`` (spec section 3). It is meant to
    run on its own in a separate terminal, for hours, and to survive being
    interrupted.

How it works, in plain words
    * Files are started in a fixed order: SPICE kernels first (small, needed
      first), then the coarse elevation maps, then the full-resolution maps,
      then the 5 m site maps. Four files are in flight at a time, because the
      elevation server limits each connection to about 0.5 MB/s.
    * Only one copy of the script can download into a folder at a time.
    * Each file is written to ``<name>.part``. Only when the whole file has
      arrived and passed its checks is it renamed to ``<name>``. A file
      without the ``.part`` ending is therefore always complete.
    * If the script stops (Ctrl+C, power cut, network loss), run the same
      command again. Finished files are skipped. A ``.part`` file continues
      with an HTTP "Range" request from the last byte known to be safely on
      the disk. Every 64 MB the script forces the file onto the disk and
      notes the position in ``<name>.part.json``; bytes after that position
      are fetched again, because after a power cut they may be garbage. The
      request also tells the server which version of the file the start came
      from, so a file replaced on the server is never glued onto an old start.
    * Checks on every file: the byte count must equal the size recorded in
      ``data_files.json``, and the SHA-256 checksum must equal the one in
      ``python/data_checksums.json``. NAIF and PGDA do not publish checksums
      for these files, so the first successful download of a file records its
      checksum there; every later download or ``--verify`` run must match it.

Usage (from the repository root)
    python python/scripts/download_data.py              download everything
    python python/scripts/download_data.py --group kernels
    python python/scripts/download_data.py --verify     re-check files on disk
    python python/scripts/download_data.py --list       show the plan only

Units
    All sizes are bytes. Speeds are shown in MB/s (1 MB = 1,000,000 bytes).

This script uses only the Python standard library and imports nothing from the
engine, so it can run before anything else is installed.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as _dt
import hashlib
import http.client
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

#: Download order. A group earlier in this tuple is always fetched first.
GROUP_ORDER = ("kernels", "coarse", "full", "sites5m")

PYTHON_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = PYTHON_DIR / "data_files.json"
DEFAULT_CHECKSUMS = PYTHON_DIR / "data_checksums.json"

CHUNK_BYTES = 1024 * 1024
#: A partial file is forced onto the disk after this many new bytes.
SYNC_BYTES = 64 * 1024 * 1024
#: Files downloaded at the same time. The PGDA server gives each connection
#: about 0.5 MB/s (measured 2026-11-14), so one at a time would take about
#: 19 hours for 35 GB. Four is what a web browser would open.
DEFAULT_WORKERS = 4

_CHECKSUM_LOCK = threading.Lock()
USER_AGENT = "lunar-landing-site-navigator-downloader/1 (NASA Space Apps entry)"


class DownloadError(Exception):
    """A file could not be downloaded or failed a check.

    ``retry`` says whether trying again can help (network trouble) or not
    (the file on the server is not the one the manifest describes).
    """

    def __init__(self, message: str, retry: bool = True, restart: bool = False):
        super().__init__(message)
        self.retry = retry
        self.restart = restart


# --------------------------------------------------------------------------
# Manifest and checksum files
# --------------------------------------------------------------------------

def load_manifest(path: Path = DEFAULT_MANIFEST) -> list[dict]:
    """Read the list of files to download.

    Args:
        path: location of ``data_files.json``.

    Returns:
        One dict per file with ``group``, ``url``, ``dest`` (path relative to
        the data root, forward slashes) and ``size`` (bytes), in file order.

    Raises:
        ValueError: if an entry is malformed, a group is unknown, a ``dest``
            is repeated, or a ``dest`` would land outside the data root.
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    files = data["files"]
    seen: set[str] = set()
    for entry in files:
        for key in ("group", "url", "dest", "size"):
            if key not in entry:
                raise ValueError(f"manifest entry is missing '{key}': {entry}")
        if entry["group"] not in GROUP_ORDER:
            raise ValueError(f"unknown group '{entry['group']}' for {entry['dest']}")
        dest = entry["dest"]
        parts = dest.split("/")
        if dest.startswith("/") or ".." in parts or "\\" in dest or ":" in dest:
            raise ValueError(f"unsafe destination path: {dest}")
        if dest in seen:
            raise ValueError(f"destination listed twice: {dest}")
        seen.add(dest)
        if not isinstance(entry["size"], int) or entry["size"] <= 0:
            raise ValueError(f"size must be a positive number of bytes: {dest}")
    return files


def ordered(files: list[dict], groups: list[str] | None = None) -> list[dict]:
    """Put files in download order and optionally keep only some groups.

    Order is by group (see ``GROUP_ORDER``), then by position in the manifest.

    Args:
        files: entries from :func:`load_manifest`.
        groups: group names to keep, or ``None`` for all.
    """
    keep = [f for f in files if groups is None or f["group"] in groups]
    return sorted(keep, key=lambda f: GROUP_ORDER.index(f["group"]))


def load_checksums(path: Path = DEFAULT_CHECKSUMS) -> dict:
    """Read the recorded checksums; an absent file means none recorded yet.

    Returns:
        ``{"version": 1, "files": {dest: {"sha256", "size", "recorded_utc"}}}``.
    """
    path = Path(path)
    if not path.exists():
        return {"version": 1, "files": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_checksums(checksums: dict, path: Path = DEFAULT_CHECKSUMS) -> None:
    """Write the checksum file safely (write a temporary file, then swap)."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    ordered_files = dict(sorted(checksums["files"].items()))
    text = json.dumps({"version": 1, "files": ordered_files}, indent=2) + "\n"
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def sha256_of(path: Path) -> str:
    """Return the SHA-256 checksum of a file as lowercase hex."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK_BYTES)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# What is already on disk
# --------------------------------------------------------------------------

def is_complete(entry: dict, root: Path, checksums: dict) -> bool:
    """Quick test: is this file fully downloaded and already verified?

    True when the final file exists, has the manifest's size, and a checksum
    was recorded for a file of that size. This does not re-read the file;
    ``--verify`` does the full re-check.

    Args:
        entry: one manifest entry.
        root: data root (``python/``); ``entry["dest"]`` is relative to it.
        checksums: result of :func:`load_checksums`.
    """
    final = Path(root) / entry["dest"]
    recorded = checksums["files"].get(entry["dest"])
    return (
        final.is_file()
        and final.stat().st_size == entry["size"]
        and recorded is not None
        and recorded.get("size") == entry["size"]
    )


def missing_files(groups, root: Path = PYTHON_DIR,
                  manifest: Path = DEFAULT_MANIFEST,
                  checksums: Path = DEFAULT_CHECKSUMS) -> list[str]:
    """List what is still missing from the named groups.

    Used by the tests to decide whether a real-data test can run.

    Args:
        groups: group names, for example ``["kernels"]``.
        root, manifest, checksums: locations; defaults are the real ones.

    Returns:
        ``dest`` paths not yet complete. A group with no files listed yet
        gives one entry saying so, because nothing can be tested with it.
    """
    files = load_manifest(manifest)
    sums = load_checksums(checksums)
    missing: list[str] = []
    for group in groups:
        if group not in GROUP_ORDER:
            raise ValueError(f"unknown data group '{group}'")
        in_group = [f for f in files if f["group"] == group]
        if not in_group:
            missing.append(f"(group '{group}' has no files listed yet)")
        missing.extend(f["dest"] for f in in_group if not is_complete(f, root, sums))
    return missing


# --------------------------------------------------------------------------
# Progress display
# --------------------------------------------------------------------------

def _gb(n: float) -> str:
    return f"{n / 1e9:.2f} GB"


def _duration(seconds: float) -> str:
    seconds = int(max(0, seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m{secs:02d}s"


class Stopped(Exception):
    """Raised inside a download when the run is being interrupted."""


class Reporter:
    """Prints progress and writes the log file. Safe to use from several threads.

    On a terminal it redraws one status line a few times a second: overall
    progress, speed, time left, and the percentage of each file in flight.
    When output is redirected it prints that line every 30 seconds instead.
    Events (file started, finished, failed) always go to the screen and to
    the log.

    Args:
        total_bytes: size of everything in this run, bytes.
        done_bytes: bytes already on disk when the run starts.
        log_path: log file to append to, or ``None`` for no log.
        stream: where to print (default: standard output).

    Attributes:
        stop: set to ask every download in flight to stop cleanly.
    """

    def __init__(self, total_bytes: int, done_bytes: int,
                 log_path: Path | None = None, stream=None):
        self.total_bytes = total_bytes
        self.done_bytes = done_bytes
        self.log_path = log_path
        self.stream = stream if stream is not None else sys.stdout
        self.interactive = bool(getattr(self.stream, "isatty", lambda: False)())
        self.stop = threading.Event()
        self._lock = threading.RLock()
        self._active: dict[str, tuple[int, int]] = {}
        self._last_draw = 0.0
        self._rate_mark = (time.monotonic(), 0)
        self._rate = 0.0
        self._session_bytes = 0
        self._line_open = False

    def event(self, message: str) -> None:
        """Print a full line and append it to the log with a UTC time."""
        with self._lock:
            if self._line_open:
                self.stream.write("\r" + " " * self._width() + "\r")
                self._line_open = False
            self.stream.write(message + "\n")
            self.stream.flush()
            if self.log_path is not None:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
                with open(self.log_path, "a", encoding="utf-8") as log:
                    log.write(f"{stamp} {message}\n")

    def add(self, n: int) -> None:
        """Count ``n`` newly received bytes."""
        with self._lock:
            self.done_bytes += n
            self._session_bytes += n

    def forget(self, n: int) -> None:
        """Un-count ``n`` bytes that had to be thrown away and fetched again."""
        with self._lock:
            self.done_bytes -= n

    def finished(self, name: str) -> None:
        """Remove a file from the status line."""
        with self._lock:
            self._active.pop(name, None)

    def _width(self) -> int:
        return max(40, shutil.get_terminal_size((120, 20)).columns - 1)

    def draw(self, name: str, have: int, size: int, force: bool = False) -> None:
        """Update one file's progress and redraw the status line if it is due."""
        with self._lock:
            self._active[name] = (have, size)
            now = time.monotonic()
            interval = 0.5 if self.interactive else 30.0
            if not force and now - self._last_draw < interval:
                return
            self._last_draw = now
            mark_time, mark_bytes = self._rate_mark
            if now - mark_time >= 5.0:
                self._rate = (self._session_bytes - mark_bytes) / (now - mark_time)
                self._rate_mark = (now, self._session_bytes)
            left = self.total_bytes - self.done_bytes
            eta = _duration(left / self._rate) if self._rate > 0 else "--"
            files = ", ".join(
                f"{_short(n)} {100.0 * h / z:.0f}%" for n, (h, z) in self._active.items())
            line = (
                f"{_gb(self.done_bytes)} of {_gb(self.total_bytes)} "
                f"({100.0 * self.done_bytes / max(1, self.total_bytes):.1f}%)  "
                f"{self._rate / 1e6:.1f} MB/s  about {eta} left  |  {files}"
            )
            if self.interactive:
                width = self._width()
                self.stream.write("\r" + line.ljust(width)[:width])
                self._line_open = True
            else:
                self.stream.write(line + "\n")
            self.stream.flush()


def _short(name: str) -> str:
    """Shorten a file name for the status line (LDEM_80S_20MPP_ADJ.TIF -> 80S_20MPP_ADJ)."""
    stem = name.rsplit(".", 1)[0]
    return stem[5:] if stem.startswith("LDEM_") else stem


# --------------------------------------------------------------------------
# Downloading one file
# --------------------------------------------------------------------------

def _total_from_headers(response, already: int) -> tuple[int, bool]:
    """Work out the file's full size from a response, and whether it resumed.

    Returns:
        ``(total_bytes, resumed)``. ``resumed`` is True for an HTTP 206 reply
        that starts exactly at byte ``already``.
    """
    if response.status == 206:
        content_range = response.headers.get("Content-Range", "")
        # Form: "bytes <first>-<last>/<total>"
        try:
            span, total = content_range.split(" ", 1)[1].split("/")
            first = int(span.split("-")[0])
            total = int(total)
        except (IndexError, ValueError):
            raise DownloadError(f"unreadable Content-Range '{content_range}'")
        if first != already:
            raise DownloadError(
                f"server resumed at byte {first}, expected {already}", restart=True)
        return total, True
    length = response.headers.get("Content-Length")
    if length is None:
        raise DownloadError("server did not report the file size")
    return int(length), False


def _state_path(part: Path) -> Path:
    """The small side file that remembers how far ``part`` can be trusted."""
    return part.with_name(part.name + ".json")


def _read_state(part: Path) -> dict | None:
    """Read the side file of a partial download, or ``None`` if unusable."""
    try:
        state = json.loads(_state_path(part).read_text(encoding="utf-8"))
        return state if isinstance(state.get("synced"), int) else None
    except (OSError, ValueError, AttributeError):
        return None


def _write_state(part: Path, state: dict) -> None:
    """Save the side file safely (write a temporary file, then swap)."""
    path = _state_path(part)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, path)


def discard_partial(part: Path) -> None:
    """Delete a partial download and its side file."""
    for path in (part, _state_path(part)):
        if path.exists():
            path.unlink()


def trusted_bytes(part: Path) -> int:
    """How many leading bytes of a partial download are safe to keep.

    Only bytes that were forced onto the disk (not just handed to the
    operating system) and noted in the side file count. After a power cut the
    end of a file can hold garbage even though its length looks right, so
    anything beyond the noted position is not trusted. A partial file with no
    side file is not trusted at all.

    Returns:
        A byte count, 0 when there is nothing to keep.
    """
    if not part.is_file():
        return 0
    state = _read_state(part)
    if state is None:
        return 0
    return max(0, min(state["synced"], part.stat().st_size))


def _fetch_once(entry: dict, part: Path, reporter: Reporter, timeout: float) -> None:
    """One attempt at filling ``part`` up to the full size.

    Keeps only the trusted start of ``part`` (see :func:`trusted_bytes`) and
    asks the server for the rest. The request carries an "If-Range" header
    with the server's own date or tag for the file from the first attempt, so
    a file that changed on the server in the meantime is sent whole instead of
    being glued onto the old start. If the server does not resume, the file
    starts again from byte 0.
    """
    size = entry["size"]
    name = Path(entry["dest"]).name
    on_disk = part.stat().st_size if part.exists() else 0
    have = min(trusted_bytes(part), size)
    state = _read_state(part) or {}
    if on_disk != have:
        if on_disk:
            reporter.event(f"  {name}: keeping the first {have} of {on_disk} bytes on disk; "
                           "the rest was not confirmed written and is fetched again")
        reporter.forget(on_disk - have if on_disk <= size else size - have)
        if have:
            with open(part, "r+b") as handle:
                handle.truncate(have)
        else:
            discard_partial(part)
            state = {}
    if have == size:
        return

    headers = {"User-Agent": USER_AGENT}
    validator = state.get("validator")
    if have:
        headers["Range"] = f"bytes={have}-"
        if validator:
            headers["If-Range"] = validator
    request = urllib.request.Request(entry["url"], headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        if error.code == 416 and have:
            raise DownloadError("server rejected the resume position", restart=True)
        retry = error.code >= 500 or error.code in (408, 429)
        raise DownloadError(f"HTTP {error.code} {error.reason}", retry=retry)

    with response:
        total, resumed = _total_from_headers(response, have)
        if total != size:
            raise DownloadError(
                f"server reports {total} bytes but the manifest says {size}; "
                "the file on the server is not the recorded version", retry=False)
        if have and not resumed:
            reporter.event(
                f"  {name}: server sent the whole file (it changed, or resuming is "
                "not supported), starting this file again")
            reporter.forget(have)
            have = 0
        # A strong ETag identifies the exact bytes; a weak one ("W/...") may
        # not be used for resuming, so fall back to the modification date.
        etag = response.headers.get("ETag", "")
        current = (etag if etag and not etag.startswith("W/")
                   else response.headers.get("Last-Modified"))
        if resumed and validator and current and current != validator:
            # Some servers resume even when asked not to. Check for ourselves.
            raise DownloadError(
                "the file changed on the server since the partial download began",
                restart=True)
        if not resumed:
            state = {"validator": current, "synced": 0}
            _write_state(part, state)
        with open(part, "ab" if resumed else "wb") as out:
            last_sync = have
            try:
                while True:
                    if reporter.stop.is_set():
                        raise Stopped()
                    block = response.read(CHUNK_BYTES)
                    if not block:
                        break
                    out.write(block)
                    have += len(block)
                    reporter.add(len(block))
                    reporter.draw(name, have, size)
                    if have - last_sync >= SYNC_BYTES:
                        out.flush()
                        os.fsync(out.fileno())
                        state["synced"] = last_sync = have
                        _write_state(part, state)
            finally:
                # Also on a network error: force what arrived onto the disk,
                # then note how far the file can be trusted.
                out.flush()
                os.fsync(out.fileno())
                state["synced"] = out.tell()
                _write_state(part, state)
    if have != size:
        raise DownloadError(f"connection closed after {have} of {size} bytes")


def download_file(entry: dict, root: Path, checksums: dict, checksums_path: Path,
                  reporter: Reporter, max_attempts: int = 30,
                  retry_wait_s: float = 10.0, timeout: float = 60.0) -> str:
    """Make sure one file is on disk, complete and verified.

    Args:
        entry: one manifest entry.
        root: data root; the file is written to ``root / entry["dest"]``.
        checksums: recorded checksums (updated in place on a first download).
        checksums_path: where to save ``checksums`` after an update.
        reporter: progress and log output.
        max_attempts: tries in a row that make no progress before giving up.
            An attempt that receives new bytes resets the count.
        retry_wait_s: seconds to wait before a retry (grows up to 6 times).
        timeout: seconds of network silence before an attempt is abandoned.

    Returns:
        ``"skipped"`` if it was already complete, otherwise ``"downloaded"``.

    Raises:
        DownloadError: after the attempts are used up, or at once when the
            server's file does not match the manifest.
    """
    final = Path(root) / entry["dest"]
    part = final.with_name(final.name + ".part")
    name = final.name
    size = entry["size"]
    dest = entry["dest"]

    if is_complete(entry, root, checksums):
        return "skipped"

    final.parent.mkdir(parents=True, exist_ok=True)
    if final.exists():
        # A file this script did not finish and verify is never adopted.
        bad = final.with_name(final.name + ".bad")
        reporter.forget(min(final.stat().st_size, size))
        os.replace(final, bad)
        reporter.event(f"  {name}: unverified file moved aside to {bad.name}")

    reporter.event(f"start  {name} ({_gb(size)})")
    attempts = 0
    checksum_retries = 0
    while True:
        before = trusted_bytes(part)
        try:
            _fetch_once(entry, part, reporter, timeout)
            reporter.draw(name, size, size, force=True)
            actual = sha256_of(part)
            recorded = checksums["files"].get(dest)
            if recorded is not None and recorded["sha256"] != actual:
                reporter.forget(size)
                discard_partial(part)
                checksum_retries += 1
                raise DownloadError(
                    f"checksum mismatch (expected {recorded['sha256'][:12]}..., "
                    f"got {actual[:12]}...); file discarded",
                    retry=checksum_retries <= 1)
            os.replace(part, final)
            _state_path(part).unlink(missing_ok=True)
            reporter.finished(name)
            if recorded is None:
                with _CHECKSUM_LOCK:
                    checksums["files"][dest] = {
                        "sha256": actual,
                        "size": size,
                        "recorded_utc": _dt.datetime.now(_dt.timezone.utc)
                        .strftime("%Y-%m-%dT%H:%M:%SZ"),
                    }
                    save_checksums(checksums, checksums_path)
                reporter.event(f"done   {name}, checksum recorded: {actual}")
            else:
                reporter.event(f"done   {name}, checksum matches: {actual}")
            return "downloaded"
        except DownloadError as error:
            problem = error
            if error.restart and part.exists():
                reporter.forget(part.stat().st_size)
                discard_partial(part)
        except (OSError, http.client.HTTPException) as error:
            problem = DownloadError(f"network error: {error}")

        now_have = trusted_bytes(part)
        attempts = 1 if now_have > before else attempts + 1
        if not problem.retry or attempts >= max_attempts:
            reporter.finished(name)
            reporter.event(f"FAILED {name}: {problem}")
            raise problem
        wait = retry_wait_s * min(attempts, 6)
        reporter.event(f"  {name}: {problem}; retrying in {wait:.0f} s "
                       f"from byte {now_have}")
        if reporter.stop.wait(wait):
            raise Stopped()


# --------------------------------------------------------------------------
# Whole runs
# --------------------------------------------------------------------------

def _bytes_on_disk(entry: dict, root: Path) -> int:
    """Bytes of this file already present (complete file or ``.part``)."""
    final = Path(root) / entry["dest"]
    part = final.with_name(final.name + ".part")
    if final.is_file():
        return min(final.stat().st_size, entry["size"])
    if part.is_file():
        return min(part.stat().st_size, entry["size"])
    return 0


class AlreadyRunning(Exception):
    """Another copy of this script is downloading into the same folder."""


class _RunLock:
    """Makes sure only one download runs per data folder.

    Holds an operating-system lock on ``dem/download.lock``. The system
    releases it by itself if the process dies, so a crash never leaves the
    folder locked. Two copies writing the same ``.part`` file would corrupt it.
    """

    def __init__(self, root: Path):
        self.path = Path(root) / "dem" / "download.lock"
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            self.handle = None
            raise AlreadyRunning(
                "another download is already running for this folder; "
                "let it finish or stop it first")
        return self

    def __exit__(self, *exc):
        if self.handle is not None:
            self.handle.close()   # closing the file releases the lock
            self.handle = None


def run_download(files: list[dict], root: Path, checksums_path: Path,
                 stream=None, max_attempts: int = 30,
                 retry_wait_s: float = 10.0, timeout: float = 60.0,
                 workers: int = DEFAULT_WORKERS) -> list[str]:
    """Download every file in ``files``, starting them in the order given.

    Up to ``workers`` files are in flight at once, each on its own connection.
    Files are started strictly in list order, so earlier groups finish first.
    A failed file does not stop the run: the rest are still fetched.

    Returns:
        ``dest`` of each file that failed (empty list means all are in place).

    Raises:
        AlreadyRunning: if another copy is downloading into ``root``.
        KeyboardInterrupt: passed on after the files in flight were stopped
            cleanly and their progress saved.
    """
    root = Path(root)
    with _RunLock(root):
        checksums = load_checksums(checksums_path)
        total = sum(f["size"] for f in files)
        done = sum(_bytes_on_disk(f, root) for f in files)
        reporter = Reporter(total, done, root / "dem" / "download.log", stream)
        reporter.event(f"Downloading {len(files)} files, {_gb(total)} in total, "
                       f"{_gb(done)} already on disk, {workers} at a time. "
                       f"Destination: {root}")
        free = shutil.disk_usage(root).free
        if free < total - done:
            reporter.event(f"WARNING: only {_gb(free)} free on this disk, "
                           f"{_gb(total - done)} still to download.")

        def one(entry: dict) -> bool:
            """Fetch one file; True if it is in place afterwards."""
            if reporter.stop.is_set():
                raise Stopped()
            try:
                status = download_file(entry, root, checksums, checksums_path, reporter,
                                       max_attempts, retry_wait_s, timeout)
            except DownloadError:
                return False
            if status == "skipped":
                reporter.event(f"skip   {Path(entry['dest']).name}: already complete")
            return True

        pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers))
        futures = [pool.submit(one, entry) for entry in files]
        try:
            # Wait in short steps so Ctrl+C is noticed at once on every system.
            while concurrent.futures.wait(futures, timeout=0.5).not_done:
                pass
        except KeyboardInterrupt:
            reporter.stop.set()
            pool.shutdown(wait=True, cancel_futures=True)
            reporter.event("Interrupted. Progress is saved.")
            raise
        pool.shutdown()
        failed = [entry["dest"] for entry, future in zip(files, futures)
                  if not future.result()]
        if failed:
            reporter.event(f"Finished with {len(failed)} file(s) FAILED: "
                           + ", ".join(failed) + ". Run the same command again.")
        else:
            reporter.event(f"All {len(files)} files are in place and verified.")
        return failed


def run_verify(files: list[dict], root: Path, checksums_path: Path,
               stream=None) -> list[str]:
    """Re-check files on disk against the manifest and recorded checksums.

    Reads every file in full to recompute its SHA-256. Downloads nothing and
    changes nothing.

    Returns:
        ``dest`` of each file that is not OK.
    """
    stream = stream if stream is not None else sys.stdout
    checksums = load_checksums(checksums_path)
    problems: list[str] = []
    for entry in files:
        final = Path(root) / entry["dest"]
        recorded = checksums["files"].get(entry["dest"])
        if not final.is_file():
            part = final.with_name(final.name + ".part")
            if part.is_file():
                status = (f"PARTIAL ({_gb(part.stat().st_size)} of "
                          f"{_gb(entry['size'])})")
            else:
                status = "MISSING"
        elif final.stat().st_size != entry["size"]:
            status = f"WRONG SIZE ({final.stat().st_size} bytes, expected {entry['size']})"
        elif recorded is None:
            status = "NO CHECKSUM RECORDED"
        elif sha256_of(final) != recorded["sha256"]:
            status = "CHECKSUM MISMATCH"
        else:
            status = "OK"
        if status != "OK":
            problems.append(entry["dest"])
        stream.write(f"{status:<22} {entry['group']:<8} {entry['dest']}\n")
        stream.flush()
    stream.write(f"{len(files) - len(problems)} of {len(files)} files OK.\n")
    return problems


def main(argv: list[str] | None = None) -> int:
    """Command-line entry point. Returns the process exit code.

    0 = everything requested is in place; 1 = at least one file failed or is
    not OK; 130 = interrupted with Ctrl+C.
    """
    parser = argparse.ArgumentParser(
        description="Download the NASA input data. Safe to interrupt and re-run.")
    parser.add_argument("--group", action="append", choices=GROUP_ORDER,
                        help="download only this group (may be repeated)")
    parser.add_argument("--verify", action="store_true",
                        help="re-check files on disk; download nothing")
    parser.add_argument("--list", action="store_true",
                        help="show the files in download order and exit")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                        help=f"files downloaded at the same time (default {DEFAULT_WORKERS})")
    parser.add_argument("--root", type=Path, default=PYTHON_DIR,
                        help="data root (default: the python/ folder)")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--checksums", type=Path, default=DEFAULT_CHECKSUMS)
    args = parser.parse_args(argv)

    files = ordered(load_manifest(args.manifest), args.group)
    if args.list:
        for index, entry in enumerate(files, start=1):
            print(f"{index:>3}  {entry['group']:<8} {_gb(entry['size']):>9}  {entry['dest']}")
        print(f"Total: {_gb(sum(f['size'] for f in files))} in {len(files)} files.")
        return 0
    if args.verify:
        return 1 if run_verify(files, args.root, args.checksums) else 0
    try:
        failed = run_download(files, args.root, args.checksums, workers=args.workers)
    except AlreadyRunning as error:
        print(f"Not started: {error}.")
        return 1
    except KeyboardInterrupt:
        print("Run the same command again to continue from where it stopped.")
        return 130
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
