"""Append-only, result-neutral audit observer for the PR10648 macOS A/B harness.

Only safe native executable basenames/probe kinds and URL hostnames are recorded.
Arguments, paths, headers, bodies, and query strings are never written.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse

_OUTPUT = os.environ.get("PR10648_AUDIT_FILE", "")
_SAFE_HOST = re.compile(r"^[a-z0-9.-]{1,253}$")
_NATIVE = re.compile(r"^(?:llama-|whisper-|node$|npm$)", re.I)


def _append(payload: dict[str, object]) -> None:
    if not _OUTPUT:
        return
    try:
        encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        descriptor = os.open(_OUTPUT, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, encoded)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def _basename(value: object) -> str:
    raw = os.fspath(value) if isinstance(value, os.PathLike) else str(value or "")
    return raw.replace("\\", "/").rsplit("/", 1)[-1][:100]


def _hook(event: str, args: tuple[object, ...]) -> None:
    if event == "subprocess.Popen" and args:
        executable = _basename(args[0])
        argv = args[1] if len(args) > 1 else ()
        if _NATIVE.match(executable):
            words = [str(item) for item in argv] if isinstance(argv, (list, tuple)) else []
            probe = "version" if "--version" in words or "-v" in words else "help" if "--help" in words or "-h" in words else "execute"
            _append({"kind": "native_subprocess", "binary": executable, "probe": probe})
    elif event == "urllib.Request" and args:
        try:
            host = (urllib.parse.urlsplit(str(args[0])).hostname or "").lower().rstrip(".")
            host = host if _SAFE_HOST.fullmatch(host) else "<invalid-host>"
        except (TypeError, ValueError):
            host = "<invalid-host>"
        _append({"kind": "urllib_request", "hostname": host})


if _OUTPUT:
    sys.addaudithook(_hook)
