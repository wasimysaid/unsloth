# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Source contracts for a cancellable generalized compare run.

A Stop during the sequential compare `/load` must abort the browser request *and*
reconcile the backend, which keeps running the load it was already issued. The
contracts below pin the ownership object that makes that reconciliation
identity-safe, and the composer/chat-page call sites that use it.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHAT = ROOT / "studio" / "frontend" / "src" / "features" / "chat"


def _read(*parts: str) -> str:
    return (CHAT.joinpath(*parts)).read_text()


def test_ownership_module_keeps_one_active_run():
    ownership = _read("compare-run-ownership.ts")
    assert "export class CompareRunOwnership" in ownership
    assert "this.activeRun?.controller.abort();" in ownership
    assert "owns(run: CompareRun<Model>): boolean" in ownership
    assert "cancelCurrent(): CompareRun<Model> | null" in ownership
    assert "throwIfCompareCancelled" in ownership
    assert "isCompareCancellation" in ownership


def test_composer_aborts_the_load_and_reconciles_the_backend():
    composer = _read("shared-composer.tsx")
    assert "cancelCompareBackendLoad" in composer
    # The unload is the backend's cancellation path; without it the aborted fetch
    # leaves the server-side load running.
    assert "await unloadModel({ model_path: modelId });" in composer
    assert "getInferenceStatus()" in composer
    assert "COMPARE_CANCEL_SETTLED_OBSERVATIONS" in composer
    assert "status.loading" in composer

    stop = composer.split("function stop() {", 1)[1].split("\n  }", 1)[0]
    assert "compareRunsRef.current.cancelCurrent()" in stop
    assert "cancelCompareBackendLoad(loadingModel.id)" in stop
    # The run's own signal must abort the browser request.
    assert "signal: compareSignal" in composer
    assert "compareRunsRef.current.begin()" in composer


def test_unload_target_is_named_only_at_the_request_boundary():
    """Stop during token validation must not unload a model no request replaced."""
    composer = _read("shared-composer.tsx")
    load = composer.split("const resp = await loadModel(", 1)[1]
    # The only pre-request assignment may resolve the owning run; naming the
    # cancellation target before the request would let Stop evict a resident
    # same-ID model while the load is still validating its token.
    preamble = composer.split("const resp = await loadModel(", 1)[0]
    preamble = preamble.split("async function ensureModelLoaded(", 1)[1]
    assert "setLoadingModel" not in preamble
    assert "const run = compareRunsRef.current.current();" in preamble
    boundary = load.split("onRequestStart: () => {", 1)[1].split("},", 1)[0]
    assert "setLoadingModel(run, sel)" in boundary


def test_composer_releases_ownership_only_after_reconciliation():
    composer = _read("shared-composer.tsx")
    catch = composer.split("} catch (err) {", 1)[1].split("} finally {", 1)[0]
    assert "await run.cleanup;" in catch
    assert "cleanupError = error;" in catch
    assert "isCompareCancellation(err, compareSignal)" in catch
    # The compare run's own finally block, after its catch.
    after_catch = composer.split("} catch (err) {", 1)[1]
    finally_block = after_catch.split("} finally {", 1)[1].split("\n    } else {", 1)[0]
    assert "await run.cleanup.catch(() => undefined);" in finally_block
    assert "compareRunsRef.current.release(run)" in finally_block


def test_compare_layout_keeps_the_pane_identity():
    page = _read("chat-page.tsx")
    general = page.split("const GeneralCompareContent = memo(", 1)[1]
    assert "isLora: loraModels.some(" in general
    assert "onComparingChange={handleComparingChange}" in general
    assert "compareSubmittingRef.current += 1;" in general
    assert "if (compareSubmittingRef.current !== submittedAt) return;" in general
