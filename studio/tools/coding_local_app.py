#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Task-only real Studio auth/coding/inference acceptance composition, no provider fixture.

Use uvicorn coding_local_app:create_app --factory with PYTHONPATH=studio/tools:studio/backend.
All mutable state and native HOME must be isolated under .scratch/ticket246-live.
Factory/startup never loads a model. An authenticated production /load or coding
request owns the eventual load, only after coordinated GPU confirmation.
"""
from __future__ import annotations

import os
from pathlib import Path


def create_app():
    root = Path(__file__).resolve().parents[2]
    task = (root / ".scratch/ticket246-live").resolve()
    for key in ("UNSLOTH_STUDIO_HOME", "MIMIR_CODING_AGENT_DIR", "HOME", "LLAMA_SERVER_PATH"):
        value = os.environ.get(key)
        if not value or not Path(value).resolve().is_relative_to(task):
            raise RuntimeError(f"Acceptance requires a task-isolated {key}")
    password = os.environ.get("CODING_ACCEPTANCE_PASSWORD")
    if not password:
        raise RuntimeError("Acceptance requires an ephemeral CODING_ACCEPTANCE_PASSWORD")
    os.umask(0o077)

    import asyncio
    import secrets
    from contextlib import asynccontextmanager
    from fastapi import Depends, FastAPI
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    from auth.authentication import get_current_subject
    from auth.storage import create_initial_user, get_user_record
    from core.coding_runtime import close_coding_runtime
    from core.inference.llama_keepwarm import LlamaKeepWarmMiddleware, coding_model_protection_count
    from hub.services.models.local_inventory import add_scan_folder_response
    from routes.auth import router as auth_router
    from routes.coding import router as coding_router
    from routes import inference

    if get_user_record("unsloth") is None:
        create_initial_user("unsloth", password, secrets.token_hex(32))
    # Existing Studio scan-folder registration, not a second catalog or manual native model list.
    add_scan_folder_response(str(task / "models"), recursive=False)
    if os.environ.get("CODING_LOCAL_COLD_LOAD") == "1":
        from utils.openai_auto_switch_settings import set_model_override
        set_model_override(str(task / "models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"),
                           max_seq_length=32768, n_parallel=1, speculative_type="off",
                           disable_vision=True, gpu_memory_mode="manual", gpu_layers=99)

    @asynccontextmanager
    async def lifespan(app):
        inference.begin_load_lifecycle()
        try:
            yield
        finally:
            # Do not force-drop coding holds if native cleanup fails. Such a failure
            # must remain visible rather than being reported as successful release.
            import json
            runtime = getattr(app.state, "coding_runtime", None)
            native = getattr(runtime, "process", None)
            facts = {"native_pid": getattr(native, "pid", None), "cleanup_confirmed": False}
            try:
                await close_coding_runtime(app)
                facts["native_exit_code"] = getattr(native, "returncode", None)
                inference.cancel_pending_loads()
                backend = inference.get_llama_cpp_backend()
                if backend.is_active or backend.is_loaded:
                    stopped = await asyncio.to_thread(backend.unload_model)
                    if stopped is False:
                        raise RuntimeError("Task-owned llama-server cleanup was not confirmed")
                from core.inference.llama_http import aclose
                await aclose()
                facts.update(coding_holds=coding_model_protection_count(),
                             primary_active=bool(backend.is_active), primary_loaded=bool(backend.is_loaded))
                facts["cleanup_confirmed"] = facts["coding_holds"] == 0 and not facts["primary_active"]
            finally:
                (Path(os.environ["UNSLOTH_STUDIO_HOME"]) / "acceptance-lifespan.json").write_text(json.dumps(facts, indent=2) + "\n")

    app = FastAPI(lifespan=lifespan)
    app.state.secure = False
    app.add_middleware(LlamaKeepWarmMiddleware)
    app.include_router(auth_router, prefix="/api/auth")
    app.include_router(coding_router, prefix="/api/coding")
    app.include_router(inference.router, prefix="/api/inference")
    app.include_router(inference.studio_router, prefix="/api/inference")
    app.include_router(inference.router, prefix="/v1")

    @app.get("/api/coding-local-acceptance/protection", dependencies=[Depends(get_current_subject)])
    async def observe_protection():
        # Read-only observations of the real gated owner. No hold injection,
        # release endpoint, provider replies, request state or inference simulation.
        backend = inference.get_llama_cpp_backend()
        return {
            "coding_holds": coding_model_protection_count(),
            "primary_coding_holds": coding_model_protection_count(backend),
            "primary_loaded": bool(backend.is_loaded),
            "primary_active": bool(backend.is_active),
            "served_context": getattr(backend, "context_length", None),
            "served_slots": getattr(backend, "effective_parallel_slots", None),
            "gpu_backend_unavailable": bool(getattr(backend, "gpu_backend_unavailable", False)),
            "server_pid": getattr(getattr(backend, "_process", None), "pid", None),
            "native_pid": getattr(getattr(getattr(app.state, "coding_runtime", None), "process", None), "pid", None),
        }

    @app.post("/api/coding-local-acceptance/recover-idle-native", dependencies=[Depends(get_current_subject)])
    async def recover_idle_native():
        # Task-only actual process fault, never a simulated event or owner result.
        # Driver must already have observed all exact native requests terminal.
        from fastapi import HTTPException
        runtime = getattr(app.state, "coding_runtime", None)
        process = getattr(runtime, "process", None)
        backend = inference.get_llama_cpp_backend()
        if coding_model_protection_count() or backend.is_active or process is None or process.returncode is not None:
            raise HTTPException(409, "Idle native recovery requires released protections and unloaded task model")
        import psutil
        observed = psutil.Process(process.pid)
        if observed.uids().real != os.getuid() or observed.cmdline()[1:] != ["plugin", "run", "studio.frontend"] or Path(observed.exe()).resolve() != Path(os.environ["UNSLOTH_MIMIR_EXECUTABLE"]).resolve():
            raise HTTPException(409, "Task native process identity was not confirmed")
        before = process.pid
        process.kill()
        await asyncio.wait_for(process.wait(), timeout=30)
        await runtime.close()
        del app.state.coding_runtime
        return {"native_pid_before": before, "native_exit_code": process.returncode,
                "coding_holds": coding_model_protection_count(), "model_active": bool(backend.is_active)}

    dist = root / "studio/frontend/dist"
    if (dist / "index.html").is_file() and (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}")
        async def frontend(path: str):
            requested = (dist / path).resolve()
            if requested.is_relative_to(dist.resolve()) and requested.is_file():
                return FileResponse(requested)
            return FileResponse(dist / "index.html")
    return app
