# SPDX-License-Identifier: AGPL-3.0-only
"""Serve one saved Studio connection to Mimir over its owned stdio transport."""
import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path


async def serve(server_id, revision):
    from mcp.server import Server
    from mcp.server.stdio import stdio_server

    from core.coding_capabilities import shared_http_server
    from core.inference import mcp_client
    from storage import mcp_servers_db

    def connection():
        row = mcp_servers_db.get_server(server_id)
        if not shared_http_server(row) or row["updated_at"] != revision:
            raise ValueError("This connection changed. Open a new Coding conversation.")
        return row

    @asynccontextmanager
    async def lifespan(_server):
        row = connection()
        async with mcp_client._client(row["url"], mcp_client.parse_server_headers(row)) as client:
            yield client

    server = Server("studio-" + server_id, lifespan = lifespan)
    visible = set()

    @server.list_tools()
    async def list_tools():
        connection()
        client = server.request_context.lifespan_context
        tools = [
            tool for tool in await client.list_tools()
            if mcp_client.tool_visible_to(tool.model_dump(by_alias = True), "model")
        ]
        visible.clear()
        visible.update(tool.name for tool in tools)
        return tools

    @server.call_tool()
    async def call_tool(name, arguments):
        connection()
        if name not in visible:
            raise ValueError("This tool is unavailable.")
        client = server.request_context.lifespan_context
        try:
            return await client.call_tool_mcp(name, arguments)
        except Exception:
            raise ValueError("Studio could not call this MCP tool.") from None

    async with stdio_server() as (reader, writer):
        await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    # -I excludes the project and user site from this host-owned interpreter.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    home, server_id, revision = sys.argv[1:]
    os.environ["UNSLOTH_STUDIO_HOME"] = home
    asyncio.run(serve(server_id, revision))
