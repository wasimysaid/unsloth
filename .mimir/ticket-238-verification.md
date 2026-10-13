# Ticket #238 candidate verification

## Delivered scope

Changes are in the requested Studio and private Mimir worktrees; no commits, pushes, merges or issue closures were performed.

- Native saved ToolResult exposes a typed output profile backed by persisted tool output through the same native converter as live observations. Generic details remain available. Shared presentation types, WIT imports/versions, affected native/TUI consumers, packaged guest/external SDK fixtures and documentation are updated together.
- Studio uses one FileChangeReport renderer beneath each originating result. File rows start collapsed, preserve supplied paths/nullable counts, and display bounded unified hunks. Repeated invocations remain separate and chronological, even with a shared native grouping key.
- Historical/not-current, binary metadata-only, partial, truncated and unavailable states have explicit text. Generic tools retain actual public output. No workspace reads, cumulative patch inference, approval, Apply/Revert controls or second diff/transcript database were added.
- Structured profiles count toward the existing ephemeral transcript budget. Keyboard expansion/focus, bounded diff scrolling, desktop/narrow overflow and preservation of the reader's scroll position were exercised.
- Review-discovered composed-budget and EOF-newline defects were demonstrated red/green and corrected. Independent read-only follow-up review found no remaining actionable findings in that scope.

## Final artifacts and fingerprints

Source baselines (uncommitted candidate changes are not identified by these SHAs alone):
- Studio: `5a9e995262be60717f494b0ff7b6e0e2697bc20c`
- Mimir: `91b975adae2df627d7c67c6bcede6d910a592a7d`

SHA-256 fingerprints independently checked after final runs:
- `../mimir/target/ticket-238/mimir`: `4d95c759a7635e00b890aacecebfa2b3c2a68d12b396aab92ca69b41fe42857d`
- `../mimir/target/ticket-238/studio-frontend-package-final/plugin.wasm`: `3302c1e1492bb6083f3c14f3478b45d92169eeadede0552bddf4be05aa4638b8`
- `studio/frontend/dist/index.html`: `c530b2f8051361c4e76061ee7bc22bef7fc95e2da6cbab36909a0bbdbcd2831f`

## Passing checks

- Frontend typecheck, production build and 91/91 coding tests passed. Final scoped Biome error-level check passed; existing warning-level diagnostics remain. Two existing lint errors in the already-modified run test were corrected without weakening assertions. A redundant 120-second typecheck timed out during extreme shared-host load; recovery with a 600-second command budget passed.
- Backend coding/recovery tests: 31 passed (`.mimir/backend-tests.log`).
- Browser-driver Python tests: 17 passed, Python compilation and both repository diff checks passed.
- Native scoped tests: 112 passed; isolated rebuilt guest registry: 11 passed; plugin tests: 24 passed. Production/test compilation, plugin Clippy/formatting, Wasm build/validation, native package compatibility and packaged/extracted SDK build/install plus actual installed `profile_contract` request passed. Full commands/results are in `../mimir/target/ticket-238/native-verification.md`.

Final deterministic real-native browser command:

```sh
.venv/bin/python studio/tools/coding_browser_acceptance.py \
  --mimir ../mimir/target/ticket-238/mimir \
  --plugin-package ../mimir/target/ticket-238/studio-frontend-package-final \
  --workload file-changes --browser firefox \
  --evidence-dir ../worker/browser-file-changes-final
```

Terminal exit 0; `../worker/browser-file-changes-final/report.json` reports passed and confirmed native-process settlement/closed server port. Browser: Firefox 155.0, software rendering. Viewports: 1440×1000 and 390×844.

Native conversation `2026-10-13T06-32-02-327Z_10d62cb8-ab47-4335-a1ff-257f918090eb`; request `prompt-2026-10-13T06-32-17-800Z_e693b090-8f60-43be-862e-25b43632ef43`.

Real write_file + two sequential edit_file operations matched their independent filesystem effects, supplied live profiles and separate rendered diffs. Reopening the same native conversation after an external file mutation retained exact chronological call/invocation/path/diff identities and historical/not-current labels. Real no-profile shell output remained inspectable. Keyboard expansion/focus, initially collapsed rows, scroll-position preservation, bounded diffs and no document overflow passed. Nine unauthenticated coding surfaces returned 401; trust fingerprints stayed unchanged.

Inspected final screenshots:
- `../worker/browser-file-changes-final/file-changes-historical-desktop.png`
- `../worker/browser-file-changes-final/file-changes-historical-narrow.png`
- `../worker/browser-file-changes-final/file-changes-SYNTHETIC-profiles-narrow.png`

Binary, unavailable-count/diff, partial and large/truncated browser edge profiles are explicitly SYNTHETIC bounded-history renderer fixtures, not native execution or live-model evidence. They were removed and proven not persisted before real history was reopened. Native/profile tests separately cover producer/projection behavior.

## Configured-provider attempts: preserve negative results

The earlier `../worker/browser-file-changes-live/report.json` passed a completed host-provider workload and live/reopened comparisons on the earlier plugin (`c106e32a...`) and frontend. That is not final-artifact acceptance.

Final-package attempts used the unchanged `file-changes-live` workload and assertions:
1. `../worker/browser-file-changes-live-final/report.json`: failed on a 30-second initial browser navigation timeout before creating a native conversation; server port cleanup confirmed.
2. `../worker/browser-file-changes-live-final-retry/report.json`: native request Completed, but the model made an extra corrective edit and failed the strict write_file/edit_file/edit_file assertion. Native settlement and closed port confirmed.
3. `../worker/browser-file-changes-live-final-attempt3/report.json`: native request Completed but again supplied write_file plus THREE edit_file operations, not the required two. The strict assertion remains intact; terminal helper exit 1. Public effect identities are preserved in the report. Provider/model: chatgpt/gpt-6.1-sol, reasoning medium, inherited from existing host configuration. Conversation `2026-10-13T06-38-26-831Z_76035876-d823-4248-9a9f-dbdc6992eb3c`; request `prompt-2026-10-13T06-39-21-930Z_16ea64a0-7693-4a59-af84-cd61a707860a`. Native settlement and closed server port confirmed.

No failed assertion was removed/weakened, no failure was relabelled passed, and no further retries were attempted. Final configured-provider reopened-diff acceptance remains unverified; the final deterministic real-native route workload passed those comparisons.

## Other limitations

- 20 additional offline VCR replays failed strict matching with the relocated task TMPDIR. The inspected recursive diff differs only in working-directory normalization: expected `<sandbox-root:1>`, actual retained the task prefix before that marker. Existing normalizer/recording code was unchanged; recordings/assertions were not modified. See native-verification.md and `../mimir/target/ticket-238/vcr-prompt-diff.txt`. A separately scoped normalization fix or canonical test environment is needed for green replays.
- Full native workspace suites and two pre-existing ignored timing harnesses were not run. No new ignores/skips were added.
- The native complete-row preview has a nominal 4096-byte budget with an explicitly documented indivisible identity/metadata floor. Oversized exact identities can exceed that nominal budget; native read/transport frame limits remain. Live/history previews share the same selection and never replace a saved effect with a history-only notice.
- CPU-only browser composition uses production coding/auth routers, built UI, installed product plugin and native Mimir, not unrelated ML/training routers. Full parent PoC acceptance, Studio-served local-model workload, ordinary-chat smoke and human UI review are not claimed by this ticket candidate.
