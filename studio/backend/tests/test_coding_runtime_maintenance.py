# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""CPU-only runtime-tree maintenance regressions for whole coding-request holds."""

import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from core.inference import llama_keepwarm as kw
from core.inference import model_slots, orchestrator
from routes import inference
from utils import llama_cpp_update as updater
from utils import transformers_version as transformers


class Llama:
    def __init__(self):
        self._serial_load_lock = threading.Lock()
        self._llama_update_in_progress = False
        self.is_loaded = self.is_active = True
        self.model_identifier = "org/model"
        self.hf_variant = "Q4_K_M"
        self.calls = []

    @kw.guards_coding_model("Unloading the model")
    def unload_model(self):
        self.calls.append("unload")
        self.is_loaded = self.is_active = False


@pytest.fixture(autouse = True)
def owners(monkeypatch):
    monkeypatch.setattr(kw, "_coding_holds", {})
    monkeypatch.setattr(kw, "_coding_mutations", [])
    monkeypatch.setattr(model_slots, "slots", [])
    monkeypatch.setattr(model_slots, "stuck", [])
    monkeypatch.setattr(model_slots, "loading", None)
    previous = orchestrator.routed_slot.set(None)
    monkeypatch.setattr(orchestrator, "_inference_backend", None)
    yield
    orchestrator.routed_slot.reset(previous)


def prepare_update(monkeypatch, tmp_path, llama):
    binary = tmp_path / "llama.cpp" / "llama-server"
    monkeypatch.setattr(updater, "_find_binary", lambda: binary)
    monkeypatch.setattr(inference, "get_llama_cpp_backend", lambda: llama)
    monkeypatch.setattr(updater, "read_install_marker", lambda _: {"release_tag": "test-tag"})
    monkeypatch.setattr(updater, "_block_mtmd_sidecar", lambda _: False)
    monkeypatch.setattr(updater, "reset_caches", lambda **_: None)
    monkeypatch.setattr(updater, "latest_published_release", lambda *_, **__: None)
    calls = []
    monkeypatch.setattr(updater._flow, "stream_installer", lambda *_, **__: calls.append("install"))
    return calls


def run_update(tmp_path):
    return updater._run_llama_phase(
        tmp_path / "llama.cpp", "example/llama", None,
        tmp_path / "installer.py", None, lambda _: None,
    )


@pytest.mark.parametrize("maintenance_flag", [False, True])
def test_protected_primary_update_cannot_swallow_unload_refusal_and_install(monkeypatch, tmp_path, maintenance_flag):
    llama = Llama()
    llama._llama_update_in_progress = maintenance_flag
    calls = prepare_update(monkeypatch, tmp_path, llama)
    identity = kw.coding_model_identity(llama)
    hold = kw.hold_coding_model("native-owner", llama, identity = identity)
    with pytest.raises(HTTPException) as error:
        run_update(tmp_path)
    assert error.value.status_code == 409
    assert error.value.detail["error"] == "coding_model_protected"
    assert calls == llama.calls == []
    assert llama.is_loaded and llama.is_active
    assert kw.coding_model_identity(llama) == identity
    assert llama._llama_update_in_progress is maintenance_flag
    assert kw.coding_model_protection_count(llama) == 1
    assert kw._coding_holds["native-owner"] is hold
    assert kw._coding_mutations == []


def test_primary_mutation_fence_spans_caught_teardown_error_and_installer(monkeypatch, tmp_path):
    llama = Llama()
    prepare_update(monkeypatch, tmp_path, llama)

    def failed_unload():
        raise RuntimeError("deterministic teardown failure")

    llama.unload_model = failed_unload
    observed = []

    def install(*args, **kwargs):
        # Existing best-effort teardown semantics are preserved, but publication of a
        # new coding hold cannot slip into the swallowed-error/runtime-swap interval.
        assert llama._llama_update_in_progress
        with pytest.raises(HTTPException) as error:
            kw.hold_coding_model("racing-owner", llama, identity = kw.coding_model_identity(llama))
        assert error.value.status_code == 409
        observed.append("install")

    monkeypatch.setattr(updater._flow, "stream_installer", install)
    run_update(tmp_path)
    assert observed == ["install"]
    assert not llama._llama_update_in_progress
    assert kw._coding_mutations == []
    kw.hold_coding_model("after-maintenance", llama, identity = kw.coding_model_identity(llama))
    assert kw.coding_model_protection_count(llama) == 1


@pytest.mark.parametrize("stuck", [False, True])
@pytest.mark.parametrize("primary_unavailable", [False, True])
def test_latest_repair_refuses_a_protected_kept_worker_before_staging(monkeypatch, tmp_path, stuck, primary_unavailable):
    import core.export as export
    import core.training as training
    import core.inference as core_inference

    idle = SimpleNamespace(is_training_active = lambda: False, is_export_active = lambda: False, is_worker_alive = lambda: False)
    monkeypatch.setattr(training, "get_training_backend", lambda: idle)
    monkeypatch.setattr(export, "get_export_backend", lambda: idle)
    primary = SimpleNamespace(active_model_name = None, loading_models = set(), is_worker_alive = lambda: False)
    monkeypatch.setattr(orchestrator, "_inference_backend", primary)
    if primary_unavailable:
        def unavailable():
            raise RuntimeError("deterministic primary lookup failure")
        monkeypatch.setattr(core_inference, "get_inference_backend", unavailable)
    worker = SimpleNamespace(active_model_name = "org/kept", loading_models = set(), is_worker_alive = lambda: True)
    slot = model_slots.ExtraSlot(SimpleNamespace(is_active = False), worker, "owner")
    model_slots.slots.append(slot)
    identity = kw.coding_model_identity(worker)
    kw.hold_coding_model("native-owner", worker, slot = slot, identity = identity)
    if stuck:
        model_slots.slots.remove(slot)
        model_slots.stuck.append(slot)
    monkeypatch.setattr(transformers, "_latest_pin_data", lambda: {"version": "5.99.0", "packages": ["transformers==5.99.0"]})
    monkeypatch.setattr(transformers, "_venv_dir_health", lambda *args: (False, True))
    monkeypatch.setattr(transformers, "_request_latest_repair", lambda: None)
    monkeypatch.setattr(transformers, "_env_offline", lambda: False)
    monkeypatch.setattr(transformers, "try_begin_sidecar_swap", lambda **kwargs: True)
    ended = []
    monkeypatch.setattr(transformers, "end_sidecar_swap", lambda: ended.append(True))
    staged = []
    monkeypatch.setattr(transformers, "_stage_and_swap_latest_venv", lambda *args: staged.append(True) or True)
    assert not transformers._ensure_venv_t5_latest_exists()
    assert not staged and ended == [True]
    assert worker.active_model_name == "org/kept"
    assert kw.coding_model_protection_count(worker) == 1


def test_protected_teardown_callback_exception_leaves_latest_tree_and_hold_intact(monkeypatch, tmp_path):
    live = tmp_path / "latest"
    live.mkdir()
    (live / "sentinel").write_text("resident-runtime")
    monkeypatch.setattr(transformers, "_VENV_T5_LATEST_DIR", str(live))

    def stage(target, packages, label):
        Path(target).mkdir()
        return True

    monkeypatch.setattr(transformers, "_ensure_venv_dir", stage)
    llama = Llama()
    kw.hold_coding_model("native-owner", llama, identity = kw.coding_model_identity(llama))
    assert not transformers._stage_and_swap_latest_venv(
        "5.99.0", ("transformers==5.99.0",), before_swap = llama.unload_model
    )
    assert (live / "sentinel").read_text() == "resident-runtime"
    assert llama.calls == [] and llama.is_loaded
    assert kw.coding_model_protection_count(llama) == 1
    assert not Path(str(live) + ".staging").exists()
