# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Editable runtime grants and Unix socket probes survive a deep source checkout."""

import os
import socket
import sys
import tempfile

import pytest

from core.inference import os_sandbox


def test_editable_grants_do_not_expand_to_undeclared_sys_path_entries(tmp_path, monkeypatch):
    source = tmp_path / "checkout"
    package = source / "demo"
    package.mkdir(parents = True)
    (package / "__init__.py").write_text("", encoding = "utf-8")
    (source / "deploy.py").write_text("private = 'fixture'\n", encoding = "utf-8")
    tests = source / "tests"
    tests.mkdir()
    (tests / "__init__.py").write_text("", encoding = "utf-8")
    (tests / "fixture_secret.py").write_text("private = 'fixture'\n", encoding = "utf-8")
    site = source / ".venv" / "lib" / "site-packages"
    (site / "unrelated").mkdir(parents = True)
    (site / "unrelated" / "__init__.py").write_text("", encoding = "utf-8")
    for path in (source, tests, site):
        monkeypatch.syspath_prepend(str(path))
    assert os_sandbox._importable_entries(str(source), frozenset({"demo"})) == (str(package),)


def test_editable_grants_resolve_relative_import_roots(tmp_path, monkeypatch):
    package = tmp_path / "checkout" / "demo"
    package.mkdir(parents = True)
    (package / "__init__.py").write_text("", encoding = "utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend("checkout")
    assert os_sandbox._importable_entries(
        str(tmp_path / "checkout"), frozenset({"demo"})
    ) == (str(package),)


@pytest.mark.skipif(sys.platform != "linux", reason = "Linux proc-fd socket path")
@pytest.mark.parametrize("live", [False, True])
def test_long_socket_probe_does_not_depend_on_a_short_temp_root(tmp_path, monkeypatch, live):
    parent = tmp_path / ("deep-" + "x" * 90)
    parent.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(parent))
    path = str(parent / "endpoint")
    assert len(os.fsencode(path)) > 108
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(f"/proc/self/fd/{descriptor}/endpoint")
        if live:
            listener.listen(1)
        else:
            listener.close()
        assert os_sandbox._ipc_endpoint_is_dead(path) is (not live)
        assert os.path.exists(path)
    finally:
        listener.close()
        os.close(descriptor)
