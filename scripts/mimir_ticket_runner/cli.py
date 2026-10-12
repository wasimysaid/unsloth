"""All remote-writing entry points require an explicit --apply."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys

from .common import RunnerError, command, git
from .config import Config, DEFAULT_CONFIG
from .github import GitHub
from .graph import plan


def doctor(config):
    reports = []
    for name, repo in config.repositories.items():
        info = GitHub(repo["github"]).request(f'repos/{repo["github"]}')
        if not info.get("permissions", {}).get("push"):
            raise RunnerError(f'No push permission for {repo["github"]}')
        if name == "mimir" and not info.get("private"):
            raise RunnerError("Mimir must remain private")
        if repo["branch"] == info["default_branch"]:
            raise RunnerError("Refusing to target the default branch")
        source = Path(repo["source"])
        reports.append({"repo": repo["github"], "source_head": git(source, "rev-parse", "HEAD"),
                        "target": repo["branch"], "private": info["private"]})
    version = command([config.campaign["mimir"], "--version"])
    help_text = command([config.campaign["mimir"], "run", "--help"])
    for flag in ("--output", "--trace-dir", "--run-timeout-seconds"):
        if flag not in help_text:
            raise RunnerError(f"Mimir is missing required CLI support: {flag}")
    for executable in ("gh", "git", "python3"):
        if not shutil.which(executable):
            raise RunnerError(f"Missing {executable}")
    return {"read_only": True, "mimir_version": version, "repositories": reports,
            "model": "chatgpt/gpt-6.1-sol", "model_authentication": "not exercised by doctor",
            "policy_sha256": config.fingerprint, "storage": str(config.root)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("doctor")
    sub.add_parser("plan")
    sub.add_parser("status")
    for name in ("run", "resume"):
        p = sub.add_parser(name)
        p.add_argument("--apply", action="store_true")
    p = sub.add_parser("stop")
    p.add_argument("--drain", action="store_true", required=True)
    p = sub.add_parser("retry")
    p.add_argument("issue", type=int)
    p.add_argument("--apply", action="store_true")
    p = sub.add_parser("approve")
    p.add_argument("issue", type=int)
    p.add_argument("--evidence-url", required=True)
    p.add_argument("--apply", action="store_true")
    p = sub.add_parser("launch")
    p.add_argument("--port", type=int, default=8899)
    args = parser.parse_args(argv)
    try:
        config = Config.load(args.config)
        if args.operation == "doctor":
            value = doctor(config)
        elif args.operation == "plan":
            snapshot = GitHub(config.campaign["repo"]).snapshot(config.campaign["parent"])
            completed = set()
            state_path = config.root / "state.sqlite3"
            if state_path.exists():
                from .state import Store
                with Store(config, readonly=True) as store:
                    completed = store.completed()
            value = plan(snapshot, config.approved, completed=completed,
                         human={n for n, p in config.tickets.items() if p.get("human")})
            value["policy_sha256"] = config.fingerprint
        else:
            from .engine import dispatch
            value = dispatch(config, args)
        print(json.dumps(value, indent=2, sort_keys=True))
        return value.get("exit_code", 0)
    except (RunnerError, ValueError, OSError, KeyError, RuntimeError) as error:
        print(f"mimir-ticket-runner: {error}", file=sys.stderr)
        return 2
