# SPDX-License-Identifier: AGPL-3.0-only
import json

from core.coding_capabilities import write_catalog
from core.inference import skills
from storage import mcp_servers_db


def test_host_catalog_tracks_settings_without_copying_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("UNSLOTH_STUDIO_HOME", str(tmp_path))
    monkeypatch.setattr(skills, "_owner_home", lambda: tmp_path)
    monkeypatch.delenv("UNSLOTH_STUDIO_SKILLS_HOME", raising = False)
    skills.create_skill("deploy", "Deployment", "Inspect the release.")
    mcp_servers_db.create_server("remote", "Remote", "https://example.org/mcp", '{"Authorization":"private"}')
    mcp_servers_db.create_server("oauth", "OAuth", "https://example.org/auth", use_oauth = True)
    mcp_servers_db.create_server("stdio", "Local", "python example.py")

    path = tmp_path / "host.json"
    write_catalog(path)
    data = json.loads(path.read_bytes())
    assert list(data["mcpServers"]) == ["studio-remote"]
    assert data["agentSkillDirectories"] == [str(tmp_path / ".agents/skills/deploy")]
    assert "private" not in path.read_text() and "example.org" not in path.read_text()

    skills.set_skill_enabled("deploy", False)
    mcp_servers_db.update_server("remote", {"is_enabled": False})
    write_catalog(path)
    assert json.loads(path.read_bytes()) == {"mcpServers": {}, "agentSkillDirectories": []}
