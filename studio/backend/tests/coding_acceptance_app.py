# SPDX-License-Identifier: AGPL-3.0-only
"""CPU-only acceptance composition of the production coding and auth routers.

Not a mock server: launches the installed product plugin and real native runtime.
Unrelated ML/training routers and startup probes are deliberately not mounted.
Run via studio/tools/coding_browser_acceptance.py, never as a production entrypoint.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from auth.authentication import get_current_subject
from auth.storage import create_initial_user, get_user_record
from .coding_transport_faults import CodingTransportFaults
from core.coding_runtime import close_coding_runtime, runtime_for
from routes.auth import router as auth_router
from routes.coding import router as coding_router


class RetentionClock(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    advance_ns: int = Field(default = 0, ge = 0, le = 9_007_199_254_740_991)


def create_app() -> FastAPI:
    # Refuse to seed credentials or launch Mimir against the developer's real profile.
    for key in ("UNSLOTH_STUDIO_HOME", "MIMIR_CODING_AGENT_DIR", "CODING_ACCEPTANCE_PASSWORD"):
        if not os.environ.get(key):
            raise RuntimeError(f"Acceptance requires an isolated {key}")
    if get_user_record("unsloth") is None:
        import secrets
        create_initial_user("unsloth", os.environ["CODING_ACCEPTANCE_PASSWORD"], secrets.token_hex(32))

    @asynccontextmanager
    async def lifespan(app):
        yield
        await close_coding_runtime(app)

    app = FastAPI(lifespan = lifespan)
    app.state.secure = False
    app.include_router(auth_router, prefix = "/api/auth")
    app.include_router(coding_router, prefix = "/api/coding")
    faults = {}
    app.add_middleware(CodingTransportFaults, faults = faults)

    @app.post("/api/coding-acceptance/reset/{conversation_id}", dependencies = [Depends(get_current_subject)])
    async def reset_next_view(conversation_id: str):
        # This test-only composition requires isolated history/auth above. The
        # production app has no fault endpoints or middleware. Native work and
        # saved history are not changed; only the next browser transport is.
        faults["reset_conversation"] = conversation_id
        return {"configured": True}

    if os.environ.get("CODING_ACCEPTANCE_RETIREMENT_FIXTURES") == "1":
        @app.post("/api/coding-acceptance/retention-clock", dependencies = [Depends(get_current_subject)])
        async def retention_clock(body: RetentionClock, request: Request):
            # Only an explicitly built acceptance component implements this command.
            # Production routers and the default component have no clock controls.
            return await runtime_for(request.app).command("retention_fixture", body.model_dump())

    @app.get("/api/{path:path}")
    async def unavailable(path: str):
        raise HTTPException(404, "This opening-only acceptance composition does not mount unrelated APIs.")

    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    app.mount("/assets", StaticFiles(directory = dist / "assets"), name = "assets")

    @app.get("/{path:path}")
    async def frontend(path: str):
        requested = (dist / path).resolve()
        if requested.is_relative_to(dist) and requested.is_file():
            return FileResponse(requested)
        return FileResponse(dist / "index.html")

    return app
