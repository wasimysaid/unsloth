#!/usr/bin/env python3
"""Build the two pure-Python desktop wheels from exact checked-out commits."""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess


def _sha(source):
    sha = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        text = True,
    ).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"invalid source revision: {source}")
    dirty = subprocess.check_output(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=normal"],
        text = True,
    )
    if dirty:
        raise ValueError(f"source checkout has uncommitted files: {source}")
    return sha


def build_pair(
    unsloth_source,
    zoo_source,
    output,
    expected_unsloth_sha,
    expected_zoo_sha,
    expected_unsloth_version = None,
):
    sources = {"unsloth": pathlib.Path(unsloth_source), "unsloth-zoo": pathlib.Path(zoo_source)}
    expected = {"unsloth": expected_unsloth_sha, "unsloth-zoo": expected_zoo_sha}
    output = pathlib.Path(output)
    output.mkdir(parents = True, exist_ok = True)
    packages = {}
    for name, source in sources.items():
        sha = _sha(source)
        if sha != expected[name] or not re.fullmatch(r"[0-9a-f]{40}", expected[name]):
            raise ValueError(f"{name} source SHA differs from requested immutable revision")
        before = set(output.glob("*.whl"))
        subprocess.run(
            ["uv", "build", "--wheel", str(source), "--out-dir", str(output)], check = True
        )
        wheels = set(output.glob("*.whl")) - before
        if len(wheels) != 1:
            raise ValueError(f"expected exactly one {name} wheel, got {wheels}")
        wheel = wheels.pop()
        if not wheel.name.startswith(name.replace("-", "_") + "-") or not wheel.name.endswith(
            "-none-any.whl"
        ):
            raise ValueError(f"unexpected {name} wheel: {wheel.name}")
        if name == "unsloth" and expected_unsloth_version is not None:
            if wheel.name.split("-")[1] != expected_unsloth_version:
                raise ValueError("tag wheel version differs from the desktop backend pin")
        packages[name] = {
            "source_sha": sha,
            "wheel": wheel.name,
            "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        }
    (output / "manifest.json").write_text(
        json.dumps({"schema": 1, "packages": packages}, indent = 2, sort_keys = True) + "\n",
        encoding = "utf-8",
    )
    return packages


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description = __doc__)
    parser.add_argument("--unsloth-source", required = True)
    parser.add_argument("--zoo-source", required = True)
    parser.add_argument("--expected-unsloth-version")
    parser.add_argument("--out", required = True)
    parser.add_argument("--unsloth-sha", required = True)
    parser.add_argument("--zoo-sha", required = True)
    args = parser.parse_args()
    build_pair(
        args.unsloth_source,
        args.zoo_source,
        args.out,
        args.unsloth_sha,
        args.zoo_sha,
        args.expected_unsloth_version,
    )
