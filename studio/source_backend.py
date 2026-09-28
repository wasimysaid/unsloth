"""Validate the immutable pair of source-built desktop backend wheels.

The release builder writes the manifest after building wheels from two pinned source
commits. Validation happens again on the consumer, before any core package install.
"""

import hashlib
import json
import pathlib
import re
import sys


PACKAGES = ("unsloth", "unsloth-zoo")


def wheel_paths(directory):
    directory = pathlib.Path(directory).resolve(strict = True)
    manifest = json.loads((directory / "manifest.json").read_text(encoding = "utf-8"))
    if manifest.get("schema") != 1 or set(manifest.get("packages", {})) != set(PACKAGES):
        raise ValueError("invalid desktop source backend manifest")
    result = []
    for name in PACKAGES:
        entry = manifest["packages"][name]
        filename = entry["wheel"]
        if not (
            isinstance(filename, str)
            and filename == pathlib.Path(filename).name
            and filename.startswith(name.replace("-", "_") + "-")
            and filename.endswith("-none-any.whl")
            and re.fullmatch(r"[0-9a-f]{40}", entry["source_sha"])
            and re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
        ):
            raise ValueError(f"invalid {name} source backend entry")
        wheel = directory / filename
        if hashlib.sha256(wheel.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"{name} source backend wheel checksum mismatch")
        result.append(str(wheel))
    return tuple(result)


if __name__ == "__main__":
    try:
        print("\n".join(wheel_paths(sys.argv[1])))
    except (IndexError, OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(f"Invalid desktop source backend: {error}")
