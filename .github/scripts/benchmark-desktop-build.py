#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Measure a release build and a real application rebuild, without signing."""

import argparse
import hashlib
import json
import os
import pathlib
import platform
import shutil
import struct
import subprocess
import time


def binary_details(data):
    """Separate Windows machine code from linker/debug build identifiers."""
    if data[:2] != b"MZ":
        return {}
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[offset:offset + 4] != b"PE\0\0":
        return {}
    sections = struct.unpack_from("<H", data, offset + 6)[0]
    optional_size = struct.unpack_from("<H", data, offset + 20)[0]
    details = {"pe_timestamp": struct.unpack_from("<I", data, offset + 8)[0],
               "section_hashes": {}}
    table = offset + 24 + optional_size
    for i in range(sections):
        section = table + 40 * i
        name = data[section:section + 8].rstrip(b"\0").decode("ascii", errors="replace")
        size, start = struct.unpack_from("<II", data, section + 16)
        details["section_hashes"][name] = hashlib.sha256(data[start:start + size]).hexdigest()
    codeview = data.find(b"RSDS")
    if codeview >= 0:
        details["codeview_guid"] = data[codeview + 4:codeview + 20].hex()
    return details


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--label", required=True)
    parser.add_argument("--target", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--keep-binary", action="store_true")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parents[2]
    crate = root / "studio/src-tauri"
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, CARGO_TERM_COLOR="never", CARGO_INCREMENTAL="0")
    target_dir = pathlib.Path(env.get("CARGO_TARGET_DIR", str(crate / "target")))
    if not target_dir.is_absolute():
        target_dir = crate / target_dir
    binary = target_dir / args.target / "release" / (
        "unsloth-studio.exe" if "windows" in args.target or platform.system() == "Windows"
        else "unsloth-studio"
    )
    base = ["cargo", "build", "--locked", "--release", "--bin", "unsloth-studio", "--timings"]
    clean = ["cargo", "clean", "--release", "--package", "unsloth-studio"]
    if args.target:
        base += ["--target", args.target]
        clean += ["--target", args.target]
    result = {
        "label": args.label,
        "target": args.target,
        "system": platform.platform(),
        "cpus": os.cpu_count(),
        "cache_hit": env.get("BENCHMARK_CACHE_HIT"),
        "rustc": subprocess.check_output(["rustc", "-Vv"], text=True),
        "source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "settings": {key: env.get(key) for key in [
            "CARGO_PROFILE_RELEASE_LTO", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
            "CARGO_PROFILE_RELEASE_OPT_LEVEL", "RUSTC_WRAPPER", "CARGO_BUILD_JOBS",
        ]},
        "builds": [],
    }
    def persist():
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")

    initial_bytes = None
    for phase in ("initial", "application-rebuild"):
        if phase == "application-rebuild":
            # Keep dependency artifacts, but actually recompile and relink the app.
            # A second no-op cargo invocation would not test reproducibility.
            subprocess.run(clean, cwd=crate, env=env, check=True)
        log = output / (phase + ".log")
        print(f"START {args.label} {phase}", flush=True)
        start = time.monotonic()
        with log.open("w", encoding="utf-8") as handle:
            completed = subprocess.run(base, cwd=crate, env=env, stdout=handle, stderr=subprocess.STDOUT)
        item = {"phase": phase, "seconds": round(time.monotonic() - start, 3),
                "exit_code": completed.returncode}
        if completed.returncode == 0:
            binary_bytes = binary.read_bytes()
            item.update(size_bytes=binary.stat().st_size,
                        sha256=hashlib.sha256(binary_bytes).hexdigest(),
                        binary_details=binary_details(binary_bytes))
            if phase == "initial":
                initial_bytes = binary_bytes
            elif binary_bytes != initial_bytes:
                # Capture a small byte-level diff rather than assume an unequal
                # Windows SHA is explained by timestamps or debug identifiers.
                differences = []
                for offset, (before, after) in enumerate(zip(initial_bytes, binary_bytes)):
                    if before != after:
                        differences.append({"offset": offset, "before": before, "after": after})
                        if len(differences) == 64:
                            break
                result["first_byte_differences"] = differences
            if args.keep_binary and phase == "initial":
                shutil.copy2(binary, output / binary.name)
        result["builds"].append(item)
        persist()
        print(json.dumps(item), flush=True)
        if completed.returncode:
            print(log.read_text(encoding="utf-8", errors="replace")[-18000:], flush=True)
            raise SystemExit(completed.returncode)
    result["identical_application_rebuild"] = result["builds"][0]["sha256"] == result["builds"][1]["sha256"]
    persist()
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"### {args.label}\n\n")
            handle.write("| Build | Seconds | Bytes | SHA-256 |\n|---|---:|---:|---|\n")
            for item in result["builds"]:
                handle.write(f"| {item['phase']} | {item['seconds']} | {item['size_bytes']} | `{item['sha256']}` |\n")
            handle.write(f"\nIdentical application rebuild: **{result['identical_application_rebuild']}**.\n")
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
