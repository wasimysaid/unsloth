# SPDX-License-Identifier: AGPL-3.0-only
"""Coding uses the shared launch schema, resident status and guarded model loader."""
import threading

import pytest
from fastapi import HTTPException, Request
from pydantic import ValidationError

from core import coding_local_models as local
from core.inference import llama_keepwarm as kw, model_slots, orchestrator
from models.inference import InferenceStatusResponse
from models.model_load_config import ModelLoadConfig
from routes import coding, inference
from state import active_generations
from utils import openai_auto_switch_settings as settings

from .test_coding_local_models import row
from .test_coding_model_protection import FakeLlama, FakeOrchestrator, admission, owners, protect


@pytest.fixture
def selected(monkeypatch):
    selected = row(load_id = "org/A", format_variant = "Q4_K_M")
    async def downloaded():
        return [selected]
    monkeypatch.setattr(local, "downloaded_rows", downloaded)
    return selected


@pytest.mark.asyncio
async def test_browser_load_opts_into_shared_placement_without_forcing_cancellation(monkeypatch, selected):
    async def load(request, fastapi_request, subject):
        assert subject == "subject"
        assert request.alongside and not request.force_alongside
        assert not request.force_cancel_active
        return {"loaded": request.model_path}

    monkeypatch.setattr(inference, "load_model", load)
    request = Request({"type": "http", "state": {"coding_subject": "subject"}})
    result = await coding.browser_load_model(local.local_choice(selected)["id"],
        coding.LocalModelLoad(load_request_id = "attempt"), request)
    assert result == {"loaded": "org/A"}


@pytest.mark.asyncio
async def test_explicit_load_settings_replace_saved_preset_without_saving(monkeypatch, selected):
    def saved(*args):
        raise AssertionError("An explicit load must not read or write the saved preset")
    monkeypatch.setattr(settings, "resolve_override_for_load", saved)
    monkeypatch.setattr(settings, "set_model_override", saved)
    request = await local.local_load_request(local.local_choice(selected)["id"], "specific-load", config = ModelLoadConfig(
        custom_context_length = 8192, kv_cache_dtype = "q8_0", n_batch = 512,
        chat_template_override = "{{ messages }}", disable_vision = True,
    ), force_reload = True)
    assert request.model_path == "org/A" and request.gguf_variant == "Q4_K_M"
    assert request.load_request_id == "specific-load" and request.force_reload
    assert request.max_seq_length == 8192 and request.cache_type_kv == "q8_0"
    assert request.n_batch == 512 and request.chat_template_override == "{{ messages }}"
    assert request.disable_vision and request.llama_extra_args == []
    assert not request.force_cancel_active and not request.alongside and not request.force_alongside


@pytest.mark.asyncio
async def test_explicit_defaults_clear_saved_and_resident_settings(monkeypatch, selected):
    monkeypatch.setattr(settings, "resolve_override_for_load", lambda *args: ("saved", {
        "max_seq_length": 65536, "llama_extra_args": ["--ctx-size", "65536"],
        "chat_template_override": "saved", "load_in_4bit": False,
    }))
    implicit = await local.local_load_request(local.local_choice(selected)["id"])
    explicit = await local.local_load_request(local.local_choice(selected)["id"], config = ModelLoadConfig())
    assert implicit.max_seq_length == 65536 and implicit.chat_template_override == "saved"
    assert explicit.max_seq_length == 0 and explicit.chat_template_override is None
    assert explicit.llama_extra_args == [] and explicit.load_in_4bit
    assert {"load_in_4bit", "max_seq_length", "llama_extra_args"} <= explicit.model_fields_set


@pytest.mark.parametrize("config", [{"n_batch": 0}, {"max_seq_length": True}, {"force_cancel_active": True}, {"model_path": "other"}])
def test_invalid_or_destructive_settings_are_rejected_at_boundary(config):
    with pytest.raises(ValidationError):
        coding.LocalModelLoad(load_request_id = "attempt", config = config)


@pytest.mark.asyncio
async def test_status_poll_reuses_inventory_identity_until_inventory_changes(monkeypatch):
    from hub.utils import inventory_scan

    model = row("status-cache-fixture", load_id = "org/A", format_variant = "Q4_K_M")
    scans, epoch = 0, 0

    async def downloaded():
        nonlocal scans
        scans += 1
        return [model]

    async def resident(requested, subject):
        assert requested == "org/A:Q4_K_M" and subject == "subject"
        return None

    monkeypatch.setattr(inventory_scan, "hf_cache_scans_epoch", lambda: epoch)
    monkeypatch.setattr(local, "downloaded_rows", downloaded)
    monkeypatch.setattr(local, "_resident_status", resident)
    identifier = local.local_choice(model)["id"]
    await local.local_model_state(identifier, "subject")
    await local.local_model_state(identifier, "subject")
    assert scans == 1
    epoch += 1
    await local.local_model_state(identifier, "subject")
    assert scans == 2


@pytest.mark.asyncio
async def test_state_reports_exact_kept_quant_and_restores_routing(monkeypatch, admission, selected):
    primary, _, _ = admission
    primary.hf_variant = "Q8_0"
    kept = model_slots.ExtraSlot(FakeLlama("org/A", "Q4_K_M"), FakeOrchestrator(), "owner")
    model_slots.slots.append(kept)
    async def status(subject):
        assert subject == "subject"
        assert orchestrator.routed_slot.get() is kept
        return InferenceStatusResponse(active_model = "org/A", model_identifier = "org/A", is_gguf = True,
                                       gguf_variant = "Q4_K_M", context_length = 8192, requested_n_batch = 512)
    async def no_reap():
        pass
    monkeypatch.setattr(inference, "_reap_exited_workers", no_reap)
    monkeypatch.setattr(inference, "_slot_status", status)
    monkeypatch.setattr(inference, "_llama_resident", lambda: (None, None))
    monkeypatch.setattr(inference, "_slot_entries_and_checkpoints", lambda: ([], {}))
    result = await local.local_model_state(local.local_choice(selected)["id"], "subject")
    assert result["loaded"] and not result["loading"]
    assert result["status"]["context_length"] == 8192
    assert result["status"]["gguf_variant"] == "Q4_K_M" and result["status"]["requested_n_batch"] == 512
    assert orchestrator.routed_slot.get() is None
    kept.llama.is_loaded = False
    assert await local.local_model_state(local.local_choice(selected)["id"], "subject") == {
        "loaded": False, "loading": False, "status": None,
    }


@pytest.mark.asyncio
async def test_native_catalog_reports_resident_template_context_and_vision(monkeypatch, selected):
    selected.capabilities.supports_vision = True
    async def resident(requested, subject):
        assert requested == "org/A:Q4_K_M" and subject == "subject"
        return InferenceStatusResponse(active_model = "org/A", is_vision = True, disable_vision = True,
            context_length = 16384, supports_reasoning = True, reasoning_style = "enable_thinking_effort",
            reasoning_effort_levels = ["high", "max"], supports_preserve_thinking = True,
            preserve_thinking_default = True)
    monkeypatch.setattr(local, "_resident_status", resident)
    model = (await local.local_catalog("subject"))["models"][0]
    assert model["id"] == local.local_choice(selected)["id"]
    assert model["context_length"] == 16384 and model["supports_vision"] is False
    assert model["reasoning"] == {"thinking": True, "toggle": True, "levels": ["high", "max"], "preserve": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("workload", ["chat", "coding", "both"])
async def test_browser_reload_keeps_active_chat_and_coding_requests(monkeypatch, selected, admission, workload):
    primary, _, _ = admission
    async def primary_slot(request):
        return None
    async def reload(request, fastapi_request, subject, **kwargs):
        assert request.force_reload and request.max_seq_length == 8192
        assert not request.force_cancel_active
        kwargs["on_reload_confirmed"](cancel = True)
        primary.calls.append("reloaded")
        raise AssertionError("Active requests must refuse the reload before mutation")
    monkeypatch.setattr(inference, "_select_load_slot", primary_slot)
    monkeypatch.setattr(inference, "_loads_anything", lambda: True)
    monkeypatch.setattr(inference, "_run_tracked_load_model_impl", reload)
    monkeypatch.setattr(inference.account_access, "account_scope", lambda: None)
    if workload in ("coding", "both"):
        protect("coding-request", primary)
    event = threading.Event()
    request = Request({"type": "http", "method": "POST", "path": "/api/coding/models/model/load", "headers": []})
    request.state.coding_subject = "subject"
    generation = active_generations.ActiveGeneration(event, thread_id = "chat") if workload in ("chat", "both") else None
    if generation:
        generation.__enter__()
    try:
        with pytest.raises(HTTPException) as failure:
            await coding.browser_load_model(local.local_choice(selected)["id"], coding.LocalModelLoad(
                load_request_id = "reload", force_reload = True, config = {"custom_context_length": 8192},
            ), request)
        assert failure.value.status_code == 409
        assert not event.is_set() and primary.is_loaded and primary.calls == []
        assert kw.coding_model_protection_count(primary) == (workload != "chat")
    finally:
        if generation:
            generation.__exit__(None, None, None)


@pytest.mark.asyncio
async def test_explicit_npu_settings_use_shared_override_mapping(selected):
    request = await local.local_load_request(local.local_choice(selected)["id"], config = ModelLoadConfig(
        npu_power_mode = "performance", npu_prefill_chunk_len = 256, npu_img_pre_resize = 0,
    ))
    assert request.npu_power_mode == "performance"
    assert request.npu_prefill_chunk_len == 256 and request.npu_img_pre_resize == 0


@pytest.mark.asyncio
async def test_cancel_targets_only_explicit_reload_attempt(monkeypatch, selected, admission):
    monkeypatch.setattr(inference.account_access, "account_scope", lambda: None)
    monkeypatch.setattr(inference, "_scoped_load_attempts", {})
    monkeypatch.setattr(inference, "_scoped_load_cancel_tombstones", {})
    monkeypatch.setattr(inference, "_running_load_attempt", None)
    identifier = local.local_choice(selected)["id"]
    first = inference._begin_load_attempt(await local.local_load_request(
        identifier, "first", config = ModelLoadConfig(custom_context_length = 8192), force_reload = True,
    ), "subject")
    newer = inference._begin_load_attempt(await local.local_load_request(
        identifier, "newer", config = ModelLoadConfig(custom_context_length = 16384), force_reload = True,
    ), "subject")
    request = Request({"type": "http", "method": "POST", "path": "/api/coding/models/model/unload", "headers": []})
    request.state.coding_subject = "subject"
    try:
        await coding.browser_unload_model(identifier, request, "first")
        assert first.cancel_event.is_set() and first.cancel_complete.is_set()
        assert not newer.cancel_event.is_set()
        inference._finish_load_attempt(first)
        await coding.browser_unload_model(identifier, request, "first")
        assert not newer.cancel_event.is_set()
        assert admission[0].is_loaded and admission[0].calls == []
    finally:
        inference._finish_load_attempt(first)
        inference._finish_load_attempt(newer)
