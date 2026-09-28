"""Fork source-backend bundle contracts (no GPU or release dispatch required)."""

import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
builder_spec = importlib.util.spec_from_file_location(
    "source_builder", ROOT / "scripts/build_desktop_source_backend.py"
)
source_builder = importlib.util.module_from_spec(builder_spec)
builder_spec.loader.exec_module(source_builder)

spec = importlib.util.spec_from_file_location("source_backend", ROOT / "studio/source_backend.py")
source_backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_backend)


class SourceBackendTests(unittest.TestCase):
    def test_verified_wheels_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            packages = {}
            for name in source_backend.PACKAGES:
                filename = name.replace("-", "_") + "-1.0-py3-none-any.whl"
                wheel = directory / filename
                wheel.write_bytes(b"source-built wheel test")
                packages[name] = {
                    "source_sha": "a" * 40,
                    "wheel": filename,
                    "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                }
            (directory / "manifest.json").write_text(
                json.dumps({"schema": 1, "packages": packages})
            )
            self.assertEqual(
                tuple(str(directory / packages[n]["wheel"]) for n in source_backend.PACKAGES),
                source_backend.wheel_paths(directory),
            )
            (directory / packages["unsloth-zoo"]["wheel"]).write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                source_backend.wheel_paths(directory)
            packages["unsloth-zoo"]["wheel"] = "../escape.whl"
            (directory / "manifest.json").write_text(
                json.dumps({"schema": 1, "packages": packages})
            )
            with self.assertRaisesRegex(ValueError, "invalid unsloth-zoo"):
                source_backend.wheel_paths(directory)

    def test_builder_rejects_dirty_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)

            def git(*args):
                return subprocess.check_output(["git", "-C", str(repo), *args], text = True).strip()

            git("init", "-q")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Test")
            (repo / "pyproject.toml").write_text("[build-system]\nrequires=[]\n")
            git("add", "pyproject.toml")
            git("commit", "-qm", "test revision")
            sha = git("rev-parse", "HEAD")
            self.assertEqual(source_builder._sha(repo), sha)
            self.assertNotEqual(sha, "0" * 40)
            (repo / "pyproject.toml").write_text("modified")
            with self.assertRaisesRegex(ValueError, "uncommitted"):
                source_builder._sha(repo)

    def test_update_source_core_phase_selects_both_wheels_in_both_modes(self):
        """Execute the production core branch with captured install calls, not a copy."""
        module = ast.parse((ROOT / "studio/install_python_stack.py").read_text())
        selector = next(
            node
            for node in ast.walk(module)
            if isinstance(node, ast.If)
            and isinstance(node.test, ast.Name)
            and node.test.id == "skip_base"
            and node.lineno > 11000
        )
        source_branch = selector.orelse[0]
        self.assertIsInstance(source_branch, ast.If)
        self.assertIn("source_wheels", ast.unparse(source_branch.test))
        body = compile(
            ast.fix_missing_locations(ast.Module(body = source_branch.body, type_ignores = [])),
            str(ROOT / "studio/install_python_stack.py"),
            "exec",
        )
        for no_torch in (False, True):
            calls = []
            env = {
                "source_wheels": ("/bundle/unsloth.whl", "/bundle/unsloth_zoo.whl"),
                "NO_TORCH": no_torch,
                "_progress": lambda *_: None,
                "pip_install": lambda *args, **kwargs: calls.append((args, kwargs)),
                "_skip_step": lambda *_args, **_kwargs: False,
                "REQ_ROOT": Path("/test"),
            }
            exec(body, env)
            core_args, core_kwargs = calls[0]
            self.assertEqual(core_args[-2:], env["source_wheels"])
            self.assertEqual(core_args.count("--reinstall-package"), 2)
            self.assertEqual("--no-deps" in core_args, no_torch)
            self.assertTrue(core_kwargs["uv_required"])
            self.assertEqual(len(calls), 3 if no_torch else 1)

    def test_unix_installer_selects_verified_pair_and_preserves_default(self):
        sh = (ROOT / "install.sh").read_text()
        block = sh.split('_unsloth_desktop_install_spec=""', 1)[1].split(
            'if [ "$_MIGRATED" = true ]; then', 1
        )[0]
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            packages = {}
            for name in source_backend.PACKAGES:
                wheel = bundle / (name.replace("-", "_") + "-1.0-py3-none-any.whl")
                wheel.write_bytes(name.encode())
                packages[name] = {
                    "wheel": wheel.name,
                    "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                    "source_sha": "a" * 40,
                }
            (bundle / "manifest.json").write_text(json.dumps({"schema": 1, "packages": packages}))
            (bundle / "verify.py").write_text((ROOT / "studio/source_backend.py").read_text())
            command = (
                "TAURI_MODE=true; STUDIO_LOCAL_INSTALL=false; PACKAGE_NAME=unsloth; "
                '_VENV_PY="$TEST_PYTHON"; UNSLOTH_DESKTOP_BACKEND_VERSION=2026.9.11; '
                '_unsloth_desktop_install_spec=""'
                + block
                + 'printf \'%s\\n%s\\n\' "$_unsloth_release_install_spec" "$_zoo_release_install_spec"'
            )
            import os

            env = {**os.environ, "TEST_PYTHON": sys.executable}
            env.pop("UNSLOTH_SOURCE_BACKEND_DIR", None)
            default = subprocess.run(
                ["sh", "-c", command], env = env, capture_output = True, text = True, check = True
            )
            self.assertEqual(
                default.stdout.splitlines(), ["unsloth>=2026.9.11", "unsloth-zoo>=2026.9.7"]
            )
            env["UNSLOTH_SOURCE_BACKEND_DIR"] = str(bundle)
            selected = subprocess.run(
                ["sh", "-c", command], env = env, capture_output = True, text = True, check = True
            )
            self.assertEqual(selected.stdout.splitlines(), list(source_backend.wheel_paths(bundle)))
            (bundle / packages["unsloth"]["wheel"]).write_bytes(b"tampered")
            failed = subprocess.run(["sh", "-c", command], env = env, capture_output = True, text = True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("checksum mismatch", failed.stderr)

    def test_windows_installer_selects_verified_pair_and_preserves_default(self):
        import os
        import shutil

        if not shutil.which("pwsh"):
            self.skipTest("PowerShell is unavailable on this host")
        ps = (ROOT / "install.ps1").read_text()
        block = ps.split("    $_desktopMinVer = if ($env:UNSLOTH_DESKTOP_BACKEND_VERSION)", 1)[1]
        block = (
            "    $_desktopMinVer = if ($env:UNSLOTH_DESKTOP_BACKEND_VERSION)"
            + block.split("    if ($_Migrated) {", 1)[0]
        )
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            packages = {}
            for name in source_backend.PACKAGES:
                wheel = bundle / (name.replace("-", "_") + "-1.0-py3-none-any.whl")
                wheel.write_bytes(name.encode())
                packages[name] = {
                    "wheel": wheel.name,
                    "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
                    "source_sha": "a" * 40,
                }
            (bundle / "manifest.json").write_text(json.dumps({"schema": 1, "packages": packages}))
            (bundle / "verify.py").write_text((ROOT / "studio/source_backend.py").read_text())
            script = (
                "$ErrorActionPreference='Stop'; function Exit-InstallFailure { param($m) throw $m }; "
                "$TauriMode=$true; $StudioLocalInstall=$false; $PackageName='unsloth'; "
                "$VenvPython=$env:TEST_PYTHON; "
                + block
                + "Write-Output ($_unslothReleaseInstallSpec + '|' + $_zooReleaseInstallSpec)"
            )
            env = {
                **os.environ,
                "TEST_PYTHON": sys.executable,
                "UNSLOTH_DESKTOP_BACKEND_VERSION": "2026.9.11",
            }
            env.pop("UNSLOTH_SOURCE_BACKEND_DIR", None)
            default = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", script],
                env = env,
                capture_output = True,
                text = True,
                check = True,
            )
            self.assertEqual(default.stdout.strip(), "unsloth>=2026.9.11|unsloth-zoo>=2026.9.7")
            env["UNSLOTH_SOURCE_BACKEND_DIR"] = str(bundle)
            selected = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", script],
                env = env,
                capture_output = True,
                text = True,
                check = True,
            )
            self.assertEqual(selected.stdout.strip(), "|".join(source_backend.wheel_paths(bundle)))
            (bundle / packages["unsloth-zoo"]["wheel"]).write_bytes(b"tampered")
            failed = subprocess.run(
                ["pwsh", "-NoProfile", "-Command", script], env = env, capture_output = True, text = True
            )
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("checksum mismatch", failed.stderr)

    def test_release_and_installer_mode_contract(self):
        workflow = (ROOT / ".github/workflows/release-desktop.yml").read_text()
        self.assertIn("refs/heads/release/desktop-source-backend", workflow)
        self.assertIn(
            "inputs.source_backend && github.sha || needs.prepare-version.outputs.desktop_release_tag",
            workflow,
        )
        self.assertIn('--zoo-sha "$ZOO_SHA"', workflow)
        self.assertIn('backend-source --unsloth-sha "$TAG_SHA"', workflow)
        for config in ("linux", "macos", "windows"):
            self.assertIn(
                '"source-backend/": "source-backend/"',
                (ROOT / f"studio/src-tauri/tauri.{config}.conf.json").read_text(),
            )
        for installer in ("install.sh", "install.ps1"):
            text = (ROOT / installer).read_text()
            self.assertIn("UNSLOTH_SOURCE_BACKEND_DIR", text)
            self.assertIn("verify.py", text)
            self.assertIn("--local", text)
            self.assertIn(
                "sourceZooSpec" if installer.endswith("ps1") else "_source_zoo_spec", text
            )
        self.assertIn(
            "source_backend_dir(app)", (ROOT / "studio/src-tauri/src/install.rs").read_text()
        )
        self.assertIn(
            "source_backend_dir(app)", (ROOT / "studio/src-tauri/src/update.rs").read_text()
        )
        update = (ROOT / "studio/install_python_stack.py").read_text()
        self.assertLess(
            update.index("elif source_wheels is not None:"),
            update.index("elif NO_TORCH:", update.index("# 3. Core packages")),
        )
        self.assertIn('"--reinstall-package", "unsloth-zoo",\n            *source_wheels', update)


if __name__ == "__main__":
    unittest.main()
