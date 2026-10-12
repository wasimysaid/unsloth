"""Real detached Python fixtures only: no Mimir, models, builds, or remote writes."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scripts.mimir_ticket_runner.common import RunnerError, atomic_json, read_json
from scripts.mimir_ticket_runner import supervisor

FIXTURE = r'''
import json, os, signal, subprocess, sys, time
from pathlib import Path
job, mode, duration = Path(sys.argv[1]), sys.argv[2], float(sys.argv[3])

start = {"schema": "mimir.run.v2", "event": "run_start", "session_id": "fixture-session"}
terminal = {"schema": "mimir.run.v2", "event": "run_finished", "session_id": "fixture-session",
            "sessionId": "fixture-session", "request_id": "fixture-request", "outcome": "completed",
            "output_text": "APPROVED: fixture-only read-only review", "cleanup_error": None,
            "execution": {"terminal_cause": "completed"}, "error": None}

def emit(record):
    print(json.dumps(record), flush=True)

def interrupted(number, frame):
    terminal["outcome"] = "cancelled"
    terminal["execution"]["terminal_cause"] = "cancelled"
    emit(terminal)
    (job / "sigint-observed").write_text("SIGINT")
    raise SystemExit(0)

signal.signal(signal.SIGINT, signal.SIG_IGN if mode == "stubborn" else interrupted)
prompt = sys.stdin.buffer.read()
with (job / "fixture-launches").open("a") as stream:
    stream.write("launched\n")
(job / "fixture-info.json").write_text(json.dumps({
    "prompt_bytes": len(prompt), "prompt_sha256": __import__("hashlib").sha256(prompt).hexdigest(),
    "github_token_present": any(key in os.environ for key in ("GH_TOKEN", "GITHUB_TOKEN")),
    "gh_config_dir": os.environ.get("GH_CONFIG_DIR"), "cuda": os.environ.get("CUDA_VISIBLE_DEVICES"),
    "native_credential_preserved": "MIMIR_FIXTURE_CREDENTIAL" in os.environ,
    "cwd": os.getcwd(), "tmpdir": os.environ.get("TMPDIR"),
}))
if mode == "start_mismatch":
    start["session_id"] = "other-session"
if mode != "command":
    emit(start)
(job / "fixture-ready").write_text("ready")
if mode == "descendant":
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.5)"], start_new_session=True)
time.sleep(duration)
if mode == "command":
    print("plain command output, not JSON", flush=True)
    print("plain command stderr", file=sys.stderr, flush=True)
    raise SystemExit(0)
if mode == "missing":
    raise SystemExit(0)
if mode == "malformed":
    print("not JSON", flush=True)
    raise SystemExit(0)
if mode == "invalid_event":
    print("[1,2]", flush=True)
if mode == "interaction":
    terminal["outcome"] = "interaction-required"
if mode == "cleanup":
    terminal["cleanup_error"] = "fixture cleanup failure"
if mode in {"error", "cancelled"}:
    terminal["outcome"] = mode
if mode == "native_error":
    terminal["error"] = "fixture native failure"
if mode == "cause":
    terminal["execution"]["terminal_cause"] = "deadline"
if mode == "schema":
    terminal["schema"] = "mimir.run.v1"
if mode == "request_missing":
    del terminal["request_id"]
if mode == "alias_mismatch":
    terminal["sessionId"] = "different-session"
if mode == "request_alias_mismatch":
    terminal["requestId"] = "different-request"
if mode == "camel":
    for record in (start, terminal):
        record["sessionId"] = record.pop("session_id")
    terminal["requestId"] = terminal.pop("request_id")
if mode == "truncated":
    sys.stdout.write(json.dumps(terminal))
    sys.stdout.flush()
else:
    emit(terminal)
if mode == "conflict":
    other = dict(terminal, outcome="error")
    emit(other)
if mode == "trailing":
    emit({"event": "after-terminal"})
raise SystemExit(3 if mode == "nonzero" else 0)
'''


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        # All runtime artifacts are scoped to the bootstrap project and removed
        # only after our own fixture identities have actually settled.
        self.temporary = tempfile.TemporaryDirectory(prefix=".supervisor-test-", dir=ROOT)
        self.root = Path(self.temporary.name)
        self.cwd = self.root / "workspace"
        self.cwd.mkdir()
        self.fixture = self.root / "fixture.py"
        self.fixture.write_text(FIXTURE)
        self.jobs = []

    def tearDown(self):
        deadline = time.monotonic() + 20
        for job in self.jobs:
            while time.monotonic() < deadline:
                observed = supervisor.inspect(job)
                identity = observed.get("identity") or {}
                if identity.get("supervisor_state") != "running" and identity.get("child_state") != "running":
                    break
                time.sleep(0.05)
            else:
                self.fail(f"Fixture did not settle; artifacts retained at {self.root}")
        self.temporary.cleanup()

    def job(self, prompt="fixture prompt\n"):
        path = self.root / f"job-{len(self.jobs)}"
        path.mkdir()
        (path / "prompt.txt").write_text(prompt)
        self.jobs.append(path)
        return path

    def argv(self, job, mode="valid", duration=0.1):
        return [sys.executable, str(self.fixture), str(job), mode, str(duration)]

    def wait(self, job, predicate, seconds=8):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            observed = supervisor.inspect(job)
            if predicate(observed):
                return observed
            time.sleep(0.03)
        log = (job / "supervisor.log").read_text() if (job / "supervisor.log").exists() else ""
        self.fail(f"Fixture observation timed out: {observed}\n{log}")

    def settle(self, job, seconds=8):
        # Wait for the receipt in the locked observation, not an exists() check
        # that can race a receipt write after inspect() has already returned.
        return self.wait(job, lambda value: value["exit_code"] is not None, seconds)

    def run_fixture(self, mode="valid", *, timeout=5, duration=0.1, protocol="native", env=None):
        job = self.job()
        supervisor.launch(job, self.argv(job, mode, duration), self.cwd,
                          timeout=timeout, protocol=protocol, env_overrides=env)
        return job, self.settle(job, seconds=max(8, duration + 3))

    def test_unlimited_job_completes_without_timeout(self):
        job, observed = self.run_fixture(timeout=None, duration=1.2)
        self.assertEqual(observed['status'], 'completed')
        self.assertIsNone(read_json(job / 'job.json')['timeout'])
        self.assertFalse(read_json(job / 'exit.json')['timed_out'])

    def test_unlimited_job_can_still_be_stopped_manually(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, duration=5), self.cwd, timeout=None)
        self.wait(job, lambda _: (job / 'fixture-ready').exists())
        supervisor.stop(job)
        observed = self.settle(job)
        self.assertEqual(observed['status'], 'needs-human')
        self.assertTrue((job / 'sigint-observed').exists())
        self.assertFalse(read_json(job / 'exit.json')['timed_out'])

    def test_complete_native_result_has_local_review_text_and_persisted_exit(self):
        job, observed = self.run_fixture()
        self.assertEqual(observed["status"], "completed")
        self.assertEqual(observed["exit_code"], 0)
        self.assertEqual(observed["terminal"]["output_text"], "APPROVED: fixture-only read-only review")
        self.assertEqual(observed["terminal"]["request_id"], "fixture-request")
        self.assertEqual(observed["protocol"], "native")
        result = supervisor.parse_result(job)
        self.assertEqual(set(result), {"status", "terminal", "exit_code", "reason"})
        self.assertEqual(result["terminal"], observed["terminal"])
        receipt = read_json(job / "exit.json")
        self.assertTrue(receipt["settled"])
        self.assertEqual(receipt["nonce"], observed["identity"]["nonce"])
        self.assertEqual(receipt["stdout_sha256"], hashlib.sha256((job / "stdout.jsonl").read_bytes()).hexdigest())
        self.assertEqual(receipt["stderr_sha256"], hashlib.sha256((job / "stderr.log").read_bytes()).hexdigest())
        self.assertEqual(receipt["child"], observed["identity"]["child"])

    def test_startup_capture_does_not_persist_partial_proc_identity(self):
        transient = {"pid": 123, "nonce": None, "cmdline": []}
        stable = {"pid": 123, "nonce": "fixture-nonce", "cmdline": ["fixture"]}
        with patch.object(supervisor, "_process", side_effect=[transient, stable, stable]):
            self.assertEqual(supervisor._capture(123, "fixture-nonce"), stable)
        with patch.object(supervisor, "_process", side_effect=[stable, None]):
            self.assertEqual(supervisor._capture(123, "fixture-nonce"), stable)
        with patch.object(supervisor, "_process", side_effect=[None, stable, stable]), \
                patch.object(supervisor.Path, "read_text", return_value="123 (fixture) R"):
            self.assertEqual(supervisor._capture(123, "fixture-nonce"), stable)
        with patch.object(supervisor, "_process", side_effect=[PermissionError("transient exec visibility"), stable, stable]):
            self.assertEqual(supervisor._capture(123, "fixture-nonce"), stable)

    def test_owned_unreaped_zombie_binds_fast_exit_without_signal_identity(self):
        job = {"nonce": "fixture-fast-exit", "argv": ["/bin/true"], "cwd": str(self.cwd)}
        child = subprocess.Popen(job["argv"], cwd=self.cwd, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 env=supervisor._environment(self.root, job["nonce"], {}))
        try:
            time.sleep(0.05)  # Intentionally do not poll/wait: preserve our zombie.
            with patch.object(supervisor, "_capture", return_value=None):
                identity = supervisor._child_identity(child, job)
            self.assertTrue(identity["exited_before_capture"])
            self.assertEqual(identity["pid"], child.pid)
            self.assertEqual(identity["uid"], os.getuid())
            self.assertEqual(identity["cmdline"], job["argv"])
            self.assertEqual(identity["cwd"], job["cwd"])
            self.assertEqual(supervisor._probe(identity, job["nonce"]), "gone")
            with patch.object(supervisor.signal, "pidfd_send_signal") as send:
                self.assertFalse(supervisor._interrupt(identity, job["nonce"]))
                send.assert_not_called()
            self.assertEqual(child.wait(timeout=2), 0)
        finally:
            child.wait(timeout=2)

    def test_forged_exit_only_identity_cannot_settle_or_signal_live_work(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, duration=3), self.cwd, timeout=5)
        observed = self.wait(job, lambda value: (job / "fixture-ready").exists())
        identity = {**observed["identity"]["child"], "exited_before_capture": True}
        nonce = observed["identity"]["nonce"]
        self.assertEqual(supervisor._probe(identity, nonce), "unknown")
        with patch.object(supervisor.signal, "pidfd_send_signal") as send:
            self.assertFalse(supervisor._interrupt(identity, nonce))
            send.assert_not_called()
        supervisor.stop(job)
        self.settle(job)

    def test_fast_command_exit_is_receipted_without_losing_process_identity(self):
        for _ in range(5):
            job = self.job()
            supervisor.launch(job, ["/bin/true"], self.cwd, timeout=5, protocol="command")
            observed = self.settle(job)
            self.assertEqual(observed["status"], "completed", {"observed": observed, "job": read_json(job / "job.json"), "exit": read_json(job / "exit.json")})

    def test_camelcase_native_ids_are_accepted_when_consistent(self):
        _, observed = self.run_fixture("camel")
        self.assertEqual(observed["status"], "completed")
        self.assertEqual(observed["terminal"]["sessionId"], "fixture-session")
        self.assertEqual(observed["terminal"]["requestId"], "fixture-request")

    def test_exit_zero_cannot_replace_native_terminal(self):
        _, observed = self.run_fixture("missing")
        self.assertEqual(observed["exit_code"], 0)
        self.assertEqual(observed["status"], "failed")
        self.assertIsNone(observed["terminal"])

    def test_interaction_required_is_not_complete_even_exit_zero(self):
        _, observed = self.run_fixture("interaction")
        self.assertEqual(observed["exit_code"], 0)
        self.assertEqual(observed["status"], "needs-human")
        self.assertEqual(observed["terminal"]["outcome"], "interaction-required")

    def test_malformed_truncated_conflicting_or_unidentified_results_fail_closed(self):
        for mode in ("malformed", "truncated", "invalid_event", "schema", "request_missing",
                     "alias_mismatch", "request_alias_mismatch", "start_mismatch", "conflict", "trailing"):
            with self.subTest(mode=mode):
                _, observed = self.run_fixture(mode)
                self.assertEqual(observed["status"], "failed")

    def test_native_error_cancel_cleanup_or_nonzero_never_pass(self):
        for mode in ("error", "cancelled", "cleanup", "native_error", "cause", "nonzero"):
            with self.subTest(mode=mode):
                _, observed = self.run_fixture(mode)
                self.assertEqual(observed["status"], "failed")
                self.assertIsNotNone(observed["terminal"])

    def test_large_prompt_stdin_eof_no_scheduler_pipe_and_safe_environment(self):
        job = self.job("large fixture input\n" * 100000)
        with patch.dict(os.environ, {"GH_TOKEN": "fixture-github-secret", "GITHUB_TOKEN": "fixture-github-secret-2",
                                     "CUDA_VISIBLE_DEVICES": "0,1,2,3", "MIMIR_FIXTURE_CREDENTIAL": "fixture-native-only"}):
            supervisor.launch(job, self.argv(job), self.cwd, timeout=5,
                              env_overrides={"TMPDIR": str(self.root)})
        observed = self.settle(job)
        self.assertEqual(observed["status"], "completed")
        info = read_json(job / "fixture-info.json")
        self.assertEqual(info["prompt_bytes"], (job / "prompt.txt").stat().st_size)
        self.assertEqual(info["prompt_sha256"], hashlib.sha256((job / "prompt.txt").read_bytes()).hexdigest())
        self.assertFalse(info["github_token_present"])
        self.assertEqual(info["cuda"], "")
        self.assertTrue(info["native_credential_preserved"])
        self.assertEqual(info["gh_config_dir"], str(job / "github-empty"))
        self.assertEqual(list((job / "github-empty").iterdir()), [])
        self.assertEqual(info["cwd"], str(self.cwd))
        self.assertEqual(info["tmpdir"], str(self.root))
        metadata = (job / "job.json").read_text()
        self.assertNotIn("fixture-github-secret", metadata)
        self.assertNotIn("fixture-native-only", metadata)
        self.assertNotIn("MIMIR_FIXTURE_CREDENTIAL", metadata)

    def test_only_explicit_gpu_override_grants_visibility(self):
        job, observed = self.run_fixture(env={"CUDA_VISIBLE_DEVICES": "2"})
        self.assertEqual(observed["status"], "completed")
        self.assertEqual(read_json(job / "fixture-info.json")["cuda"], "2")

    def test_untrusted_or_secret_overrides_rejected_before_launch_intent(self):
        for overrides in ({"GH_TOKEN": "fixture"}, {"GITHUB_TOKEN": "fixture"}, {"HOME": "other"},
                          {"GH_CONFIG_DIR": "other"}, {"ARBITRARY_SECRET": "fixture"}):
            with self.subTest(overrides=overrides):
                job = self.job()
                with self.assertRaises(RunnerError):
                    supervisor.launch(job, self.argv(job), self.cwd, timeout=5, env_overrides=overrides)
                self.assertFalse((job / "job.json").exists())

    def test_launch_is_concurrently_idempotent_and_restart_inspection_does_not_spawn(self):
        job = self.job()
        argv = self.argv(job, duration=0.5)
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: supervisor.launch(job, argv, self.cwd, timeout=5), range(4)))
        self.assertEqual(len({result["identity"]["nonce"] for result in results}), 1)
        active = self.wait(job, lambda value: value["identity"]["child_state"] == "running")
        self.assertEqual(os.getsid(active["identity"]["supervisor"]["pid"]), active["identity"]["supervisor"]["pid"])
        restart = subprocess.run([sys.executable, "-c",
                                  "import json,sys; from scripts.mimir_ticket_runner.supervisor import inspect; "
                                  "print(json.dumps(inspect(sys.argv[1])))", str(job)],
                                 cwd=ROOT, capture_output=True, text=True, check=True, timeout=5)
        self.assertEqual(json.loads(restart.stdout)["identity"]["nonce"], active["identity"]["nonce"])
        settled = self.settle(job)
        before = (job / "job.json").read_bytes()
        self.assertEqual(supervisor.launch(job, ["intentionally-not-an-executable"], self.cwd, timeout=1)["status"], "completed")
        self.assertEqual(before, (job / "job.json").read_bytes())
        self.assertEqual((job / "fixture-launches").read_text(), "launched\n")
        self.assertEqual(settled["status"], "completed")

    def test_detached_helper_writes_exit_after_original_orchestrator_exits(self):
        job = self.job()
        code = ("import json,sys; from pathlib import Path; "
                "from scripts.mimir_ticket_runner.supervisor import launch; "
                "print(json.dumps(launch(Path(sys.argv[1]),json.loads(sys.argv[2]),Path(sys.argv[3]),timeout=5)))")
        scheduler = subprocess.run([sys.executable, "-c", code, str(job),
                                    json.dumps(self.argv(job, duration=0.6)), str(self.cwd)],
                                   cwd=ROOT, capture_output=True, text=True, check=True, timeout=5)
        self.assertIn(json.loads(scheduler.stdout)["status"], {"running", "completed"})
        observed = self.settle(job)
        self.assertEqual(observed["status"], "completed")
        self.assertTrue((job / "exit.json").exists())

    def test_helper_replay_cannot_reset_an_existing_attempt(self):
        job, _ = self.run_fixture()
        original = read_json(job / "job.json")
        before = (job / "exit.json").read_bytes()
        replay = subprocess.run([sys.executable, "-m", "scripts.mimir_ticket_runner.supervisor", str(job)],
                                cwd=ROOT, env={**os.environ, supervisor.NONCE_ENV: original["nonce"]},
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(replay.returncode, 0)
        self.assertEqual((job / "fixture-launches").read_text(), "launched\n")
        self.assertEqual((job / "exit.json").read_bytes(), before)

    def test_manual_stop_sends_verified_sigint_and_never_false_completion(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, duration=5), self.cwd, timeout=8)
        self.wait(job, lambda value: (job / "fixture-ready").exists())
        stopped = supervisor.stop(job)
        self.assertIn(stopped["status"], {"needs-human", "unknown"})
        observed = self.settle(job)
        self.assertEqual(observed["status"], "needs-human")
        self.assertTrue((job / "sigint-observed").exists())
        self.assertTrue(read_json(job / "exit.json")["stop_requested"])
        self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5)["status"], "needs-human")
        self.assertEqual((job / "fixture-launches").read_text(), "launched\n")

    def test_timeout_sends_sigint_and_preserves_interrupted_receipt(self):
        job, observed = self.run_fixture(timeout=1, duration=5)
        self.assertEqual(observed["status"], "needs-human")
        self.assertTrue((job / "sigint-observed").exists())
        self.assertTrue(read_json(job / "exit.json")["timed_out"])

    def test_grace_expiry_keeps_ignoring_fixture_observable_without_killing(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, "stubborn", 13), self.cwd, timeout=1)
        observed = self.wait(job, lambda value: read_json(job / "job.json", {}).get("needs_human"), seconds=12.5)
        self.assertEqual(observed["status"], "needs-human")
        self.assertEqual(observed["identity"]["child_state"], "running")
        self.assertFalse((job / "exit.json").exists())
        self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5)["status"], "needs-human")
        self.assertEqual(self.settle(job, seconds=5)["status"], "needs-human")
        self.assertEqual((job / "fixture-launches").read_text(), "launched\n")

    def test_pid_identity_mismatch_never_signals_or_relaunches(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, duration=3), self.cwd, timeout=5)
        self.wait(job, lambda value: (job / "fixture-ready").exists())
        with supervisor._lock(job):
            original = read_json(job / "job.json")
            changed = deepcopy(original)
            changed["child"]["start_time"] += 1
            atomic_json(job / "job.json", changed)
        with patch.object(supervisor.signal, "pidfd_send_signal") as send, patch.object(supervisor.subprocess, "Popen") as spawn:
            self.assertEqual(supervisor.inspect(job)["status"], "unknown")
            self.assertEqual(supervisor.stop(job)["status"], "unknown")
            self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5)["status"], "unknown")
            send.assert_not_called()
            spawn.assert_not_called()
        with supervisor._lock(job):
            atomic_json(job / "job.json", original)
        supervisor.stop(job)
        self.settle(job)

    def test_native_terminal_before_process_exit_is_still_running(self):
        job = self.job()
        script = "import json,sys,time; print(json.dumps({'event':'run_finished'}),flush=True); time.sleep(0.8)"
        supervisor.launch(job, [sys.executable, "-c", script], self.cwd, timeout=5)
        observed = self.wait(job, lambda value: (job / "stdout.jsonl").exists() and (job / "stdout.jsonl").stat().st_size > 0)
        self.assertEqual(observed["status"], "running")
        self.assertEqual(self.settle(job)["status"], "failed")

    def test_exit_receipt_cannot_claim_a_still_running_process_settled(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, duration=3), self.cwd, timeout=5)
        observed = self.wait(job, lambda value: (job / "fixture-ready").exists())
        metadata = read_json(job / "job.json")
        atomic_json(job / "exit.json", {"nonce": metadata["nonce"], "protocol": "native",
                                       "child": metadata["child"], "exit_code": 0, "settled": True})
        self.assertEqual(supervisor.inspect(job)["status"], "unknown")
        self.assertEqual(supervisor.inspect(job)["identity"]["child"], observed["identity"]["child"])
        (job / "exit.json").unlink()  # Only our deliberately forged fixture receipt.
        supervisor.stop(job)
        self.assertEqual(self.settle(job)["status"], "needs-human")

    def test_descendant_settlement_is_required_after_main_native_exit(self):
        job = self.job()
        supervisor.launch(job, self.argv(job, "descendant"), self.cwd, timeout=5)
        observed = self.wait(job, lambda value: bool(value["identity"]["unsettled"]))
        self.assertEqual(observed["identity"]["child_state"], "gone")
        self.assertEqual(observed["status"], "running")
        self.assertFalse((job / "exit.json").exists())
        self.assertEqual(self.settle(job)["status"], "completed")

    def test_ambiguous_launch_intent_and_orphan_artifacts_are_never_reset(self):
        job = self.job()
        atomic_json(job / "job.json", {"version": 1, "nonce": "uncertain-spawn", "protocol": "native",
                                       "supervisor": None, "child": None, "child_spawn_intent": True})
        before = (job / "job.json").read_bytes()
        with patch.object(supervisor.subprocess, "Popen") as spawn:
            self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5)["status"], "unknown")
            self.assertEqual(supervisor.inspect(job)["status"], "unknown")
            spawn.assert_not_called()
        self.assertEqual(before, (job / "job.json").read_bytes())
        orphan = self.job()
        (orphan / "stdout.jsonl").write_text("existing fixture artifact")
        self.assertEqual(supervisor.launch(orphan, self.argv(orphan), self.cwd, timeout=5)["status"], "unknown")
        self.assertFalse((orphan / "job.json").exists())
        self.assertEqual((orphan / "stdout.jsonl").read_text(), "existing fixture artifact")

    def test_corrupt_metadata_and_changed_logs_fail_closed_without_reset(self):
        job, _ = self.run_fixture()
        before = (job / "stdout.jsonl").read_bytes()
        (job / "stderr.log").write_text("changed after settlement")
        self.assertEqual(supervisor.inspect(job)["status"], "failed")
        (job / "job.json").write_text("{truncated")
        self.assertEqual(supervisor.inspect(job)["status"], "unknown")
        self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5)["status"], "unknown")
        self.assertEqual((job / "job.json").read_text(), "{truncated")
        self.assertEqual(before, (job / "stdout.jsonl").read_bytes())

    def test_explicit_command_protocol_accepts_plain_logs_only_after_settlement(self):
        job, observed = self.run_fixture("command", protocol="command")
        self.assertEqual(observed["status"], "completed")
        self.assertEqual(observed["protocol"], "command")
        self.assertIsNone(observed["terminal"])
        self.assertIn("plain command output", (job / "stdout.jsonl").read_text())
        self.assertIn("plain command stderr", (job / "stderr.log").read_text())
        self.assertEqual(read_json(job / "exit.json")["protocol"], "command")
        _, native = self.run_fixture("command")
        self.assertEqual(native["status"], "failed")

    def test_parent_verification_environment_and_absent_command_prompt(self):
        job = self.job()
        (job / "prompt.txt").unlink()
        with self.assertRaises(RunnerError):
            supervisor.launch(job, self.argv(job), self.cwd, timeout=5)
        env = {"CARGO_TARGET_DIR": str(self.root / "cargo"), "CARGO_BUILD_JOBS": "4",
               "npm_config_cache": str(self.root / "npm"), "PIP_CACHE_DIR": str(self.root / "pip"),
               "UV_CACHE_DIR": str(self.root / "uv"), "HF_HOME": str(self.root / "hf"),
               "TMPDIR": str(self.root), "CUDA_VISIBLE_DEVICES": ""}
        supervisor.launch(job, self.argv(job, "command"), self.cwd, timeout=5,
                          protocol="command", env_overrides=env)
        self.assertEqual(self.settle(job)["status"], "completed")
        self.assertEqual(read_json(job / "fixture-info.json")["prompt_bytes"], 0)
        self.assertFalse((job / "prompt.txt").exists())
        self.assertEqual(read_json(job / "job.json")["env_overrides"], env)

    def test_executable_paths_and_relative_path_entries_resolve_in_job_cwd(self):
        binary = self.cwd / "bin" / "fixture-python"
        binary.parent.mkdir()
        binary.symlink_to(sys.executable)
        for name in ("./bin/fixture-python", "fixture-python"):
            with self.subTest(name=name):
                job = self.job()
                argv = self.argv(job, "command")
                argv[0] = name
                env = {"PATH": "bin" + os.pathsep + os.environ.get("PATH", "")}
                supervisor.launch(job, argv, self.cwd, timeout=5, protocol="command", env_overrides=env)
                self.assertEqual(self.settle(job)["status"], "completed")
                self.assertEqual(read_json(job / "job.json")["argv"][0], str(binary))

    def test_command_nonzero_and_timeout_fail_closed(self):
        job = self.job()
        supervisor.launch(job, [sys.executable, "-c", "import time;time.sleep(.1);raise SystemExit(7)"],
                          self.cwd, timeout=5, protocol="command")
        self.assertEqual(self.settle(job)["status"], "failed")
        timed, result = self.run_fixture("command", protocol="command", duration=5, timeout=1)
        self.assertEqual(result["status"], "needs-human")
        self.assertTrue((timed / "sigint-observed").exists())

    def test_protocol_cannot_be_changed_to_bypass_native_validation(self):
        job, observed = self.run_fixture("missing")
        self.assertEqual(observed["status"], "failed")
        self.assertEqual(supervisor.launch(job, self.argv(job), self.cwd, timeout=5, protocol="command")["status"], "failed")
        metadata = read_json(job / "job.json")
        metadata["protocol"] = "command"
        atomic_json(job / "job.json", metadata)
        self.assertEqual(supervisor.inspect(job)["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
