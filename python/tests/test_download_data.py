"""Tests for the download script, run against a small local web server.

No test here touches the internet or the real data folders. The server below
can be told to cut a transfer short, to ignore resume requests, or to serve
different bytes, so each failure the script must survive is produced on
purpose.
"""

from __future__ import annotations

import hashlib
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import download_data as dd


class _Handler(BaseHTTPRequestHandler):
    """Serves ``server.files`` and records every request it receives."""

    def log_message(self, *args):  # keep test output quiet
        pass

    def do_GET(self):
        server = self.server
        with server.count_lock:
            server.in_flight += 1
            server.max_in_flight = max(server.max_in_flight, server.in_flight)
        try:
            time.sleep(server.delay_s)
            self._serve()
        finally:
            with server.count_lock:
                server.in_flight -= 1

    def _serve(self):
        server = self.server
        name = self.path.lstrip("/")
        range_header = self.headers.get("Range")
        server.requests.append((name, range_header))
        if name not in server.files:
            self.send_error(404)
            return
        body = server.files[name]
        start = 0
        if_range = self.headers.get("If-Range")
        server.if_ranges.append(if_range)
        current = (if_range is None or if_range == server.last_modified
                   or server.ignore_if_range)
        if range_header and server.support_range and current:
            start = int(range_header.split("=")[1].split("-")[0])
            if start >= len(body):
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
        else:
            self.send_response(200)
        payload = body[start:]
        self.send_header("Last-Modified", server.last_modified)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if server.drop_after is not None:
            # Send only the first bytes, then cut the connection: a network drop.
            payload = payload[:server.drop_after]
            server.drop_after = None
            self.wfile.write(payload)
            self.wfile.flush()
            self.connection.close()
            return
        self.wfile.write(payload)


@pytest.fixture
def server():
    """A local web server on a free port, stopped after the test."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.files = {}
    httpd.requests = []
    httpd.if_ranges = []
    httpd.ignore_if_range = False
    httpd.delay_s = 0.0
    httpd.count_lock = threading.Lock()
    httpd.in_flight = 0
    httpd.max_in_flight = 0
    httpd.last_modified = "Fri, 07 Jul 2023 22:03:02 GMT"
    httpd.support_range = True
    httpd.drop_after = None
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    httpd.base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield httpd
    httpd.shutdown()
    httpd.server_close()


def _body(n: int, seed: int = 1) -> bytes:
    """``n`` bytes of repeatable, non-repeating-looking content."""
    out = bytearray()
    counter = 0
    while len(out) < n:
        out += hashlib.sha256(f"{seed}-{counter}".encode()).digest()
        counter += 1
    return bytes(out[:n])


def _entry(server, name: str, body: bytes, group: str = "kernels") -> dict:
    server.files[name] = body
    return {"group": group, "url": f"{server.base}/{name}",
            "dest": f"{group}/{name}", "size": len(body)}


def _plant_partial(server, tmp_path, name: str, content: bytes, synced: int | None):
    """Put a ``.part`` file on disk as an earlier, interrupted run would leave it.

    ``synced`` is the position noted in the side file; ``None`` means no side file.
    """
    part = tmp_path / "kernels" / (name + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    part.write_bytes(content)
    if synced is not None:
        (tmp_path / "kernels" / (name + ".part.json")).write_text(
            json.dumps({"validator": server.last_modified, "synced": synced}))
    return part


def _run(files, tmp_path, **kwargs):
    """Run a download into ``tmp_path``; return (failed list, printed text)."""
    out = io.StringIO()
    kwargs.setdefault("retry_wait_s", 0.0)
    kwargs.setdefault("timeout", 5.0)
    kwargs.setdefault("workers", 1)
    failed = dd.run_download(files, tmp_path, tmp_path / "sums.json", stream=out, **kwargs)
    return failed, out.getvalue()


def test_fresh_download_is_complete_and_checksum_recorded(server, tmp_path):
    body = _body(300_000)
    entry = _entry(server, "a.bin", body)

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert (tmp_path / "kernels/a.bin").read_bytes() == body
    assert not (tmp_path / "kernels/a.bin.part").exists()
    sums = json.loads((tmp_path / "sums.json").read_text())
    assert sums["version"] == 1
    assert sums["files"]["kernels/a.bin"]["sha256"] == hashlib.sha256(body).hexdigest()
    assert sums["files"]["kernels/a.bin"]["size"] == len(body)
    assert "All 1 files are in place and verified." in text


def test_interrupted_download_resumes_from_the_right_byte(server, tmp_path):
    body = _body(500_000)
    entry = _entry(server, "big.bin", body)

    # First run: the connection is cut after 123,457 bytes and no retry is allowed.
    server.drop_after = 123_457
    failed, _ = _run([entry], tmp_path, max_attempts=1)
    part = tmp_path / "kernels/big.bin.part"
    assert failed == ["kernels/big.bin"]
    assert not (tmp_path / "kernels/big.bin").exists(), "an incomplete file must keep its .part name"
    kept = part.stat().st_size
    assert 0 < kept <= 123_457
    assert part.read_bytes() == body[:kept]

    # Second run of the same command: it must ask only for the missing bytes.
    server.requests.clear()
    failed, _ = _run([entry], tmp_path)
    assert failed == []
    assert server.requests == [("big.bin", f"bytes={kept}-")]
    assert server.if_ranges[-1] == server.last_modified
    assert (tmp_path / "kernels/big.bin").read_bytes() == body
    assert not part.exists()
    assert not (tmp_path / "kernels/big.bin.part.json").exists()


def test_a_drop_is_retried_within_one_run(server, tmp_path):
    body = _body(400_000)
    entry = _entry(server, "retry.bin", body)
    server.drop_after = 50_000

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert (tmp_path / "kernels/retry.bin").read_bytes() == body
    assert len(server.requests) == 2 and server.requests[1][1].startswith("bytes=")
    assert "retrying" in text


def test_finished_files_are_skipped_without_any_request(server, tmp_path):
    entry = _entry(server, "a.bin", _body(100_000))
    _run([entry], tmp_path)
    server.requests.clear()

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert server.requests == []
    assert "skip   a.bin: already complete" in text


def test_corrupted_download_is_rejected(server, tmp_path):
    good = _body(200_000, seed=1)
    entry = _entry(server, "a.bin", good)
    _run([entry], tmp_path)                       # records the checksum of the good file
    (tmp_path / "kernels/a.bin").unlink()
    server.files["a.bin"] = _body(200_000, seed=2)  # same size, different bytes

    failed, text = _run([entry], tmp_path)

    assert failed == ["kernels/a.bin"]
    assert "checksum mismatch" in text
    assert not (tmp_path / "kernels/a.bin").exists()
    assert not (tmp_path / "kernels/a.bin.part").exists()


def test_wrong_size_on_server_is_rejected_without_retry(server, tmp_path):
    entry = _entry(server, "a.bin", _body(100_000))
    entry["size"] = 99_999                         # manifest describes another version

    failed, text = _run([entry], tmp_path)

    assert failed == ["kernels/a.bin"]
    assert "not the recorded version" in text
    assert len(server.requests) == 1
    assert not (tmp_path / "kernels/a.bin").exists()


def test_server_without_resume_support_restarts_the_file(server, tmp_path):
    body = _body(300_000)
    entry = _entry(server, "a.bin", body)
    _plant_partial(server, tmp_path, "a.bin", body[:1000], synced=1000)
    server.support_range = False

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert server.requests[0] == ("a.bin", "bytes=1000-")
    assert "starting this file again" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == body


def test_stale_partial_file_with_wrong_content_is_caught(server, tmp_path):
    """A .part left over from other content resumes, then fails its checksum."""
    body = _body(300_000)
    entry = _entry(server, "a.bin", body)
    _run([entry], tmp_path)
    (tmp_path / "kernels/a.bin").unlink()
    _plant_partial(server, tmp_path, "a.bin", b"x" * 1000, synced=1000)

    failed, text = _run([entry], tmp_path)

    # The bad start is discarded and the file is fetched again from byte 0.
    assert failed == []
    assert "checksum mismatch" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == body


def test_bytes_not_confirmed_on_disk_are_fetched_again_on_a_first_download(server, tmp_path):
    """After a power cut the end of a partial file may be garbage of the right length.

    No checksum is recorded yet for a first download, so the garbage could not be
    caught afterwards. It must never be kept in the first place.
    """
    body = _body(300_000)
    entry = _entry(server, "a.bin", body)
    # 100,000 good bytes were confirmed written; 50,000 more are on disk but zeroed.
    _plant_partial(server, tmp_path, "a.bin", body[:100_000] + bytes(50_000), synced=100_000)

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert server.requests == [("a.bin", "bytes=100000-")]
    assert "not confirmed written" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == body
    sums = json.loads((tmp_path / "sums.json").read_text())
    assert sums["files"]["kernels/a.bin"]["sha256"] == hashlib.sha256(body).hexdigest()


def test_partial_file_without_its_side_file_is_not_trusted(server, tmp_path):
    body = _body(200_000)
    entry = _entry(server, "a.bin", body)
    _plant_partial(server, tmp_path, "a.bin", b"y" * 50_000, synced=None)

    failed, _ = _run([entry], tmp_path)

    assert failed == []
    assert server.requests == [("a.bin", None)], "must ask for the whole file"
    assert (tmp_path / "kernels/a.bin").read_bytes() == body


def test_file_replaced_on_the_server_is_not_glued_onto_the_old_start(server, tmp_path):
    old, new = _body(200_000, seed=1), _body(200_000, seed=2)   # same size
    entry = _entry(server, "a.bin", old)
    _plant_partial(server, tmp_path, "a.bin", old[:80_000], synced=80_000)
    server.files["a.bin"] = new
    server.last_modified = "Sat, 08 Jul 2023 10:00:00 GMT"

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert "starting this file again" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == new


def test_changed_file_is_caught_even_if_the_server_resumes_anyway(server, tmp_path):
    """A server may ignore the version sent with a resume request; the script checks itself."""
    old, new = _body(200_000, seed=1), _body(200_000, seed=2)
    entry = _entry(server, "a.bin", old)
    _plant_partial(server, tmp_path, "a.bin", old[:80_000], synced=80_000)
    server.files["a.bin"] = new
    server.last_modified = "Sat, 08 Jul 2023 10:00:00 GMT"
    server.ignore_if_range = True

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert "changed on the server" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == new


def test_progress_is_forced_to_disk_and_noted_while_downloading(server, tmp_path, monkeypatch):
    monkeypatch.setattr(dd, "CHUNK_BYTES", 10_000)
    monkeypatch.setattr(dd, "SYNC_BYTES", 30_000)
    body = _body(200_000)
    entry = _entry(server, "a.bin", body)
    server.drop_after = 95_000

    failed, _ = _run([entry], tmp_path, max_attempts=1)

    assert failed == ["kernels/a.bin"]
    part = tmp_path / "kernels/a.bin.part"
    state = json.loads((tmp_path / "kernels/a.bin.part.json").read_text())
    assert state["synced"] == part.stat().st_size > 0
    assert state["validator"] == server.last_modified
    assert dd.trusted_bytes(part) == part.stat().st_size


def test_unverified_complete_looking_file_is_not_adopted(server, tmp_path):
    body = _body(100_000)
    entry = _entry(server, "a.bin", body)
    final = tmp_path / "kernels/a.bin"
    final.parent.mkdir(parents=True)
    final.write_bytes(bytes(100_000))             # right size, wrong content, no checksum

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert "unverified file moved aside" in text
    assert final.read_bytes() == body
    assert (tmp_path / "kernels/a.bin.bad").exists()


def test_one_failed_file_does_not_stop_the_others(server, tmp_path):
    missing = {"group": "kernels", "url": f"{server.base}/nope.bin",
               "dest": "kernels/nope.bin", "size": 10}
    ok = _entry(server, "ok.bin", _body(50_000))

    failed, _ = _run([missing, ok], tmp_path)

    assert failed == ["kernels/nope.bin"]
    assert (tmp_path / "kernels/ok.bin").exists()


def test_several_files_download_at_once_and_all_arrive_intact(server, tmp_path):
    server.delay_s = 0.2
    bodies = {f"f{i}.bin": _body(60_000, seed=i) for i in range(6)}
    entries = [_entry(server, name, body) for name, body in bodies.items()]

    failed, text = _run(entries, tmp_path, workers=3)

    assert failed == []
    assert server.max_in_flight == 3, "three connections at a time, no more and no fewer"
    for name, body in bodies.items():
        assert (tmp_path / "kernels" / name).read_bytes() == body
    sums = json.loads((tmp_path / "sums.json").read_text())
    assert len(sums["files"]) == 6
    assert "All 6 files are in place and verified." in text


def test_files_are_started_in_list_order_when_downloading_in_parallel(server, tmp_path):
    server.delay_s = 0.05
    entries = [_entry(server, f"f{i}.bin", _body(20_000, seed=i)) for i in range(8)]

    _run(entries, tmp_path, workers=2)

    first_four = {name for name, _ in server.requests[:4]}
    assert first_four == {"f0.bin", "f1.bin", "f2.bin", "f3.bin"}


def test_a_second_copy_refuses_to_run_in_the_same_folder(server, tmp_path):
    entry = _entry(server, "a.bin", _body(10_000))
    with dd._RunLock(tmp_path):
        with pytest.raises(dd.AlreadyRunning):
            _run([entry], tmp_path)
    assert server.requests == []
    failed, _ = _run([entry], tmp_path)     # the lock is free again afterwards
    assert failed == []


def test_verify_reports_each_kind_of_problem_and_downloads_nothing(server, tmp_path):
    entries = [_entry(server, f"{n}.bin", _body(40_000, seed=i))
               for i, n in enumerate(["ok", "changed", "gone", "short"])]
    _run(entries, tmp_path)
    (tmp_path / "kernels/changed.bin").write_bytes(_body(40_000, seed=99))
    (tmp_path / "kernels/gone.bin").unlink()
    (tmp_path / "kernels/short.bin").write_bytes(b"abc")
    server.requests.clear()

    out = io.StringIO()
    problems = dd.run_verify(entries, tmp_path, tmp_path / "sums.json", stream=out)

    assert problems == ["kernels/changed.bin", "kernels/gone.bin", "kernels/short.bin"]
    lines = out.getvalue().splitlines()
    assert lines[0].startswith("OK")
    assert lines[1].startswith("CHECKSUM MISMATCH")
    assert lines[2].startswith("MISSING")
    assert lines[3].startswith("WRONG SIZE")
    assert lines[4] == "1 of 4 files OK."
    assert server.requests == []


def test_download_order_is_kernels_then_coarse_then_full(tmp_path):
    files = [{"group": g, "url": "u", "dest": f"{g}/{i}", "size": 1}
             for i, g in enumerate(["full", "sites5m", "coarse", "kernels", "full", "kernels"])]

    assert [f["group"] for f in dd.ordered(files)] == [
        "kernels", "kernels", "coarse", "full", "full", "sites5m"]
    assert [f["dest"] for f in dd.ordered(files)][:2] == ["kernels/3", "kernels/5"]
    assert [f["group"] for f in dd.ordered(files, ["coarse", "kernels"])] == [
        "kernels", "kernels", "coarse"]


@pytest.mark.parametrize("dest", ["../evil.bin", "/abs.bin", "C:/abs.bin", "a\\b.bin"])
def test_manifest_refuses_paths_outside_the_data_folder(tmp_path, dest):
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"version": 1, "files": [
        {"group": "kernels", "url": "u", "dest": dest, "size": 1}]}))
    with pytest.raises(ValueError, match="unsafe destination"):
        dd.load_manifest(manifest)


def test_missing_files_lists_what_a_real_data_test_waits_for(server, tmp_path):
    a = _entry(server, "a.bin", _body(10_000))
    b = _entry(server, "b.bin", _body(10_000), group="coarse")
    manifest = tmp_path / "m.json"
    manifest.write_text(json.dumps({"version": 1, "files": [a, b]}))
    sums = tmp_path / "sums.json"
    args = dict(root=tmp_path, manifest=manifest, checksums=sums)

    assert dd.missing_files(["kernels", "coarse"], **args) == ["kernels/a.bin", "coarse/b.bin"]
    _run([a], tmp_path)
    assert dd.missing_files(["kernels"], **args) == []
    assert dd.missing_files(["kernels", "coarse"], **args) == ["coarse/b.bin"]
    # A group nobody has filled in yet counts as missing, not as ready.
    assert dd.missing_files(["sites5m"], **args) == ["(group 'sites5m' has no files listed yet)"]
    # A file of the right name but wrong size is not "there".
    (tmp_path / "kernels/a.bin").write_bytes(b"short")
    assert dd.missing_files(["kernels"], **args) == ["kernels/a.bin"]


# ---- The real manifest -----------------------------------------------------

def test_real_manifest_is_well_formed_and_in_the_planned_order():
    files = dd.load_manifest()
    groups = [f["group"] for f in files]

    assert groups == sorted(groups, key=dd.GROUP_ORDER.index), "manifest is not in download order"
    assert groups.count("kernels") == 8 and groups.count("coarse") == 4 and groups.count("full") == 8
    assert groups.count("sites5m") == 65                     # option B: 5 sites x (3 maps + 10 clones)
    for f in files:
        assert f["url"].startswith("https://")
        assert f["url"].rsplit("/", 1)[1] == f["dest"].rsplit("/", 1)[1]
        folder = "kernels/" if f["group"] == "kernels" else "dem/"
        assert f["dest"].startswith(folder)
        host = "naif.jpl.nasa.gov" if f["group"] == "kernels" else "pgda.gsfc.nasa.gov"
        assert f["url"].split("/")[2] == host

    full = [f for f in files if f["group"] == "full"]
    assert all(not f["dest"].endswith("_ERR.TIF") for f in full[:4]), "height maps come before error maps"
    assert all(f["dest"].endswith("_ERR.TIF") for f in full[4:])
    total = sum(f["size"] for f in files if f["group"] != "sites5m")
    assert 34.5e9 < total < 35.5e9
    sites5m = [f for f in files if f["group"] == "sites5m"]
    assert 3.0e9 < sum(f["size"] for f in sites5m) < 3.1e9
    assert all(f["url"].endswith("/LOLA_5mpp/" + f["dest"][len("dem/sites5m/"):]) for f in sites5m), \
        "5 m files keep the server's folders under dem/sites5m/"


def test_every_manifest_file_is_explained_in_data_md():
    text = (dd.PYTHON_DIR / "DATA.md").read_text(encoding="utf-8")
    for f in dd.load_manifest():
        assert Path(f["dest"]).name in text, f"{f['dest']} is not documented in DATA.md"
