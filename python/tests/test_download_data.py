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
        name = self.path.lstrip("/")
        range_header = self.headers.get("Range")
        server.requests.append((name, range_header))
        if name not in server.files:
            self.send_error(404)
            return
        body = server.files[name]
        start = 0
        if range_header and server.support_range:
            start = int(range_header.split("=")[1].split("-")[0])
            if start >= len(body):
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
        else:
            self.send_response(200)
        payload = body[start:]
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


def _run(files, tmp_path, **kwargs):
    """Run a download into ``tmp_path``; return (failed list, printed text)."""
    out = io.StringIO()
    kwargs.setdefault("retry_wait_s", 0.0)
    kwargs.setdefault("timeout", 5.0)
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
    assert (tmp_path / "kernels/big.bin").read_bytes() == body
    assert not part.exists()


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
    assert "already complete, skipped" in text


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
    part = tmp_path / "kernels/a.bin.part"
    part.parent.mkdir(parents=True)
    part.write_bytes(body[:1000])
    server.support_range = False

    failed, text = _run([entry], tmp_path)

    assert failed == []
    assert "does not support resuming" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == body


def test_stale_partial_file_with_wrong_content_is_caught(server, tmp_path):
    """A .part left over from other content resumes, then fails its checksum."""
    body = _body(300_000)
    entry = _entry(server, "a.bin", body)
    _run([entry], tmp_path)
    (tmp_path / "kernels/a.bin").unlink()
    (tmp_path / "kernels/a.bin.part").write_bytes(b"x" * 1000)

    failed, text = _run([entry], tmp_path)

    # The bad start is discarded and the file is fetched again from byte 0.
    assert failed == []
    assert "checksum mismatch" in text
    assert (tmp_path / "kernels/a.bin").read_bytes() == body


def test_one_failed_file_does_not_stop_the_others(server, tmp_path):
    missing = {"group": "kernels", "url": f"{server.base}/nope.bin",
               "dest": "kernels/nope.bin", "size": 10}
    ok = _entry(server, "ok.bin", _body(50_000))

    failed, _ = _run([missing, ok], tmp_path)

    assert failed == ["kernels/nope.bin"]
    assert (tmp_path / "kernels/ok.bin").exists()


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
    total = sum(f["size"] for f in files)
    assert 34.5e9 < total < 35.5e9


def test_every_manifest_file_is_explained_in_data_md():
    text = (dd.PYTHON_DIR / "DATA.md").read_text(encoding="utf-8")
    for f in dd.load_manifest():
        assert Path(f["dest"]).name in text, f"{f['dest']} is not documented in DATA.md"
