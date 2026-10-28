#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Apply one isolated experiment; capture its effective features and release build."""
import argparse
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--variant", choices=["baseline", "opt2", "opts", "optz", "tokio-min", "tokio-parking", "aws-only"], required=True)
parser.add_argument("--target", default="")
parser.add_argument("--output", required=True)
parser.add_argument("--tests", action="store_true")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
crate = root / "studio/src-tauri"
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
opt = {"opt2": "2", "opts": "s", "optz": "z"}.get(args.variant, "3")
os.environ.update(CARGO_PROFILE_RELEASE_LTO="fat", CARGO_PROFILE_RELEASE_CODEGEN_UNITS="1",
                  CARGO_PROFILE_RELEASE_OPT_LEVEL=opt, CARGO_INCREMENTAL="0")
toml = crate / "Cargo.toml"
original = toml.read_text()
lock = crate / "Cargo.lock"
original_lock = lock.read_text()
if args.variant.startswith("tokio-"):
    # Every used public API remains enabled; retain fs for Tauri's runtime.
    features = ["fs", "io-util", "macros", "net", "process", "rt-multi-thread", "sync", "time"]
    if args.variant == "tokio-parking":
        features.append("parking_lot")
    needle = 'tokio = { version = "1", features = ["full"] }'
    assert original.count(needle) == 1
    toml.write_text(original.replace(needle, 'tokio = { version = "1", features = ' + json.dumps(features) + ' }'))
elif args.variant == "aws-only":
    needle = 'tauri-plugin-updater = "2"'
    assert original.count(needle) == 1
    # Reqwest's existing default still enables rustls/AWS-LC and certificate
    # verification. Keep updater proxy/archive support; omit its second (ring)
    # provider and the corresponding process-global provider switch.
    toml.write_text(original.replace(needle, 'tauri-plugin-updater = { version = "2", default-features = false, features = ["system-proxy", "zip"] }'))
(out / "Cargo.toml").write_text(toml.read_text())
feature_command = ["cargo", "tree", "--locked", "-e", "normal,build,features"]
if toml.read_text() != original:
    # Removing an optional dependency edge legitimately updates Cargo.lock.
    # Permit that graph change, but reject any dependency version changes.
    feature_command.remove("--locked")
if args.target:
    feature_command += ["--target", args.target]
with (out / "features.txt").open("w") as handle:
    subprocess.run(feature_command, cwd=crate, stdout=handle, check=True)
versions = lambda text: set(re.findall(r'^name = "([^"]+)"\nversion = "([^"]+)"', text, re.M))
assert versions(lock.read_text()) <= versions(original_lock), "An experiment changed dependency versions"
(out / "Cargo.lock").write_text(lock.read_text())

command = [sys.executable, str(root / ".github/scripts/benchmark-desktop-build.py"),
           "--label", args.variant, "--target", args.target, "--output", str(out),
           "--keep-binary", "--initial-only"]
subprocess.run(command, check=True)
result = json.loads((out / "result.json").read_text())
result["experiment"] = {"variant": args.variant, "opt_level": opt,
                        "manifest_modified": toml.read_text() != original}
if args.tests:
    env = dict(os.environ)
    # Tests intentionally exercise the shipped minimum-backend floor.
    env.pop("UNSLOTH_DESKTOP_BACKEND_VERSION", None)
    env.pop("UNSLOTH_DESKTOP_SOURCE_BACKEND", None)
    test_command = ["cargo", "test", "--locked", "--release", "--bin", "unsloth-studio"]
    if args.target:
        test_command += ["--target", args.target]
    started = time.monotonic()
    with (out / "tests.log").open("w") as handle:
        completed = subprocess.run(test_command, cwd=crate, env=env, stdout=handle, stderr=subprocess.STDOUT)
    result["tests"] = {"exit_code": completed.returncode, "seconds": time.monotonic() - started}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    if completed.returncode:
        print((out / "tests.log").read_text()[-10000:])
        raise SystemExit(completed.returncode)
(out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
