# Cross-feature integration and ordinary-chat regressions (#254)

## Scope and provenance

This is the final **automated** cross-feature pass, not full PoC acceptance.
Implementation inputs are Studio `7089871db40303322de698bf9988372a46e2e4da`
and private Mimir `7482fa0d41f114743daf6870c0052bf7fd95bd4e` in the supplied
#254 worktrees. Historical reports from #234–253 remain historical; their old
build paths, source revisions and model/GPU grants are not renewed by this pass.
No commits, publication, shared trust changes, GPU workloads or paid provider
requests are part of this ticket.

The single parent A1–A10 matrix remains authoritative. Evidence categories:

- **Static/build:** current production/test compilation, packaged/extracted SDK
  consumers, rebuilt Wasm guests and replacement-inventory review.
- **Deterministic/fault:** native/backend/frontend suites and authenticated,
  rendered, real-process coding-route drivers with controlled provider input.
  Synthetic large histories/diffs and transport/clock injection stay labelled.
- **Live:** completed real-model external-provider/Studio-local coding workloads
  and real ordinary-chat smoke are #255 gates; fixture success is not a substitute.
- **Pending-human:** implemented-UI user review and corrections remain #256.

## Integrated changes

The existing native desktop Settings menu omitted **Mimir**, causing the inherited
`Go > Settings lists every Settings page, in the dialog's order` regression.
The baseline reproduction failed 1/19 tests. Added the missing native menu entry
between Agents and Voice, retaining About and all other existing pages. Strengthened
the assertion to compare the **entire** dialog list instead of a sliced prefix;
no failed assertion was relaxed. The focused rerun passed 364/364 coding,
route-isolation and desktop-menu tests. Native macOS menu rendering requires a
macOS host; this Linux pass does not claim that platform-specific execution.

`studio/tools/coding_integration_acceptance.py` orchestrates the **existing**
coding-route and MCP browser drivers; it adds no application execution harness,
scheduler, transcript/diff store, model inventory or credential profile. Each
workload retains its original isolated state, request/tool/view identities,
filesystem evidence, screenshots, command result and terminal cleanup checks.
The reconciler:

- requires current paired source revisions and native/product/frontend hashes;
- checks helper exit **and** retained terminal report, scenarios and process/port
  settlement, plus actual configured MCP connection settlement;
- refuses to overwrite evidence; missing workloads and truncated reports fail
  closed, and a timeout stops further submissions over uncertain cleanup;
- keeps the separate compile-gated retirement guest distinct from the production
  package and never promotes deterministic passes into live/human acceptance.

The MCP driver's record now fingerprints the built frontend alongside native and
product Wasm artifacts, allowing the same freshness check as other workloads.

The real rendered pass also repaired accumulated driver assumptions without
relaxing checks: conversation operations now carry the required native runtime
incarnation; collapsed tool reports are selected by call ID and expanded before
asserting details; the shared Settings-modal trigger is distinguished from the
coding view tab; a resized picker is scrolled into view before measuring its
bounds; and plan output inspection explicitly returns from the bounded historical
window to live history. Picker clipping was reproduced and diagnosed with real
scroll geometry, not fixed by changing application layout. Parent browser testing
also found the production `unsupported_command` → HTTP 502 mapping defect; an
added failing regression and exact HTTP 400 correction are documented in the
backend evidence.

## Reproduction

First run the paired native build/SDK verification and backend checks documented in
`coding-backend-254-evidence.md` and private Mimir's
`docs/ticket-254-native-verification.md`. Build/typecheck Studio production and tests:

```sh
npm --prefix studio/frontend ci --no-audit --no-fund
npm --prefix studio/frontend run typecheck
npm --prefix studio/frontend run build
(cd studio/frontend && npm test)
python -m compileall -q studio/tools/coding*.py studio/tools/test_coding*.py
python -m unittest discover -s studio/tools -p 'test_coding*.py' -v
rustfmt --check studio/src-tauri/src/app_menu.rs
```

Then, with **newly built** paired artifacts and a task-owned backend environment
containing Playwright Firefox, invoke the accumulated route drivers:

```sh
.verification/backend-venv/bin/python studio/tools/coding_integration_acceptance.py \
  --mimir /absolute/path/to/current/mimir \
  --plugin-package /absolute/path/to/rebuilt/product-package \
  --retirement-package /absolute/path/to/rebuilt/retirement-package \
  --commands-package /absolute/path/to/rebuilt/test.commands-package \
  --build-record /absolute/path/to/current-source-build-record.json \
  --evidence-dir /absolute/path/to/worker/254-automation --browser firefox
```

Evidence must be outside the Git worktree, as required by the existing driver.
Use repeated `--workload NAME` to run bounded batches in disjoint directories.
Batches publish unique local records and report only their selected workloads;
then `--reconcile-only` serializes the final `integration-report.json` publication.
Final reconciliation intentionally exits nonzero until **all** required workloads
and current-source builds are present and passing. The build record contains
observed passed build commands, `current_sources(root)` and an `artifacts` mapping
matching current frontend/native/product/retirement/contributed-command hashes.
Source manifests include scoped uncommitted code and exclude profiles/credentials.
The reconciler also requires each workload's external scenario inventory and exact
driver/options; an opening report cannot stand in for recovery or MCP apply.
A deadline interrupts the Python driver so its `finally` can drain/write evidence,
then recovers only captured exact-owned identities if necessary. Any timeout is
still failed acceptance, and PID absence never certifies a clean native drain.
No GPU visibility/reservation is used.

## Current observed frontend/tool verification

Sanitized logs: Studio `.verification/ticket254/frontend/` and
`.verification/ticket254/tools-tests.log`.

| Command | Observed result | Category |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | Exit 0; lockfile-pinned React 0.12.28/Core 0.1.17 installed | Setup |
| `npm run typecheck` | Exit 0; application and test code compiled | Static/build |
| `npm run build` | Exit 0; production Vite build (existing large-chunk warnings retained) | Static/build |
| Focused coding, route-isolation and desktop-menu tests | 364 passed, 0 failed, 0 skipped | Deterministic + shipped-artifact/static contracts |
| Full frontend `npm test` | 11,802 passed, 0 failed, 1 timing-sensitive self-skip | Mixed existing frontend regressions |
| Timing-sensitive test file rerun | Exit 0; see `timing-rerun.log` (not a weakened assertion) | Deterministic timing |
| Driver contract unittest discovery | Final rerun: 75 passed, including reconciliation/source/timeout and isolated compilation-cache checks | Deterministic/fault |
| Python compilation; `rustfmt --check`; `git diff --check` | Exit 0 | Static/build |

The full frontend suite includes source-based legacy checks as well as executed
state/adapter/runtime tests. It is not described as 11,802 rendered interactions.
The full run's self-skip was `a healthy read resets the stall window`, which
reported scheduler stalls; its scoped rerun is recorded separately.

## Replacement inventory

| Inventory item | Current owner/consumer and disposition |
| --- | --- |
| Opening-only disabled-execution adapter | Superseded by `run-runtime.ts`/`run-session.ts`; shipped assistant-ui tests execute that adapter. `session.ts` remains the actively used folder/list/create/open presentation controller, not a competing execution fallback. |
| Browser folder catalog as live picker inventory | `codingModelApi.catalog` reads the retained conversation's `/models`; `/models/refresh` updates native discovery/selectability. Folder catalog remains needed before creating a conversation. |
| Untyped historical-profile decoding | `file-changes.ts` consumes bounded public typed `output_profile`; shared live/historical report rendering stays under originating tool identities. No private saved-result JSON decoder or cumulative workspace diff is introduced. |
| Studio MCP file/inventory projection | Settings forwards native edit/save/apply/reconnect/inventory. No Studio-side MCP-file editor or secondary configuration authority. Shared native owner and distinct TUI/generic result consumers are checked in the native report. |
| Ordinary chat and model-folder safeguards | Not replaced. Coding's composer/runtime has no chat execution imports; route tests and real-browser ordinary-observer isolation verify behavior independently of this static observation. General-chat and gated-model regression checks remain in the backend record. |

## Native terminal evidence and remaining strict gates

Private Mimir's `docs/ticket-254-native-verification.md` and source/build JSONs
record the final generation-four CLI (`mimir-final-gen4`), source digest
`b7bf0bcbdd5e7765b4946ea53ba40e4eebf5442fc6181fd46d4a41fd79a09fe1`,
and successful source-bracketed workspace/all-target/CLI/all-guest builds.
Native repairs cover cancellation-aware reload retirement, typed Busy admission,
exact unavailable/saved branch intent, next-request replacement/API refresh, and
PowerShell final-command/early-return/error ordering. The final review finding was
reproduced before repair; three final PowerShell regressions pass, including
preservation of a user-owned breakpoint. Independent read-only review confirms
that finding is resolved.

The broad generation-three CLI run is terminal: **2156 passed, 6 failed, 5 ignored**;
full tools **319 passed**; affected actual extracted SDK consumers **2 passed**.
Generation two separately completed all **15** external-frontend cases. Final
source generations differ only in the bounded PowerShell repair; no whole-suite
or packaged-SDK rerun on generation four is implied. Source and artifact
provenance, exact commands/deadlines, log hashes, reproduction failures and
terminal process checks remain in the native report.

Strict integration still requires deliberate resolution of five retained native
workflow VCR/schema mismatches, the unchanged oversized-entry tail assertion,
six additional tool/real-work replay failures, and unchanged strict Clippy
findings. Recordings and assertions were not replaced, weakened or skipped.
Live recordings were not authorized or made. These failures prevent a clean
whole-native/strict-CI acceptance claim even when all rendered fixture workloads
pass. Live workloads/ordinary-chat smoke (#255) and implemented-UI human review
(#256) remain separately pending.

## Parent A1–A10 reconciliation

Serialized final reconciliation exited **0**: **16/16** required authenticated,
rendered workload reports pass on the final source manifests and generation-four
CLI. Every report has the required external scenarios, successful driver exit,
matched native/product/frontend hashes and settled native process/server/provider
fixture; MCP additionally confirms actual configured connections settled.

Retained task-local records are under `../worker/`:

- `254-final-acceptance/`: all original final-source runs, including the failed
  synthetic-history keyboard-focus assertion in `reading/`; the original final
  reconciliation correctly exited 1 (15 passed, one failed).
- `254-reading-final-recovery/reading/`: one focused **unchanged** rerun passed
  the complete reading workload. No source, assertion or fixture was changed for
  this recovery; it does not establish why the initial focus assertion failed.
- `254-final-reconciled/`: the serialized passed `integration-report.json`, fresh
  source/build record, and `evidence-index.json` preserving the initial failure
  and exact selected terminal reports. Workload links point to the original
  retained directories; no failed evidence was overwritten or relabelled.

Thus this is **passing after explicitly recorded recovery**, not a single
initially clean run. Earlier driver corrections, failed routes, source-stale
attempts and diagnostic runs remain separate evidence and are not promoted into
final-source acceptance.

| Parent row | Current automated evidence | Remaining acceptance boundary |
| --- | --- | --- |
| A1 | Real supervised native/product owners, packaged consumers, prompt/tool identities and ordered/cut-bounded history; deterministic, recovery, concurrency, file-change and MCP routes | Strict replay/entry gates below; live-model #255 |
| A2 | Native questions/accepted history, Plan write refusal and decisions, goals and independent review, child outcomes, commands and rich inputs | Real provider/model behavior #255 |
| A3 | Real sequential file effects and typed historical profiles; full native/synthetic reading workload after unchanged focus rerun | Initial synthetic focus failure retained for investigation; live #255 |
| A4 | Qualified native picker/default reasoning, running-versus-next separation, actual replacement and updated API execution boundary | Live-provider/catalog combination #255 |
| A5 | Host downloaded-inventory/identity and guarded lifecycle backend suites; native catalog refresh and exact unavailable/retry/replacement flow | CPU fixtures are not GPU/Studio-local serving; #255 |
| A6 | Native canonical directory/OS errors, trust/saved identity, cross-process lease, actor matrix, intentional same-folder concurrency and retention reopen | Combined real-model/multi-user serving #255 |
| A7 | Real native Stop/child/MCP/process settlement, reconnect/no replay, crash/maintenance fencing and retirement plus host protection faults | Live local-model holds through all native gaps #255 |
| A8 | Shared Settings inventory/skills, scoped reload and uncertain receipt recovery; saved versus applied MCP, real stdio connection/tool/busy/reconnect cleanup | User review #256; live provider gates #255 |
| A9 | Ordinary-chat/auth/folder/SSE/lifecycle and multi-account regressions; real-browser ordinary-observer isolation | Completed real ordinary-chat inference smoke #255 |
| A10 | Desktop 1440×1000 and narrow 390×844 keyboard/layout/focus/reading/diff/error states in all drivers, with representative screenshots inspected | Initial reading focus failure and macOS menu execution unverified; full live/human #255/#256 |

Representative final screenshots inspected include
`254-final-acceptance/deterministic/desktop-tools-public-output.png` and
`254-final-acceptance/picker/picker-narrow-config.png`. Actual public tool details,
bounded overflow and the fully positioned narrow picker were readable; the
initial pre-position resize measurements were not treated as stable UI geometry.

**Historical ticket outcome: needs-human.** At the original handoff, native
replay/entry failures and the synthetic focus failure still required repair.
Original failures and reports above are retained; the operator reconciliation
below supersedes their blocker status, not their historical results.

## Operator repair and current candidate

All 12 requested native failures are now repaired: **71 scoped tests passed**,
including controller/tool/real-work replays and the entire entry module. Current
workspace/all-target compilation, CLI, guest and Studio Wasm builds passed. The
71-test result is source-bound; the parent checked the full current native source
manifest and all five test executable hashes against the repair receipts.
Recorded provider responses are unchanged; request metadata migrations and exact
temporary-root normalization are documented in
`../mimir/target/ticket-254-verification/operator-repair/report.md`.
The **41 remaining strict Clippy findings are baseline-identical**, not new
integration regressions; a full strict lint pass is not claimed.

The reading defect was real: reconnect cleared paging flags during native capture,
unmounting the focused history control. Preserve those flags for same-conversation
start/capture; reset still removes them. A failing-before unit reproducer now
passes. **72 reading/run unit tests**, frontend application/test typecheck and build
passed. The browser driver also accidentally awaited an unrelated reconnect's
`latest` HTTP response during forward navigation; the failing screenshot and
request log show the requested page was rendered. The driver now waits for the
exact keyboard action's cursor, retaining all geometry/focus/pagination assertions.
**30 driver tests passed**, including the cursor-matching regression.

The final authenticated real-native reading workload exited **0**, with **21
scenarios** at **1440×1000 and 390×844**. Both viewports retained the focused paging
control and historical window across pending reconnect capture, navigated back to
the oldest rows and forward through 11 pages to latest, and reopened correctly.
Native process, server port and provider thread all settled. Desktop/narrow
reopen screenshots were inspected; text and controls remain readable without
horizontal overflow. Evidence: `../worker/operator-reading-final/report.json`;
current source/artifact digests and exact limitations:
`coding-integration-254-operator-record.json`.

**Current outcome: candidate.** Reuse the prior broad integration results as
historical evidence and the current affected checks above; this is not a fresh
full-suite rerun. Whole-workspace test execution and packaged-SDK distribution
smoke were not repeated. Two existing native timing harnesses remain ignored;
no tests were newly ignored. macOS native menu execution remains unavailable on
Linux. **#255 live workloads and #256 user UI acceptance remain pending**—fixture
success is not live-model proof or user approval.
