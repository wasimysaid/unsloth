# Coding native run/stop, recovery, questions, reported changes, rich inputs, concurrency and Mimir Settings

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
- `GET /conversations/{id}/overlap` reads native canonical-folder overlap against
  other retained, busy owners; it never opens an owner or changes project identity.
- `POST /conversations/{id}/prompts` accepts `{submission_key,text}` plus optional
  `skill_mentions`, `images` and `overlap_confirmed`, and returns native
  conversation/submission/request identities. Confirmation defaults to false;
  the host refuses newly overlapping work before native admission with a structured
  `overlap_required` warning. Transport retries are disabled.
- `GET /conversations/{id}/skills` discovers the already-open controller's effective
  native skill metadata. It neither loads skill bodies nor creates another registry.
- `POST /conversations/{id}/requests/{request_id}/cancel` targets exactly that native
  request. Acknowledgment is not terminal cleanup. It never closes the owner.
- `POST /conversations/{id}/entries` reads a native immutable root or child `cut`, with
  an exact `latest`, `before` or `after` anchor and bounded entry/byte selection.
- `GET /conversations/{id}/children/{handle}/attempts/{attempt}` reads bounded
  descriptive details and exactly that attempt’s retained outcome without claiming
  the completion owed to Mimir. A newer attempt is never returned as the requested one.
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

## Native question cards (#237)

The authoritative `state.user_request` supplies question IDs, prompts, native option
labels/descriptions, and single/multiple selection. Expanded inline cards render
those controls separately from the disabled ordinary composer. HTML radio groups,
checkboxes, freeform textareas and Submit support keyboard operation and wrap at
narrow widths. A new card focuses its heading only while following latest activity;
reconnect does not steal focus from an existing draft or earlier reading.

`POST /conversations/{id}/requests/{request_id}/questions/{user_request_id}/answers`
uses `{subscription, answers:[{question_id,selected_options,freeform_text}]}`. Every
answer captures the exact current live view, running request and pending native
question identity. Browser guards invalidate old controls on Stop, replacement,
completion, reconnect and detach; host/native validation is the final authority.
A command being sent is **Submitting**, never accepted. Only a matching native
acceptance or typed saved public answer evidence can confirm **Accepted**. The
transcript displays native accepted answer rows, including after history restoration.

A lost acknowledgement never triggers automatic replay. A fresh atomic view and
captured-cut history reconcile the exact answer. If the native question is still
waiting, the retained draft is actionable only through explicit resubmission using
the new live view. If it is gone with no available accepted evidence, its outcome
stays unconfirmed and the old draft cannot answer a replacement. Transport loss
neither cancels the question nor releases the host owner. Native errors remain
visible with their draft. Up to eight form drafts are ephemeral, not saved public
history; a full browser reload drops unsent drafts but never replays an answer.

Evidence selectors: `coding-question-card` (native `data-question-id`,
`data-request-id`, `data-subscription`), `coding-answer-status`, and
`coding-submit-answer`. Cards disappear from latest activity when their accepted
native transcript row is visible; no optimistic or duplicate answer row is added.

## Concurrent conversations and overlap (#247)

Independent requests use the same supervised native process, with no browser-owned
process or Studio execution serialization cap. Native/provider admission remains
responsible for capacity, same-conversation busy state, and execution leases.

Before a new prompt POST, a read-only overlap preflight checks other retained busy
conversations in the **same canonical folder**. The accessible warning focuses
Cancel, traps keyboard focus, supports Escape cancellation, and offers explicit
Continue anyway. Cancelling retains a known-unsent in-memory draft and never sends
Stop to another owner. The prompt-side native guard closes races after preflight;
its rejection opens the same warning while clearing definitively rejected pending
delivery. Only explicit continuation supplies `overlap_confirmed: true` for this
submission; no remembered project permission or durable authority is created.
Already accepted key retries remain native deduplication and do not run a fresh
preflight or acquire new authority. Failed/superseded preflight sends nothing.

This warning is **not** a filesystem lock, sandbox, comprehensive nested-workspace
or cross-process work detector. It grants no authority over another owner and
cannot guarantee absence of file conflicts. Another process's saved conversation
is still in use; Studio never forces it open, forks it, or steals its lease.
Project changes create distinct conversations; reconnect retains native identity.

## Child-attempt inspection (#241)

Native agent-icon rows open a right-hand, inspection-only panel; no launch,
continue, steer, or individual Stop is exposed. On narrow screens the dismissible
panel fills the transcript width, leaving connection feedback and the **main-session
Stop** available below. Enter/Space activate native buttons, Escape dismisses from
inside the inspector, and focus returns to the activating row (or its replacement
or composer if that row is no longer available). Hidden narrow-screen transcript
content is inert, while the inspector remains non-modal.

`child-view.ts` consumes children from the same atomic parent start/reset and ordered
child/activity/checkpoint items. Exact `(handle, attempt)` keys isolate continuation
outcomes. History-only observations cannot make old work live. Descriptive reads
cannot advance the ordered cut or lifecycle; terminal outcomes come only from the
non-consuming native outcome read. Inspector navigation cancels obsolete reads,
not native work. Disconnect/reconstruction leaves status unconfirmed until recapture.

Child journals are loaded lazily at captured cuts, with native bounded paging and
explicit clipping/unavailable labels. A journal through an attempt’s cut may include
earlier retained context; it is not mislabeled as an attempt-only transcript. When
an old attempt has no available exact cut, the current child journal is **not**
substituted. The inspector retains at most 200 rows / 512 KiB of text and 512 compact
attempt rows, and discloses omitted content. Results/errors use the bridge’s bounded
public prefix with explicit clipping labels, never raw model context/private history.
Reconnect uses a new atomic capture and preserves the selected exact historical
attempt without relabeling it as current. Inspection never consumes parent delivery.

Stable selectors: `coding-child-row` and `coding-child-inspector` carry
`data-child-handle` / `data-child-attempt`; the panel is the `Subagent inspector`
dialog. `--workload children` in the coding-route driver exercises actual native
delegation with a deterministic protocol provider, not real-model acceptance.

## Skill mentions and images (#242)

`coding-composer.tsx` retains the shipped assistant-ui text field/Send ownership.
`input.ts` tracks only ephemeral draft associations, not execution or history.
Selecting a skill inserts its exact qualified `@name`, preserving the native disk
`path` where supplied (plugin names are not shortened). Edits shift intact ranges
or invalidate touched/extended tokens. JS UTF-16 offsets are converted to half-open
native UTF-8 byte ranges against the exact untrimmed text at submission. Typing a
short display name alone does not invent a native skill reference or load its body.

Images can be selected or pasted, inspected and removed before Send. Supported
PNG/JPEG/WebP/GIF images are bounded to four, 512 KiB aggregate original bytes, and
4096×4096 dimensions. GIF is image input, not a promise to forward every animation
frame. Browser checks give immediate feedback; authenticated Studio validates the
transport shape/bytes and the plugin independently decodes and enforces bounds.
Native provider image refusal and request failures remain explicit. Images are
base64 bytes, never user-supplied host paths or remote URLs; no upload store exists.
Include text with attachments. Existing 1 MiB private frame bounds remain in place.

Every send snapshots text, exact skill identities/paths/ranges and original image
bytes once under its native submission key. Uncertain delivery retries that whole
snapshot, not the current composer. A definite pre-admission rejection retains
**Restore rejected input**; neither it nor a preview creates an accepted transcript
row. Native acceptance/reconciliation clears draft associations. Cross-reload durable
recovery remains #236; this slice preserves rich input wherever #235's in-memory
uncertain-delivery capability is present.

The mention list supports search, keyboard Arrow/Enter selection from `@` input,
Escape dismissal and focus return. Attachment/mention controls wrap on narrow screens;
they are not ordinary-chat tool-selection pills.

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

## Native commands and current-session diagnostics (#243)

The Commands dialog queries the live native registry, including effective contributed
names/aliases, descriptions, optional arguments and native availability. Selecting a
command does not execute it. Execute and composer slash input both use native command
handling; unsupported/terminal-only attempts never become model prompts. Prompt HTTP
also refuses slash input. Native busy/admission guards remain final.

`POST /conversations/{id}/commands` accepts `{operation_id,name,tail}`. Handled,
transient-display and submitted native request outcomes are presented distinctly;
none is an optimistic conversation message or proof of terminal completion. Native
compression is submitted work with real lifecycle/view evidence; public history is
retained. Transient output is bounded and is not appended to the transcript.

Before dispatch, `pending-command.ts` durably records a conversation-scoped operation
identity/name, **not arguments**. Reload/reopen retains uncertainty. A fresh atomic
view must reconstruct before the read-only command receipt lookup can resolve that
exact outcome. An incomplete/missing receipt (including runtime loss) remains unknown
and blocks another mutation; Inspect command outcome only reads again. No command is
replayed and receipt storage does not promise generic exactly-once execution.

The compact indicator uses native current-session prompt/turn observations, labeling
provider-confirmed, estimated and stale data where supplied. Unavailable metrics stay
unavailable, never invented zeroes. The diagnostics dialog requests only the selected
context, tokens, retry or execution category. Native context inspection exposes bounded
structural roles/counts rather than private message contents; provider payloads,
credentials, arbitrary error reasons and raw logs are not browser diagnostics.
Dismissal invalidates pending inspection replies. Model-context diagnostics are not
public transcript entries or a historical-usage dashboard.

## Inspection-only reported file changes (#238)

`tool.output_profile` is the product plugin's bounded projection of the native
public typed profile, shared by live observations and persisted tool results.
Studio never decodes saved `details` or reads current files to reconstruct a diff.
`FileChangeReport` renders supplied file paths, optional added/removed counts and
reported hunks beneath their originating tool result. Supplied EOF-newline changes
remain distinguishable; truncated lines never assert missing EOF terminators.
Rows start collapsed; native
`details`/`summary` supports keyboard activation and visible focus, and expanded
unified diffs have a bounded, keyboard-scrollable viewport. Text prefixes, status
labels and unavailable-count text do not depend on color.

Repeated edits stay separate in chronological invocation order, even when native
activity grouping shares a key. There is no cumulative workspace patch, approval,
Apply or Revert. Reopened rows explicitly say **Historical** and **not current
filesystem state**. Binary profiles show metadata only; partial, unavailable and
truncated content remain labeled. Generic/no-profile tools retain their actual
public output without claiming no files changed. Structured effects count toward
the same ephemeral transcript memory budget; no diff database is added.

Browser defence-in-depth bounds are 64 files, 400 rendered diff lines and 16 Ki
characters per expanded diff; plugin bounds apply first. Omission is disclosed,
not treated as complete output. Existing scroll handling is not triggered by
expansion alone; it continues to follow only readers already at the bottom.

## Mimir Settings (#250)

The focused **Mimir Settings** view uses the open native conversation's effective
trust and project directory to inspect MCP's global/workspace layers. Native source
identities, configured states, effective field origins and live ownership/status
are preserved; inventory is redacted. The explicit editor reads raw source JSON
(including secrets), never expanded/merged transport values for persistence.

Authenticated endpoints under `/api/coding/conversations/{id}/mcp`:

- `GET /inventory`: native scoped documents, source entries, effective values and
  live connection metadata; does not open an owner or apply changes.
- `POST /edit` with `{source,name}`: begins an edit of that exact native source.
  Missing names create a draft. Returns `{edit_id,source,name,revision,json}`.
- `POST /save` with `{edit_id,revision,json}`: native validation and revision-checked
  persistence; returns `{draft,configured_state,inventory,inventory_error}` with the
  actual committed editor revision and configured state at the saved source.
  Inventory is a separate best-effort observation: if it exceeds transport bounds,
  `inventory` is null and `inventory_error` explains how to refresh. A completed
  persistence operation is never reported as failed because observation is unavailable.
  Raw and normalized editor JSON are bounded to 512 KiB before persistence.
  It never applies/reconnects connections, attaches transient servers, cancels work,
  or closes/reopens conversations. Live apply/reconnect belongs to #251.
- `POST /release` with `{edit_id}`: drops only an obsolete native editor resource
  after comparison/reconciliation/discard, never its conversation or connections.

No endpoint accepts arbitrary file paths. Responses are `no-store`; raw drafts
are never logged or included in request-validation diagnostics. The browser
uses authenticated fetch with transport replay disabled. A lost save reply is
**uncertain**, not a failed write: compare the saved version before deliberate retry.

`mcp-settings.ts` holds ephemeral forms keyed by native conversation ID, retaining
draft text and edit revision through errors, conflicts, tab switches and conversation
changes within this mounted coding page. It does not use browser storage or persist
secrets. A browser reload/navigation away loses these in-memory unsaved drafts.
Refresh reads inventory without rebasing edits. Comparison reads a new native draft
separately; only **Keep draft and use latest revision** or **Replace draft with saved
version** adopts it. Another intervening writer can still conflict. Discard is
confirmed; selecting another row never silently replaces a draft. Operations are
serialized per form, with focused native errors and keyboard-operable reconciliation.

Saved status and native live connection status are separate. The persisted revision
is an editor revision, not evidence that servers have reconfigured. Native inventory's
`live_available` explicitly distinguishes unknown observation from known-empty connections;
unavailable status offers refresh instead of inferring no applied servers. Refresh is a
read, not an apply mechanism. Extensions/maintenance sections are supplied by #252.

## Next-request model picker (#244)

The composer bottom-right trigger opens native model configuration; its heading
opens the searchable, provider-navigable list in the same popover. Selecting a model
returns to configuration without dismissal. Shared Studio popover/button/slider
primitives are presentation only. Keyboard Tab remains ordinary focus navigation;
Escape returns from search to configuration or dismisses to the trigger.

`GET /catalog?cwd=…` is the only inventory. Exact provider ID + provider-local model
ID select a model; labels and API-model mapping are display/search metadata, never
replacement identities. Favorites persist only identity pairs. Reasoning positions
come only from the selected model's offered native values and disappear when none
exist. Switching models sends only the identity patch and lets Mimir reset effort
to its native default; there is no per-model remembered effort.

`POST /conversations/{id}/configuration` accepts only `{provider?,model?,reasoning?}`.
It is separate from prompts, which still carry only submission key/text. Native
ordered state exposes next `configuration` and separate `running_configuration`.
The browser never rewrites active work or installs a potentially stale HTTP reply
as newer view state. Definite native refusal retains the selection; an uncertain
configuration response is not retried and requires authoritative reconstruction
before further configuration or input. Stop remains available during selection.

Catalog presence is not a health/credential check. Missing selected identities
remain visible without fallback, with catalog retry or replacement. Setup,
credentials and downloads remain in their existing workflows. Native execution
boundary preparation/protection and fresh live selectability are implemented by
subsequent #245–246 slices, not a browser scheduler or compatibility checker.

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
