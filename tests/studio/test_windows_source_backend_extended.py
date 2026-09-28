"""Execute the production PowerShell source selector with Windows resource paths."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
INSTALLER = Path(os.environ.get("UNSLOTH_INSTALL_PS1_UNDER_TEST", ROOT / "install.ps1"))


def _selector() -> str:
    text = INSTALLER.read_text(encoding = "utf-8")
    start = "    $_desktopMinVer = if ($env:UNSLOTH_DESKTOP_BACKEND_VERSION)"
    return start + text.split(start, 1)[1].split("    if ($_Migrated) {", 1)[0]


def _migrated_install() -> str:
    text = INSTALLER.read_text(encoding = "utf-8")
    start = "    if ($_Migrated) {"
    return (
        start
        + text.split(start, 1)[1].split("    } elseif ($TorchIndexUrl -or $ROCmIndexUrl) {", 1)[0]
        + "    }"
    )


def _run_selector(
    env: dict[str, str],
    verifier: str,
    after: str | None = None,
) -> subprocess.CompletedProcess[str]:
    script = (
        "$ErrorActionPreference = 'Stop'; "
        "function Exit-InstallFailure { param($Message) "
        "[Console]::Error.WriteLine($Message); exit 71 }; "
        "$TauriMode=$true; $StudioLocalInstall=$false; $PackageName='unsloth'; "
        f"{verifier} "
        + _selector()
        + (after or "Write-Output ($_unslothReleaseInstallSpec + '|' + $_zooReleaseInstallSpec)")
    )
    return subprocess.run(
        ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script],
        env = env,
        capture_output = True,
        text = True,
    )


class WindowsExtendedSourceBackendTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("pwsh"), "PowerShell is unavailable")
    def test_extended_resource_path_and_verifier_fail_closed(self):
        # The exact provider-opaque path Tauri hands to Windows PowerShell. It
        # cannot be opened on Linux, so the verifier is a PowerShell function;
        # the real verifier/wheels run in the native Windows case below.
        source = "\\\\?\\D:\\app\\resources\\source-backend"
        env = {**os.environ, "UNSLOTH_SOURCE_BACKEND_DIR": source}
        verifier = (
            "function Invoke-TestVerifier { param($verify, $directory) "
            "if ($directory -ne $env:UNSLOTH_SOURCE_BACKEND_DIR -or "
            "-not $verify.StartsWith($directory) -or "
            "-not $verify.EndsWith('verify.py')) { throw 'incorrect verifier path' }; "
            "if ($env:TEST_VERIFIER_MODE -eq 'throw') { throw 'verifier crashed' }; "
            "if ($env:TEST_VERIFIER_MODE -eq 'exit') { "
            "$global:LASTEXITCODE=23; return }; "
            "$global:LASTEXITCODE=0; "
            "Write-Output 'unsloth-2026.9.11-py3-none-any.whl'; "
            "if ($env:TEST_VERIFIER_MODE -ne 'short') { "
            "Write-Output 'unsloth_zoo-2026.9.7-py3-none-any.whl' } }; "
            "$VenvPython='Invoke-TestVerifier';"
        )
        selected = _run_selector(env, verifier)
        self.assertEqual(selected.returncode, 0, selected.stderr)
        self.assertEqual(
            selected.stdout.strip(),
            "unsloth-2026.9.11-py3-none-any.whl|unsloth_zoo-2026.9.7-py3-none-any.whl",
        )
        for mode in ("exit", "short", "throw"):
            with self.subTest(mode = mode):
                failed = _run_selector({**env, "TEST_VERIFIER_MODE": mode}, verifier)
                self.assertNotEqual(failed.returncode, 0, failed.stdout + failed.stderr)
                self.assertIn("Invalid desktop source backend", failed.stderr)

        install_failure = _run_selector(
            env,
            verifier
            + "$_Migrated=$true; $SkipTorch=$true; "
            + "function Write-TauriLog {}; function substep {}; function Write-StudioLine {}; "
            + "function Invoke-InstallCommandRetry { param($Label,$Action) return 19 };",
            _migrated_install(),
        )
        self.assertNotEqual(install_failure.returncode, 0)
        self.assertIn("Failed to install unsloth", install_failure.stderr)

    @unittest.skipUnless(
        os.name == "nt" and os.environ.get("UNSLOTH_TEST_SOURCE_BACKEND_DIR"),
        "requires a staged source bundle on a native Windows runner",
    )
    def test_native_windows_extended_path_installs_real_source_wheels(self):
        bundle = Path(os.environ["UNSLOTH_TEST_SOURCE_BACKEND_DIR"]).resolve()
        extended = "\\\\?\\" + str(bundle)
        env = {
            **os.environ,
            "UNSLOTH_SOURCE_BACKEND_DIR": extended,
            "TEST_PYTHON": sys.executable,
        }
        selected = _run_selector(env, "$VenvPython=$env:TEST_PYTHON;")
        self.assertEqual(selected.returncode, 0, selected.stdout + selected.stderr)
        wheels = selected.stdout.strip().split("|")
        self.assertEqual(len(wheels), 2)
        self.assertTrue(all(wheel.startswith(extended) for wheel in wheels), wheels)
        with tempfile.TemporaryDirectory() as tmp:
            python = Path(tmp) / "venv" / "Scripts" / "python.exe"
            subprocess.run(
                ["uv", "venv", "--python", sys.executable, str(python.parent.parent)], check = True
            )
            subprocess.run(
                ["uv", "pip", "install", "--python", str(python), "--no-deps", *wheels], check = True
            )
            versions = subprocess.check_output(
                [
                    str(python),
                    "-c",
                    "from importlib.metadata import version; "
                    "print(version('unsloth'), version('unsloth-zoo'))",
                ],
                text = True,
            ).strip()
            expected = json.loads((bundle / "manifest.json").read_text())["packages"]
            self.assertEqual(
                versions,
                " ".join(
                    expected[name]["wheel"].split("-")[1] for name in ("unsloth", "unsloth-zoo")
                ),
            )
            corrupted = Path(tmp) / "corrupted"
            shutil.copytree(bundle, corrupted)
            (corrupted / Path(wheels[1]).name).write_bytes(b"corrupted")
            env["UNSLOTH_SOURCE_BACKEND_DIR"] = "\\\\?\\" + str(corrupted)
            failed = _run_selector(env, "$VenvPython=$env:TEST_PYTHON;")
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("Invalid desktop source backend", failed.stderr)
