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
FEATURES = ROOT / "studio" / "frontend" / "src" / "features"
CHAT = FEATURES / "chat"


def _read(*parts: str) -> str:
    return (CHAT.joinpath(*parts)).read_text()


def _read_feature(feature: str, *parts: str) -> str:
    return (FEATURES.joinpath(feature, *parts)).read_text()


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
    # leaves the server-side load running. It runs under a deadline so a pending
    # request cannot hold the compare's cleanup lease open.
    assert "await withCompareCancelDeadline((signal) =>" in composer
    assert "unloadModel(" in composer
    assert "readInferenceStatusWithinPollBudget(" in composer
    assert "COMPARE_CANCEL_SETTLED_OBSERVATIONS" in composer
    assert "status.loading" in composer

    stop = composer.split("function stop() {", 1)[1].split("\n  }", 1)[0]
    assert "compareRunsRef.current.cancelCurrent()" in stop
    assert "cancelCompareBackendLoad(" in stop
    # The unload names the attempt, not just the model.
    assert "run.loadingRequestId" in stop
    # The submitting run's own signal must abort the browser request.
    assert "signal: stoppedSignal" in composer
    assert "compareRunsRef.current.begin()" in composer


def test_cancellation_is_scoped_to_the_originating_load_attempt():
    """A Stop must cancel the load this run started, not whoever holds the slot."""
    composer = _read("shared-composer.tsx")
    ownership = _read("compare-run-ownership.ts")

    # A fresh request id per compare load, carried on both requests.
    assert "function newCompareLoadRequestId()" in composer
    assert "load_request_id: loadRequestId," in composer
    assert "cancel_load_request_id: loadRequestId" in composer
    assert "const loadRequestId = newCompareLoadRequestId();" in composer
    # Claimed at the request boundary alongside the model, never before it.
    boundary = composer.split("onRequestStart: () => {", 1)[1].split("},", 1)[0]
    assert "setLoadingModel(run, sel)" in boundary
    assert "setLoadingRequestId(run, loadRequestId)" in boundary
    # The id lives on the run, and is dropped once the load lands.
    assert "loadingRequestId: string | null;" in ownership
    assert "setLoadingRequestId(" in ownership
    assert "requestId: string | null," in ownership
    assert "run.loadingRequestId = null;" in ownership


def test_visible_target_retries_cancellation_instead_of_waiting_out():
    """A target that surfaces after the unload failure must still be cancelled.

    The first scoped `/unload` can fail before the load registers -- and the empty
    report that produces is not proof of absence either, since `onRequestStart` fires
    before the request is sent. The retry therefore runs every round, scoped to the
    attempt's own request id, so a request that registers late is still cancelled.
    """
    composer = _read("shared-composer.tsx")
    assert "if (loadRequestId) {" in composer
    assert "if (reported.length > 0 && loadRequestId) {" not in composer


def test_cancellation_poll_matches_the_reported_public_id():
    """The poll must not read a path-shaped id as a settled load."""
    composer = _read("shared-composer.tsx")
    assert "function compareLoadingStatusIds(modelId: string): string[]" in composer
    assert "publicModelId(modelId)" in composer
    assert "const statusIds = compareLoadingStatusIds(modelId);" in composer
    assert "reported.some((id) => statusIds.includes(id))" in composer
    assert "(status.loading ?? []).map((id) => id.trim().toLowerCase())" in composer
    # The raw-id comparison is the defect: it never matches the reported public id.
    assert "loadingId.toLowerCase() === modelId.toLowerCase()" not in composer


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


def test_cancellation_is_honored_across_preparation_and_generation():
    """Stop during preparation or after a generation must still stop the compare."""
    composer = _read("shared-composer.tsx")
    # The submitting signal is threaded into the helper instead of only being read
    # after its final await.
    assert "stoppedSignal: AbortSignal," in composer
    assert "const status1 = await ensureModelLoaded(model1, compareSignal);" in composer
    assert "const status2 = await ensureModelLoaded(model2, compareSignal);" in composer

    helper = composer.split("async function ensureModelLoaded(", 1)[1]
    helper = helper.split("const handle1 = handlesRef.current", 1)[0]
    # Entry plus every preparatory boundary: staged metadata, extra args, the GPU
    # cache, validation, and the confirmation dialogs.
    assert helper.count("throwIfCompareCancelled(stoppedSignal);") >= 6

    # Both generations are re-checked after their run ends, so a Stop during model
    # 2's generation cannot be reported as "Compare complete".
    generation = composer.split("const handle2 = handlesRef.current", 1)[1]
    generation = generation.split("if (compareRunsRef.current.owns(run)) {", 1)[0]
    assert generation.count("throwIfCompareCancelled(compareSignal);") >= 3


def test_successful_cancellation_reconciles_the_store_checkpoint():
    """A cancelled load that evicted the old runtime must not leave it selected."""
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    # The successful unload path re-derives residency from the backend, so the
    # checkpoint cannot keep naming a model this cancellation removed.
    success = cancel.split("} catch (unloadError) {", 1)[0]
    assert "resyncInferenceStatusAfterServerModelChange(signal)" in success


def test_unload_failure_never_settles_against_a_hidden_queued_attempt():
    """Absence from status.loading proves nothing while another load can hide it.

    The backend publishes at most one attempt -- the running one, else a single queued
    one -- so a cancelled attempt waiting behind another load is invisible there.
    """
    composer = _read("shared-composer.tsx")
    assert "COMPARE_CANCEL_MAX_STATUS_POLLS" in composer
    # Both visibility cases are named, and both stay unsettled: the target visible
    # because the retry has not landed yet, or another load hiding the queued target.
    assert "const targetStillLoading = reported.some((id) => statusIds.includes(id));" in composer
    assert "const anotherLoadVisible = reported.length > 0 && !targetStillLoading;" in composer
    assert "targetStillLoading || anotherLoadVisible" in composer
    # The retry re-cancels by request id on every round, including one whose report is
    # empty: a delayed request can register after three empty reads, so gating the retry
    # on visibility would let it load without a cancellation tombstone.
    assert "if (loadRequestId) {" in composer
    assert "if (reported.length > 0 && loadRequestId) {" not in composer
    retry = composer.split("if (loadRequestId) {", 1)[1]
    retry = retry.split("retriedCancellation = true;", 1)[0]
    assert "cancel_load_request_id: loadRequestId," in retry
    assert "unloadModel(" in retry
    assert "withCompareCancelDeadline(" in retry
    assert "(signal) =>" in retry
    # The poll is bounded, so an unrelated load cannot hang the run forever.
    assert "pollRounds < COMPARE_CANCEL_MAX_STATUS_POLLS" in composer


def test_compare_end_re_lists_history_without_a_run_transition():
    """An accepted compare that ends pre-generation must still re-list its history."""
    page = _read("chat-page.tsx")
    handler = page.split("const handleComparingChange = useCallback(", 1)[1]
    handler = handler.split("const handleModelsChange = useCallback(", 1)[0]
    assert "void listStoredChatThreads({ pairId })" in handler
    assert "resolveComparePaneThreadIds(threads)" in handler
    assert "if (compareSubmittingRef.current !== submittedAt) return;" in handler
    # The callback's own lookup is not effect-owned, so an unmount between the
    # request and its response must not set state on a dead component.
    assert "if (!compareMountedRef.current) return;" in handler
    assert "compareMountedRef.current = false;" in page
    # The lookup effect's own settle edge is untouched, so the existing
    # `anyRunning`-driven re-list still runs for a compare that did generate.
    assert page.count("}, [pairId, anyRunning]);") == 2


def test_cancellation_phase_starts_before_the_preparatory_awaits():
    """The Stop control must exist while the confirmation/GPU-cache waits run.

    Those awaits hold the model-lifecycle lease and reject further sends, so a
    run that is only claimed afterwards leaves that whole window uncancellable.
    """
    composer = _read("shared-composer.tsx")
    prep = composer.split("async function sendImpl(", 1)[1]
    confirmation = prep.index("await confirmStopRunningChatsIfNeeded(")
    gpu_cache = prep.index("await ensureGpuDeviceCache();")
    claimed = prep.index("ownedCompareRun = compareRunsRef.current.begin();")
    assert claimed < confirmation and claimed < gpu_cache
    # The pre-generation entry must not begin a second run, and must not throw past the
    # cleanup scope: the cancellation gate sits inside the try, so a Stop taken during
    # those preparatory awaits unwinds through the catch/finally instead of stranding the
    # run, the lifecycle lease and the busy state.
    entry = prep.split('const toastId = toast("Comparing models…"', 1)[1]
    before_try = entry.split("try {", 1)[0]
    assert "compareRunsRef.current.begin()" not in before_try
    assert "throwIfCompareCancelled(" not in before_try
    protected = entry.split("try {", 1)[1]
    assert "throwIfCompareCancelled(compareSignal);" in protected
    # The draft clear and both prompt appends must also sit past that gate: a Stop
    # taken during those awaits otherwise erases the draft and persists a comparison
    # in both pane histories even though neither side generates.
    assert "clearSubmittedDraft();" not in before_try
    assert "appendMessage(content);" not in before_try
    gated = protected.split("throwIfCompareCancelled(compareSignal);", 1)[1]
    gated = gated.split("const status1 = await ensureModelLoaded", 1)[0]
    assert "clearSubmittedDraft();" in gated
    assert gated.count("appendMessage(content);") == 2
    # Every early return inside that window abandons the claimed run: the confirmation
    # throwing, it declining, and the GPU device-cache failing each release directly,
    # while both draft-changed exits go through the shared helper.
    window = prep[: prep.index("const handle1 = handlesRef.current[")]
    helper = prep.split("const keepChangedDraft = () => {", 1)[1].split("\n    };", 1)[0]
    assert "abandonCompareRun();" in helper
    # Both draft-changed exits route through that helper, so neither can forget it.
    assert window.count("keepChangedDraft();") == 2
    # Excluding the helper's own call, the three direct exits release themselves:
    # confirmation threw, confirmation declined, GPU device cache failed.
    direct = window.replace(helper, "")
    assert direct.count("abandonCompareRun();") == 3


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


def test_pending_compare_history_survives_a_rejected_send():
    """History invalidation must follow an accepted run, not every send attempt."""
    composer = _read("shared-composer.tsx")
    # The panes are claimed only once the run is accepted, past the cheap pre-flight
    # returns that can still reject a send before any compare state is entered.
    acceptance = composer.split(
        "ownedCompareRun = compareRunsRef.current.begin();", 1
    )[1].split("\n    }", 1)[0]
    assert "onComparingChange?.(true);" in acceptance
    # The claim is released with the run's ownership, and not around the whole send.
    release = composer.split("if (compareRunsRef.current.release(run)) {", 1)[1]
    release = release.split("\n      }", 1)[0]
    assert "onComparingChange?.(false);" in release
    send = composer.split("async function send() {", 1)[1].split("async function sendImpl", 1)[0]
    assert "onComparingChange?.(true);" not in send
    assert "onComparingChange?.(false);" not in send

    # The lookup's own invalidation counter is the only one bumped, and it is bumped
    # by the composer's accept-time claim, never by a send attempt.
    page = _read("chat-page.tsx")
    assert "const compareSubmittingRef = useRef(0);" in page
    assert "if (compareSubmittingRef.current !== submittedAt) return;" in page
    assert "}, [pairId, anyRunning]);" in page


def test_cancellation_retry_that_lands_reports_success():
    """A scoped retry that succeeds must finish like the successful path.

    The fallback cleared the checkpoint, so rethrowing the first /unload error would
    leave the UI unselected and report a failed cancellation that actually worked.

    The case that matters is a successful retry while an UNRELATED load stays visible:
    those reads never settle, so the timeout is reached with the cancellation already
    effective. The success check therefore sits before that throw, and a landed retry
    ends the poll instead of spending the whole budget on a settled cancellation.
    """
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    fallback = cancel.split("} catch (unloadError) {", 1)[1]

    assert "let retriedCancellation = false;" in fallback
    retry = fallback.split("if (loadRequestId) {", 1)[1]
    retry = retry.split("retriedCancellation = true;", 1)[0]
    assert "cancel_load_request_id: loadRequestId," in retry
    # A landed retry ends the poll instead of waiting out an unrelated load.
    assert "retriedCancellation = true;" in fallback
    assert "break;" in fallback.split("retriedCancellation = true;", 1)[1].split("}", 1)[0]

    # The success path is consulted BEFORE the timeout throw, so a retry that lands
    # while an unrelated load keeps the poll unsettled still reports success rather
    # than a cancellation failure that did not happen. Anchored on the throw itself:
    # the loop's own settle wait uses the same condition text.
    success_at = fallback.index("if (retriedCancellation) {")
    timeout_at = fallback.index("was never confirmed cancelled.")
    assert success_at < timeout_at
    settled = fallback[success_at:timeout_at]
    assert "resyncInferenceStatusAfterServerModelChange(signal)" in settled
    assert "return;" in settled
    # The original error survives only for the no-retry case, after that early return.
    assert "Could not cancel the backend model load: ${detail}" in fallback[timeout_at:]


def test_fallback_preserves_an_unrelated_external_selection():
    """Cancelling a local load must not erase a valid external checkpoint."""
    composer = _read("shared-composer.tsx")
    assert 'import { isExternalModelId } from "./external-providers";' in composer
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    fallback = cancel.split("} catch (unloadError) {", 1)[1]
    # Guarded, exactly like the successful path's resync helper.
    assert (
        "if (!isExternalModelId(useChatRuntimeStore.getState().params.checkpoint)) {"
        in fallback
    )
    guarded = fallback.split(
        "if (!isExternalModelId(useChatRuntimeStore.getState().params.checkpoint)) {", 1
    )[1]
    assert "clearCheckpoint();" in guarded.split("}", 1)[0]


def test_cancellation_retry_survives_a_status_outage():
    """A failing status read must not skip the scoped retry.

    The retry used to sit inside the status try, so a status-specific outage jumped
    straight to the outer catch: the aborted load could then register and finish with
    no cancellation tombstone while the run was released on an unproven "settled".
    """
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    loop = cancel.split("while (", 1)[1].split("if (retriedCancellation) {", 1)[0]
    # The retry is sequenced ahead of the status read and is not nested inside it, so a
    # status outage -- or a read that never answers -- cannot skip it.
    assert "let reported: string[] | null = null;" not in loop
    retry_at = loop.index("if (loadRequestId) {")
    status_at = loop.index("await readInferenceStatusWithinPollBudget(")
    assert retry_at < status_at
    retry_block = loop[retry_at:status_at]
    assert "unloadModel(" in retry_block
    # An unknown status settles nothing.
    assert "if (reported === null) {" in loop
    assert "settledObservations = 0;" in loop.split("if (reported === null) {", 1)[1]
    # Empty status alone settles nothing either: every scoped retry may have rejected while
    # the load was still delayed before its attempt registered, and such an attempt can
    # appear later. Only a registration that was watched appear and then retire counts.
    assert "let observedRegistration = false;" in cancel
    assert "if (targetStillLoading) {" in loop
    assert "observedRegistration = true;" in loop
    assert "targetStillLoading || anotherLoadVisible || !observedRegistration" in loop


def test_a_status_read_that_never_answers_cannot_stall_the_poll():
    """A pending status read must expire, so the round -- and its retry -- still advance.

    Without a bound, a status request that never settles (rather than rejecting) holds the
    round forever: the per-round scoped retry stops running, the poll-count bound never
    applies, and the compare stays busy while the aborted load can still finish.
    """
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    loop = cancel.split("while (", 1)[1].split("if (retriedCancellation) {", 1)[0]
    # The read is bounded by its own expiry, and that expiry also aborts the request.
    assert "const expiry = new Promise<null>((resolve) => {" in composer
    assert "controller.abort();" in composer
    assert "getInferenceStatus(controller.signal)" in composer
    assert "COMPARE_CANCEL_STATUS_TIMEOUT_MS" in composer
    # The loop awaits the bounded helper, not the raw request.
    assert "await getInferenceStatus()" not in loop
    assert "await readInferenceStatusWithinPollBudget(" in loop
    # A bounded read that answered nothing settles nothing this round.
    assert "const reported = status" in loop
    assert ": null;" in loop


def test_the_whole_cancellation_poll_has_one_elapsed_deadline():
    """Per-round bounds alone compose to many minutes when every request stalls.

    Each round could otherwise spend its full retry and status budgets, so the nominally
    bounded poll held the compare's busy lease for far longer than its constants imply.
    """
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    loop = cancel.split("while (", 1)[1].split("if (retriedCancellation) {", 1)[0]
    assert "COMPARE_CANCEL_TOTAL_DEADLINE_MS" in composer
    assert "const pollDeadline = Date.now() + COMPARE_CANCEL_TOTAL_DEADLINE_MS;" in cancel
    # The loop stops once the budget is spent, not only when the round count runs out.
    assert "const remainingMs = pollDeadline - Date.now();" in loop
    assert "if (remainingMs <= 0) break;" in loop
    # The retry is capped by what is left of the round's budget...
    assert "Math.min(COMPARE_CANCEL_REQUEST_TIMEOUT_MS, remainingMs)" in loop
    # ...and the status read re-reads it: a retry that consumed the whole allowance
    # must not hand the read that same stale budget, nor may the trailing pause run
    # past the deadline.
    assert "const statusRemainingMs = pollDeadline - Date.now();" in loop
    assert "if (statusRemainingMs <= 0) break;" in loop
    assert "Math.min(COMPARE_CANCEL_STATUS_TIMEOUT_MS, statusRemainingMs)" in loop
    assert "pollDeadline - Date.now()," in loop
    assert "if (delayMs > 0) {" in loop


def test_every_cancellation_request_is_bounded():
    """The unload and its resync must expire, not just the status read.

    The compare's cleanup lease awaits this reconciliation, so a cancellation request that
    stays pending (rather than rejecting) keeps `modelLoading`/`comparing` open and hides the
    fallback. Both the initial `/unload`, the per-round retry, and the post-cancel resync
    therefore run under a deadline that aborts the request.
    """
    composer = _read("shared-composer.tsx")
    cancel = composer.split("async function cancelCompareBackendLoad(", 1)[1]
    cancel = cancel.split("function newCompareLoadRequestId", 1)[0]
    # A deadline helper that aborts the request and fails the wait.
    assert "async function withCompareCancelDeadline<T>(" in composer
    assert "controller.abort();" in composer.split("async function withCompareCancelDeadline", 1)[1].split("async function cancelCompareBackendLoad", 1)[0]
    assert "COMPARE_CANCEL_REQUEST_TIMEOUT_MS" in composer
    # Every cancellation request in the function goes through it, and none is awaited raw.
    assert "await unloadModel(" not in cancel
    assert cancel.count("withCompareCancelDeadline(") == 4
    # Both post-cancel resyncs forward the deadline signal, so a resync that outlives its
    # deadline cannot publish a stale model list over a later load.
    assert cancel.count("resyncInferenceStatusAfterServerModelChange(signal)") == 2


def test_staged_metadata_and_validate_carry_the_cancellation_signal():
    """Stop during a preparatory request must abort it, not wait it out.

    The composer's cancellation gates sit after these awaits, so without the signal a
    request that never answers holds `comparing` and the model-lifecycle lease open
    however many times the user presses Stop.
    """
    api = _read("api", "chat-api.ts")
    staged = api.split("export async function fetchGgufStagedMetadata(", 1)[1]
    staged = staged.split("export async function unloadModel(", 1)[0]
    assert "options?: { signal?: AbortSignal }," in staged
    assert "signal: options?.signal," in staged

    validate = api.split("export async function validateModel(", 1)[1]
    validate = validate.split("/** Read a GGUF's header dims", 1)[0]
    assert "options?: { signal?: AbortSignal }," in validate
    assert "signal: options?.signal," in validate

    composer = _read("shared-composer.tsx")
    helper = composer.split("async function ensureModelLoaded(", 1)[1]
    helper = helper.split("const handle1 = handlesRef.current", 1)[0]
    # Both preparatory requests in that helper are issued under the submitting signal.
    assert "{ signal: stoppedSignal }," in helper
    assert "}, { signal: stoppedSignal });" in helper


def test_hf_token_preparation_is_cancellable():
    """Token validation must expire with the compare, not outlive the Stop.

    `prepareHfTokenForUse` awaits `/api/hub/token/validate` for any nonempty token, and
    that await precedes every later gate, so a pending validation would otherwise hold
    `comparing` and the model-lifecycle lease open with no way to unwind.
    """
    api = _read_feature("hf-auth", "api.ts")
    validate = api.split("export async function validateHfToken(", 1)[1]
    assert "options?: { signal?: AbortSignal }," in validate
    assert "signal: options?.signal," in validate

    prepare = _read_feature("hf-auth", "confirm-token.ts")
    assert "signal?: AbortSignal;" in prepare
    # A supplied signal must bypass the shared burst cache: that promise is one request
    # for every caller, so racing it against this caller's Stop cannot abort anything.
    assert "? await validateHfToken(normalized, { signal: options.signal })" in prepare
    assert ": await validateOncePerBurst(normalized);" in prepare

    composer = _read("shared-composer.tsx")
    helper = composer.split("async function ensureModelLoaded(", 1)[1]
    helper = helper.split("const staged = await fetchGgufStagedMetadata(", 1)[0]
    assert "{ signal: stoppedSignal }," in helper


def test_load_preflights_race_the_cancellation_signal():
    """Stop must reach every awaited preflight, not only the ones already gated.

    The GGUF flag catalogue and the stored-extra-args lookup are `authFetch` calls with
    no deadline, and the cancellation gate sits after them; an endpoint that never
    answers would hold `comparing` and the lifecycle lease open however often Stop is
    pressed. Token preparation runs before `onRequestStart`, so it needs the signal too.
    """
    api = _read("api", "chat-api.ts")
    for name, tail in (
        ("export async function loadModel(", "export async function countChatInputTokens("),
        ("export async function validateModel(", "/** Read a GGUF's header dims"),
    ):
        body = api.split(name, 1)[1].split(tail, 1)[0]
        prepare = body.split("const preparedToken = await prepareHfTokenForUse(", 1)[1]
        prepare = prepare.split(");", 1)[0]
        assert "signal: options?.signal," in prepare

    composer = _read("shared-composer.tsx")
    assert (
        'import { withAbort } from "@/features/hub/lib/abort-signals";' in composer
    )
    managed = composer.split("const managed = await withAbort(", 1)[1]
    managed = managed.split(");", 1)[0]
    assert "loadManagedLlamaFlags()," in managed
    assert "stoppedSignal," in managed
    extra = composer.split("const resolvedArgs = await withAbort(", 1)[1]
    extra = extra.split(");", 1)[0]
    assert "fetchLoadExtraArgs(" in extra
    assert "stoppedSignal," in extra


def test_compare_pane_classifies_adapters_by_normalized_identity():
    """A Hub ID differing only by case must still load as the LoRA it is.

    The checkpoint and its inventory row can be the same model in two spellings; an exact
    comparison then marks the pane a base model, and the sequential reload sends
    `is_lora: false` against the adapter.
    """
    page = _read("chat-page.tsx")
    pane = page.split(
        "const GeneralCompareContent = memo(function GeneralCompareContent({", 1
    )[1]
    pane = pane.split("return (\n    <CompareShell", 1)[0]
    assert "modelIdsMatch" in pane
    assert "lora.id === globalCheckpoint" not in pane
    assert "lora.id === current.id" not in pane
    # Both the initial state and the deferred-inventory repair use the normalized match.
    assert pane.count("modelIdsMatch(lora.id,") == 2
