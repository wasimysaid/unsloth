#!/usr/bin/env python3
"""Run Studio against a local Mimir checkout, for fast Coding iteration.

Unlike ``python3 -m scripts.mimir_ticket_runner launch``, this builds the Mimir
binary and studio.frontend plugin incrementally from a working tree (uncommitted
changes included), skips the lock's revision and artifact hashes, and serves this
Studio checkout as it is. Shared Mimir settings, auth and history are used as-is.

    python3 scripts/mimir_dev.py --mimir ../mimir             # build, serve on :8899
    python3 scripts/mimir_dev.py --mimir ../mimir --watch     # rebuild + restart on edits
    python3 scripts/mimir_dev.py --mimir ../mimir --pin       # write the lock, don't serve

``--watch`` restarts only the Mimir runtime, so loaded models stay loaded. It signs
in with UNSLOTH_STUDIO_PASSWORD when set; otherwise restart the runtime from Coding.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

STUDIO = Path(__file__).resolve().parents[1]
LOCK = STUDIO / "studio/mimir-runtime.lock.json"
FRONTEND = STUDIO / "studio/frontend"
STUDIO_PYTHON = Path.home() / ".unsloth/studio/unsloth_studio/bin/python"
WATCHED = ("Cargo.toml", "Cargo.lock", "crates", "plugins/studio-frontend")
WATCHED_SUFFIXES = {".rs", ".toml", ".wit", ".json", ".lock"}


class DevError(RuntimeError):
    pass


def run(argv, cwd, env=None):
    print("+ " + " ".join(str(arg) for arg in argv), flush=True)
    if subprocess.run(argv, cwd=cwd, env=env).returncode:
        raise DevError(f"{argv[0]} failed in {cwd}")


def output(argv, cwd):
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build(mimir, release):
    """Incremental binary + plugin build; returns (binary, package)."""
    profile = ["--release"] if release else []
    run(["cargo", "build", "--locked", *profile, "-p", "mimir-cli", "--bin", "mimir"], mimir)
    package = mimir / "target/studio-frontend-package"
    # build.py keeps its own target dir: its reproducible-rustc wrapper would
    # otherwise invalidate every host artifact above.
    run([sys.executable, "plugins/studio-frontend/build.py", "--output", str(package)], mimir,
        env={k: v for k, v in os.environ.items() if k != "CARGO_TARGET_DIR"})
    target = Path(os.environ.get("CARGO_TARGET_DIR", mimir / "target"))
    return target / ("release" if release else "debug") / "mimir", package


def build_frontend(force):
    dist = FRONTEND / "dist/index.html"
    if not force and dist.exists():
        return
    if not (FRONTEND / "node_modules").exists():
        run(["npm", "ci", "--no-audit", "--no-fund"], FRONTEND)
    run(["npm", "run", "build"], FRONTEND)


def pin(mimir):
    """Record this Mimir HEAD and its package hashes in the runtime lock."""
    if output(["git", "status", "--porcelain", "--untracked-files=no"], mimir):
        raise DevError("Commit the Mimir changes before pinning; the lock names a commit, not a working tree.")
    revision = output(["git", "rev-parse", "HEAD"], mimir)
    if not output(["git", "branch", "-r", "--contains", revision], mimir):
        raise DevError(f"Push Mimir {revision[:12]} first; launchers fetch the pinned commit from GitHub.")
    _, package = build(mimir, release=False)
    lock = json.loads(LOCK.read_text())
    lock["mimir"]["revision"] = revision
    lock["frontend"]["artifacts"] = {path.name: sha256(path) for path in sorted(package.iterdir()) if path.is_file()}
    LOCK.write_text(json.dumps(lock, indent=2) + "\n")
    print(f"Pinned Mimir {revision} in {LOCK.relative_to(STUDIO)} ({output(['rustc', '--version'], mimir)}).")


def snapshot(mimir):
    latest = 0.0
    for name in WATCHED:
        root = mimir / name
        paths = root.rglob("*") if root.is_dir() else [root]
        for path in paths:
            if path.suffix in WATCHED_SUFFIXES and "target" not in path.parts:
                try:
                    latest = max(latest, path.stat().st_mtime)
                except FileNotFoundError:
                    pass
    return latest


def restart_runtime(base):
    password = os.environ.get("UNSLOTH_STUDIO_PASSWORD")
    if not password:
        print("Rebuilt. Restart the Mimir runtime from Coding (or set UNSLOTH_STUDIO_PASSWORD).", flush=True)
        return

    def post(path, body, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(base + path, json.dumps(body).encode(), headers)
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    username = os.environ.get("UNSLOTH_STUDIO_USERNAME", "unsloth")
    try:
        token = post("/api/auth/login", {"username": username, "password": password})["access_token"]
        post("/api/coding/runtime/restart", {"scope": "all_hosted_conversations"}, token)
        print("Rebuilt and restarted the Mimir runtime.", flush=True)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        print(f"Rebuilt, but the runtime restart was refused ({error.code}): {detail}", flush=True)
    except OSError as error:
        print(f"Rebuilt, but Studio could not be reached to restart the runtime: {error}", flush=True)


def watch(mimir, release, backend, base):
    seen = snapshot(mimir)
    while backend.poll() is None:
        time.sleep(1)
        current = snapshot(mimir)
        if current == seen:
            continue
        time.sleep(1)  # let multi-file saves settle
        seen = snapshot(mimir)
        try:
            build(mimir, release)
        except DevError as error:
            print(f"{error}; keeping the previous build.", flush=True)
            continue
        restart_runtime(base)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mimir", type=Path, default=Path(os.environ.get("MIMIR_SOURCE", STUDIO.parent / "mimir")),
                        help="Mimir checkout (default: $MIMIR_SOURCE or ../mimir)")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--release", action="store_true", help="Build an optimized Mimir binary (slower to build)")
    parser.add_argument("--watch", action="store_true", help="Rebuild Mimir and restart its runtime on source edits")
    parser.add_argument("--frontend-build", action="store_true", help="Rebuild studio/frontend/dist even if present")
    parser.add_argument("--python", type=Path, default=STUDIO_PYTHON if STUDIO_PYTHON.exists() else Path(sys.executable),
                        help="Python with Studio's backend dependencies (default: the installed Studio venv)")
    parser.add_argument("--pin", action="store_true", help="Write Mimir HEAD and its package hashes to the lock, then exit")
    args = parser.parse_args()
    mimir = args.mimir.resolve()
    try:
        if not (mimir / "plugins/studio-frontend/build.py").exists():
            raise DevError(f"{mimir} is not a Mimir checkout with plugins/studio-frontend")
        if args.pin:
            return pin(mimir)
        binary, package = build(mimir, args.release)
        build_frontend(args.frontend_build)
    except (DevError, subprocess.CalledProcessError) as error:
        sys.exit(f"mimir_dev: {error}")
    env = dict(os.environ, UNSLOTH_MIMIR_EXECUTABLE=str(binary), UNSLOTH_MIMIR_PLUGIN_PACKAGE=str(package))
    argv = [str(args.python), str(STUDIO / "studio/backend/run.py"),
            "--host", "127.0.0.1", "--port", str(args.port), "--no-cloudflare"]
    print("+ " + " ".join(argv), flush=True)
    backend = subprocess.Popen(argv, cwd=STUDIO, env=env)
    try:
        if args.watch:
            watch(mimir, args.release, backend, f"http://127.0.0.1:{args.port}")
        backend.wait()
    except KeyboardInterrupt:
        backend.terminate()
        backend.wait()
    return backend.returncode


if __name__ == "__main__":
    sys.exit(main())
