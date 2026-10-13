# Ticket #251 verification

Implementation source baselines: Studio `be0a051ae00f35935c3babb76e8c6e03626464d6`;
private Mimir `f5364ce6a0c1d8cc4d5bc5f6c05e26ef3ce787f5`.
Evidence belongs to the task-owned worktrees and attempt worker directory; no
commits, pushes, shared credentials, shared trust edits or GPU workloads.

## A1 — Contracts and consumer compatibility

- Studio `npm run typecheck` (production and test code) and `npm run build`: passed.
- Coding frontend Node tests: 214 passed, including draft/save distinction,
  native refusal, failed/running/completed outcomes, exact lost-reply inspection,
  persisted per-tab correlation, storage failure and late-observation races.
- Authenticated coding backend suites: 102 passed. A malformed post-delivery
  response regression failed with the previous HTTP 400 mapping, then passed
  with protocol/unknown runtime failures mapped to HTTP 502 (uncertain delivery).
- SDK 0.15.0, Session Control 12.0.0, tools 10.0.0: native/carrier/registry and
  affected consumers/fixtures updated together. Extracted SDK packaging, locked
  Wasm consumers and isolated CLI workflow passed; actual native MCP operation
  replies and read-only inspection are recorded in
  `mimir/target/ticket-251/sdk-verification.log`.
- Production frontend package compiled and passed Wasm Clippy, builder tests
  and native static compatibility checking. Cold native validation took 214
  seconds; setup now permits up to 600 seconds without extending the separate
  60-second execution-command response deadline.

## A7/A8 — Native failure, admission and ownership

Final native scoped groups recorded in `mimir/target/ticket-251/lifetime-fixed-focused.log`
passed (7, 25, 1, 9, 9, 9 and 9 tests), including configured/session/transient
ownership, explicit SDK grant cleanup, safe-idle refusals, retained operation
identity, connection/application errors, and saved/applied/tool evidence.

Independent lifetime review found two hazards: a failed reconnect cleanup
reacquired a still-held connection mutex, and an aggregate shutdown timeout could
drop cleanup futures after removing their native owners. Real HTTP regressions
failed before fixes and passed afterward (`lifetime-reproduction.log` versus
`lifetime-fixed-focused.log`). Failed DELETE now produces terminal failure with
retained ownership/OS execution lease; 32 delayed DELETEs prove that shutdown and
concurrent close retry await every batch before releasing the real lease.
A follow-up review found RMCP's timed close returns `Ok(None)` and detaches
its join authority on timeout. Two controlled real-RMCP/stdio regressions failed
before correction (`rmcp-close-reproduction.log`) and passed after correction
(`rmcp-close-fixed-focused.log`). Each connection now retains one native untimed
close task and completion receiver through timeouts/cancelled waiters; configured
replacement and real OS lease release remain fenced until actual settlement.
The final focused groups passed 27, 7, 1, 9, 9 and 9 tests.

## A8/A10 — Rendered real coding-route checks

Reproducible driver:

```sh
.venv/bin/python studio/tools/coding_mcp_browser_acceptance.py \
  --mimir /path/to/current/paired/mimir \
  --plugin-package /path/to/rebuilt/studio-frontend-package \
  --apply-reconnect --browser firefox --evidence-dir /path/to/task/evidence
```

The driver uses production authentication/coding routers, built Studio UI,
installed product frontend and real native MCP connections/tools. Provider
responses are deterministic external HTTP protocol fixtures, not live-model
acceptance. Its 18 helper tests passed, including real stdio handshake/tool/error/
held-call/EOF/signal lifetime checks and rejection of unreaped zombies as cleanup.
The initial rendered attempt stopped at a 120-second cold native installation
timeout; no request/tool/rendered success is claimed for that setup-only attempt.
Final installed-product run: **passed, 31 scenarios and 31 screenshots** in
`worker/mcp-browser-251-final/report.json`. Viewports are 1440×1000 and 390×844.
Desktop completed/apply and narrow background-save-error screenshots were
visually inspected: distinct actions/state, readable wrapped identifiers and
alerts, no horizontal overflow. Native busy refusals, actual remote tool results,
connection/application errors, retained drafts/revisions, reload and second-tab
correlation isolation, unavailable inspection and unknown-operation non-replay
all passed. Seven actual stdio fixture PIDs, provider fixture, native process and
server port settled before driver success.

- Native conversation: `2026-10-13T11-25-51-421Z_e65f9ac2-dee2-45af-ad2c-6395a581b74c`.
- Supervised native PID: `2330671` (settled).
- Native SHA-256: `5b2e7c79141d4bbc4df5e747771bff133ed0e2f9f72c1df662fe7fb1fd9fd57e`.
- Product component SHA-256: `e539fded7754ffb5bde9b6da30b370e9fdef8cd1fabd02a05317788fdf15c947`.
- Command used the example above with `--mimir ../mimir/target/ticket-251/mimir-reviewed`,
  `--plugin-package ../mimir/target/ticket-251/studio-frontend-package`,
  `--evidence-dir ../worker/mcp-browser-251-final`, and
  `--compilation-cache ../worker/mcp-browser-251-retry/state-a618ca2f/mimir-home/cache/wasmtime`.
  Only task-owned compiled Wasmtime artifacts were reused; configuration,
  authentication, projects, trust and history were isolated afresh.

Intermediate attempts exposed driver-only locator/ordering issues: scope Settings
navigation to Coding views, observe native live invocation identity before its
historical presentation, and await actual aborted POST delivery rather than the
immediate pending label. Assertions still require actual native outcomes/tool
identity and exactly one upstream execution. Final UI recovery and native cleanup
re-reviews found no remaining actionable findings in their scoped checks.

## Verification boundaries

Strict native Clippy is blocked by unchanged warnings in
`extension_inspection.rs`, `plugin_watch.rs` and dependency
`mimir-tools/src/output.rs`; changed native/production Wasm code was checked
without suppressing or deleting tests. Full external-provider/Studio-local-model
workloads and the user's implemented-UI review remain parent PoC tickets
#255–256; deterministic native-tool evidence does not claim those gates.
