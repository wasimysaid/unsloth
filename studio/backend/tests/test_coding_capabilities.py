# SPDX-License-Identifier: AGPL-3.0-only
import asyncio
import json
import socket

import pytest

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


@pytest.mark.asyncio
async def test_saved_http_tool_round_trip_and_revocation(tmp_path, monkeypatch):
    import uvicorn
    from fastmcp import Client, FastMCP
    from fastmcp.client.transports import StdioTransport
    from fastmcp.server.dependencies import get_http_headers

    monkeypatch.setenv("UNSLOTH_STUDIO_HOME", str(tmp_path))
    monkeypatch.setattr(skills, "_owner_home", lambda: tmp_path)
    remote = FastMCP("fixture")

    @remote.tool
    def twice(n: int) -> int:
        assert get_http_headers()["x-fixture-key"] == "test-only"
        return 2 * n

    @remote.tool(meta = {"ui": {"visibility": ["app"]}})
    def app_only() -> str:
        return "for the MCP app"

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(remote.http_app(), log_level = "warning"))
        serving = asyncio.create_task(server.serve(sockets = [listener]))
        try:
            async with asyncio.timeout(30):
                while not server.started:
                    if serving.done():
                        await serving
                        raise AssertionError("MCP fixture stopped before startup")
                    await asyncio.sleep(0.01)
                mcp_servers_db.create_server(
                    "fixture", "Fixture", f"http://127.0.0.1:{port}/mcp",
                    headers_json = '{"x-fixture-key":"test-only"}',
                )
                catalog = tmp_path / "catalog.json"
                write_catalog(catalog)
                definition = json.loads(catalog.read_bytes())["mcpServers"]["studio-fixture"]
                async with Client(StdioTransport(**definition, keep_alive = False)) as client:
                    assert [tool.name for tool in await client.list_tools()] == ["twice"]
                    assert (await client.call_tool_mcp("app_only", {})).isError
                    result = await client.call_tool_mcp("twice", {"n": 21})
                    assert not result.isError and result.content[0].text == "42"
                    mcp_servers_db.update_server("fixture", {"is_enabled": False})
                    assert (await client.call_tool_mcp("twice", {"n": 21})).isError
        finally:
            server.should_exit = True
            await serving
