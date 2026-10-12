"""Small, explicit I/O helpers. No shell interpolation or ambient repository choice."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


class RunnerError(RuntimeError):
    """An actionable, fail-closed campaign error."""


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path: Path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def command(argv, *, cwd=None, timeout=120, env=None, input=None) -> str:
    try:
        result = subprocess.run([str(x) for x in argv], cwd=cwd, env=env, input=input,
                                text=True, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RunnerError(f"Command failed: {argv[0]}: {error}") from error
    if result.returncode:
        # Full model/provider output is never included in GitHub-facing errors.
        raise RunnerError(f"Command exited {result.returncode}: {argv[0]} {argv[1:3]}\n{result.stderr[-2000:]}")
    return result.stdout.strip()


def git(path, *args) -> str:
    return command(["git", "-C", str(path), *args])


def within(path: Path, root: Path) -> Path:
    path = path.resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise RunnerError(f"Path escapes the owned root: {path}")
    return path
