# Coding native execution, delivery recovery and goals (#234–240)

`/coding` keeps Studio’s authenticated route gate, sidebar primitives and composer
CSS, without importing ordinary chat execution, tool orchestration, model loading
or transcript persistence. An already-visited ordinary workspace remains parked,
not cancelled. Direct coding visits do not mount its model observers.

Mimir’s production `studio.frontend` plugin owns Session Control attachments and
saved public history. The browser keeps only an ephemeral Session View projection;
there is no second scheduler, inference loop, provider configuration or transcript
database. Providers and credentials remain configured on the Mimir host.

## Installed assistant-ui contract

React **0.12.28**, Core **0.1.17**, Store **0.2.9** are lockfile-pinned.
`run-runtime.ts` uses the shipped `ExternalStoreAdapter<PresentationRow>` converter,
`messages`, `isDisabled`, `isLoading`, `isRunning`, `onNew`, and `onCancel`.
`ThreadPrimitive.Messages` renders those external rows; `ComposerPrimitive` forwards
text through the authenticated API. No `setMessages`, local optimistic turns,
attachment/tool-result executor, edit/reload adapter or remote transcript store is
provided. The shipped runtime's transient upcoming-assistant placeholder has no
native row and is intentionally invisible, not a fabricated transcript entry.
Shipped-artifact tests exercise the actual runtime, including running before the
first native reply.

## HTTP and authoritative reconstruction

All `/api/coding` routes use established Studio auth, including IDs and fetch SSE:

- Browse/catalog/list/create/open retain the #234 canonical-folder and effective,
  non-persisting trust behavior. Selecting a folder always creates a new native
  conversation; reopening preserves its saved native identity and directory.
- `POST /conversations/{id}/prompts` accepts only `{submission_key,text}` and returns
  native conversation/submission/request identities. Transport retries are disabled.
- `POST /conversations/{id}/requests/{request_id}/cancel` targets exactly that native
  request. Acknowledgment is not terminal cleanup. It never closes the owner.
- `POST /conversations/{id}/entries` reads only the native immutable root `cut`, with
  an exact `latest`, `before` or `after` anchor and bounded entry/byte selection.
- `GET /conversations/{id}/events` consumes the native atomic start capture, then
  ordered activity, checkpoints, whole state, completion and reset items. Position
  gaps are allowed; backward positions and wrong conversation IDs are errors.

Initial/reset history is read at the captured root cut before the view is Ready.
Checkpoint reads reconcile saved rows after the previous cut and replace provisional
activity, except exact still-live tool invocations. A reset discards the old branch;
recovery remains visible until a root checkpoint. There is no snapshot-then-subscribe
race or history polling for lifecycle state. Earlier history outside the current
bounded page is explicitly disclosed and can be requested at that same cut. The
projection retains at most 1000 displayed rows / 2 MiB of text; omitted earlier
content is disclosed. Native reads and public text/output have their own smaller,
disclosed bounds; oversized entries are typed public SDK reads, never private
saved-result decoding.

Tool activity uses exact invocation/call identities and native titles/status. Public
output is expandable and keyboard-operable; clipping is labeled. Public presentation
content is authoritative, not model-only output. Starts/results of one invocation
share a compact chronological slot; repeated invocations remain separate. Historical
reports are labeled and are not claims about the current filesystem. There are no
Apply/Revert controls or tool-selection pills.

## Delivery and lifetime

Before project selection or complete capture, the composer is disabled. Enter and
Send forward text; queued requests remain native. Before **any** prompt HTTP send,
`pending-submission.ts` writes and verifies one conversation-scoped delivery record
in localStorage under `unsloth:coding:pending-submission:${encodeURIComponent(id)}`:
`{version:1, conversation_id:id, key, text}`. It is not a transcript store. The record
is removed only after confirmed acceptance/native request identity or explicit
pre-admission rejection; read/write/readback/cleanup failures disable sending.
If storage fails before HTTP, the eagerly-cleared assistant-ui composer text is
retained separately as a **known-unsent draft**, not a transcript row or uncertain
submission. A selectable, read-only `coding-unsent-draft` field lets the user copy it
before leaving/reopening. This draft is in-memory only because storage failed;
nothing is sent or retried automatically.

Reload/reopen restores pending metadata, never automatically replays the prompt,
and blocks new input. Only after a reconstructed, non-recovering native view may
**Retry same submission** send the original key/text. A matching native request
clears pending metadata even after frontend/plugin restart and lost acknowledgement.
An interrupted accepted request is delivery-confirmed, not continued: continuation
requires deliberate new input, never reuse of delivery recovery as a process restart.
Clear browser storage only deliberately: deleting the pending record loses the
browser's ability to identify uncertain delivery.

Stop captures the active native request, remains **Stopping…** through its matching
terminal completion/cleanup, and exposes native cleanup failure as failure. A
reconnected atomic capture may settle that request only when its native terminal
status and released active-request admission agree. Other queued or conversation
requests are never substituted. Uncertain non-prompt acknowledgements use the shared
**inspect fresh native captured view → reconcile exact target → explicitly offer an
appropriate action** pattern, demonstrated by Stop. Stop is not automatically
replayed and this is not a generic exactly-once guarantee. A still-active target can
be explicitly retried only after capture/recovery; a terminal, released target settles
without cancelling the next request. Unresolved cleanup remains unconfirmed.
Create/open transport uncertainty likewise inspects the authoritative shared catalog
without replay, preserves any previously active identity/canonical folder, and does
not infer success by matching a folder. Until catalog inspection succeeds all new
openings are blocked; afterward only deliberate saved-identity reopen is offered,
not another creation. Failed inspection remains actionable through history refresh.
Explicit pre-admission folder/lease/trust errors remain normal actionable refusals.

Transport loss automatically reconnects with 500 ms exponential backoff capped at
15 seconds. Every attempt reconstructs a new authoritative capture; no Last-Event-ID
or arbitrary last-event replay is sent. The persistent disconnect banner survives
HTTP connection, unfinished entry reads and recovering resets until capture/checkpoint
is complete. A native closed view instead requires deliberate reopen, preserving
native lease/folder/trust errors. Detach aborts only watching and reconnect timers,
not accepted work or the conversation owner. Late Stop replies are gated by the
captured lifecycle generation, so neither cancellation refusal nor transport failure
can reconnect a detached or superseded view. No process restart or command replay
is added. Nonprogressing/oversized older pages stay visibly incomplete and actionable.
Coding-specific transport messages explicitly leave delivery/work unconfirmed rather
than inferring host death or suggesting relaunch; native HTTP refusals and aborts
retain their original errors.

Stable browser evidence selectors: `coding-disconnect-banner`,
`coding-delivery-recovery` (with `data-submission-key`), `coding-retry-submission`,
`coding-submission-recovered`, `coding-submission-storage-error`, `coding-unsent-draft`,
`coding-action-reconciliation`, and `coding-opening-reconciliation`.

## Autonomous goals (#240)

`GoalSummary` is a compact keyboard-operable disclosure above the transcript. The
native goal objective, phase/cause/reason, independent review gap and accepted
completion checklist remain separate from ordinary request status. Only a native
`complete` goal with its independent completion evidence is labeled verified;
ordinary turns, model claims and HTTP acknowledgments do not establish completion.
The expanded content is bounded/scrollable and controls wrap on narrow screens.

`POST /conversations/{id}/goal` forwards native `{revision, action, objective?,
duration_seconds?}` to `change_goal`. The native owner projects admitted actions
and explanations in `goal_controls` and atomically rejects stale admission identities.
Studio does not infer busy support or weaken native guards to enable a button.
Start/edit drafts capture their original revision and remain visibly stale after a
state change; they cannot submit against a different incarnation. All goal actions
are disabled during incomplete reconstruction or uncertain delivery. A fresh captured
view reconciles uncertain commands without replay. Late replies cannot revive a
detached/superseded watcher. Main-session Stop remains separately available while a
goal command is pending and retains its existing awaited-cleanup semantics.

Pause is not Stop, clear is not history deletion, and reopening never resumes work.
A native `restart` cause is shown as interrupted requiring explicit resume.
The `--workload goals` coding-route browser driver exercises this product path with
deterministic external provider/reviewer replies, not a real-model workload claim.

## Verification

```sh
npm --prefix studio/frontend ci --no-audit --no-fund
npm --prefix studio/frontend run typecheck
(cd studio/frontend && node --experimental-strip-types --test tests/coding-*.test.ts)
npm --prefix studio/frontend run build
```

The route browser driver is `studio/tools/coding_browser_acceptance.py`. It exercises
built UI → authenticated production routes → installed plugin → native Mimir.
Deterministic provider scenarios exercise actual native tools but are not live model
acceptance. See `studio/docs/coding-integration.md` and task-local reports for the
shared acceptance mapping, observed results, browser dimensions and external blockers.
