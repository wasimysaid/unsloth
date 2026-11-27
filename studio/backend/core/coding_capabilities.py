# SPDX-License-Identifier: AGPL-3.0-only
"""An embedding-host catalog for new Mimir conversations."""
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Literal

from core.inference import mcp_client, skills
from storage import mcp_servers_db
from utils.paths import studio_root


CodingLimit = Literal["local-command", "oauth", "studio-internal"]


def mcp_coding_limit(row: dict) -> CodingLimit | None:
    url = row["url"]
    if row.get("builtin_id"):
        return "studio-internal"
    if mcp_client.is_stdio(url):
        return "local-command"
    if row.get("use_oauth"):
        return "oauth"
    if mcp_client.is_studio_tools(url) or mcp_client.is_studio_decisions(url):
        return "studio-internal"
    return None


def shared_http_server(row: dict | None) -> bool:
    return bool(row and row["is_enabled"] and mcp_coding_limit(row) is None)


def write_catalog(path: Path) -> None:
    bridge = Path(__file__).resolve().parents[1] / "coding_mcp_bridge.py"
    servers = {
        "studio-" + row["id"]: {
            "command": sys.executable,
            "args": ["-I", str(bridge), str(studio_root()), row["id"], row["updated_at"]],
        }
        for row in mcp_servers_db.list_servers() if shared_http_server(row)
    }
    content = json.dumps({
        "mcpServers": servers,
        "agentSkillDirectories": [str(p) for p in skills.enabled_skill_directories()],
    }).encode()
    if path.is_file() and path.read_bytes() == content:
        return
    staged = tempfile.NamedTemporaryFile(dir = path.parent, delete = False)
    try:
        with staged:
            staged.write(content)
        os.replace(staged.name, path)
    finally:
        Path(staged.name).unlink(missing_ok = True)
