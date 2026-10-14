# SPDX-License-Identifier: AGPL-3.0-only
"""Combined host admission/HTTP release/supervisor/idle-retirement boundaries.

The framed child is a fault fixture, not the native scheduler. In particular,
Studio's idle TTL here is not Mimir's separate conversation-retention clock.
"""
import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from auth import storage
from core.coding_local_models import local_choice
from core.coding_runtime import CodingRuntime, close_coding_runtime
from core.inference import llama_keepwarm as kw
from core.inference import media_keepwarm
from routes import inference
from utils import openai_auto_switch_settings as settings

from .test_coding import coding_app
from .test_coding_local_transport import setup_request
from .test_coding_maintenance import child_runtime
from .test_coding_model_protection import admission, owners


@pytest.mark.asyncio
@pytest.mark.parametrize("shutdown", ["confirmed", "lost-process", "unconfirmed-drain"])
async def test_authenticated_acquisition_survives_idle_and_only_confirmed_drain_releases(
    coding_app, admission, monkeypatch, tmp_path, shutdown,
):
    app, _ = coding_app
    primary, _, _ = admission
    # Restore the simulated idle clock after this test, not just the TTL reader.
    monkeypatch.setattr(kw, "_last_active", kw._last_active)
    runtime = CodingRuntime()
    app.state.coding_runtime = runtime
    await runtime.configure_local_serving(setup_request(app))
    serving = runtime.local_serving
    row = SimpleNamespace(
        id="org/A", inventory_id="org/A:Q4_K_M", load_id="org/A",
        display_name="A", format_variant="Q4_K_M", model_format="gguf",
    )

    async def inventory():
        return [row]

    monkeypatch.setattr("core.coding_local_models.downloaded_rows", inventory)
    monkeypatch.setattr(settings, "get_auto_unload_api_only", lambda: False)
    monkeypatch.setattr(settings, "get_auto_unload_keep_kv", lambda: False)
    monkeypatch.setattr(inference, "release_chat_gpu_claim", lambda: None)

    async def no_media():
        pass

    monkeypatch.setattr(media_keepwarm, "idle_unload_step", no_media)

    async def expired_ticks():
        ticks = []

        def ttl():
            # Expire HTTP idleness repeatedly, including after model discovery.
            kw._last_active = time.monotonic() - 3601
            ticks.append(True)
            return 1800

        monkeypatch.setattr(settings, "get_auto_unload_idle_seconds", ttl)
        task = asyncio.create_task(kw.idle_unload_loop(0.001))
        try:
            async with asyncio.timeout(5):
                while len(ticks) < 4:
                    await asyncio.sleep(0.001)
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    choice = local_choice(row)
    native = {"Authorization": "Bearer " + serving.key}
    await child_runtime(tmp_path, runtime=runtime, confirm=shutdown != "unconfirmed-drain")
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=native) as client:
            for owner in ("request-a", "request-b"):
                response = await client.post("/api/coding/local-models/acquire", json={
                    "incarnation": serving.incarnation, "operation_id": owner,
                    "conversation_id": owner + "-conversation", "request_id": owner,
                    "model_id": choice["id"], "api_model": choice["api_model"],
                })
                assert response.status_code == 200, response.text
                assert response.json()["token"] == owner
            assert kw.coding_model_protection_count(primary) == 2
            await expired_ticks()
            assert primary.is_loaded and primary.calls == []
            released = await client.post("/api/coding/local-models/release", json={
                "incarnation": serving.incarnation, "operation_id": "request-a",
            })
            assert released.status_code == 200
            assert kw.coding_model_protection_count(primary) == 1
            await expired_ticks()
            assert primary.is_loaded and primary.calls == []
            with pytest.raises(HTTPException) as failure:
                primary.unload_model()
            assert failure.value.status_code == 409
            assert failure.value.detail["error"] == "coding_model_protected"

        if shutdown == "lost-process":
            runtime.process.kill()
            await runtime._reader
            await runtime._shutdown_task
        else:
            await close_coding_runtime(app)
        assert storage.validate_api_key(serving.key) is None
        confirmed = shutdown == "confirmed"
        assert runtime.status()["cleanup"]["confirmed"] is confirmed
        assert serving.inspect("request-a")["state"] == "released"
        assert serving.inspect("request-b")["state"] == ("released" if confirmed else "protected")
        assert kw.coding_model_protection_count(primary) == (0 if confirmed else 1)
        # Releasing ownership never itself unloads the resident. Only a later idle
        # tick may retire it, and failed/unconfirmed shutdown cannot authorize it.
        assert primary.is_loaded and primary.calls == []
        await expired_ticks()
        assert primary.is_loaded is not confirmed
        assert primary.calls == (["unload"] if confirmed else [])
    finally:
        await runtime.close()
        kw.release_coding_model("request-a")
        kw.release_coding_model("request-b")
