#!/usr/bin/env python3
"""Secret-free, bounded native-window probe for the disposable PR #11910 workflow.

Runs the *subject* checkout's Tauri binary, not a browser rendering of its UI.
The installed scenario uses the subject's real --local --no-torch installer and
seeds only the saved-window-state file. The onboarding flow is not mocked.
"""

import ctypes
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time

RESULTS = Path("workbench-results").resolve()
RESULTS.mkdir(exist_ok=True)
IS_WINDOWS = platform.system() == "Windows"

MAC_OBSERVER = r'''
import AppKit
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let dest = CommandLine.arguments[2]
let started = Date()
var first = false
while Date().timeIntervalSince(started) < 9 {
    if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for window in windows {
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let width = bounds["Width"] as? NSNumber, width.intValue >= 320,
                  let height = bounds["Height"] as? NSNumber, height.intValue >= 240 else { continue }
            let elapsed = Date().timeIntervalSince(started)
            let record: [String: Any] = ["elapsed_s": elapsed, "bounds": bounds,
                                         "title": window[kCGWindowName as String] ?? ""]
            if let bytes = try? JSONSerialization.data(withJSONObject: record),
               let line = String(data: bytes, encoding: .utf8) { print(line); fflush(stdout) }
            if !first {
                first = true
                let capture = Process()
                capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = ["-x", dest]
                do { try capture.run(); capture.waitUntilExit() } catch {
                    fputs("screencapture failed: \(error)\n", stderr)
                }
            }
            break
        }
    }
    Thread.sleep(forTimeInterval: 0.04)
}
'''


def run_command(argv, name, timeout=1800, env=None):
    with (RESULTS / (name + ".log")).open("w", encoding="utf-8", errors="replace") as log:
        log.write("argv: " + json.dumps(argv) + "\n")
        log.flush()
        result = subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env)
    if result.returncode:
        raise RuntimeError(f"{name} exited {result.returncode}; see {name}.log")


def windows_visible(pid):
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visitor(hwnd, unused):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        if rect.right <= rect.left or rect.bottom <= rect.top:
            return True
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, len(title))
        # Exclude Tauri's 16x16 single-instance helper before recording or capturing.
        if title.value != "Unsloth" or rect.right - rect.left < 320 or rect.bottom - rect.top < 240:
            return True
        found.append({"title": title.value, "x": rect.left, "y": rect.top,
                      "width": rect.right - rect.left, "height": rect.bottom - rect.top})
        return True

    cb = callback_type(visitor)
    user32.EnumWindows(cb, 0)
    return found


def windows_capture(path, bounds):
    # Capture only the observed app window, never unrelated runner content.
    ps_path = str(path).replace("'", "''")
    x, y, w, h = (bounds[key] for key in ("x", "y", "width", "height"))
    script = ("Add-Type -AssemblyName System.Drawing; "
              f"$b=New-Object System.Drawing.Bitmap({w},{h}); "
              "$g=[System.Drawing.Graphics]::FromImage($b); "
              f"$g.CopyFromScreen([System.Drawing.Point]::new({x},{y}),"
              "[System.Drawing.Point]::Empty,$b.Size); "
              f"$b.Save('{ps_path}',[System.Drawing.Imaging.ImageFormat]::Png); "
              "$g.Dispose(); $b.Dispose()")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                           capture_output=True, text=True, timeout=12)
        return {"exit_code": r.returncode, "error": r.stderr[-1500:]}
    except subprocess.TimeoutExpired:
        return {"exit_code": None, "error": "screenshot command timed out after 12 s"}


def launch(binary, scenario, root):
    env = os.environ.copy()
    home = root / scenario
    home.mkdir(parents=True)
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    env["APPDATA"] = str(home / "AppData" / "Roaming")
    env["LOCALAPPDATA"] = str(home / "AppData" / "Local")
    env["XDG_CONFIG_HOME"] = str(home / ".config")
    env["UNSLOTH_SKIP_AUTOSTART"] = "1"
    Path(env["APPDATA"]).mkdir(parents=True, exist_ok=True)
    Path(env["LOCALAPPDATA"]).mkdir(parents=True, exist_ok=True)
    summary = {"scenario": scenario, "backend": "absent" if scenario == "fresh-setup" else "real local --no-torch install",
               "samples": [], "screenshots": [], "platform": platform.platform()}
    if scenario == "installed-saved-layout":
        try:
            if IS_WINDOWS:
                installer = [shutil.which("pwsh") or "pwsh", "-NoProfile", "-NonInteractive",
                             "-ExecutionPolicy", "Bypass", "-File", "install.ps1", "--local", "--no-torch"]
            else:
                installer = ["bash", "install.sh", "--local", "--no-torch"]
            run_command(installer, "local-install", 1500, env=env)
            summary["installer"] = "passed; see local-install.log"
        except Exception as exc:
            summary["installer"] = "failed: " + repr(exc)
            (RESULTS / (scenario + ".json")).write_text(json.dumps(summary, indent=2))
            return summary
        if IS_WINDOWS:
            config = Path(env["APPDATA"]) / "ai.unsloth.studio"
        else:
            config = home / "Library" / "Application Support" / "ai.unsloth.studio"
        config.mkdir(parents=True, exist_ok=True)
        (config / ".window-state.json").write_text(json.dumps({"main": {
            "width": 1200, "height": 800, "x": 40, "y": 45, "prev_x": 40,
            "prev_y": 45, "maximized": False, "visible": True,
            "decorated": True, "fullscreen": False}}))
        (config / "app-layout-initialized-v1").write_text("initialized\n")
        summary["seeded_state_path"] = str(config / ".window-state.json")
    started = time.monotonic()
    app_log = RESULTS / (scenario + "-app.log")
    with app_log.open("w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.Popen([str(binary)], cwd=binary.parent, env=env, stdout=log,
                                stderr=subprocess.STDOUT)
        try:
            if IS_WINDOWS:
                for _ in range(225):
                    for win in windows_visible(proc.pid):
                        summary["samples"].append({"elapsed_s": round(time.monotonic() - started, 3), **win})
                    if summary["samples"] and "capture" not in summary:
                        shot = RESULTS / (scenario + "-first-visible.png")
                        summary["capture"] = windows_capture(shot, win)
                        if shot.is_file() and shot.stat().st_size:
                            summary["screenshots"].append(shot.name)
                    if proc.poll() is not None:
                        break
                    time.sleep(0.04)
            else:
                observer = subprocess.run([str(root / "mac-observer"), str(proc.pid),
                                           str(RESULTS / (scenario + "-first-visible.png"))],
                                          capture_output=True, text=True, timeout=15)
                summary["observer_exit"] = observer.returncode
                summary["observer_stderr"] = observer.stderr[-1500:]
                for line in observer.stdout.splitlines():
                    try:
                        summary["samples"].append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
                shot = RESULTS / (scenario + "-first-visible.png")
                if shot.is_file() and shot.stat().st_size:
                    summary["screenshots"].append(shot.name)
        finally:
            summary["app_returncode_before_stop"] = proc.poll()
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            summary["app_returncode_after_stop"] = proc.returncode
    summary["elapsed_s"] = round(time.monotonic() - started, 3)
    (RESULTS / (scenario + ".json")).write_text(json.dumps(summary, indent=2))
    return summary


def main():
    summary = {"source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
               "expected_sha": os.environ["SUBJECT_SHA"], "workflow_sha": os.environ["WORKFLOW_SHA"],
               "run_id": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
               "cell": os.environ["CELL_ID"], "os": platform.platform(), "scenarios": []}
    try:
        if summary["source_sha"] != summary["expected_sha"]:
            raise RuntimeError("subject SHA mismatch")
        run_command([sys.executable, "scripts/lockfile_supply_chain_audit.py"], "lockfile-audit", 90)
        run_command([shutil.which("npm") or "npm", "ci", "--prefix", "studio", "--no-fund", "--no-audit"], "npm-tauri", 420)
        run_command([shutil.which("npm") or "npm", "ci", "--prefix", "studio/frontend", "--no-fund", "--no-audit"], "npm-frontend", 420)
        run_command([shutil.which("npx") or "npx", "--prefix", "studio", "tauri", "build", "--debug", "--no-bundle"],
                    "tauri-build", 2700)
        binary = Path("studio/src-tauri/target/debug/unsloth-studio" + (".exe" if IS_WINDOWS else "")).resolve()
        if not binary.is_file():
            raise RuntimeError("Tauri binary missing at " + str(binary))
        summary["binary"] = str(binary)
        with tempfile.TemporaryDirectory(prefix="unsloth-window-probe-") as temp:
            root = Path(temp)
            if not IS_WINDOWS:
                swift = root / "observer.swift"
                swift.write_text(MAC_OBSERVER)
                run_command(["swiftc", str(swift), "-o", str(root / "mac-observer")], "mac-observer-compile", 120)
            for scenario in ("fresh-setup", "installed-saved-layout"):
                summary["scenarios"].append(launch(binary, scenario, root))
        summary["gui_observed"] = any(s["samples"] for s in summary["scenarios"])
        summary["limitations"] = ["Installed case seeds a saved layout after a real --local --no-torch backend install; no installer GUI or fully provisioned torch/model inference was exercised."]
        if any(s.get("installer", "").startswith("failed:") for s in summary["scenarios"]):
            summary["limitations"].append("Real backend installer failed; normal-window comparison is unavailable.")
        if not summary["gui_observed"]:
            summary["limitations"].append("No on-screen native window observed in the bounded runner session.")
    except Exception as exc:
        summary["error"] = repr(exc)
    finally:
        (RESULTS / "desktop-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2), flush=True)
    installed = next((s for s in summary["scenarios"] if s["scenario"] == "installed-saved-layout"), None)
    if ("error" in summary or not summary.get("gui_observed") or not installed
            or installed.get("installer", "").startswith("failed:") or not installed["samples"]):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
