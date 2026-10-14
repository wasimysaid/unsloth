# Ticket #249 combined recovery and local-serving validation

The original ticket's local-protection blocker is cleared after integrating #246 and #253. No replacement ticket coding session was launched.

## Integrated checks

- 341 scoped frontend tests passed; application and test TypeScript checks and the production frontend build passed.
- Backend reconciliation: 213 scoped coding/lifecycle/authenticated-history tests and 27 account/credential tests passed. Parent rerun: 70 recovery/transport/browser-driver tests plus 26 subtests passed.
- Native reconciliation: 49 focused native tests, 78 frontend-plugin tests, native compilation, CLI build, WASI checks and component validation passed.

## Actual GPU/browser workload

Local evidence: `.scratch/ticket246-live/live-664666e6/{launcher-report.json,browser/report.json}`. These artifacts contain isolated runtime state and are intentionally not committed.

The real Studio-served Qwen model ran native `write_file`, `shell`, and `read_file`. During the running shell, destructive model unload and whole-runtime restart both returned HTTP 409; the native PID, runtime generation and coding hold were preserved. Native completion released protection. Ordinary authenticated chat succeeded, and selecting a second real downloaded model exercised busy admission and explicit selection retry without replay.

After gated model unload, an identity-checked idle native process fault and deliberate saved-conversation reopening restored the catalog and tool history without changing prior file effects. Final native shutdown exited 0; protection holds were 0 and the model was unloaded. The browser driver and launcher exited 0, cleanup was confirmed, and all recorded server/native/model PIDs were absent. GPU peak was 7,794 MiB on coordinated GPU 6, below its 24 GiB budget.

Native executable SHA-256: `2762e3ed0af38ba8362cafe0e85816ae3c2af7950422ec92befe7f1d1dd742bb`.
Plugin SHA-256: `4812c0e1df15a12f963be5ceb46c2bb82f0646d03bb94f422f5e67d1442af909`.

## Recovery attempts and limitations

An initial NVML query timed out. A subsequent run exposed missing `jinja2`/`gguf` validation-environment dependencies; they were installed and real tool-template support was verified before the successful run. Both failed runs cleaned up and were not counted as passes. Failure cleanup now sends the original opening's runtime-generation header.

Five strict native VCR replays remain failing. All five failures were reproduced on exact incoming #246, with relevant sources/cassettes unchanged; local native evidence is `target/ticket249-vcr-verification/report.md`. These replay failures were not weakened or treated as passes. This does not replace the remaining cross-feature acceptance tickets #254–#256, other platforms, or human acceptance.
