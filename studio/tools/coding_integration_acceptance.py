#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Run/reconcile the existing isolated coding-route drivers after current builds.

No live provider/GPU work is launched. Parallel batches publish only batch-local
records; --reconcile-only is the serialized final acceptance-record operation.
Build provenance and source manifests include uncommitted source, not credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

WORKLOAD_ROWS = {
    "deterministic": ("A1", "A2", "A6", "A7", "A9", "A10"),
    "recovery": ("A1", "A6", "A7", "A10"), "maintenance": ("A6", "A7", "A8", "A10"),
    "plan": ("A2", "A7", "A10"), "goals": ("A2", "A7", "A10"), "questions": ("A2", "A7", "A10"),
    "picker": ("A4", "A5", "A10"), "catalog": ("A4", "A5", "A10"), "commands": ("A2", "A7", "A10"),
    "retirement": ("A6", "A7"), "concurrency": ("A1", "A6", "A7", "A10"),
    "children": ("A2", "A10"), "inputs": ("A2", "A10"), "file-changes": ("A1", "A3", "A10"),
    "reading": ("A3", "A10"),
}
# Required external scenario evidence from accumulated drivers, not component or
# source-text assertions. Native/provider/live/human categories remain separate.
REQUIRED_SCENARIOS = {
    "deterministic": "A1-busy-native-admission A1-native-identities-tools A2-public-output-bound A7-actual-tool-failure A7-provider-failure A7-disconnected-running A7-exact-cancel-cleanup A7-detach-unrelated-owner A10-narrow-run-keyboard",
    "recovery": "A7-navigation-refresh-tab A7-automatic-authoritative-reconnect A1-incomplete-history A1-reset-recovering-checkpoint A7-pending-key-frontend-restart A7-uncertain-nonprompt-reconciliation A7-lost-ack-plugin-frontend-restart A7-uncertain-opening-reconciliation A7-durable-storage-fails-closed",
    "maintenance": "A7-restart-concurrent-refusal A7-stale-http-incarnation-fence A7-idle-restart A7-active-process-loss A7-duplicate-key-interrupted A7-explicit-continuation A7-native-shutdown-drain",
    "plan": "A2-native-plan-write-refusal A2-mode-is-not-plan-acceptance A10-plan-keyboard-focus-layout A2-stale-plan-validation A2-native-busy-plan-controls A2-mode-does-not-rewrite-running-plan A2-implement-current-context A2-implement-fresh-context A2-save-stop-history A2-historical-plan-lifecycle A7-uncertain-plan-action-reconnect",
    "goals": "A2-goal-unrelated-busy-refusal A2-goal-start A7-goal-stale A2-goal-busy-edit-pause A2-goal-blocked A7-goal-uncertain-action A2-goal-checklist-updates A2-goal-verified A10-goal-narrow-keyboard A7-goal-reopen A10-goal-bounded-display",
    "questions": "A2-exact-live-question-validation A2-A10-keyboard-accepted-restored A10-question-focus-recovery A7-answer-loss-before-delivery A7-answer-loss-after-delivery A2-stale-replacement-isolation A2-A7-stop-waiting-terminal-cleanup",
    "picker": "A10-picker-configuration-list-back A10-picker-search-provider-collisions A10-picker-identity-favorites A5-picker-reasoning-default-reset A10-picker-narrow-clipping-focus A4-picker-running-versus-next",
    "catalog": "A5-catalog-live-add-remove A4-catalog-active-next-boundary A5-catalog-refresh-failure-retry A5-catalog-lost-closed-refresh-reconciliation A5-catalog-saved-unavailable-reopen A5-catalog-explicit-retry-replacement",
    "commands": "A6-commands-diagnostics-auth A2-A10-effective-command-discovery A2-unsupported-no-model-fallback A2-transient-native-display A2-contributed-native-submitted A2-native-busy-admission A2-bounded-private-diagnostics A2-native-compression-history A10-narrow-command-context-focus A2-native-handled A7-uncertain-native-command-receipt",
    "retirement": "A6-retention-fixture-auth A7-retention-busy-exclusion A7-retention-exact-duration-view-reset A6-retirement-history-trust-reopen A7-retirement-error-rendering-http-fixture",
    "concurrency": "A1-A6-independent-tool-concurrency A6-A10-overlap-before-submission A10-overlap-narrow-keyboard A10-overlap-disconnected-cancel-focus A6-overlap-native-route-guard A10-overlap-delayed-continuation-focus A6-overlap-explicit-continuation A7-cancellation-isolation-settlement",
    "children": "A2-child-admission-not-terminal A2-child-bounded-retained-outcome A2-child-continuation-disconnect A10-child-narrow-keyboard A2-child-parent-completion-debt A2-child-saved-historical-inspection",
    "inputs": "A2-input-effective-skills A2-image-rejections A10-image-inspect-remove-focus A2-mention-occurrence-edit A10-input-layout-keyboard A10-mention-escape-running A2-rich-input-native-terminal A2-input-rejected-restore-fixture A2-input-response-loss-reconciliation",
    "file-changes": "A3-real-repeated-edits A3-no-profile-output A10-diff-reading-position A1-A3-historical-state A10-file-diff-keyboard-bounds A1-SYNTHETIC-not-persisted A3-SYNTHETIC-edge-profiles",
    "reading": "A3-A10-reading-native-desktop A3-A10-reading-native-narrow A3-A10-reading-SYNTHETIC-desktop A3-A10-reading-SYNTHETIC-narrow A1-reading-SYNTHETIC-not-persisted",
}
COMMON_SCENARIOS = "A6-auth-route A10-layout A6-folder-missing A6-folder-file A6-folder-denied A6-canonical A6-native-missing A6-native-denied A6-change-reopen A6-same-id-view-reopen A6-cross-process-lease A1-one-runtime A10-narrow-keyboard A6-known-id-auth A9-ordinary-observer-isolation A6-saved-policy"


def fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_manifest(root: Path, scopes: list[str]) -> dict:
    """Hash explicit source roots including uncommitted inputs; never agent profiles."""
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *scopes], cwd=root).split(b"\0")
    suffixes = {".py", ".rs", ".wit", ".toml", ".lock", ".ts", ".tsx", ".css", ".js", ".mjs", ".json", ".html", ".yaml", ".yml", ".svg", ".png", ".woff", ".woff2", ".ttf"}
    files = {}
    for raw in sorted(set(names)):
        if not raw:
            continue
        name = os.fsdecode(raw)
        path = root / name
        if path.is_file() and (path.suffix in suffixes or path.name in {"package.json", "package-lock.json"} or path.name.startswith("tsconfig")):
            files[name] = fingerprint(path)
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {"sha256": hashlib.sha256(encoded).hexdigest(), "files": files}


def current_sources(root: Path) -> dict:
    return {
        "studio": source_manifest(root, ["studio/backend", "studio/frontend", "studio/tools", "studio/src-tauri/src/app_menu.rs"]),
        "mimir": source_manifest(root.parent / "mimir", ["Cargo.toml", "Cargo.lock", ".cargo", "crates", "plugins/studio-frontend", "tools/quality"]),
    }


def assess_report(report: dict, expected: dict, *, workload: str) -> list[str]:
    errors = []
    if report.get("status") != "passed":
        errors.append("Driver did not reach a passed terminal outcome")
    scenarios = report.get("scenarios", [])
    ids = {row["id"] for row in scenarios if row.get("status") == "passed"}
    required = set(REQUIRED_SCENARIOS[workload].split()) | set(COMMON_SCENARIOS.split())
    if required - ids:
        errors.append("Required scenarios absent: " + " ".join(sorted(required - ids)))
    if any(row.get("status") != "passed" for row in scenarios):
        errors.append("Non-passing scenario evidence")
    if report.get("provider_workload") != workload:
        errors.append("Driver workload identity mismatch")
    for key, value in expected.items():
        if report.get(key) != value:
            errors.append(f"Current source/artifact mismatch: {key}")
    cleanup = report.get("cleanup", {})
    for key in ("native_process_settled", "server_port_closed"):
        if cleanup.get(key) is not True:
            errors.append(f"Terminal cleanup unconfirmed: {key}")
    if cleanup.get("provider_thread_settled") is not True:
        errors.append("Provider fixture thread settlement unconfirmed")
    return errors


def command_identity(workload: str, command: list[str]) -> bool:
    if len(command) < 2 or Path(command[1]).name != "coding_browser_acceptance.py":
        return False
    return ("--workload" in command and command[command.index("--workload") + 1] == workload
            and (workload != "commands" or "--commands-package" in command))


def reconcile(evidence: Path, expected: dict, sources: dict, guest_hashes: dict, build: dict) -> dict:
    records = []
    build_errors = []
    if build.get("status") != "passed" or build.get("sources") != sources or build.get("artifacts") != {**expected, **guest_hashes}:
        build_errors.append("Current-source build provenance missing/stale/failed")
    for workload, rows in WORKLOAD_ROWS.items():
        directory = evidence / workload
        result_path, report_path = directory / "command.json", directory / "report.json"
        record = {"workload": workload, "rows": rows, "category": "deterministic/fault", "status": "blocked", "report": str(report_path), "errors": []}
        if not result_path.is_file():
            record["errors"] = ["Required workload not executed"]
        else:
            try:
                command = json.loads(result_path.read_text())
                record["command_result"] = command
                if command.get("returncode") != 0 or command.get("timed_out"):
                    record["errors"].append("Driver command did not exit successfully before its deadline")
                if command.get("sources") != sources:
                    record["errors"].append("Current uncommitted source manifest mismatch")
                if not command_identity(workload, command.get("command", [])):
                    record["errors"].append("Required driver/workload/options mismatch")
                if not report_path.is_file():
                    record["errors"].append("No retained terminal driver report")
                else:
                    report = json.loads(report_path.read_text())
                    artifacts = dict(expected)
                    if workload == "retirement":
                        artifacts["plugin_sha256"] = guest_hashes.get("retirement_sha256")
                    if workload == "commands":
                        artifacts["commands_fixture_sha256"] = guest_hashes.get("commands_sha256")
                    record["errors"].extend(assess_report(report, artifacts, workload=workload))
                    record["scenarios"] = report.get("scenarios", [])
                    record["limitations"] = report.get("limitations", [])
            except (ValueError, AttributeError, TypeError, KeyError, IndexError):
                record["errors"].append("Malformed/incomplete command or terminal report")
            record["status"] = "failed" if record["errors"] else "passed"
        records.append(record)
    return {"issue": 254, "source_and_artifacts": expected, "sources": sources, "guest_hashes": guest_hashes,
            "build_errors": build_errors,
            "route_status": "passed" if not build_errors and all(row["status"] == "passed" for row in records) else "blocked",
            "workloads": records, "parent_acceptance": "not established by fixture automation",
            "other_required_evidence": ["static/build and packaged SDK/native suites", "backend/frontend deterministic/fault suites", "ordinary-chat/auth/model-lifecycle regressions"],
            "pending_gates": [
                {"category": "live", "ticket": 255, "status": "pending", "requirement": "Completed external-provider and Studio-local coding-route workloads, ordinary-chat smoke and full rendered acceptance"},
                {"category": "pending-human", "ticket": 256, "status": "pending", "requirement": "User review of implemented UI and resolved corrections"}]}


def write_record(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def run_driver(command: list[str], root: Path, output, timeout: float, grace: float = 75) -> dict:
    """Preserve exact process identities; interrupt Python finally before recovery."""
    import psutil
    try:
        child = subprocess.Popen(command, cwd=root, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    except OSError as exc:
        return {"returncode": None, "timed_out": False, "launch_error": type(exc).__name__}
    result = {"driver": {"pid": child.pid}, "timed_out": False, "owned_descendants": [],
              "forced_cleanup": False, "ownership_capture_errors": []}
    def identity(process):
        return {"pid": process.pid, "created": process.create_time(), "uid": process.uids().real,
                "exe": process.exe(), "argv": process.cmdline()}
    owner = None
    try:
        owner = psutil.Process(child.pid)
        result["driver"] = identity(owner)
    except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied) as exc:
        result["ownership_capture_errors"].append("initial: " + type(exc).__name__)
    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        result["timed_out"] = True
        # Capture only actual descendants of this verified task-created helper.
        owned = []
        try:
            descendants = owner.children(recursive=True) if owner is not None else []
        except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied) as exc:
            descendants = []
            result["ownership_capture_errors"].append("descendants: " + type(exc).__name__)
        for process in descendants:
            try:
                owned.append(identity(process))
            except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied) as exc:
                result["ownership_capture_errors"].append(f"descendant {process.pid}: " + type(exc).__name__)
        result["owned_descendants"] = owned
        child.send_signal(signal.SIGINT)  # Normal Python finally writes terminal evidence.
        try:
            child.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            result["forced_cleanup"] = True
            child.kill()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                result["driver_cleanup_error"] = "Helper did not exit after forced termination"
        # After grace, repair only surviving exact identities. Absence is not a
        # clean native drain, and any timeout remains a failed acceptance result.
        for item in reversed(owned):
            try:
                process = psutil.Process(item["pid"])
                if identity(process) == item and item["uid"] == os.getuid():
                    result["forced_cleanup"] = True
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except psutil.TimeoutExpired:
                        if identity(process) == item:
                            process.kill()
                            process.wait(timeout=10)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                pass
            except (psutil.TimeoutExpired, psutil.AccessDenied) as exc:
                item["cleanup_error"] = type(exc).__name__
        result["unsettled"] = []
        for item in owned:
            try:
                process = psutil.Process(item["pid"])
                if process.create_time() == item["created"] and process.status() != psutil.STATUS_ZOMBIE:
                    result["unsettled"].append(item)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                pass
            except psutil.AccessDenied:
                result["unsettled"].append({**item, "cleanup_error": "AccessDenied"})
    result["returncode"] = child.returncode
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mimir", type=Path, required=True)
    parser.add_argument("--plugin-package", type=Path, required=True)
    parser.add_argument("--retirement-package", type=Path)
    parser.add_argument("--commands-package", type=Path)
    parser.add_argument("--compilation-cache", type=Path)
    parser.add_argument("--build-record", type=Path, required=True, help="Observed passed build commands with current_sources() and artifact fingerprints")
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--workload", choices=WORKLOAD_ROWS, action="append")
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="firefox")
    parser.add_argument("--timeout-seconds", type=int, default=500)
    parser.add_argument("--reconcile-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = args.evidence_dir.resolve()
    if evidence.is_relative_to(root) or args.timeout_seconds <= 0:
        parser.error("Use an external evidence directory and positive timeout")
    revisions = {name: subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()
                 for name, path in (("studio", root), ("mimir", root.parent / "mimir"))}
    expected = {"source_revisions": revisions, "native_sha256": fingerprint(args.mimir.resolve()),
                "plugin_sha256": fingerprint(args.plugin_package.resolve() / "plugin.wasm"),
                "frontend_index_sha256": fingerprint(root / "studio/frontend/dist/index.html")}
    guests = {"retirement_sha256": fingerprint(args.retirement_package.resolve() / "plugin.wasm") if args.retirement_package else None,
              "commands_sha256": fingerprint(args.commands_package.resolve() / "plugin.wasm") if args.commands_package else None}
    sources = current_sources(root)
    build = json.loads(args.build_record.read_text())
    if build.get("status") != "passed" or build.get("sources") != sources or build.get("artifacts") != {**expected, **guests}:
        parser.error("Current-source build provenance is missing/stale/failed; rebuild/revalidate first")
    evidence.mkdir(parents=True, exist_ok=True)
    if args.reconcile_only:
        import fcntl
        with (evidence / "reconciliation.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            record = reconcile(evidence, expected, sources, guests, build)
            write_record(evidence / "integration-report.json", record)
        raise SystemExit(0 if record["route_status"] == "passed" else 1)
    batch = []
    for workload in dict.fromkeys(args.workload or WORKLOAD_ROWS):
        directory = evidence / workload
        if directory.exists():
            parser.error(f"Refusing to overwrite retained evidence: {directory}")
        directory.mkdir()
        if workload == "commands" and not args.commands_package or workload == "retirement" and not args.retirement_package:
            batch.append({"workload": workload, "status": "blocked"})
            continue
        package = args.retirement_package if workload == "retirement" else args.plugin_package
        command = [sys.executable, str(root / "studio/tools/coding_browser_acceptance.py"), "--mimir", str(args.mimir.resolve()),
                   "--plugin-package", str(package.resolve()), "--browser", args.browser, "--evidence-dir", str(directory),
                   "--workload", workload]
        if args.compilation_cache:
            command.extend(["--compilation-cache", str(args.compilation_cache.resolve())])
        if workload == "commands":
            command.extend(["--commands-package", str(args.commands_package.resolve())])
        started = time.monotonic()
        with (directory / "driver.log").open("w") as output:
            result = run_driver(command, root, output, args.timeout_seconds)
        result.update(command=command, sources=sources, duration_seconds=round(time.monotonic() - started, 3))
        write_record(directory / "command.json", result)
        current = reconcile(evidence, expected, current_sources(root), guests, build)
        outcome = next(row for row in current["workloads"] if row["workload"] == workload)
        batch.append(outcome)
        print(f"{workload}: {outcome['status']} (helper exit {result['returncode']})", flush=True)
        if result["timed_out"]:
            break
    # Parallel workers cannot overwrite a newer global snapshot. Only explicit
    # serialized final reconciliation publishes integration-report.json.
    write_record(evidence / ("batch-" + uuid.uuid4().hex + ".json"), {"workloads": batch})
    raise SystemExit(0 if all(row["status"] == "passed" for row in batch) else 1)


if __name__ == "__main__":
    main()
