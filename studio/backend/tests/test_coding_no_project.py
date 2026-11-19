# SPDX-License-Identifier: AGPL-3.0-only
"""No-project chats keep native execution and durable working directories."""
from pathlib import Path

import httpx
import pytest

from .test_coding import RuntimeDouble, coding_app


@pytest.mark.asyncio
async def test_no_project_create_list_and_reopen(coding_app, monkeypatch, tmp_path):
    from routes import coding

    monkeypatch.setattr(coding, "studio_root", lambda: tmp_path)
    app, headers = coding_app
    records = []

    class Runtime(RuntimeDouble):
        async def command(self, method, params):
            if method == "create":
                assert Path(params["cwd"]).is_dir()
                info = {"id": str(len(records)), "cwd": params["cwd"], "runtime_generation": 1}
                records.append(info)
                return {"info": info}
            if method == "list":
                return {"sessions": records, "next_cursor": None}
            assert method == "open"
            return {"info": records[int(params["conversation_id"])]}

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        for body in ({"cwd": None}, {}):
            response = await client.post("/api/coding/conversations", json = body)
            assert response.status_code == 201
            assert response.json()["cwd"] is None
        assert records[0]["cwd"] != records[1]["cwd"]
        artifact = Path(records[0]["cwd"]) / "note.txt"
        artifact.write_text("kept across reopen")
        project = tmp_path / "my-project"
        project.mkdir()
        response = await client.post("/api/coding/conversations", json = {"cwd": str(project)})
        assert response.json()["cwd"] == str(project)
        listed = (await client.get("/api/coding/conversations")).json()["conversations"]
        assert [row["cwd"] for row in listed] == [None, None, str(project)]
        reopened = await client.post("/api/coding/conversations/0/open")
        assert reopened.json()["cwd"] is None
        assert artifact.read_text() == "kept across reopen"
