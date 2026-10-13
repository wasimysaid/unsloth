# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""The managed E2E fixture works from both supported pytest working directories."""

import os
from pathlib import Path
import sys
from types import SimpleNamespace

from . import conftest as shared
from . import test_studio_api as e2e


def test_managed_server_uses_the_collected_test_package_and_private_log(
    monkeypatch, tmp_path_factory
):
    for name in (
        "UNSLOTH_E2E_BASE_URL",
        "UNSLOTH_E2E_MODEL",
        "UNSLOTH_E2E_VARIANT",
    ):
        monkeypatch.delenv(name, raising = False)
    request = SimpleNamespace(config = SimpleNamespace(getoption = lambda name: None))
    original_log = e2e.LOG_FILE
    original_home = os.environ.get("UNSLOTH_STUDIO_HOME")
    process = object()
    started = []
    killed = []

    def start(model, variant):
        started.append((model, variant, e2e.LOG_FILE))
        return process, "fixture-key"

    monkeypatch.setattr(e2e, "_start_server", start)
    monkeypatch.setattr(e2e, "_kill_server", killed.append)
    fixture = shared.studio_server.__wrapped__(request, tmp_path_factory)
    try:
        assert next(fixture) == (f"http://{e2e.HOST}:{e2e.PORT}", "fixture-key")
        assert started == [(e2e.DEFAULT_MODEL, e2e.DEFAULT_VARIANT, e2e.LOG_FILE)]
        assert e2e.LOG_FILE != original_log
        assert e2e.LOG_FILE.is_relative_to(tmp_path_factory.getbasetemp())
        assert e2e.LOG_FILE.name == "server.log"
        assert Path(os.environ["UNSLOTH_STUDIO_HOME"]) == e2e.LOG_FILE.parent
        assert (e2e.LOG_FILE.parent / "unsloth_studio").samefile(sys.prefix)
        assert killed == []
    finally:
        fixture.close()
    assert killed == [process]
    assert e2e.LOG_FILE == original_log
    assert os.environ.get("UNSLOTH_STUDIO_HOME") == original_home


def test_api_server_launch_does_not_require_an_ignored_frontend_build(monkeypatch, tmp_path):
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "")
    monkeypatch.setattr(e2e, "LOG_FILE", tmp_path / "server.log")
    monkeypatch.setattr(e2e.time, "sleep", lambda seconds: None)
    process = SimpleNamespace(poll = lambda: None)
    launches = []

    def popen(command, **kwargs):
        launches.append((command, kwargs))
        kwargs["stdout"].write("API Key: sk-unsloth-0123456789abcdef\n")
        kwargs["stdout"].flush()
        return process

    monkeypatch.setattr(e2e.subprocess, "Popen", popen)
    try:
        assert e2e._start_server("fixture/model", "Q4_K_M") == (
            process, "sk-unsloth-0123456789abcdef"
        )
        command, kwargs = launches[0]
        assert command[:3] == ["unsloth", "studio", "run"]
        assert "--api-only" in command
        assert command[command.index("--model") + 1] == "fixture/model"
        assert command[command.index("--gguf-variant") + 1] == "Q4_K_M"
        assert kwargs["env"]["CUDA_VISIBLE_DEVICES"] == ""
    finally:
        for _, kwargs in launches:
            kwargs["stdout"].close()
