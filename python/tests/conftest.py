"""Shared pytest set-up: tests that need the real NASA data.

Role
    A test marked ``@pytest.mark.realdata("kernels")`` (or ``"coarse"``,
    ``"full"``, ``"sites5m"``, or several) needs downloaded files from those
    groups of ``python/data_files.json``.

How it works, in plain words
    Before the tests run, each marked test is checked against the disk. If
    every file of its groups is complete and verified, the test runs like any
    other. If not, it is skipped. Nothing has to be changed for the tests to
    start running once the download finishes.

    Every run ends with a "Real-data tests" section that names each skipped
    test and the files it is waiting for, so a skip is never silent.
"""

from __future__ import annotations

import pytest

import download_data

_WAITING = pytest.StashKey[list]()
_RAN = pytest.StashKey[int]()


def pytest_collection_modifyitems(config, items):
    """Skip each real-data test whose files are not all on disk."""
    waiting = []
    ran = 0
    cache: dict[tuple, list[str]] = {}
    for item in items:
        marker = item.get_closest_marker("realdata")
        if marker is None:
            continue
        groups = tuple(marker.args)
        if not groups:
            raise pytest.UsageError(
                f"{item.nodeid}: realdata marker needs at least one group name")
        if groups not in cache:
            cache[groups] = download_data.missing_files(groups)
        missing = cache[groups]
        if missing:
            item.add_marker(pytest.mark.skip(
                reason=f"waiting for {len(missing)} data file(s) from {', '.join(groups)}"))
            waiting.append((item.nodeid, groups, missing))
        else:
            ran += 1
    config.stash[_WAITING] = waiting
    config.stash[_RAN] = ran


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    """Print which real-data tests were skipped and what each is waiting for."""
    waiting = config.stash.get(_WAITING, [])
    ran = config.stash.get(_RAN, 0)
    terminalreporter.section("Real-data tests")
    terminalreporter.write_line(
        f"{ran} real-data test(s) had their data and ran; {len(waiting)} skipped.")
    for nodeid, groups, missing in waiting:
        shown = ", ".join(missing[:3]) + (f" and {len(missing) - 3} more"
                                          if len(missing) > 3 else "")
        terminalreporter.write_line(f"  SKIPPED {nodeid}")
        terminalreporter.write_line(f"          waiting for [{', '.join(groups)}]: {shown}")
    if waiting:
        terminalreporter.write_line(
            "  Get the data with: python python/scripts/download_data.py")
