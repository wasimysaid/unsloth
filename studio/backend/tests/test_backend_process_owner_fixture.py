# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Shared ownership teardown releases real test logs without replacing backend cleanup."""

import atexit

from . import conftest as shared
from core.inference.llama_cpp import LlamaCppBackend


def test_test_owned_backends_release_real_logs_after_assertions(monkeypatch, tmp_path):
    monkeypatch.setattr(LlamaCppBackend, "_kill_orphaned_servers", lambda self: 0)
    fixture = shared._own_test_llama_backends.__wrapped__()
    next(fixture)
    owners = []
    handles = []
    try:
        for index in range(3):
            owner = LlamaCppBackend()
            handle = (tmp_path / f"attempt-{index}.log").open("w")
            owner._llama_log_fh = handle
            owners.append(owner)
            handles.append(handle)
        assert all(not handle.closed for handle in handles)
        assert all(not getattr(owner, "_shutting_down", False) for owner in owners)
    finally:
        fixture.close()
    assert all(handle.closed for handle in handles)
    assert all(owner._llama_log_fh is None for owner in owners)
    assert all(owner._shutting_down for owner in owners)


def test_non_backend_exit_callbacks_remain_owned_by_the_caller():
    called = []

    class OtherOwner:
        def _cleanup(self):
            called.append("other")

    owner = OtherOwner()
    fixture = shared._own_test_llama_backends.__wrapped__()
    next(fixture)
    try:
        assert atexit.register(owner._cleanup) == owner._cleanup
    finally:
        fixture.close()
        atexit.unregister(owner._cleanup)
    assert called == []
