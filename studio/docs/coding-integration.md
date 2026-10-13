# Coding: trusted projects, run/stop, recovery and questions (#234–237)

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
fresh captured view/history cut, and reconciles the exact question. It never blindly
resubmits. Confirmed still-waiting state permits only an explicit action with the new
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
with their feature tickets. Production process restart and idle retirement remain
#249 and #248 respectively.

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

| ID | Implemented #234–237 coverage (see attempt reports for verification) | Remaining capability evidence |
|---|---|---|
| A1 | Native opening/SDK contracts; single supervised product plugin; authenticated HTTP/SSE; exact submission/request/tool identities; atomic ordered public view, checkpoints/reset/recovery, bounded cut reads and durable reconnect reconciliation (#236) | Cross-feature integration and packaged-consumer regression (#254) |
| A2 | Native prompt/Stop controls; compact inspectable public tool results/failures and clipping disclosure; native inline questions and retained accepted answers (#237) | Modes, plans/goals, children and diagnostics (#239 onward) |
| A3 | No diff implementation or fabricated effects | Typed live/historical reported changes (#238) |
| A4 | No model picker | Model/reasoning interactions (#244) |
| A5 | Externally configured provider admission; no Studio local-model serving | Local-model requests and whole-request protection (#246/#255) |
| A6 | Canonical/native validated opening, non-persisting effective trust, saved-policy tests, child inheritance, mismatch/lease refusals, authenticated run/Stop/history access | Concurrent execution/same-folder warning and retirement/recovery (#247–249) |
| A7 | Exact request cancellation; Stop acknowledgment distinct from cleanup; disconnect never stops owners; typed native failures; durable submission identity across reload/native restart, automatic authoritative reconnect and non-prompt reconciliation (#236); exact live-view/request/question answer validation and uncertain-answer reconciliation (#237); no automatic work replay; awaited EOF shutdown | Controlled idle clocks and full process-interruption/maintenance scenarios (#248/#249) |
| A8 | No Settings management surface | Native MCP and headless inventory/settings (#250–252) |
| A9 | Ordinary-chat store/engine untouched; affected shared/ordinary-chat tests; coding route excludes ordinary model observers and chat execution imports | Real ordinary-chat smoke and cross-feature regression (#254/#255) |
| A10 | Rendered opening, deterministic provider/native-tool, cancellation/failure, keyboard/narrow, and separate live-provider driver | Full cross-feature execution UI checks and user's implemented-UI review (#255/#256) |

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
