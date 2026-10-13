# Coding: native execution, recovery, maintenance, questions, goals, rich inputs, models, file changes and Settings

## Process recovery and whole-runtime maintenance (#249)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.

Unexpected frontend-process loss disconnects every affected native view and fails
unconfirmed commands; it never becomes Completed or a clean Stop. The supervisor
reaps only its own process, retains unconfirmed cleanup diagnostics, and does not
automatically replace the process, reopen owners, or replay accepted work, answers
or commands. Saved native history remains authoritative. Deliberate reopening
reapplies effective Studio project trust without changing saved trust/defaults and
still respects native execution leases and live-controller conflicts.

The coding route's **Mimir runtime maintenance** disclosure separates read-only
**Refresh runtime status** from **Restart whole Mimir runtime**. The latter names
its all-hosted-conversations scope and is the required way to replace the selected
frontend plugin; it is not hot reload. Authenticated `GET /api/coding/runtime`
reads supervisor status without starting Mimir. Authenticated
`POST /api/coding/runtime/restart` requires exactly
`{"scope":"all_hosted_conversations"}`. Command admission is closed during the
maintenance operation. Native safe-idle admission refuses any affected busy work;
no view, owner or process is cancelled by refusal. Users must explicitly Stop
work and await native terminal cleanup first. The backend awaits both native
session drain confirmation and process exit before starting a replacement. Missing
confirmation, forced termination or a nonzero exit prevents that replacement and
is surfaced as incomplete cleanup. Accepted maintenance survives HTTP disconnect;
an uncertain restart is inspected via fresh status/generation, never blindly retried.
Unconfirmed safe-idle admission leaves the original process/stdin alive: timeout,
transport uncertainty and local admission limits cannot authorize cancelling busy
work. Read-only native maintenance inspection distinguishes an unadmitted guard
from a drained/prepared runtime. Completing a prepared restart still requires
another explicit user action; inspection itself does not stop or replace a process.

Create/open HTTP replies stamp `runtime_generation`. Prompts, question answers, goal changes,
native command dispatch, cancellation, bounded history and SSE require
`X-Mimir-Runtime-Generation` from that opening. Stale-tab
operations are rejected before native delivery even if another tab has reopened
the same saved conversation ID in the replacement process. Epochs do not reset to
the same counter after backend restart. Process-loss SSE explicitly requires
reopening; a transient view-buffer/transport reconnect cannot retarget a new owner.
A pending restart poll is not proof of owner loss, so a native busy refusal keeps
the current incarnation's view and Stop controls available.

After unexpected process loss, explicit restart may start an empty runtime after
the supervised process is reaped. Its previous cleanup remains **not confirmed**;
this is not proof orphaned external work settled. Saved conversations must be
reopened deliberately. Native interrupted requests are shown as **Interrupted**.
**Retry same submission** only reconciles delivery and returns the original
accepted ID, even for interrupted work. **Continue interrupted work** is a separate
explicit admission with a new key, asking Mimir to inspect saved history and
current project state before continuing. No request, answer or command is replayed
automatically. Saved configured provider/model identities stay visible; reopening
or admission errors never substitute a new folder, owner or model.

Normal backend shutdown invokes native cancellation/drain, closes every owning
session and awaits process cleanup. Status remains **Stopping** until the retained
operation actually finishes. Cleanup confirmation, exit code, forced-termination
state and actionable failure text are retained in supervisor diagnostics and
logged on failure; neither cancellation acknowledgment nor a helper's exit is
sufficient confirmation.

Run the actual coding-route browser driver on current paired artifacts:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/current/mimir --plugin-package /path/to/current/package \
  --workload maintenance --browser firefox --evidence-dir /path/to/worker/maintenance
```

This deterministic-provider/native-process fault workload covers concurrent
conversations and busy restart refusal, explicit Stop/terminal cleanup,
idle restart, stale-tab delivery across replacement, process loss after a real file tool, saved interrupted identities,
same-key deduplication, keyboard explicit continuation, authenticated maintenance,
1440×1000 and 390×844 state/layout checks, unchanged saved trust fingerprints and
native shutdown confirmation. Supervisor fault tests separately cover missing
native acknowledgment, nonzero exit, forced termination and uncertain maintenance.
Native tests cover the native busy admission categories and cleanup failures.
These are fixture/fault checks, not live provider/model acceptance.

The inherited #249 baseline does not contain #246's coding whole-request
local-model protection integration. The required combined local-protection cleanup
scenario must be run once that dependency is integrated; no synthetic lease or
per-inference protection is substituted. Full cross-feature/live/human acceptance
remains #254–256 and cannot be claimed from this ticket's scoped evidence.

## Autonomous-goal slice (#240)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
The compact goal disclosure above the transcript shows native objective,
phase/cause/reason, independent review gap and accepted completion checklist.
Latest visible native `update_status` public output is also inspectable as a
conversation-level progress report, explicitly not goal-specific verification;
historical and clipped reports remain labeled. No private result JSON is decoded
and no second checklist/history store is introduced.

The authenticated goal endpoint passes native admission identity and action to the
same production frontend plugin. Native controls provide admitted actions and
busy/disabled reasons; Mimir owns scheduling and lifecycle. Start/edit drafts retain
their captured identity and become non-submittable when stale. Reconnect and
uncertain responses reconstruct native state before another action, never replay
commands. Main-session Stop remains available while goal admission is pending;
its exact cancellation attempt survives goal-triggered watcher reconstruction,
while detach and terminal settlement still supersede late replies.

Only native independently reviewed completion evidence establishes verified goal
completion. Model claims, command acknowledgment and ordinary request completion
cannot do so. Pause/clear cancel only the matching goal-owned root and children,
never unrelated activity; admission acknowledgment is not cleanup. Main-session Stop
remains the separate awaited-cleanup control. Reopened interrupted goals require
explicit resume. Native start/resume require idle admission and a model; edit/pause/
clear retain their native phase guards during busy activity. This revalidates and
corrects the former blanket busy-refusal documentation without relaxing guards.
Goal strings/evidence are clipped at native public display bounds (16 KiB/string,
64 KiB aggregate, 128 checklist entries), with explicit partial-evidence notices.
Clipped objective text is not silently reused as the full replacement in an edit.

Run the real coding-route goal driver after building the paired CLI/plugin and UI:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/current/mimir --plugin-package /path/to/current/package \
  --workload goals --evidence-dir /path/to/worker/goals
```

A2/A7/A10 evidence is recorded through authenticated production coding routes,
installed product plugin, native tools/goals and the built rendered UI at
1440×1000 and 390×844. Deterministic provider and independent-review replies remain
fixture evidence, not real-model acceptance. Completed external-provider/local-model
workloads and implemented-UI human review remain the separate #255–256 gates.

## Safe questions slice (#237)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
The native public state now supplies the actual pending question and controls.
Expanded inline cards stay separate from ordinary prompt input, with keyboard-native
single/multiple selection, custom answers, non-color status and wrapping layout.
Focus follows the exact accepted question when its controls disappear, including
checkpoint row replacement; outside interaction revokes a deferred focus handoff.

Answers target the exact conversation, live view, active coding request and pending
user request. Native admission validates current authority; stale actions must not
answer another question. The authenticated endpoint and private framing carry the
same identities. Public accepted answers are restored from Mimir history, never
synthesized from a sent browser command. Waiting, submitting, accepted, errors and
unconfirmed delivery remain distinct. Stop still awaits terminal native cleanup.
The bridge acquires an event queue only for a `view` command: answer acknowledgments
merely echo their target subscription and must not replace the queue held by SSE.

On answer transport uncertainty the frontend retains its in-memory draft, opens a
fresh captured view/history cut, and reconciles the exact question. Runtime-generation
or process-loss evidence instead requires deliberate reopening; accepted native
answer history remains readable but cannot authorize reconnecting a lost owner.
It never blindly resubmits. Confirmed still-waiting state permits only an explicit action with the new
view identity; an absent question without accepted evidence remains unconfirmed and
non-actionable, not cancelled. Native validation errors preserve the draft. Full
browser reload drops unsent form drafts, but accepted native transcript answers
remain readable and no answer is replayed. These drafts are not a second history.

Reproduce the deterministic native coding-route scenarios with:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/paired/mimir --plugin-package /path/to/current/package \
  --workload questions --browser firefox --evidence-dir /path/to/worker/questions
```

Focused contract suites and the route driver cover accepted/history-restored answers,
invalid and stale identities, replacement, lost acknowledgements, reconnect and
Stop while waiting. Browser evidence records exact view/conversation/request/question
identities, desktop 1440×1000 and narrow 390×844 viewports, screenshots and confirmed
terminal cleanup. This is deterministic provider/fault-injected native execution,
not external-provider/local-model full-PoC or human-review acceptance (#255–256).

## Continuous idle retirement (#248)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
The product frontend retains owning handles across navigation/disconnect as before.
It now starts a monotonic 30-minute interval only when no native browser views
remain **and** Session Control reports authoritative quiescence. A new view or
native admission interrupts the interval. Native's incarnation-local admission
epoch detects even work that starts and finishes between maintenance ticks.
Unknown eligibility is never idle. Admitted plugin reload remains native busy
through reconciliation and deferred idle retry, even after a lost reply or the
prompt that caused deferral finishes. Read-only inventory does not acquire this
maintenance admission. The periodic tick is retained across stream selections,
so activity in one conversation cannot starve another's maintenance.

At expiry the native conditional close atomically rechecks the same epoch and
busy exclusions. The plugin retains its handle until awaited confirmation; other
owning attachments retain their session and lease. Closing this attachment is
not reported as execution-lease release unless native confirms last-owner cleanup.
Failed cleanup retains retry-only ownership and an explicit error; it is not an
automatic retry loop or a clean release. Deliberate reopening retries that exact
failed retirement before opening a new trusted incarnation. It never cancels new
work to make a stale retirement succeed.

Retirement never deletes saved history or changes the canonical folder. Deliberate
reopen reapplies `Some(true)` effective trust without persisting shared policy,
reconstructs saved history, and does not submit/resume work. The UI names reopening
and displays cleanup errors without replacing the current conversation identity.
The timer owns no model/request protection: whole-request protection remains a
separate lifetime (#246), not a 30-minute conversation reservation.

Verification is deliberately split: pure controlled-clock timer tests; native busy,
owner/race/failure fixtures; production Wasm compilation; authenticated HTTP and
frontend tests; and the real coding-route browser driver with a separately compiled
`retirement-fixtures` component. Its clock freezes/advances retention only; native
busy/close/history and actual native file tools remain real. Default production
builds reject the clock command. The isolated acceptance app alone exposes the
authenticated clock endpoint; production routes never expose it. The browser's
502 error-rendering scenario is explicitly an HTTP projection fault, not execution
of native cleanup failure. **None of these are 30-minute live-model workload evidence.**

```sh
python3 plugins/studio-frontend/build.py --retirement-fixtures \
  --output /path/to/acceptance-only-package
# From Studio, after building dist and the paired native runtime:
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/paired/mimir --plugin-package /path/to/acceptance-only-package \
  --workload retirement --browser firefox --evidence-dir /path/to/task/evidence
```

Never install the acceptance-only component into normal shared Mimir state.
Full external-provider/local-model and human PoC acceptance remain #255–256.

## Extension inspection and maintenance (#252)

Implementation baselines: Studio `a784d9193d38c640562b5464d5e9c10def6ac82d`
and paired Mimir `7ddec52c566497dd6e0cf572a18272a88d8fa10a`.
The Mimir Settings tab composes native effective skill discovery, structured
installed/selected/enabled/live plugin inventory, and bounded supervisor
connection facts. Opening Settings is not project selection or a trust grant:
extension commands require an already retained native conversation owner.
Installed packages are not implicitly enabled or live. Runtime frontend
activation is identified separately from session plugin activation. Inventory rows
are identified by plugin ID and native lifetime: changing an installed package's
lifetime can leave a retained live owner alongside the new installed row. Plugin
reload refreshes the native effective-skill projection before reporting completion,
without executing a prompt.

`GET /api/coding/diagnostics` does not start/restart the process and exposes
only allowlisted connection/protocol/count/transport-bound facts. It never
returns environment, executable/package paths, raw errors, stderr, configuration
or credentials. Like every coding route, all Settings endpoints retain Studio's
existing authentication dependency. Inventory and skill instructions/configuration
stay native; the browser receives bounded overview metadata only.

`Refresh view and inventory` re-reads the view; it does not execute reload.
`Reload plugins for this conversation` sends one explicitly identified operation
to the existing native reconciliation owner. This reconciles shared runtime
plugins and exactly the selected conversation's session plugins, not other
session activations or the selected process frontend. Busy native reload remains Deferred
until native state confirms application. Lost replies remain Unconfirmed and are
reconciled by exact operation ID via read-only inspection, never transport replay.
A mounted Settings view re-reads pending outcomes for at most one minute, after
which explicit refresh remains available. Switching tabs, targets or disconnecting
does not cancel reload, close owners, or create another execution/persistence owner.

Reload does not replace unrelated sessions or the runtime `studio.frontend`
activation. Model catalog refresh (#245), MCP save/apply/reconnect (#250–251),
and whole-runtime restart/frontend replacement (#249) remain separately owned
operations; their controls are not implemented by this ticket or disguised as
plugin reload. The MCP section can compose into this same tab when those owning
tickets land; there is no second Studio MCP store or direct configuration editor.

Focused Settings browser scenarios extend the existing coding-route driver.
Fixture/fault-injected results are distinct from live-model/full-PoC acceptance;
this ticket does not claim #255 live workloads or #256 human UI review complete.

## Independent conversations and overlap slice (#247)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
The existing one-process bridge and native Session Control owners remain the
execution authority; no Studio scheduler, browser-owned process or new global
execution cap is introduced. Provider/native capacity refusals remain actionable.

`GET /api/coding/conversations/{id}/overlap` is an authenticated read-only native
preflight. Before a new prompt POST, the browser warns if other retained, busy
conversations share its canonical folder, including symlink aliases. The native
prompt guard checks again before admission, returning a structured
`overlap_required` refusal if another conversation became busy after preflight.
The warning offers initially focused Cancel prompt, Escape cancellation, trapped
keyboard focus and explicit Continue anyway; the original text/key is retained
until the user chooses. Cancellation abandons only this known-unadmitted draft.
It never stops another request. An explicit continuation supplies the strict
optional boolean `overlap_confirmed`; it is not remembered project authority.
Already accepted native submission keys retain original request identity and
bypass new overlap warnings during delivery recovery. The narrowly added native
Session Control **11.0.0** `submitted_request(context,key)` reads the same whole-journal
lookup as native keyed admission, including inactive branches after reopen. The
plugin uses no current-branch request-state guess or separate key registry. SDK
WIT consumers, native trait/carrier/registry, fixtures and guides are updated coherently. Rebuild
both the native executable and product component against this exact paired SDK;
an older cached executable/package is not compatible evidence.

Detection covers exact canonical folders among the supervised plugin's retained
owners, not comprehensive cross-process or nested-workspace overlap. It is **not a
filesystem lock or sandbox**, grants no authority over another owner and cannot
guarantee absence of file conflicts. Execution leases stay mandatory: a foreign
process's conversation is in use until native cleanup releases it, never
force-opened, forked or stolen. Project changes create distinct conversations;
reconnect preserves the conversation identity, canonical folder and owner.

Reproduce the focused rendered/route scenarios after building frontend and the
matching native package:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/paired/mimir --plugin-package /path/to/current/package \
  --workload concurrency --browser firefox --evidence-dir /path/to/worker/concurrency
```

The driver exercises concurrent independent native shell workloads in the same
supervised process, canonical alias warning before any prompt POST, cancellation
and explicit keyboard continuation, the route admission guard, narrow rendering
at 390×844 and desktop at 1440×1000, exact Stop isolation, native tool process
settlement, foreign-process lease refusal, and authenticated overlap access.
Paired product/native tests additionally exercise native tool capacity refusal,
keyed deduplication and settled lease handoff. Reports include exact native IDs,
PIDs, build hashes, filesystem outcomes, policy fingerprints and cleanup results.
These are deterministic provider/real native tool checks, not live-model or full
PoC acceptance. Live-provider/local-model acceptance and human UI review remain
#255–256; attempt evidence records actual completed checks and limitations.


## Reported file changes slice (#238)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
Live tool observations and saved public tool results share a native typed output
profile. The product plugin projects bounded reported effects; Studio does not
decode private saved-result JSON or query current files to build a patch.

File rows appear collapsed beneath each originating tool result, with the exact
supplied path and only available added/removed counts. Keyboard expansion reveals
reported unified hunks in a bounded scrollable region. Repeated edits are separate
chronological records, never a cumulative patch. Reopened and entry-backed profiles
say **Historical** and **not current filesystem state**. Binary, partial, truncated
and unavailable cases have textual labels. No Apply/Revert, approval semantics or
claim that generic/no-profile tools changed no files is introduced; their real
public output remains inspectable.

The native replacement moves live profile types to the shared presentation owner
and adds the historical projection at the existing persisted-message boundary.
Generic result details and distinct TUI behavior remain available. Generated
bindings, affected consumers, packaged fixtures and SDK/native documentation change
together; stale Wasm guests are not compatibility evidence.

The shared browser driver supports `--workload file-changes` (deterministic HTTP
provider, real native tools) and `--workload file-changes-live` (existing configured
provider). It compares disposable file effects, live reported hunks and reopened
historical identities/content, including an external file mutation before reopen.
Additional edge-case renderer fixtures are explicitly identified separately from
native execution and live-model acceptance. Desktop/narrow screenshot paths,
request/tool IDs, terminal cleanup and commands belong in the task-local report.
The scoped implementation is not full A1–A10 PoC acceptance or human UI review.

## Skill/image slice (#242)

Implementation baselines: Studio `a784d9193d38c640562b5464d5e9c10def6ac82d`,
private Mimir `7ddec52c566497dd6e0cf572a18272a88d8fa10a`.
The product plugin reuses native `session.skills()` and supported `Input.skills` /
`Input.images` without a new SDK registry, scheduler, upload store or provider gate.
Authenticated conversation-scoped discovery returns only effective metadata; a disk
skill's exact descriptor path and a plugin skill's full qualified name survive Send.
The composer converts edited UTF-16 ranges to native UTF-8 byte ranges and snapshots
all associations and original image bytes under the existing keyed submission.
Browser edit ranges distinguish selected occurrences from identical literal text;
ambiguous/unavailable edits discard associations instead of guessing native intent.
Escape dismisses mention suggestions without cancelling work; Stop remains explicit.

PNG/JPEG/WebP/GIF images support inspect/remove/paste with explicit type, decode,
dimension, aggregate-size and native provider failures. Four images / 512 KiB aggregate
bytes / 4096×4096 dimensions keep the existing 1 MiB private transport bound useful;
larger content fails explicitly rather than being dropped. A preview is not native
acceptance. Definite pre-admission refusal retains Restore rejected input; uncertain
retry uses the exact saved text/skills/images and key. Reload persistence remains #236.
The native input surface and public history remain authoritative; ordinary-chat
execution/tool pills are not imported.

Run the rich-input actual-browser contract scenarios after building current artifacts:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/current/mimir --plugin-package /path/to/current/package \
  --workload inputs --browser firefox --evidence-dir /path/to/worker/browser-inputs
```

This exercises rendered desktop/narrow composer controls and the authenticated coding
route into a real native request consuming both skill body and image content. The HTTP
provider is a deterministic protocol fixture, **not real-model multimodal acceptance**.
Transport refusal/response-loss scenarios are separately labeled fault injection. Native
contract tests cover qualified-name collisions, path identity and decoder/provider
rejections. `--workload inputs-live` separately uses the existing native provider profile
(no credential copies), a 128×128 visual fixture and skill instructions prepared before
native opening. It requires image recognition, a skill-only JSON marker, actual native
write/read effects and terminal completion; fixture success cannot satisfy that check.
Completed full-feature provider and Studio-local-model workloads,
full ordinary-chat smoke and human implemented-UI review remain separate acceptance
responsibilities (#255–256), not claims implied by these deterministic checks.

## Commands and current-session context (#243)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and paired Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
This slice reuses native Session Control command discovery/handling, context
snapshots and observations; it adds no SDK version, harness or history owner.
See the coding feature README and product plugin PROTOCOL for exact shapes.

Effective contributed commands, aliases, descriptions, optional arguments and
native availability are discovered from the live conversation. Terminal-only and
unknown names fail explicitly and slash input never becomes a prompt. Handled,
transient-display and submitted-request outcomes remain distinct; submitted work
is completed only by native lifecycle evidence. Compression is native asynchronous
work and retains public history.

Before command delivery the browser durably retains only an operation identity/name
(no arguments). Uncertain delivery first reconstructs the atomic native view, then
reads the exact command receipt without replay. Reload/reopen preserves the pending
identity. Native receipts are volatile and bounded; missing outcomes after process
loss remain unknown and mutations blocked rather than silently retried.

Current-session usage is nullable native observation data, with confirmed/estimated
and stale labels. On-demand context/token/retry/execution diagnostics are bounded,
metadata-only projections separate from public transcript rows. No raw logs, model
message content, provider payloads, credential/configuration fields or arbitrary
retry reasons are browser diagnostics. Closing inspection invalidates late replies.

Reproduce the rendered route with a freshly built production package and current
SDK command contribution fixture:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/current/mimir --plugin-package /path/to/current/product-package \
  --commands-package /path/to/current/test.commands-package \
  --workload commands --browser chromium --evidence-dir /path/to/worker/commands
```

This CPU-only suite uses authenticated production coding/auth routes and real
Mimir/production Wasm with a deterministic HTTP provider. It checks effective
contributions and all outcome kinds, unsupported/busy admission, uncertain response
receipt recovery through reload, bounded diagnostics, native compression/history,
and rendered keyboard/focus controls at 1440×1000 and 390×844. Reports distinguish
fixture evidence from live-model/full-PoC acceptance, which remains #255–256.

## Reopen/reconnect slice (#236)

Implementation baselines: Studio `a784d9193d38c640562b5464d5e9c10def6ac82d`
and private Mimir `7ddec52c566497dd6e0cf572a18272a88d8fa10a`.
Shared history is authenticated and deliberate reopening retains the exact native
conversation and saved canonical folder. Missing/inaccessible folders, execution
leases and incompatible trust remain native refusals, not replacement projects.

Browser navigation and view teardown release only views, never accepted work or
host owning handles. Transport recovery automatically opens a fresh atomic native
view and reconstructs its immutable history cut before becoming ready. A persistent
disconnect banner remains through retry/reconstruction; no Last-Event-ID suffix is
assumed authoritative. Native recovering state waits for the root checkpoint.
Bounded earlier pages and clipped/unloaded output remain explicitly incomplete.
Historical activity is not evidence of a currently running request.

Before prompt HTTP delivery, the browser durably stores one conversation-scoped
pending submission key and text. A reload/reopen recovers that delivery record,
not a second transcript. Retry reuses the same key; native persistent deduplication
returns the original request identity, including after plugin restart. No prompt
is automatically replayed. Failure to persist recovery identity prevents sending.
Recovering delivery is distinct from explicitly continuing interrupted work with
new input after process loss.

For uncertain non-prompt responses, rebuild the authoritative native view before
allowing another action. Stop is never blindly replayed; cancellation acknowledgment
is not terminal cleanup. This shared pattern does **not** promise generic
exactly-once commands. Capability-specific stale question/plan/goal tests remain
with their feature tickets. Production process recovery/restart is described in
#249 above; continuous idle retirement is described above (#248).

Run the actual-browser recovery driver after building the frontend/native package:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir /path/to/paired/mimir --plugin-package /path/to/current/package \
  --workload recovery --browser firefox --evidence-dir /path/to/worker/recovery
```

The driver exercises actual navigation, refresh, viewing-tab closure and deliberate
reopen; automatic reconnect; failed bounded-history reads; native tools/checkpoint
replacement; lost prompt/cancel acknowledgments; durable keys across frontend
reload; and same-key native deduplication after a clean acceptance-server/plugin
restart. The reset shim is **acceptance-only transport fault injection**: it
reuses the real atomic start capture as a recovering reset, remaps positions in
order, then waits for real native checkpoint evidence. It neither alters saved
history nor fabricates execution/results. Tests of naturally occurring slow-reader
resets and native chunk bounds belong to the paired real-process suite.

Task-local browser reports record scenario IDs, source/artifact fingerprints,
native conversation/request/submission identities, screenshots at 1440×1000 and
390×844, trust fingerprints and awaited cleanup. Deterministic HTTP-provider/native
tool and fault evidence is distinct from live-model evidence. This slice does not
claim external-provider/local-model full-PoC acceptance or implemented-UI human
review; those remain #255–256.

## Subagent inspection slice (#241)

Implementation baselines: Studio `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
and private Mimir `91b975adae2df627d7c67c6bcede6d910a592a7d`.
The product bridge consumes existing native child view captures, exact child/attempt
activity, checkpoints, bounded child-journal reads, and non-consuming retained
outcomes. The authenticated child-inspection endpoint exposes no delegation controls.
Mimir remains the delegation and completion-delivery owner.

The browser presents compact agent-icon rows and a right-hand inspector, expanded
only on demand. The narrow layout covers the transcript width while leaving native
connection feedback and main-session Stop available. Inspecting another attempt or
dismissing the panel aborts only obsolete inspection reads. Historical attempts and
outcomes keep their exact identities; historical reports cannot turn old work live
and launch acceptance never fabricates completion. Native outcome reads do not
claim the parent’s pending completion. Missing old transcript cuts are explicitly
unavailable, never replaced with the newer attempt’s journal. Public oversized
entry/detail/result prefixes stay bounded with truthful incomplete-content labels.

Run the same actual coding-route driver with `--workload children --browser firefox`.
It uses a deterministic HTTP provider with **actual native delegation** and native
read-file work, including a continued attempt and terminal failure. Scenario reports
preserve `(child handle, attempt)` outcome identities, ordered view positions,
captured cuts, parent completion debt/delivery, desktop 1440×1000 and narrow 390×844
keyboard/navigation/dismissal captures, disconnect/reopen, and awaited cleanup.
Focused browser-driver, projection and native view-contract tests complement this
route seam; fixture success is not live-model or human acceptance. See the task-local
reports for checks actually completed. Full external/local-model PoC acceptance
and implemented-UI human review remain #255–256, not claims of this feature slice.

## Run/stop slice (#235)

Implementation baselines are Studio `1ca8b10f3f3c43fddf3e510cf90aa5c65b79d9bd`
and paired private Mimir `1fd0ca7275f25a3bde6507a17535983e2aeec5ee`.
The same production plugin now admits keyed native prompts, exact request
cancellation, full ordered public views and bounded immutable-cut history reads.
The frontend uses assistant-ui external state, with no chat execution imports,
optimistic turns or durable transcript store. Credentials remain external.

Read `studio/frontend/src/features/coding/README.md` and the paired plugin
`PROTOCOL.md` for exact HTTP/wire shapes and reconstruction. Stop acknowledgment
is not settlement: Stopping persists through native completion and cleanup;
cleanup errors remain failures. Disconnect never implies work stopped, and browser
view teardown never closes the native owner. Reconnect uses the same captured-cut
projection; durable reopen/uncertain delivery across reload belongs to #236.

The opening-only adapter and its disabled-execution assertions are superseded by
`run-runtime.ts`, `run-session.ts` and current shipped-artifact behavior tests.
No SDK WIT signature or historical private-profile decoder is added for #235;
this slice reuses existing public typed history, native prompt/cancellation and
presentation contracts. File-diff profiles remain #238.

The browser driver now supports opening, deterministic HTTP-provider/native-tool
scenarios, and a separate externally configured live-provider workload. Fixture
success is not live-model evidence. Task-local reports record native identities,
filesystem effects, exact desktop/narrow sizes, cleanup, and concrete external
blockers. Human/full-PoC review and Studio-local-model acceptance remain #255–256.

## Next-request model and reasoning slice (#244)

Implementation baselines are Studio `a784d9193d38c640562b5464d5e9c10def6ac82d`
and paired private Mimir `7ddec52c566497dd6e0cf572a18272a88d8fa10a`.
The coding composer uses the native catalog only; IDs remain independent of labels
and native API mappings. The authenticated configuration command contains no
provider setup, credentials or model administration, and prompts still contain
only their native submission key and text.

Mimir publishes next-request configuration separately from pinned running
configuration. Its serialized `prepare_execution` boundary resolves the latest
choice for direct and already-queued native requests, retaining selection ordering
through start. That is the host integration point for #246 preparation/protection;
this ticket does not load Studio local models or reserve them. Configure errors
leave active work and selection unchanged; there is no compatibility admission
check or fallback. SDK session-control@11 adds native defaults/API mapping and the
separate running configuration; generated bindings, carrier fixtures and packaged
consumers are updated together rather than a competing old catalog projection.

The Studio-styled popover supports configuration/list/Back, search, provider
navigation, identity-pair favorites, and a discrete slider over native offered
values. Model-switch patches omit reasoning so Mimir chooses the new default.
Uncertain configuration delivery is not replayed: a view opened before that
operation's outcome cannot clear its uncertainty. A later reconstruction is
required before further selection or input; native Stop stays available.

Run the existing browser driver with `--workload picker` for deterministic HTTP
provider selection, real native tool continuation, rendered desktop/narrow
interactions and running-versus-next assertions. Task reports distinguish that
fixture workload from live provider/local inference and human PoC acceptance.
Fresh catalog/live selectability (#245), local-model protection (#246), and final
live/human acceptance (#255–256) remain separate slices.

## Historical #234 boundary and source audit

The historical #234 attempt revalidated Studio
`1152ca6decda2a0e1a7e09ad8f806d5f76207453` and private Mimir
`8b90a6f9b934c72813539ba99e11a8591a63cbb0`.
The carried-forward attempt used Studio
`1ba38a92b9c2f78e597c8ef26d0230c63171fdb9`; the intervening tracked changes
are coordinator/runner changes, not part of this ticket's implementation.
The recovered implementation was originally audited at Studio
`7bdad61371a811c6001832908cf36d4d4af3fe8c` and Mimir
`fe821251db6d8327fb59fde5f5a2cad9de0c231c`; prior-attempt evidence is not a
substitute for this attempt's verification.
These are audit baselines, not assertions that HEAD must remain unchanged. The
coordinator records the delivered native revision in `mimir-runtime.lock.json`.
Validation must work on committed snapshots as well as an uncommitted patch.
The standalone `external_frontend_cli` suite prepares current workspace guests
and its extracted-SDK consumer once per invocation, so check ordering or cached
Wasm cannot substitute for current-source verification. Preparation does not
serialize the actual native scenarios or relax their assertions/deadlines.

The product source is **Mimir `plugins/studio-frontend`**, ID
`studio.frontend`, a runtime-lifetime, headless frontend using the existing SDK.
It is not `tools/quality/fixtures/external-frontend`, which remains the packaged
SDK acceptance consumer. There is no companion session/provider plugin. See the
product package README/PROTOCOL in the pinned Mimir checkout for locked build,
installation, framing, resource bounds, and public-state projection.

Studio supervises `mimir plugin run studio.frontend` over private pipes. Set
`UNSLOTH_MIMIR_EXECUTABLE` to the built pinned executable when it is not on PATH.
`UNSLOTH_MIMIR_PLUGIN_PACKAGE` names the built package; before its first launch the
bridge validates the product ID and installs that package with the same executable.
Without that setting, install the package with the executable's `plugin install` command.
Production inherits normal Mimir configuration/history; Studio never creates an
agent profile, copies credentials, edits trust records, or supplies a coding
folder allowlist. Test runs alone override `MIMIR_CODING_AGENT_DIR`.

`core/coding_runtime.py` retains one process, multiplexes bounded framed responses
and ordered lifecycle views, and awaits shutdown. Browser disconnection does not
replay commands or release conversation owners. Fatal private-transport failures
initiate supervised EOF and await process cleanup without restart/replay. Slow SSE readers receive an explicit
reconstruction error, not a silently truncated suffix. Disconnecting a browser
closes only its view. Continuous idle retirement is described above; whole-runtime
maintenance remains #249.

All `/api/coding` routes use Studio's existing `get_current_subject`; conversation
IDs, history, catalogs, folder browsing, and SSE have no auth bypass. This slice
adds no new owner-only policy. Existing model-folder browsing safeguards remain
untouched. The coding folder browser lists OS-readable directories only; native
Session Control validates canonical read/search access again at opening. A folder
is a working directory, **not an upload or a sandbox**.

Explicit selection/reopen/catalog sends the narrow effective trust input through
Session Control. Trust is non-persisting, controller-scoped, and inherited by
native children. Native live-trust mismatches and execution leases remain native
refusals; neither Studio nor the plugin cancels or takes over an owner.

## Presentation audit and isolation

The installed manifest pins `@assistant-ui/react` **0.12.28**, core **0.1.17**.
The coding shell uses the shipped `useExternalStoreRuntime`,
`AssistantRuntimeProvider`, and `ComposerPrimitive` APIs; tests exercise that
installed artifact, not assumed newer documentation. #234 disabled execution;
#235 enables native submission after a connected captured view. The shipped
runtime's transient upcoming-assistant placeholder has no native row and is
intentionally invisible; only native public entries render in the transcript.

Ordinary chat's page, runtime store, history database, model loading, and tool
orchestration are not reused in coding. Shared button/input/dialog/sidebar
primitives and existing composer CSS are presentation-only. `/coding` branches
into its isolated visual shell before ordinary-chat execution hooks mount.
Backend route re-exports are lazy so importing coding/auth does not initialize
chat/training; the full application still imports the same established routers.

## Replacement inventory

Before the native edits, Session Control catalog/create/open lacked an explicit
effective-trust opening input. Their SDK WIT, native trait/carrier implementations,
CLI controller/catalog callers, Rust mocks, packaged external-frontend fixture,
SDK guide and external-frontend guide are updated together. The prior call forms
are superseded rather than maintained as a competing fallback. Generated bindings
remain generated by the SDK's existing WIT mechanism.

Existing CLI launch trust resolution remains distinct from explicit controller
opening trust: do not replace shared saved policy or TUI trust behavior. Existing
native child configuration already carries the parent's resolved trust; focused
tests verify inheritance. No history schema, generic tool result, model-folder
safeguard, provider inventory, or TUI capability is superseded by this ticket.
Historical profiles are implemented by the #238 slice above. MCP management and
headless inventories remain their respective later capability tickets.

## Reproducible actual-browser driver

After building frontend and native/product artifacts, run from Studio root:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir-source /path/to/paired/pinned/mimir-checkout \
  --evidence-dir /path/to/attempt/worker/browser
```

`--mimir-source` rebuilds the native executable and product package from that
checkout before running the browser. For separately verified builds, use
`--mimir /path/to/pinned/mimir --plugin-package /path/to/built/package` instead.
The report records native/package hashes and both source revisions; a source
revision alone is not evidence that an uncommitted patch was built.

Use a task-owned Python environment with backend test dependencies and
`playwright`; the driver uses installed Chrome (override `--chrome`), or
`--browser firefox` with Playwright's Firefox installed under a task-owned
`PLAYWRIGHT_BROWSERS_PATH`. Both paths disable hardware acceleration; the report
records the engine/version actually used. Firefox provides a software-rendered
alternative when host Chromium launch/screenshot support is unavailable. It binds
loopback only, creates isolated Studio auth/native history/disposable projects,
installs the real product package, authenticates using the real password endpoint,
and exercises the **built `/coding` page → production Studio coding/auth routers
→ private plugin → native Mimir**. The acceptance composition omits unrelated
ML/training startup, not any coding or authentication implementation. It requires
no GPU. `--workload opening` makes no provider calls; the default deterministic
workload uses an external HTTP protocol fixture with real native tools. The
separately reported `--workload live` uses existing host provider configuration
and credential resolution, never browser credentials or copied configuration.
This composition is not a full Studio/ordinary-chat or local-model workload. It preserves screenshots, scenario facts, native IDs and
server logs outside Git; passwords/tokens are never included in the report.

Desktop is 1440×1000; narrow is 390×844. The driver asserts placement, disabled
Send before selection, invalid/missing/OS-denied paths, canonical symlink identity,
changed-project identity, deliberate reopen, and unauthenticated refusal on all
nine coding surfaces (browse/catalog/history/create/open/SSE/prompt/cancel/bounded
entries), including valid command inputs and known IDs. Run scenarios add actual
write/read/shell outcomes, same-key retry/busy refusal, exact cancellation and
process cleanup, provider/tool failures, public-output bounds, disconnect/reconnect,
and keyboard tool details/Enter submission. It also checks focus, dismissal and overflow. It fingerprints the native saved policy at
`MIMIR_CODING_AGENT_DIR/trust.json`, or `~/.mimir/agent/trust.json` when unset,
before and after acceptance; the separate isolated ancestor-distrust fixture is
also checked. Run `python3 -m unittest discover -s studio/tools -p
test_coding_browser_acceptance.py` to verify that evidence-path contract without
reading or writing real policy. Generated evidence and logs must never be committed.

## Shared A1–A10 evidence ledger

This is the shared record for follow-on tickets. **Implemented is not accepted.**
The task-local `worker/ticket-result.json` and browser `report.json` identify actual
commands/artifacts/results; this tracked matrix intentionally contains no stale
claim tied to a mutable local HEAD or absent screenshots.

## Question-contract replacement inventory (#237)

Session Control 11 replaces the former pending-ID-only answer call with an exact
active-request plus pending-user-request call. Tool Invocation 9 follows its public
dependency. Native controller/carrier callers, generated SDK imports, TUI responder,
registry expectations, fixtures and SDK documentation are updated together; the old
answer admission form is not kept as a competing fallback. Display entries and view
observations add typed accepted-answer metadata, projected natively from the existing
question-result journal with exact correlation IDs. No private schema is decoded by
Studio, no second receipt/history store is added, and generic tool results remain
available independently of accepted answers. SDK fixtures must be rebuilt against
these contracts, not reused from an older Wasm artifact.

| ID | Implemented coverage (see attempt reports for verification) | Remaining capability evidence |
|---|---|---|
| A1 | Native opening/SDK contracts; single supervised product plugin; authenticated HTTP/SSE; exact submission/request/tool identities; atomic ordered public view, checkpoints/reset/recovery, bounded cut reads and durable reconnect reconciliation (#236) | Cross-feature integration and packaged-consumer regression (#254) |
| A2 | Native prompt/Stop controls; compact inspectable public tool results/failures and clipping disclosure; native inline questions and retained accepted answers (#237); exact child-attempt inspector with non-consuming outcomes, public historical completion records, bounded child views and real native-delegation route driver (#241) | Modes, plans/goals and cross-feature/live-model acceptance (#254/#255) |
| A3 | Shared typed live/historical reported changes; collapsed inspection-only rows, bounded unified hunks, optional counts and incomplete/binary labels (#238) | See task-local file-change browser and SDK reports; cross-feature/live acceptance (#254/#255) |
| A4 | #244 next-request picker: native catalog/identity, stepped reasoning/default reset, provider search/navigation/favorites, separate running/next state, configuration/dequeue races | Live catalog refresh (#245) and cross-feature integration (#254) |
| A5 | Externally configured provider admission; no Studio local-model serving | Local-model requests and whole-request protection (#246/#255) |
| A6 | Canonical/native validated opening, non-persisting effective trust, saved-policy tests, child inheritance, mismatch/lease refusals, authenticated run/Stop/history access; independent concurrent native workloads and canonical-folder warning/admission (#247); same-identity trusted history reopening after idle retirement (#248) | Process-loss recovery (#249) and cross-feature acceptance (#254–255) |
| A7 | Exact request cancellation; Stop acknowledgment distinct from cleanup; disconnect never stops owners; typed native failures; durable submission identity across reload/native restart, automatic authoritative reconnect and non-prompt reconciliation (#236); no automatic work replay; awaited EOF shutdown; continuous unviewed/native-quiescent retention, controlled clocks, atomic native retirement and failure-safe cleanup retry (#248) | Full process-interruption/maintenance scenarios (#249) and cross-feature live-model acceptance (#254–255) |
| A8 | Focused Mimir Settings; native headless installed/enabled/selected/live inventory, effective skills, bounded diagnostics, exact scoped reload and uncertain-outcome reconciliation (#252); scoped native MCP inventory, revision-checked persistence and draft reconciliation, save-only Settings with configured/applied distinction (#250) | MCP live apply/reconnect (#251) and separately owned runtime restart (#249) |
| A9 | Ordinary-chat store/engine untouched; affected shared/ordinary-chat tests; coding route excludes ordinary model observers and chat execution imports | Real ordinary-chat smoke and cross-feature regression (#254/#255) |
| A10 | Rendered opening, deterministic provider/native-tool, cancellation/failure, keyboard/narrow, and separate live-provider driver | Full cross-feature execution UI checks and user's implemented-UI review (#255/#256) |

## MCP save-only Settings slice (#250)

Revalidated paired baselines: Studio `1ca8b10f3f3c43fddf3e510cf90aa5c65b79d9bd`
and Mimir `1fd0ca7275f25a3bde6507a17535983e2aeec5ee`. Settings extends the
existing authenticated coding boundary and single `studio.frontend` activation;
no Studio file editor, competing configuration store, or additional plugin is added.
See [frontend Settings contracts](../frontend/src/features/coding/README.md#mimir-settings-250)
and the paired native SDK/protocol documentation for resource/revision semantics.

The real-route MCP driver uses the built UI, production auth/coding routers,
installed product plugin and native Mimir. It isolates **all four** MCP layers
(including the OS home layer) and configuration/history/trust. It performs actual
native reads/writes (including a readable, non-writable inherited layer),
conflicting authenticated writers, invalid definitions, permission/persistence
faults, deliberate reconciliation, enabled-but-unapplied
configuration, and rendered keyboard/focus/narrow error flows. It also exercises a
compact definition whose normalized editor JSON exceeds the native bound: refusal
must precede persistence and retain the draft/revision. The bounded save acknowledgment
contains the actual committed revision and source-configured state independently of
best-effort inventory; unavailable inventory never replays or falsifies a completed
save. It does not call a provider, apply/reconnect servers, or claim
full-Studio/ordinary-chat smoke evidence.

```sh
.venv/bin/python studio/tools/coding_mcp_browser_acceptance.py \
  --mimir /path/to/current/mimir \
  --plugin-package /path/to/rebuilt/studio-frontend/package \
  --evidence-dir /path/to/attempt/worker/mcp-browser
```

Use task-owned backend/test dependencies, `playwright` and `psutil`; Chrome is the
default, with software-rendered Firefox available via `--browser firefox`.
The driver records 1440×1000 and 390×844 screenshots, native conversation identity,
opaque committed edit revisions, source/binary hashes, sanitized requests/logs and
awaited native-process/server cleanup. Its report is evidence only after terminal
success and screenshot inspection. `test_coding_mcp_browser_acceptance.py` tests
fixture isolation/redaction; it is not a browser result. A task-owned native
persistence-writer lock injects actual cross-process busy refusal through the real
save path. This is distinct from busy-sensitive live apply (#251); mocked native
busy/error propagation checks are supplementary, not live runtime-apply validation.

Focused native tests cover document revision conflicts (including inherited input
changes and semantically equal target rewrites), validation, failed persistence,
closed editors and activation/session identity. Studio controller/API/auth tests
cover draft retention, no replay, deliberate rebase, and native editor-only cleanup.
Actual React rendered fixtures distinguish unavailable live observations from
known-empty applied connections using `live_available`, never diagnostic parsing.
Full provider/local-model workloads and human acceptance remain #255/#256.

## Source-sensitive command-admission follow-ups

At the native audit baseline, `runtime/controller/plugin.rs::commands` filters
terminal-only Human Commands and projects `Any`/`IdleOnly`; `command` delegates to
`invoke_command`. #243 must exercise unknown/terminal-only/idle-only refusals, not
turn unknown slash text into prompts or infer admission from a visible button.

`plugin.rs::decide_plan` delegates to the native controller. #239 must verify stale
plan identity and native busy-state decisions for each implement/fresh-context/
save-and-stop action; changing mode is not plan acceptance.

`plugin.rs::change_goal` delegates to `SessionController::execute_goal` in
`runtime/controller/goals.rs`. The inspected source acquires a prompt lease for
Start/Resume, while Edit/Pause/Clear use the existing running-goal path and capture
cancellation for Pause/Clear. Thus the historical blanket-busy discrepancy must
be tested at the exact delivered source in #240; do not bypass guards or claim
support solely from the enum. #235 must await exact cancellation settlement;
#237 addresses pending questions by exact native and live-view identity; #242 must
use native image/skill admission. Remaining capabilities are not wired here.
