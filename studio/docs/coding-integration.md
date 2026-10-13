# Coding: trusted projects, native execution, recovery and maintenance

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

Create/open HTTP replies stamp `runtime_generation`. Prompts, cancellation, bounded
history and SSE require `X-Mimir-Runtime-Generation` from that opening. Stale-tab
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
#249 above; idle retirement remains #248.

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
closes only its view. Idle retirement/restart/recovery are later tickets.

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
Historical profiles, MCP management and headless inventories belong to their
respective later capability tickets, not this patch.

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

| ID | Implemented #234–236 coverage (see attempt reports for verification) | Remaining capability evidence |
|---|---|---|
| A1 | Native opening/SDK contracts; single supervised product plugin; authenticated HTTP/SSE; exact submission/request/tool identities; atomic ordered public view, checkpoints/reset/recovery, bounded cut reads and durable reconnect reconciliation (#236) | Cross-feature integration and packaged-consumer regression (#254) |
| A2 | Native prompt/Stop controls; compact inspectable public tool results/failures and clipping disclosure | Questions, modes, plans/goals, children and diagnostics (#237 onward) |
| A3 | No diff implementation or fabricated effects | Typed live/historical reported changes (#238) |
| A4 | No model picker | Model/reasoning interactions (#244) |
| A5 | Externally configured provider admission; no Studio local-model serving | Local-model requests and whole-request protection (#246/#255) |
| A6 | Canonical/native validated opening, non-persisting effective trust, saved-policy tests, child inheritance, mismatch/lease refusals, authenticated run/Stop/history access | Concurrent execution/same-folder warning and retirement/recovery (#247–249) |
| A7 | Exact request cancellation; Stop acknowledgment distinct from cleanup; disconnect never stops owners; typed native failures; durable submission identity across reload/native restart, automatic authoritative reconnect and non-prompt reconciliation (#236); no automatic work replay; awaited EOF shutdown | Controlled idle clocks and full process-interruption/maintenance scenarios (#248/#249) |
| A8 | No Settings management surface | Native MCP and headless inventory/settings (#250–252) |
| A9 | Ordinary-chat store/engine untouched; affected shared/ordinary-chat tests; coding route excludes ordinary model observers and chat execution imports | Real ordinary-chat smoke and cross-feature regression (#254/#255) |
| A10 | Rendered opening, deterministic provider/native-tool, cancellation/failure, keyboard/narrow, and separate live-provider driver | Full cross-feature execution UI checks and user's implemented-UI review (#255/#256) |

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
#237 must address pending questions by native identity; #242 must use native
image/skill admission. These capabilities are deliberately not wired here.
