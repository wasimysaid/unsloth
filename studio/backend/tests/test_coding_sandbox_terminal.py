# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from core.coding_runtime import CodingRuntime
from utils.account_context import AccountContext, OWNER, run_as


@pytest.mark.parametrize(("account", "managed_accounts", "enabled"), [
    (OWNER, False, True),
    (OWNER, True, False),
    (replace(OWNER, via_api_key = True), False, False),
    (AccountContext("someone", "someone"), False, False),
])
def test_sandbox_runner_is_scoped_to_the_interactive_owner(monkeypatch, account, managed_accounts, enabled):
    from auth import policy

    monkeypatch.setattr(policy, "installation_has_managed_accounts", lambda: managed_accounts)
    monkeypatch.setenv("UNSLOTH_CODING_SANDBOX_PYTHON", "/inherited/python")
    monkeypatch.setenv("UNSLOTH_CODING_SANDBOX_RUNNER", "/inherited/runner")
    env = run_as(account, CodingRuntime)._environment()
    if enabled and sys.platform == "linux":
        assert env["UNSLOTH_CODING_SANDBOX_PYTHON"] == sys.executable
        assert Path(env["UNSLOTH_CODING_SANDBOX_RUNNER"]).samefile(
            Path(__file__).parents[1] / "coding_sandbox_terminal.py"
        )
    else:
        assert "UNSLOTH_CODING_SANDBOX_PYTHON" not in env
        assert "UNSLOTH_CODING_SANDBOX_RUNNER" not in env


@pytest.mark.parametrize(("mode", "command", "status"), [
    ("ask", "ls -1", 10),
    ("auto", "ls -1", 0),
    ("auto", "rm -rf testing-only", 10),
    ("off", "rm -rf testing-only", 0),
    ("full", "rm -rf testing-only", 0),
])
def test_decisions_use_studio_terminal_policy(mode, command, status):
    from coding_sandbox_terminal import check

    assert check(mode, command) == status


@pytest.mark.skipif(sys.platform != "linux", reason = "Linux terminal helper")
def test_full_access_rechecks_the_owner(monkeypatch):
    from fastapi import HTTPException
    import coding_sandbox_terminal as terminal

    monkeypatch.setattr(terminal, "installation_has_managed_accounts", lambda: False)
    with pytest.raises(HTTPException, match = "installation owner"):
        run_as(AccountContext("other", "other"), terminal.checkout, "full")
    monkeypatch.delenv("UNSLOTH_STUDIO_ALLOW_API_FULL_ACCESS", raising = False)
    with pytest.raises(HTTPException, match = "API keys"):
        run_as(replace(OWNER, via_api_key = True), terminal.checkout, "full")


@pytest.mark.skipif(sys.platform != "linux", reason = "Linux terminal helper")
def test_terminal_mode_is_supplied_by_plugin_only(tmp_path):
    helper = Path(__file__).resolve().parents[1] / "coding_sandbox_terminal.py"
    result = subprocess.run(
        [sys.executable, "-I", str(helper), "ask", "run"],
        cwd = tmp_path,
        env = {**os.environ, "UNSLOTH_STUDIO_HOME": str(tmp_path / "studio")},
        input = json.dumps({"command": "touch marker", "mode": "full"}),
        capture_output = True,
        text = True,
        timeout = 30,
    )
    assert result.returncode == 125 and "Expected a nonempty" in result.stderr
    assert not (tmp_path / "marker").exists()


@pytest.mark.skipif(sys.platform != "linux", reason = "Linux terminal helper")
def test_auto_classifies_absolute_paths_against_the_actual_checkout(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    helper = Path(__file__).resolve().parents[1] / "coding_sandbox_terminal.py"
    for path, expected in ((checkout / "file", 0), (tmp_path / "outside", 10)):
        result = subprocess.run(
            [sys.executable, "-I", str(helper), "auto", "check"],
            cwd = checkout,
            env = {**os.environ, "UNSLOTH_STUDIO_HOME": str(tmp_path / "studio")},
            input = json.dumps({"command": f'cat "{path}"'}),
            capture_output = True,
            text = True,
            timeout = 30,
        )
        assert result.returncode == expected, result.stderr


@pytest.mark.skipif(sys.platform != "linux", reason = "Linux terminal helper")
@pytest.mark.parametrize("mode", ["ask", "auto", "off"])
def test_sandboxed_modes_refuse_when_isolation_is_unavailable(monkeypatch, tmp_path, mode):
    import threading
    import coding_sandbox_terminal as terminal

    sandbox = terminal.os_sandbox
    monkeypatch.setattr(
        sandbox, "capability_snapshot",
        lambda **_: sandbox.SandboxCapability("none", False, "unavailable"),
    )
    monkeypatch.setattr(terminal.tools, "_refresh_sandbox_memory_limit", lambda: None)
    with pytest.raises(sandbox.SandboxUnavailableError, match = "OS_ISOLATION_UNAVAILABLE"):
        terminal.run(mode, str(tmp_path), "touch marker", threading.Event())
    assert not (tmp_path / "marker").exists()


@pytest.mark.asyncio
async def test_landing_hint_is_nonblocking_and_scoped_to_the_runtime_generation(monkeypatch):
    runtime = CodingRuntime()
    release = asyncio.Event()
    probes = 0

    async def inspect():
        nonlocal probes
        probes += 1
        await release.wait()
        return True

    monkeypatch.setattr(runtime, "_inspect_terminal_package", inspect)
    monkeypatch.setattr(runtime, "_terminal_runner_allowed", lambda: True)
    try:
        assert "terminal_permissions_available" not in await runtime.inspect_status()
        await asyncio.sleep(0)
        assert "terminal_permissions_available" not in await runtime.inspect_status()
        assert probes == 1
        release.set()
        await asyncio.sleep(0)
        assert (await runtime.inspect_status())["terminal_permissions_available"]
        assert runtime.process is None
        runtime._generation += 1
        assert "terminal_permissions_available" not in await runtime.inspect_status()
        await asyncio.sleep(0)
        assert (await runtime.inspect_status())["terminal_permissions_available"]
        assert probes == 2
        monkeypatch.setattr(runtime, "_terminal_runner_allowed", lambda: False)
        assert (await runtime.inspect_status())["terminal_permissions_available"] is False
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("version", "frontends", "compatible", "expected"), [
    ("0.1.0", ["headless"], True, False),
    ("0.2.0", [], True, False),
    ("0.2.0", ["headless"], False, False),
    ("0.2.0", ["headless"], True, True),
])
async def test_landing_hint_needs_installed_permission_support(tmp_path, version, frontends, compatible, expected):
    package = {
        "id": "studio.sandbox-terminal", "version": version, "enabled_frontends": frontends,
        "lifetime": "session", "compatible": compatible,
    }
    executable = tmp_path / "catalog"
    executable.write_text(
        f"#!{sys.executable}\nimport json, sys\nassert sys.argv[1:] == ['plugin', 'list', '--json']\n"
        f"print(json.dumps({{'packages': [{package!r}]}}))\n"
    )
    executable.chmod(0o700)
    runtime = CodingRuntime(str(executable))
    assert await runtime._inspect_terminal_package() is expected
