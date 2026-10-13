# Ticket #247 candidate evidence

## Scope and sources

Feature: independent coding conversations and canonical-project overlap warning (A1/A6/A7/A10). Implemented in the supplied worktrees only; no commits, publication, issue updates or runner-control edits.

- Studio baseline: `5a9e995262be60717f494b0ff7b6e0e2697bc20c`, with this uncommitted candidate.
- Private Mimir baseline: `91b975adae2df627d7c67c6bcede6d910a592a7d`, with this uncommitted candidate.
- Product plugin: `plugins/studio-frontend`, not the packaged-SDK acceptance fixture.
- Native executable SHA-256: `2c38a89ac20542263c9521a5ef2d50955be0a195d4f44785e179a840ec222754`.
- Production plugin Wasm SHA-256: `167540a18954646d4299f9afb31ac67dc346aebf9392ec0aa57e322942c9cb41`.

## Requirements reconciled

1. **Multiple conversations, one supervised process, native limits:** browser report `../worker/browser-concurrency-2/report.json`, scenarios `A1-A6-independent-tool-concurrency` and `A1-one-runtime`, records two real simultaneously running shell processes, three exact admitted requests and four retained conversations under unchanged supervisor PID `1646448`. No execution scheduler or Studio-wide serialization cap was added. Native terminal-capacity regression fills 32 actual shell slots, refuses the 33rd before launch and allows an independent conversation to execute; `../mimir/.scratch/ticket247/native-capacity.log`. Native process suite additionally tests busy admission and an actual loopback HTTP 429 provider response.
2. **Accessible warning before canonical-folder overlap:** browser scenarios `A6-A10-overlap-before-submission`, `A10-overlap-narrow-keyboard`, `A6-overlap-native-route-guard` and `A6-overlap-explicit-continuation` passed. Symlink aliases produce native canonical identity; preflight warns before any prompt POST. Native prompt admission checks again to close the preflight race. Cancel has initial focus; Enter/Escape cancel only the known-unadmitted draft; focus is trapped; Continue is explicit. Desktop 1440×1000 and narrow 390×844 screenshots were inspected with no warning/control clipping or document overflow.
3. **Truthful warning scope:** both rendered warning screenshots explicitly state this is not a filesystem lock, sandbox or comprehensive nested-workspace detector, does not grant authority over another owner and does not guarantee absence of file conflicts. Native capacity and leases still apply. Detection is exact canonical folder identity among retained owners, not comprehensive cross-process discovery.
4. **Ownership/identity preserved:** browser scenarios `A6-change-reopen`, `A6-same-id-view-reopen` and `A6-cross-process-lease` passed. Another project creates a distinct native identity; deliberate reopen and stream reconnect retain the original ID/cwd. Foreign process ownership refuses opening; no force-open, fork or theft. After confirmed native EOF cleanup the exact ID can reopen. Native whole-journal `submitted_request(context,key)` shares existing keyed admission authority, including inactive branches after reopen, without a competing key store or history mutation.
5. **Route/native workloads and settlement:** all 24 browser scenarios passed, including exact Stop leaving the independent shell alive, native completion and reaping, authenticated overlap access and ten known-ID route auth refusals. Browser report cleanup is `native_process_settled: true`, `server_port_closed: true`; its two tool identities are reaped and the independent shell wrote `NATIVE_COMPLETED`. Native process report `../mimir/.scratch/ticket247/concurrency-final/studio-concurrency-b61987ab1648/report.json` independently records cancelled PID `3585376` reaped while PID `3588261` remained alive and completed, and owner/contender/restarted-owner exits all zero. Saved and real shared trust fingerprints are unchanged.

## Verification

- `npm --prefix studio/frontend run typecheck`: passed, including the final scoped repeat.
- `cd studio/frontend && node --experimental-strip-types --test tests/coding-*.test.ts`: 88 passed, zero failed. The capacity-refused draft regression first failed (expected retained text, got null) and passed after correction.
- `npm --prefix studio/frontend run build`: passed; `.mimir/ticket247-build.log` records Vite completion. Existing npm configuration, CSS highlight and chunk-size warnings remain.
- `PYTHONPATH=studio/backend .venv/bin/python -m pytest studio/backend/tests/test_coding.py studio/backend/tests/test_coding_recovery.py -q`: 38 passed.
- `python -m unittest discover -s studio/tools -p test_coding_browser_acceptance.py`: six passed. Python compile checks passed.
- Scoped ordinary-chat/auth backend regressions: 144 passed; frontend auth/account/loaded-model coding-route regressions passed. Browser ordinary-model observer scenario recorded no ordinary inference/media status requests with the preference enabled.
- `.venv/bin/python studio/tools/coding_browser_acceptance.py --mimir ../mimir/.scratch/ticket247/bin/mimir --plugin-package ../mimir/.scratch/ticket247/studio-frontend-package --workload concurrency --browser firefox --evidence-dir ../worker/browser-concurrency-2`: terminal exit zero; 24 passed scenarios; Firefox 155.0. Native/plugin/frontend build hashes match report.
- Native verification manifest `../mimir/.scratch/ticket247/verification.json`: native and production Wasm builds, 20 plugin tests, 11 native lookup tests, 30 request/cancellation tests, real terminal-capacity regression, 11 registry tests, five carrier tests, 19 history/SDK consumer tests (two pre-existing ignored timing harnesses), 21 rebuilt SDK guests, smoke/concurrency/reconnect real-process suites, scoped production/library/Wasm Clippy and formatting passed.
- Packaged SDK: task-isolated invocation of `tools/quality/verify_sdk.py`, terminal exit zero. `../mimir/.scratch/ticket247/packaged-sdk.log` ends with `Packaged SDK external build and isolated CLI workflow verified`; extracted SDK WIT set was checked, external consumers rebuilt, Session Control 10.1.0 validated/installed and a real isolated frontend counter workflow completed.
- Independent review of native admission and Studio refusal/focus corrections found no actionable blockers. It inspected source and recorded evidence, not an independent browser execution.
- Both repository `git diff --check` checks passed.

## Recovery and limitations

- Initial backend setup dependencies and the first browser server-start deadline failure were recovered; the succeeding browser run completed all assertions and cleanup. Those setup failures are not positive evidence.
- A redundant final typecheck/test repeat exceeded 120 seconds on the heavily loaded shared host (observed load average above 595). Recovery with a 600-second total deadline completed in 168 seconds, terminal exit zero: typecheck, 88 frontend tests, 38 backend tests, six acceptance-driver tests, Python compilation and both diff checks all passed. Final frontend counts are in `.mimir/ticket247-frontend-tests-final.log`. A separate report/hash/settlement assertion exited zero and confirmed all 24 browser scenarios and matching build artifacts.
- Deterministic HTTP protocol fixtures plus real native/runtime/tool execution are not completed live external-model or Studio-served local-model acceptance. Unrelated ML/training routers were not mounted in this CPU-only acceptance composition. Full cross-feature/Windows CI and human UI review remain separate acceptance tickets.
- Broad native all-target Clippy fails only on the unchanged pre-existing 111-line UI test at `crates/mimir-cli/src/ui/prompt/editor.rs:823`. Scoped production/native-library/plugin checks pass. Frontend broad Biome checks encounter pre-existing three status-role and one non-null assertion errors; the new dialog uses semantic `output`. No baseline suppression or unrelated fix was made.
