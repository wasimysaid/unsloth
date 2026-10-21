# Coding native execution, recovery, questions, goals, reported changes, rich inputs, concurrency and Mimir Settings

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
`run-runtime.ts` uses the shipped `ExternalStoreAdapter<TranscriptBlock>` converter,
`messages`, `isDisabled`, `isLoading`, `isRunning`, `onNew`, and `onCancel`.
`isDisabled` means the prompt cannot be *edited* (no confirmed owner, or failed
delivery storage); whether it can be *sent* is `codingSendBlockedReason`, one rule
for the Send button, Enter, the adapter and `run.send`. Text stays editable while
mode, model, goal or command work settles. Sending consumes that message's rich
input (mentions, images) from the draft at once, so its later acceptance by HTTP
or by ordered native state can never clear a newer draft; every refusal keeps the
consumed input in run state (restorable, or retryable when delivery is
uncertain). A send refused after the shipped composer cleared its text is
retained the same way, never lost.

The transcript is rendered from `transcript-model.ts` blocks keyed by native
presentation identity, not through `ThreadPrimitive.Messages` (which keys message
components by list index, so expansion state could move between rows on prepend or
eviction). `ComposerPrimitive` forwards text through the authenticated API. No
`setMessages`, local optimistic turns, attachment/tool-result executor, edit/reload
adapter or remote transcript store is provided. The shipped runtime's transient
upcoming-assistant placeholder carries no native block and renders nothing.
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
  `skill_mentions`, `subagent_mentions`, `file_mentions`, `images` and
  `overlap_confirmed`, and returns native
  conversation/submission/request identities. Confirmation defaults to false;
  the host refuses newly overlapping work before native admission with a structured
  `overlap_required` warning. Transport retries are disabled.
- `GET /conversations/{id}/skills` discovers the already-open controller's effective
  native skill metadata. It neither loads skill bodies nor creates another registry.
- `GET /conversations/{id}/files?query=…&max_results=40` returns native host search
  results `{files:[{path,kind:"file"|"directory"}],truncated}`: canonical
  project-relative paths only, never file contents.
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

Owner calls retain the `runtime_generation` returned by create/open through
`X-Mimir-Runtime-Generation`, including model/reasoning `POST /configuration`.
A stale configuration is rejected before native stdin just like other fenced owner
mutations; status polling never retargets a tab's opening or authorizes replay.

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
Apply/Revert controls or tool-selection pills. See **Transcript projection** below.

## Native mode and plan decisions (#239)

The compact Build/Plan segment (native radios inside the composer) shows only
`state.configuration.mode` from the ordered native view. It never optimistically
changes mode, accepts a plan, or rewrites running work; a requested mode is marked
on its own segment (`data-requested-mode`) and nothing else is dimmed or disabled.

A **mode-only** command keeps the existing event stream: after a definite
acknowledgment the ordered native `state` item settles it, including one that
arrived before the reply. A definite refusal needs no reconstruction (the open view
is still authoritative). An uncertain reply waits for the same ordered evidence.
Only if no confirmation arrives within a bound (5 s) is one fresh captured view
read, without replaying the command. Stop, the event stream and the draft stay
usable throughout; Send, plan decisions, model and goal changes wait. Plan
decisions still reconstruct a fresh captured view, as below.
`POST /conversations/{id}/mode` sends only `{mode}` to native configuration.
`POST /conversations/{id}/plan-actions` sends `{plan_id,revision,decision}` to native
admission; decisions are `implement`, `implement_fresh`, and `save_and_stop`, not
prompts or mode changes. Native current identity, revision and busy admission are
authoritative. All admitted decisions return to Build; save-and-stop starts no
implementation request. Fresh implementation clears model context, not saved public
history.

The expandable current plan preserves native identity, status, path and Markdown.
Saved lifecycle rows use the same renderer as inspection-only historical records,
without actionable controls. Clipping is disclosed. Controls explain busy/refused
states, action failures and reconnect uncertainty in text. After a mode/plan command,
reconstruct a fresh captured view before permitting another choice (a mode-only
command settles from ordered state instead, as above). Lost responses
never trigger command replay. Late responses to a detached surface do not reconnect
it. A subsequent choice must address the currently captured native revision;
native stale validation is still required for races after browser checks.

Stable selectors: `coding-current-plan`, `coding-historical-plan`,
`coding-plan-content`, `coding-plan-mode`, `coding-plan-reconciliation`.

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

Native agent-icon rows sit in their chronological transcript slot (exact
`(handle, attempt)` identity from a child row or a tool's subagent presentation;
live attempts not yet named by any row are listed after the transcript) and open a
right-hand, inspection-only panel; no launch,
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

## Skill and subagent mentions and images (#242)

`coding-composer.tsx` retains the shipped assistant-ui text field/Send ownership.
`input.ts` tracks only ephemeral draft associations, not execution or history.
`@` at a token start opens one floating combobox grouped **Skills**, **Subagents**
and **Files** (`GET /conversations/{id}/skills` and `/subagents`, discovered
independently so one failing never hides the other; Files is a debounced, aborted-on-
change host search for the typed query, listed in server order and never
re-filtered in the browser). Focus stays in the prompt
(`aria-activedescendant`); Arrow keys move over selectable options, Enter/Tab select
the active one, Escape dismisses that token, and Enter with no selectable match
falls through to ordinary Send. In Plan mode a subagent whose native
`plan_eligible` is false stays listed but disabled with that reason.

A selection inserts its exact `@name` (skill: qualified name plus native disk
`path` where supplied; subagent: native name) or native file reference and records
a typed `DraftMention` (`kind: "skill" | "subagent" | "file"`). File references use
the native TUI grammar without escapes: `@path`, or `@"path with spaces"` when the
visible path contains whitespace; directories are written `path/`. A path that
grammar cannot carry (a quote together with whitespace, `#`, control characters)
stays listed but disabled. Native identity comes only from that
selection, never from typed text. Edits shift intact ranges or invalidate
touched/extended tokens; undo and other unreported edits are inferred from the text
diff, and any token that occurs twice is dropped rather than guessed. Chips remove
exactly their identity and token. JS UTF-16 offsets become half-open native UTF-8
byte ranges at submission: `skill_mentions:[{name,path?,start,end}]`,
`subagent_mentions:[{name,start,end}]` and `file_mentions:[{path,kind,start,end}]`
(the range covers the whole visible reference, quotes included; `path` stays the
exact catalog path), at most 64 together. Selecting a subagent selects context; it
never launches work. Native loads referenced file context host-side; the browser
never reads file bodies.

Images can be selected, pasted or dropped, inspected and removed before Send.
Supported PNG/JPEG/WebP/GIF images are bounded to four, **10 MiB each, 20 MiB
total** original bytes, and 4096×4096 dimensions. Count/size feedback is given
before reading; each image is then read and validated on its own while typing
continues (only Send waits). These reads, and their refusal/failure messages,
belong to the input draft that started them (`draft.attach`), not to a composer:
Send waits on the draft's `reading`, wherever that draft is shown. Thumbnails and
the inspector use the image's own base64 `data:` URL; the only object URL is the
temporary one used to decode, revoked as soon as decoding ends. GIF is image input, not a promise to forward every
animation frame. Browser checks give immediate feedback; authenticated Studio
validates the transport shape/bytes and the plugin independently decodes and
enforces bounds. Native provider image refusal and request failures remain
explicit. Images are base64 bytes, never user-supplied host paths or remote URLs;
no upload store exists. Include text with attachments.

Every send snapshots text, exact skill/subagent/file identities and ranges and
original image bytes once under its native submission key. Uncertain delivery retries that whole
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
`{version:2, conversation_id:id, key, text, skill_mentions?, subagent_mentions?,
file_mentions?}`. That is the only record schema; with images it carries an
`image_manifest` of `{mime_type,length,sha256}` and the exact bytes are written first
to IndexedDB under the same name, because megabyte images exceed localStorage quota.
Without durable IndexedDB an image send fails closed before HTTP (its input is kept
restorable; text-only prompts still send). Persistence is revalidated before HTTP:
if detach, reconnect or owner loss happened while saving, nothing is sent, a fresh
record is withdrawn and the input is kept as known-unsent. A retry after reload
reads the bytes back and sends them only if every digest matches; otherwise it
refuses and sends nothing different. It is not a transcript store. The record
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
is complete. A native `invalidated` view (`reason: "reopened"`) means compatible
same-owner reopen revoked the old subscription: immediately recapture read-only,
retaining rows/drafts without an owner-loss warning. Old answer capabilities stay
unusable until a fresh capture supplies a new subscription. No open, prompt, answer,
configuration or other mutation is replayed. A native `closed` view, or `not_found` /
`closed` at view admission after idle retirement, instead requires deliberate reopen
via the existing `X-Mimir-Requires-Reopen` contract. Other missing-resource errors
are not owner-loss evidence. Native lease/folder/trust errors remain visible.
Detach aborts only watching and reconnect timers,
not accepted work or the conversation owner. Late Stop replies are gated by command attachment lifetime and exact terminal
evidence, so neither cancellation refusal nor transport failure can reconnect a
detached surface. Mode-driven view reconstruction does not retire an outstanding
Stop reply or strand its error reconciliation. No process restart or command replay
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
characters per expanded diff section; plugin bounds apply first. Supplied diff
sections are keyboard-navigable in both directions. Native partial/truncated
content remains explicitly labelled; section navigation cannot recover content
that the native public profile did not supply. Expanding a report is a reading
request, not a request to follow its growth. See #253 below.

## Mimir Settings (#250–251)

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
  or closes/reopens conversations.
- `POST /apply` with `{operation_id}`: native safe-idle application of saved layers
  for this conversation, never unsaved editor text.
- `POST /reconnect` with `{operation_id,name?}`: safe-idle reconnect of configured
  connections using applied definitions. No transient SDK attachments are replaced.
- `GET /operations/{operation_id}`: read-only exact native outcome plus current
  inventory. Missing/evicted status is unknown, never proof of non-admission.
- `POST /release` with `{edit_id}`: drops only an obsolete native editor resource
  after comparison/reconciliation/discard, never its conversation or connections.

No endpoint accepts arbitrary file paths. Responses are `no-store`; raw drafts
are never logged or included in request-validation diagnostics. The browser
uses authenticated fetch with transport replay disabled. A lost save reply is
**uncertain**, not a failed write: compare the saved version before deliberate retry.

`mcp-settings.ts` holds ephemeral forms keyed by native conversation ID, retaining
draft text and edit revision through errors, conflicts, tab switches and conversation
changes within this mounted coding page. Definitions/drafts are never stored in
browser storage; a browser reload/navigation away loses these in-memory unsaved
drafts. Only unresolved runtime-operation ID/kind/name is retained in per-tab
sessionStorage as transport correlation across reload. Other tabs cannot overwrite
or clear the submitting tab's unresolved identity; native safe-idle admission
still orders their distinct commands. Lost apply/reconnect replies are inspected by exact
identity before another runtime action, never replayed; corrupted/unavailable
correlation storage blocks sending. Native running/failed/completed outcomes and
saved effective/applied revision and actual configured tool evidence are separate
from persistence acknowledgment. A mounted Settings view observes unresolved
outcomes for at most one minute, then retains explicit refresh/reconciliation.
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

The composer bottom-right trigger (model name, muted effort) opens a compact
configuration popover: the reasoning slider for the selected model and a model line
that opens the searchable list in the same popover, with Starred and per-provider
tabs and an icon-only refresh. A missing selection or failed catalog read shows one
short line with **Retry** / **Choose another**; there is no catalog-details panel.
Selecting a model returns to configuration without dismissal. Shared Studio popover/button/slider
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
credentials and downloads remain in their existing workflows. Live refresh and
local preparation use native execution owners, not a browser scheduler or
compatibility checker.

## Studio local serving (#246)

Downloaded Studio chat models enter the same native catalog as provider
`studio-local`, with a stable provider-local ID derived from Studio's existing
semantic inventory identity. The backend projects current downloaded rows; it
neither saves another inventory nor adds downloads/onboarding to the picker.
The native built-in OpenAI transport uses Studio's authenticated serving endpoint.
One internal workflow credential per supervised process incarnation is minted by
Studio's existing credential owner, transferred through a one-use read-only inherited
pipe, and revoked after process exit. Native consumes/closes the descriptor before
threads, plugins or tools start; environment contains only its non-secret descriptor
number, never the credential. Legacy credential-bearing bootstrap variables are
refused. The credential is never catalog or browser diagnostic data.

Native execution resolves selection under its dequeue/configuration boundary,
then admits an exact request-scoped hold through Studio's process-wide lifecycle
gates before inference. The hold spans tool work, unanswered questions and native
delegated activity, independently of browser connection or retained conversation
lifetime. An idle conversation does not acquire a hold. Existing resident models
are borrowed without changing their settings/ownership; a different workload is
busy, never force-stopped or silently evicted to satisfy coding selection.

`execution_preparation` in the ordered native state distinguishes loading, busy,
failed and cleanup-pending. Retry local selection validates the exact current
choice with empty native configuration; it does not load or automatically replay
a failed prompt. Failed work must be explicitly resent. Cleanup-pending keeps
protection and prevents unsafe successor work. HTTP timeouts/disconnects retain
exact preparation receipts until acquisition/release is reconciled, and one
request's release cannot remove another request's hold.

The supervisor derives the loopback origin from the actual ASGI listening socket,
not browser Host/proxy headers. `UNSLOTH_MIMIR_STUDIO_URL` can explicitly configure
a trusted numeric-loopback HTTP origin (for example `http://127.0.0.1:8000` or
`http://[::1]:8000`). HTTPS, DNS hostnames, malformed ports, credentials and paths
are refused before a workflow credential is created, matching the native transport.
CPU-only compositions without inference can set
`UNSLOTH_MIMIR_LOCAL_SERVING=0`; the existing CPU browser driver does so explicitly.
Local lifecycle HTTP operations require the current private workflow key and exact
incarnation, not an ordinary browser credential. Process loss/failed native drain
is not clean release: retained protections remain a visible recovery obligation.

## Transcript projection and layout (UI refresh)

`transcript-model.ts` projects immutable native rows into chronological blocks:
user bubbles, Markdown reply text (the shared pure `MarkdownPreview`), accepted
answers, plans, notices, semantic public answers/reports, subagent lifecycle rows,
and **activity groups**. Consecutive tool and `reasoning` rows of one request form
one icon-led tree; reply text, a new request or a semantic answer ends it. Every
tool invocation stays its own item with its public result, including several calls
on one delegated attempt (e.g. a launch and a refused message); invocations that
carry an exact `(handle, attempt)` get an **Inspect** link and form their own
always-visible group. Only lifecycle rows of one attempt are deduplicated. Icons and summary verbs come from native `display_kind` (`shell`, `file_read`,
`file_change`, `file_*_search`, `web`, `status`, `mcp`, …), never tool names; unknown
kinds are counted as tools. The summary states real counts, distinct reported
edited paths and failures ("Thought 2 times · ran 2 commands · 1 failed"); empty
reasoning is skipped, nothing is invented. A group opens itself only while live; a
reader's choice wins and survives remounts. Each item expands to its actual bounded
output, typed file-change diff and native identities.

`reasoning` rows are native `Summary` thinking only, shown as a "Thought process"
disclosure. Liveness comes from the native `active_request`: only the tail rows of
that request in the latest window are live, never an older request's completed
group. A frozen historical reading window (`viewingEarlier`) infers nothing live,
even for the still-active request; tool rows show their supplied status as is. No timestamps or
durations are synthesized.

Block and item keys are native row identities: invocation and accepted-answer
identities (which also correlate a live row with its saved row), otherwise the
native row `id` (saved rows are `{entry}` / `{entry}:{block}`), so prepending or
evicting history never moves a key, disclosure or reading anchor to other content.
**Native gap:** live text, reasoning and user rows
(`{kind}:{run}:{turn}:{attempt}:{index}`, `live:{position}`) carry no identity shared
with their saved rows, so those blocks remount once at the saving checkpoint.
`run-session.ts` reuses derived row objects by reference so unchanged blocks keep
identity and memoized components skip work.

Layout: a quiet header (project switcher, Session details popover with conversation
ID/cwd/reopen, trust disclosure and runtime maintenance, Mimir Settings), a
full-height transcript, and a bottom dock with only actionable notices (disconnect,
errors, recovery, reconciliation), current plan and goal disclosures, the composer
(+ menu: images, mention, goal; Build/Plan; model; Send/Stop) and a one-line footer
(run status → model details popover with **Diagnostics…**; a context ring whose
hover shows only used / limit / remaining tokens; Commands). Request identities and
bounded native diagnostics live only in the Diagnostics dialog.
Stable selectors added: `coding-activity-group`, `coding-reasoning`,
`coding-mention-list`, `coding-composer-surface`, `coding-session-details`,
`coding-event-details`, `coding-context-usage`. `coding-running-model` and
`coding-next-model` live in the run-details popover, `coding-request-id` in the
Diagnostics dialog; `coding-conversation-id`
and `coding-reopen-saved` in Session details.

## Navigation, landing and Stop authority (interaction refresh)

`session.ts` holds one `PendingOpening {operation:"create"|"open", id}`. Opening a
saved conversation is supersedable: a newer open or **New coding conversation**
aborts the older request (`AbortSignal`) and bumps the navigation revision, so its
late reply never replaces the newer view (a superseded open that did succeed only
refreshes the list). A pending create is not supersedable, because it may already
own a native conversation; uncertain creates still block until inspected. Saved
session buttons carry `data-conversation-id` and `aria-busy` and stay clickable
while another open is pending.

**New coding conversation** returns at once to a blank landing composer
(`active: null`); no folder dialog opens. While a create is pending it is disabled
and `startNew()` refuses (returns false), so the create is neither orphaned nor
repeated; it opens what it created. An uncertain create keeps its reconciliation on
the landing, which cannot create another copy. The landing composer is editable but
not sendable ("Choose a project to start."); its **Choose project** menu lists
recent project folders and **Choose project folder…**. Choosing creates the
conversation with the existing native canonical-folder authority.

The session owns the composer draft of the current view (`state.draft`: text,
selected mentions, images, images still being read and attachment errors). The landing stays editable while its create is
pending, and the conversation created from the landing takes over that same
draft object as it is when the create lands, edits and images added meanwhile
included. Opening any conversation, a create started from an open conversation,
and New each start a fresh draft, so no conversation inherits a draft meant for
another; an uncertain create leaves the draft on the landing. A new composer whose
field is empty shows its draft's text; one that already has text is never
overwritten.

`CodingRunState.authority` names the subscription whose ordered start/reset
capture this view holds. `codingStopTarget(state)` is the only Stop gate: once a
capture names an `active_request`, Stop targets exactly that request even while
history is still read or native recovery is in progress; before any capture, after
detach/owner loss, while stopping or reconciling an action it has no target, so a
stale generation or another conversation is never cancelled.

## Saved conversation list

The sidebar mounts only the saved rows near its viewport (`conversation-list.tsx`,
`@tanstack/react-virtual` on the sidebar's own `SidebarContent` scroll container).
Every row has a fixed slot (`h-13` plus the 1px menu gap, scaled with the UI font
size) and the list keeps the height of the whole inventory, so each saved
conversation is reachable by scrolling. Mounted rows keep `data-conversation-id`,
`aria-current`, `aria-busy`, the cwd title and the disclosure description, and add
`aria-posinset`/`aria-setsize`. Tab still moves through the mounted rows; Arrow
Up/Down, Page Up/Down, Home and End move focus across the whole list, focusing a
row only once it is mounted, and the focused row stays mounted while scrolled away.
A newly active conversation is scrolled into view once, not on later refreshes or
events. Rows outside the window are not in the DOM, so find-in-page and DOM
selectors only see mounted rows until the list is scrolled to them.

## Long-conversation reading (#253)

`transcript-reader.ts` retains viewport geometry and focus intent only. Streaming
follows while the main transcript is already at its bottom (48px tolerance).
Reading above the bottom or expanding a report pauses following; keyboard-operable
**Jump to latest** explicitly rejoins the latest projection and focuses the reading
region. **New activity** reports observed native state/activity/completion changes,
not an invented unread-message count. Captures/checkpoints, historical pagination
and replayed already-observed positions do not themselves mark new activity.
The authenticated bridge tags observations with an opaque native-process epoch;
one ephemeral position watermark suppresses replay without suppressing unseen
activity or low positions after an explicit runtime restart. Numeric usage-only
state reconstruction is diagnostic, not unread content. Being at the
bottom of a historical window is not being at the live transcript's bottom.

Native invocation and accepted request/question identities supply stable
presentation keys without rewriting the native entry IDs. Anchors compensate for
inline expansion/collapse, saved-row replacement and history prepending. A
same-conversation reconnect retains the visibly busy projection and its mounted
controls until reconstruction completes; a native reset discards the superseded
branch rather than claiming it is still authoritative. Focus restoration does not
steal focus from the composer, picker, inspector or Settings.

Older/newer native pages are read at one immutable cut and merged into a bounded
historical window. Opposite-edge eviction drops complete saved entries, discloses
omitted content and leaves **Load earlier history**, **Load newer history** and
**Jump to latest** access. The latest projection and historical reading window
are each bounded to 1000 rows / 2,097,152 measured JavaScript text/profile code
units. While away, an ephemeral reading snapshot follows the displayed projection
until eviction/reconnect requires freezing it. It is not a history database or a
performance guarantee; native output/read bounds and their partial labels remain.

Collapsed tool output is mounted lazily. Expanded tool/diff output is independently
keyboard-scrollable; long native messages (over 4000 characters or 80 lines) have
a labelled scrollable viewport without dropping their supplied text. Diff-section
navigation preserves access to supplied content beyond the per-section bound.

Run the CPU-only rendered driver with `--workload reading`; it records desktop
1440×1000 and narrow 390×844 row geometry, scrollTop and focus assertions. Real
native tool/streaming work uses a deterministic HTTP provider; 1664-row long-history
fixtures and delayed/disconnected browser transports are separately labelled.
Neither is live-model acceptance or human implemented-UI review. Evidence and the
cross-feature acceptance boundary are recorded in `studio/docs/coding-reading-253-evidence.md`.

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
