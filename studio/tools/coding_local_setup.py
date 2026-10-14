#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket 246 task-owned model setup. Downloads only; never starts inference."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download

REPO = "unsloth/Qwen3-4B-Instruct-2507-GGUF"
REVISION = "a06e946bb6b655725eafa393f4a9745d460374c9"
FILENAME = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2] / ".scratch/ticket246-live")
    parser.add_argument("--alternate", action="store_true", help="Download the modest second real identity needed for busy admission, never load it")
    args = parser.parse_args()
    repo, revision, filename = (("unsloth/Qwen3-0.6B-GGUF", "50968a4468ef4233ed78cd7c3de230dd1d61a56b", "Qwen3-0.6B-Q4_K_M.gguf")
                                if args.alternate else (REPO, REVISION, FILENAME))
    root = args.root.resolve()
    permitted = Path(__file__).resolve().parents[2] / ".scratch/ticket246-live"
    if not root.is_relative_to(permitted.resolve()):
        parser.error("Setup root must remain under .scratch/ticket246-live")
    os.umask(0o077)
    models = root / "models"
    models.mkdir(parents=True, exist_ok=True)
    info = HfApi(token=False).model_info(repo, revision=revision, files_metadata=True)
    entry = next(s for s in info.siblings if s.rfilename == filename)
    path = Path(hf_hub_download(repo, filename, revision=revision, token=False, local_dir=models))
    with path.open("rb") as stream:
        if stream.read(4) != b"GGUF":
            raise RuntimeError("Downloaded file has no GGUF magic")
        stream.seek(0)
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    expected = entry.lfs.sha256 if entry.lfs else None
    if path.stat().st_size != entry.size or (expected and digest != expected):
        raise RuntimeError("Model size/checksum disagrees with pinned Hub metadata")
    report = {
        "kind": "setup-only", "repo": repo, "revision": revision,
        "filename": filename, "path": str(path.resolve()), "size_bytes": path.stat().st_size,
        "sha256": digest, "hub_sha256": expected, "gpu_workload_started": False,
        "download_method": "huggingface_hub.hf_hub_download, anonymous, pinned revision, task local_dir",
        "budget": {"gpu_uuid": "GPU-2bdfcc31-cf97-42d6-c898-40700d02fd40", "peak_gib": 24,
                   "grant_expires_epoch": 1791980523, "requires_parent_confirmation": True},
    }
    (root / ("alternate-model-setup.json" if args.alternate else "model-setup.json")).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
