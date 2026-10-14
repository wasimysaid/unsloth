# Coding reading and bounded output (#253)

## Scope and contracts

Studio remains a bounded, ephemeral presentation of the production
`studio.frontend` plugin and native Session Control. No execution engine, durable
transcript, cumulative patch, private saved-result decoder, or Apply/Revert action
was introduced. The paired private Mimir worktree has no source changes.

- Bottom-follow is reader intent, not inferred from a reconnect or checkpoint.
  Reading earlier or expanding a report pauses it. **Jump to latest** explicitly
  returns to the latest projection; **New activity** means observed native activity,
  not an unread-message count. Reconstruction/pagination alone do not set it.
  A per-runtime SSE observation epoch scopes a retained delivery watermark, so
  same-epoch replays (including resets) do not invent activity; genuinely unseen
  positions and new runtime epochs still count. Usage-only state is not activity.
- Stable native invocation and request/question identities anchor provisional/saved
  replacements. Visual anchors and owned focus survive inline report changes and
  bounded history insertion. Same-conversation reconstruction retains mounted,
  visibly busy history; genuine keyboard scrolling can still update its anchor.
  Busy paging controls remain focusable with guarded `aria-disabled` activation.
  Exhausted-control removal cannot checkpoint temporarily clamped geometry before
  assistant-ui mounts prepended rows; owned focus restoration is not reader intent.
  Narrow layouts retain a usable transcript height within a scrollable outer panel.
- Earlier/newer pages use one immutable native cut. Each latest/historical window
  retains at most 1000 rows / 2,097,152 JavaScript text/profile code units. Eviction
  removes complete saved entries, discloses omission and supports opposite-direction
  reads. These are explicit implementation bounds, not measured latency guarantees.
- Expanded supplied diffs mount one section at a time, bounded to 16 KiB UTF-8 and
  400 physical lines. Forward/backward controls preserve all supplied content,
  including oversized individual lines and Unicode. Native partial/truncation,
  binary/unavailable, repeated-invocation and historical labels remain truthful.
  Public tool output and long native messages have keyboard-scrollable viewports.

## Reproduction

From the Studio worktree, after building the paired CLI/product plugin:

```sh
npm --prefix studio/frontend run typecheck
(cd studio/frontend && node --experimental-strip-types --test tests/coding-*.test.ts)
npm --prefix studio/frontend run build
.venv/bin/python -m pytest -q studio/tools/test_coding_browser_acceptance.py
PLAYWRIGHT_BROWSERS_PATH="$PWD/.verification/playwright" \
  .venv/bin/python studio/tools/coding_browser_acceptance.py \
  --workload reading --browser firefox \
  --mimir .verification/mimir \
  --plugin-package .verification/product-package \
  --evidence-dir ../worker-recovered-start/browser-reading-accepted
```

The reading workload uses built Studio, authenticated production coding/auth routes,
an installed product plugin, and native Mimir. Its paced HTTP provider performs
real native tools in disposable projects and controls streaming boundaries. Its
1664-row history phase intercepts browser history pages and is explicitly labelled
**SYNTHETIC**, never persisted or presented as native execution. Delayed/disconnected
browser transports are separately labelled timing/fault injections. Viewports are
1440×1000 and 390×844; geometry checks use a 3-pixel tolerance and record focus,
scrollTop, row positions, identities, cuts and supplied-section tail access.

## Observed checks

Regression results are retained in the task-local `.verification` directory:

- TypeScript application/test typechecks, **285 coding tests** and the production
  Vite build passed (`coding-tests-final.log`, `frontend-build-final.log`). Four
  Jump/reconstruction race reproductions failed before the reading-intent fix and
  passed afterward. Usage-only reconstruction, same-epoch replay (including reset),
  and new-epoch activity regressions also pass; reset replay failed before its fix.
  A geometry-only test covers intermediate clamping while exhausted navigation
  disappears before assistant-ui mounts prepended rows. Rendered Firefox exposed
  that failure before the fix; this unit test is not browser-layout evidence.
- Backend SSE/runtime/history checks: **93 tests passed**
  (`backend-reading-final.log`), including stable/distinct observation epochs,
  unchanged native envelope fields, queue-item immutability and shared history.
- Browser-driver contracts: **26 tests and 26 subtests passed**; Python syntax
  checks and `git diff --check` passed.
- Full frontend suite: **11,746 passed / 1 failed** (`frontend-tests-final.log`). The failure
  is the pre-existing `Go > Settings lists every Settings page, in the dialog's
  order` expectation: Mimir is missing and About is present in the native menu.
  Its test/menu/settings source files are unchanged from the worktree baseline.
- Scoped Biome check retains four baseline errors: the existing request-status
  region's non-semantic element, two existing accepted-submission non-null
  assertions, and the existing unsent-draft test assertion. Their baseline text is
  retained in `biome-baseline-errors.log`; new reading/diff lint errors were fixed.
- System Chromium crashed at launch (SIGTRAP), before browser interactions.
  Downloaded Playwright Firefox with software rendering launches successfully.
  Earlier Firefox attempts exposed a native fixture exceeding the plugin's 4 KiB
  entry bound and an insufficient fixed keyboard-scroll wait. The fixture now
  stays within that native bound; keyboard checks await their asserted end position
  rather than relaxing it. The larger-content checks remain labelled synthetic.

## Rendered verification

The final **browser-only Firefox run exited 0**. Its
`../worker-recovered-start/browser-reading-accepted/report.json` records **passed**
for the workload and all **21 scenarios**, including native desktop/narrow reading,
separate synthetic desktop/narrow history, and removal of the synthetic interception.
The preceding combined build/browser command hit its 600-second total deadline;
this separate completed run replaces that incomplete attempt, not its assertions.

- **312 reading-position checkpoints** record row geometry, scroll position and
  focus. Native phases verify bottom-follow, reading away during paced streaming,
  truthful activity, keyboard Jump/resumed follow, repeated native edit identities,
  one view disconnect per width, delayed reconstruction with genuine keyboard
  movement, and terminal saved-entry reconciliation without replaying work.
- The explicitly **SYNTHETIC 1,664-row** phase made **80 history-page requests**.
  Recorded paging samples retained **138–1000 rendered rows**; each width reached
  the oldest entry and returned through **11 forward pages** to native latest
  content. Both pending-history Jump probes passed. These are observed fixture
  checks, not a native long-history workload or a performance benchmark.
- At each width, keyboard forward/backward navigation read the supplied 450-line
  synthetic diff across **two sections**, reached `SYNTHETIC_LARGE_449_`, and
  verified that no supplied lines were duplicated or omitted. Native clipping and
  historical/partial labels remained separate from presentation sectioning.
- Inspected final screenshots at **1440×1000** and **390×844**:
  `reading-stream-away-desktop.png`, `reading-stream-away-narrow.png`, and
  `reading-SYNTHETIC-narrow-repeat-7-supported-tail.png` in that evidence directory.
  The reading region remains usable, activity/Jump and section controls are visible,
  and narrow content wraps without horizontal page overflow. Output intentionally
  scrolls within its bounded region; the narrow outer panel also scrolls to expose
  the composer and controls below the reading region.

## Acceptance boundary

This slice contributes shared A3/A10 evidence (reported changes, reading geometry,
keyboard navigation, reconnect and desktop/narrow layout). It does **not** refresh
historical claims for the complete A1–A10 cross-feature PoC, external-provider or
local-model live acceptance (#255), or the user's implemented-UI review (#256).
Deterministic native execution, synthetic rendered history and visual inspection
are recorded separately. No live-model or performance guarantee is claimed.
