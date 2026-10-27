# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Whole native request holds, with deterministic CPU-only lifecycle owners."""

import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from core.inference import gpu_arbiter as arb
from core.inference import llama_keepwarm as kw
from core.inference import model_slots as slots
from core.inference import orchestrator
from core.inference.llama_cpp import LlamaCppBackend
from core.inference.orchestrator import InferenceOrchestrator
from models.inference import InstallLatestTransformersRequest, LoadRequest, UnloadRequest
from routes import inference as inf


class FakeLlama:
    def __init__(self, name = "org/A", variant = "Q4_K_M"):
        self.model_identifier = name
        self.hf_variant = variant
        self.is_loaded = self.is_active = bool(name)
        self.calls = []

    @kw.guards_coding_model("Unloading the model")
    def unload_model(self):
        self.calls.append("unload")
        self.is_loaded = self.is_active = False

    def _cleanup(self):
        self.calls.append("cleanup")


class FakeOrchestrator:
    def __init__(self, name = None):
        self.active_model_name = name
        self.loading_models = set()
        self.models = {name: {}} if name else {}
        self.calls = []

    def _cleanup(self):
        self.calls.append("cleanup")

    def is_worker_alive(self):
        return bool(self.active_model_name)


@pytest.fixture(autouse = True)
def owners(monkeypatch):
    monkeypatch.setattr(kw, "_coding_holds", {})
    monkeypatch.setattr(kw, "_coding_mutations", [])
    monkeypatch.setattr(kw, "_inflight", 0)
    monkeypatch.setattr(kw, "_pending", 0)
    monkeypatch.setattr(slots, "slots", [])
    monkeypatch.setattr(slots, "stuck", [])
    monkeypatch.setattr(slots, "loading", None)
    monkeypatch.setattr(arb, "_owner", None)
    monkeypatch.setattr(arb, "_release_idle_video_servers", lambda _: None)
    monkeypatch.setattr(arb, "other_accounts_active", lambda _: 0)
    monkeypatch.setattr(inf, "_raise_if_sidecar_swap_in_progress", lambda: None)
    monkeypatch.setattr(inf.account_access, "managed_account", lambda: False)
    monkeypatch.setattr(inf.account_access, "require_live_account", lambda: None)
    monkeypatch.setattr(slots.account_access, "managed_account", lambda: False)
    previous = orchestrator.routed_slot.set(None)
    yield
    orchestrator.routed_slot.reset(previous)


def protect(token, backend, slot = None):
    return kw.hold_coding_model(token, backend, slot = slot, identity = kw.coding_model_identity(backend))


def assert_protected(fn):
    with pytest.raises(HTTPException) as error:
        fn()
    assert error.value.status_code == 409
    assert error.value.detail["error"] == "coding_model_protected"
    assert "retry" in error.value.detail["message"].lower()
    assert "org/" not in str(error.value.detail)


def test_independent_tokens_release_only_their_owner_without_unloading():
    backend = FakeLlama()
    first = protect("request-1", backend)
    assert protect("request-1", backend) is first
    protect("request-2", backend)
    assert kw.coding_model_protection_count(backend) == 2
    assert kw.release_coding_model("unrelated") is False
    assert kw.release_coding_model("request-1") is True
    assert kw.release_coding_model("request-1") is False
    assert_protected(backend.unload_model)
    assert kw.coding_model_protection_count(backend) == 1
    assert kw.release_coding_model("request-2") is True
    assert kw.coding_model_protection_count() == 0
    assert backend.calls == [] and backend.is_loaded
    backend.unload_model()
    assert backend.calls == ["unload"]


def test_token_cannot_retarget_and_stale_identity_cannot_publish():
    backend = FakeLlama()
    protect("owner", backend)
    with pytest.raises(ValueError, match = "retargeted"):
        protect("owner", FakeLlama("org/B"))
    assert_protected(lambda: kw.hold_coding_model("stale", backend, identity = ("org/B",)))
    assert kw.coding_model_protection_count() == 1


def test_removed_slot_cannot_be_protected():
    slot = slots.ExtraSlot(FakeLlama(), FakeOrchestrator(), "owner")
    assert_protected(lambda: protect("owner", slot.llama, slot))
    assert kw.coding_model_protection_count() == 0


@pytest.mark.parametrize("phase", ["tool", "unanswered-question", "delegated-activity", "failed-cancellation-cleanup"])
def test_hold_survives_inference_gaps_without_ttl_or_task_callbacks(phase, monkeypatch):
    backend = FakeLlama()
    protect("native-request", backend)
    # The HTTP inference has finished, but native request cleanup has not succeeded.
    kw._note_pending()
    kw._note_start()
    kw._note_end()
    monkeypatch.setattr(kw, "_last_active", -1e20)
    assert kw._is_idle(1)  # HTTP counters alone are idle; the independent host hold is not.
    assert_protected(backend.unload_model)
    assert kw.coding_model_protection_count(backend) == 1
    assert backend.is_loaded


def test_mutation_and_hold_publication_are_atomic_without_serializing_independent_slots():
    backend, other = FakeLlama(), FakeLlama("org/B")
    entered, finish = threading.Event(), threading.Event()

    def maintenance():
        with kw.coding_model_mutation(backend):
            entered.set()
            assert finish.wait(2)

    thread = threading.Thread(target = maintenance)
    thread.start()
    assert entered.wait(2)
    try:
        assert_protected(lambda: protect("racing", backend))
        protect("independent", other)
    finally:
        finish.set()
        thread.join(2)
    assert not thread.is_alive()
    protect("racing", backend)
    assert kw.coding_model_protection_count() == 2
    assert kw._coding_mutations == []


def test_failed_mutation_cleanup_does_not_release_another_hold():
    backend = FakeLlama()
    protect("owner", backend)
    with pytest.raises(OSError):
        with kw.coding_model_mutation(FakeLlama("org/B")):
            raise OSError("deterministic cleanup failure")
    assert kw._coding_mutations == []
    assert kw.coding_model_protection_count(backend) == 1
    assert_protected(backend.unload_model)


@pytest.mark.parametrize("operation", ["load", "unload", "kill", "cleanup"])
def test_real_llama_lower_owner_guards_precede_any_destructive_side_effect(operation):
    # __new__ deliberately has no process locks, cancellation event, or callable process.
    # A guard must fire before production tries to touch any of them.
    backend = LlamaCppBackend.__new__(LlamaCppBackend)
    backend._process = object()
    backend._healthy = True
    backend._model_identifier = "org/A"
    backend._hf_variant = "Q4_K_M"
    protect("owner", backend)
    call = {
        "load": lambda: backend.load_model(None),
        "unload": backend.unload_model,
        "kill": lambda: backend._kill_process(teardown = True),
        "cleanup": backend._cleanup,
    }[operation]
    assert_protected(call)
    assert backend._process is not None and backend._healthy
    assert kw.coding_model_protection_count(backend) == 1


@pytest.mark.parametrize("operation", ["load", "unload", "cancel", "respawn", "shutdown", "locked-shutdown", "cleanup"])
def test_real_orchestrator_lower_owner_guards_precede_worker_mutation(operation):
    backend = InferenceOrchestrator.__new__(InferenceOrchestrator)
    backend.active_model_name = "org/A"
    protect("owner", backend)
    call = {
        "load": lambda: backend.load_model(None),
        "unload": lambda: backend.unload_model("org/A"),
        "cancel": lambda: backend.cancel_load("org/A"),
        "respawn": backend._shutdown_before_respawn,
        "shutdown": backend._shutdown_subprocess,
        "locked-shutdown": lambda: backend._shutdown_subprocess_locked(1),
        "cleanup": backend._cleanup,
    }[operation]
    assert_protected(call)
    assert backend.active_model_name == "org/A"


def test_protected_extra_slot_is_not_victim_and_unrelated_slot_can_be_dropped():
    protected = slots.ExtraSlot(FakeLlama(), FakeOrchestrator(), "owner")
    independent = slots.ExtraSlot(FakeLlama("org/B"), FakeOrchestrator(), "owner")
    slots.slots[:] = [protected, independent]
    protect("owner", protected.llama, protected)
    assert slots.eviction_victims(None, 1) == [independent]
    assert slots.claim_victim(protected) is False
    assert_protected(lambda: slots.drop(protected))
    assert slots.unload_idle() == 1
    assert slots.slots == [protected]
    assert protected.llama.calls == []
    assert independent.llama.calls == ["unload"]
    # The counterpart worker belongs to the protected slot as well.
    assert_protected(lambda: kw.require_coding_model_unprotected(protected.orchestrator))


@pytest.mark.parametrize("strict", [False, True])
def test_management_unload_all_refuses_before_partial_cleanup(strict):
    independent = slots.ExtraSlot(FakeLlama("org/B"), FakeOrchestrator(), "owner")
    protected = slots.ExtraSlot(FakeLlama(), FakeOrchestrator(), "owner")
    slots.slots[:] = [independent, protected]
    protect("owner", protected.llama, protected)
    assert_protected(lambda: slots.unload_extra_models(strict = strict))
    assert slots.slots == [independent, protected]
    assert independent.llama.calls == []
    assert slots.unload_extra_models(lambda _: False, spare_filling = True) == 1
    assert slots.slots == [protected]


def test_sidecar_worker_maintenance_refuses_protected_extra_before_any_drop():
    slot = slots.ExtraSlot(FakeLlama(None), FakeOrchestrator("org/A"), "owner")
    slots.slots.append(slot)
    protect("owner", slot.orchestrator, slot)
    assert_protected(slots.stop_orchestrator_workers)
    assert slot in slots.slots and slot.orchestrator.calls == []


def test_arbiter_cannot_handoff_a_protected_chat_even_with_forceful_eviction(monkeypatch):
    backend = FakeLlama()
    protect("owner", backend)
    monkeypatch.setattr(arb, "_owner", arb.CHAT)
    calls = []
    monkeypatch.setitem(arb._EVICTORS, arb.CHAT, lambda: calls.append("evict"))
    assert_protected(lambda: arb.acquire_for(arb.DIFFUSION, allow_evict = True, replacing = True))
    assert arb.current_owner() == arb.CHAT and calls == []
    # A same-owner assertion or independent alongside admission is not a GPU handoff.
    arb.acquire_for(arb.CHAT)
    arb.acquire_for(arb.CHAT, lambda: calls.append("alongside"), alongside = True)
    assert calls == ["alongside"]
    kw.release_coding_model("owner")
    arb.acquire_for(arb.DIFFUSION)
    assert calls == ["alongside", "evict"]


@pytest.mark.parametrize("resident_order", [(arb.DIFFUSION, arb.CHAT), (arb.CHAT, arb.DIFFUSION)])
def test_arbiter_protects_parked_chat_before_evicting_any_resident(monkeypatch, resident_order):
    backend = FakeLlama()
    protect("owner", backend)
    resident = dict.fromkeys(resident_order)
    monkeypatch.setattr(arb, "_owner", arb.DIFFUSION)
    monkeypatch.setattr(arb, "_residents", dict(resident))
    calls = []
    for name in resident_order:
        monkeypatch.setitem(arb._EVICTORS, name, lambda name = name: calls.append(name))
    assert_protected(lambda: arb.acquire_for(arb.VIDEO))
    assert calls == []
    assert arb.current_owner() == arb.DIFFUSION
    assert arb.residents() == resident
    assert kw.coding_model_protection_count(backend) == 1
    kw.release_coding_model("owner")
    arb.acquire_for(arb.VIDEO)
    assert calls == list(resident_order)
    assert arb.residents() == {arb.VIDEO: None}


def test_forced_primary_and_extra_route_guards_refuse_before_cancelling(monkeypatch):
    backend = FakeLlama()
    monkeypatch.setattr(inf, "_llama_cpp_backend", backend)
    monkeypatch.setattr(inf, "_peek_inference_backend", lambda: FakeOrchestrator())
    protect("primary", backend)
    assert_protected(lambda: inf._raise_or_cancel_active_generations(force = True, action = "Forced reload"))
    event = threading.Event()
    slot = slots.ExtraSlot(FakeLlama("org/B"), FakeOrchestrator(), "owner", generations = {event})
    slots.slots.append(slot)
    protect("extra", slot.llama, slot)
    assert_protected(lambda: inf._raise_or_cancel_slot_generations(slot, force = True))
    assert not event.is_set()


@pytest.fixture
def admission(monkeypatch):
    primary, backend = FakeLlama(), FakeOrchestrator()
    monkeypatch.setattr(inf, "_llama_cpp_backend", primary)
    monkeypatch.setattr(orchestrator, "_inference_backend", backend)

    async def no_drafter(_):
        pass

    monkeypatch.setattr(inf, "_require_drafter_access", no_drafter)
    request = Request({"type": "http", "method": "POST", "path": "/api/coding/local-models/acquire", "headers": []})

    def acquire(model = "org/A:Q4_K_M", token = "owner", **kwargs):
        return asyncio.run(inf.load_model_for_coding(LoadRequest(model_path = model, **kwargs), request, "subject", token))

    return primary, backend, acquire


def test_coding_admission_borrows_exact_resident_without_reconfiguration(admission, monkeypatch):
    primary, _, acquire = admission

    async def forbidden(*args, **kwargs):
        raise AssertionError("Resident borrow must not call any loader")

    monkeypatch.setattr(inf, "_run_tracked_load_model_impl", forbidden)
    hold = acquire(force_reload = True, context_length = 8192, force_cancel_active = True)
    assert hold.backend is primary and hold.slot is None
    assert hold.identity == kw.coding_model_identity(primary)
    assert primary.calls == []
    acquire(token = "independent")
    assert kw.coding_model_protection_count(primary) == 2


def test_coding_admission_borrows_exact_kept_slot_with_primary_busy(admission):
    primary, _, acquire = admission
    slot = slots.ExtraSlot(FakeLlama("org/B", "Q8_0"), FakeOrchestrator(), "owner")
    slots.slots.append(slot)
    hold = acquire("org/B:Q8_0")
    assert hold.backend is slot.llama and hold.slot is slot
    assert kw.coding_model_protection_count(primary) == 0
    assert kw.coding_model_protection_count(slot = slot) == 1
    assert orchestrator.routed_slot.get() is None


@pytest.mark.parametrize("busy", ["primary", "variant", "loading", "kept", "stuck", "decisions", "diffusion", "video"])
def test_coding_admission_never_replaces_or_evicts_other_work(admission, monkeypatch, busy):
    primary, backend, acquire = admission
    requested = "org/B:Q4_K_M"
    if busy != "primary":
        primary.is_loaded = primary.is_active = False
    if busy == "variant":
        primary.is_loaded = primary.is_active = True
        requested = "org/A:Q8_0"
    if busy == "loading":
        backend.loading_models.add("org/loading")
    if busy == "kept":
        slots.slots.append(slots.ExtraSlot(FakeLlama("org/C"), FakeOrchestrator(), "owner"))
    if busy == "stuck":
        slots.stuck.append(slots.ExtraSlot(FakeLlama("org/C"), FakeOrchestrator(), "owner"))
    if busy in ("decisions", "diffusion", "video"):
        monkeypatch.setattr(arb, "_owner", busy)
    with pytest.raises(HTTPException) as error:
        acquire(requested)
    assert error.value.status_code == 409
    assert error.value.detail["error"] == "coding_model_busy"
    assert primary.calls == [] and kw.coding_model_protection_count() == 0


def test_empty_admission_disables_force_and_publishes_before_unlock(admission, monkeypatch):
    primary, _, acquire = admission
    primary.is_loaded = primary.is_active = False
    observed = []

    async def load(request, fastapi_request, subject, **kwargs):
        assert kw._load_lock.locked() and kw._lifecycle_lock.locked()
        assert kwargs["allow_gpu_owner_eviction"] is False
        assert not request.force_cancel_active and not request.force_reload and not request.alongside
        kwargs["on_reload_confirmed"](cancel = True)
        primary.is_loaded = primary.is_active = True
        observed.append("loaded")

    original_hold = kw.hold_coding_model

    def hold(*args, **kwargs):
        assert kw._load_lock.locked() and kw._lifecycle_lock.locked()
        observed.append("held")
        return original_hold(*args, **kwargs)

    monkeypatch.setattr(inf, "_run_tracked_load_model_impl", load)
    monkeypatch.setattr(kw, "hold_coding_model", hold)
    assert acquire(force_reload = True, force_cancel_active = True, alongside = True).backend is primary
    assert observed == ["loaded", "held"]
    assert not kw._load_lock.locked() and not kw._lifecycle_lock.locked()


@pytest.mark.parametrize("background", [False, True])
def test_tracked_non_evicting_load_preserves_upstream_kwargs_and_warning_context(monkeypatch, background):
    response = {"loaded": True}
    external_cancel = threading.Event()
    observed = []

    async def load(request, fastapi_request, subject, **kwargs):
        assert kwargs["allow_gpu_owner_eviction"] is False
        assert kwargs["cache_environment"] == {"HF_HOME": "/isolated-cache"}
        assert kwargs["load_cancel_event"] is inf._running_load_attempt.cancel_event
        assert not kwargs["load_cancel_event"].is_set()
        assert inf._load_warnings_reach_user.get() is (not background)
        observed.append(subject)
        return response

    monkeypatch.setattr(inf, "_load_model_impl", load)
    assert asyncio.run(inf._run_tracked_load_model_impl(
        LoadRequest(model_path = "org/A"), None, "subject",
        allow_gpu_owner_eviction = False,
        impl_kwargs = {"cache_environment": {"HF_HOME": "/isolated-cache"}, "load_cancel_event": external_cancel},
        background = background,
    )) is response
    assert observed == ["subject"]
    assert inf._running_load_attempt is None
    assert inf._load_warnings_reach_user.get() is False


def test_failed_admission_keeps_existing_hold_and_never_publishes_new_owner(admission, monkeypatch):
    primary, _, acquire = admission
    protect("existing", primary)
    with pytest.raises(HTTPException):
        acquire("org/B", token = "new")
    assert kw.coding_model_protection_count(primary) == 1
    assert kw.release_coding_model("new") is False
    assert primary.calls == []


def test_queued_coding_admission_checks_resident_after_the_gate_not_at_selection(admission):
    primary, _, _ = admission
    request = Request({"type": "http", "method": "POST", "path": "/api/coding/local-models/acquire", "headers": []})

    async def drive():
        async with kw.model_load_gate():
            task = asyncio.create_task(inf.load_model_for_coding(
                LoadRequest(model_path = "org/A:Q4_K_M"), request, "subject", "queued"
            ))
            await asyncio.sleep(0)
            assert not task.done()
            primary.model_identifier = "org/different"
        with pytest.raises(HTTPException) as error:
            await task
        assert error.value.status_code == 409

    asyncio.run(drive())
    assert kw.coding_model_protection_count() == 0 and primary.calls == []


def test_failed_loader_does_not_publish_a_hold_or_unload_a_partial_resident(admission, monkeypatch):
    primary, _, acquire = admission
    primary.is_loaded = primary.is_active = False

    async def fail(*args, **kwargs):
        primary.is_loaded = primary.is_active = True
        raise HTTPException(status_code = 503, detail = "deterministic loader failure")

    monkeypatch.setattr(inf, "_run_tracked_load_model_impl", fail)
    with pytest.raises(HTTPException) as error:
        acquire()
    assert error.value.status_code == 503
    assert kw.coding_model_protection_count() == 0 and primary.calls == []
    assert not kw._load_lock.locked() and not kw._lifecycle_lock.locked()


@pytest.mark.parametrize("target", ["primary", "extra"])
def test_forced_unload_endpoint_cannot_bypass_request_hold(admission, target):
    primary, _, _ = admission
    name = "org/A"
    if target == "extra":
        slot = slots.ExtraSlot(FakeLlama("org/B"), FakeOrchestrator(), "owner")
        slots.slots.append(slot)
        protect("owner", slot.llama, slot)
        name = "org/B"
    else:
        protect("owner", primary)
    assert_protected(lambda: asyncio.run(inf._unload_model_impl(
        UnloadRequest(model_path = name, force_cancel_active = True), "subject"
    )))
    assert kw.coding_model_protection_count() == 1


@pytest.mark.parametrize("target,force", [("primary", False), ("primary", True), ("extra", True)])
def test_transformers_installer_refuses_protected_workers_before_any_staging(admission, monkeypatch, target, force):
    import core.export as export
    import core.training as training
    from utils import transformers_latest, transformers_version

    _, backend, _ = admission
    if target == "primary":
        backend.active_model_name = "org/A"
        protect("owner", backend)
    else:
        slot = slots.ExtraSlot(FakeLlama(None), FakeOrchestrator("org/B"), "owner")
        slots.slots.append(slot)
        protect("owner", slot.orchestrator, slot)
    idle = SimpleNamespace(is_training_active = lambda: False, is_export_active = lambda: False, current_checkpoint = None)
    monkeypatch.setattr(training, "get_training_backend", lambda: idle)
    monkeypatch.setattr(export, "get_export_backend", lambda: idle)
    monkeypatch.setattr(transformers_version, "try_begin_sidecar_swap", lambda: True)
    ended = []
    monkeypatch.setattr(transformers_version, "end_sidecar_swap", lambda: ended.append(True))

    def forbidden(*args):
        raise AssertionError("A protected sidecar must be refused before installation starts")

    monkeypatch.setattr(transformers_latest, "install_latest_transformers", forbidden)
    assert_protected(lambda: asyncio.run(inf.install_latest_transformers_route(
        InstallLatestTransformersRequest(version = "5.0.0", force_cancel_active = force), "subject"
    )))
    assert ended == [True]
    assert kw.coding_model_protection_count() == 1
    assert backend.calls == []


def test_idle_tick_spares_protection_through_tools_gap_and_frees_independent_slot(admission, monkeypatch):
    from core.inference import media_keepwarm
    from utils import openai_auto_switch_settings as settings

    primary, _, _ = admission
    protected = slots.ExtraSlot(FakeLlama("org/B"), FakeOrchestrator(), "owner")
    independent = slots.ExtraSlot(FakeLlama("org/C"), FakeOrchestrator(), "owner")
    slots.slots[:] = [protected, independent]
    protect("primary", primary)
    protect("extra", protected.llama, protected)
    ticks = []

    def ttl():
        ticks.append(True)
        kw._last_active = -1e20
        return 1

    async def no_media():
        pass

    monkeypatch.setattr(settings, "get_auto_unload_idle_seconds", ttl)
    monkeypatch.setattr(settings, "get_auto_unload_api_only", lambda: False)
    monkeypatch.setattr(media_keepwarm, "idle_unload_step", no_media)
    monkeypatch.setattr(inf, "release_chat_gpu_claim", lambda: None)

    async def drive():
        task = asyncio.create_task(kw.idle_unload_loop(0.001))
        try:
            for _ in range(1000):
                if len(ticks) >= 3:
                    break
                await asyncio.sleep(0.001)
            assert len(ticks) >= 3
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    asyncio.run(drive())
    assert slots.slots == [protected]
    assert primary.calls == protected.llama.calls == []
    assert independent.llama.calls == ["unload"]
    assert kw.coding_model_protection_count() == 2
