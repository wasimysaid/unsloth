# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Direct-call test teardown owns scopes, not the middleware's live counters."""

from . import conftest as shared
from core.inference import llama_keepwarm as keepwarm


def test_direct_admissions_live_through_assertions_and_end_with_the_test():
    before = keepwarm.other_admitted_inference_count()
    fixture = shared._own_direct_inference_requests.__wrapped__()
    next(fixture)
    scopes = [{"path": "/v1/chat/completions"}, {"path": "/v1/responses"}]
    try:
        for scope in scopes:
            keepwarm.note_admitted_inference(scope)
            keepwarm.note_admitted_inference(scope)  # Real per-scope idempotence.
        assert keepwarm.other_admitted_inference_count() == before + 2
        assert all(scope[keepwarm._ADMITTED_SCOPE_KEY] for scope in scopes)
    finally:
        fixture.close()
    assert keepwarm.other_admitted_inference_count() == before
    assert all(keepwarm._ADMITTED_SCOPE_KEY not in scope for scope in scopes)


def test_middleware_owned_admissions_are_not_released_by_test_teardown():
    before = keepwarm.other_admitted_inference_count()
    scope = {"path": "/v1/chat/completions", keepwarm._TRACKED_SCOPE_KEY: True}
    fixture = shared._own_direct_inference_requests.__wrapped__()
    next(fixture)
    try:
        keepwarm.note_admitted_inference(scope)
        fixture.close()
        assert keepwarm.other_admitted_inference_count() == before + 1
        assert scope[keepwarm._ADMITTED_SCOPE_KEY] is True
    finally:
        fixture.close()
        keepwarm.untrack_admitted_inference(scope)
    assert keepwarm.other_admitted_inference_count() == before


def test_preexisting_admissions_remain_owned_by_the_caller():
    before = keepwarm.other_admitted_inference_count()
    scope = {"path": "/v1/chat/completions"}
    keepwarm.note_admitted_inference(scope)
    fixture = shared._own_direct_inference_requests.__wrapped__()
    next(fixture)
    try:
        keepwarm.note_admitted_inference(scope)
        fixture.close()
        assert keepwarm.other_admitted_inference_count() == before + 1
        assert scope[keepwarm._ADMITTED_SCOPE_KEY] is True
    finally:
        fixture.close()
        keepwarm.untrack_admitted_inference(scope)
    assert keepwarm.other_admitted_inference_count() == before


def test_a_route_released_scope_is_not_decremented_twice():
    before = keepwarm.other_admitted_inference_count()
    fixture = shared._own_direct_inference_requests.__wrapped__()
    next(fixture)
    scope = {"path": "/v1/chat/completions"}
    try:
        keepwarm.note_admitted_inference(scope)
        assert keepwarm.other_admitted_inference_count() == before + 1
        keepwarm.untrack_admitted_inference(scope)
        assert keepwarm.other_admitted_inference_count() == before
    finally:
        fixture.close()
    assert keepwarm.other_admitted_inference_count() == before
