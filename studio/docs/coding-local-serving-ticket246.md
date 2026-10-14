# Ticket #246: Studio local serving evidence

Implementation baselines: Studio `0b75d58a3c8de1456cdf4dcc5c5bee832547e1a0`,
paired private Mimir `adaf7a47982096606b6bf3b2da880e0db2ccb8a7`.
The changes are uncommitted in the supplied ticket worktrees.

## Acceptance mapping (parent matrix, not a replacement)

| Parent check | Slice responsibility | Evidence category |
| --- | --- | --- |
| A5 | Current downloaded Studio inventory in native provider/model identity; authenticated built-in serving; exact execution-boundary admission and whole-request protection | Native/backend deterministic contracts and required real-model coding-route run |
| A7 | Independent protection owners, cancellation/cleanup failure, dequeue/selection races, no idle-conversation hold | Controlled lifecycle/transport failures, native request settlement and live cleanup |
| A9 | Ordinary inference, model ownership, kept slots, leases, update/maintenance paths unchanged without holds | Existing backend/native regression suites; ordinary-chat smoke remains explicitly separate from fixtures |
| A10 | Loading/busy/error/cleanup-pending text and explicit non-replaying retry; desktop/narrow coding route | Frontend build/typecheck, projection tests and real rendered evidence |

## Implementation boundaries

- Studio projects its existing current downloaded inventory into the native catalog;
  it does not save another inventory, run another harness, or install a provider plugin.
- Native selection/dequeue owns the exact configuration committed to execution.
  A private incarnation credential authenticates native catalog/admission/release
  and Studio's existing OpenAI-compatible inference endpoint.
- Studio's existing load/lifecycle owner holds independent exact tokens on concrete
  resident backends. Protection survives inference gaps, tools and questions; it is
  not an HTTP generation lease or a 30-minute conversation-retention reservation.
- Native terminal cleanup, not cancellation acknowledgment or browser lifetime,
  authorizes release. Uncertain admission remains inspectable, early release is a
  tombstone against late arrival, and failed drain retains protections.
- Destructive backend load/unload/cleanup, kept-slot eviction, GPU ownership transfer,
  idle unload and runtime maintenance refuse protected work, including force paths.
- Retry validates the same selection without loading an idle model or replaying a
  prompt. Endpoint/authentication/choice failures never select a fallback.

## Observed deterministic checks

These are fixtures/fault injection, **not live-model acceptance**.

- Parent combined backend run: `CUDA_VISIBLE_DEVICES='' .venv/bin/python -m pytest
  studio/backend/tests/test_coding*.py
  studio/backend/tests/test_account_native_model_lease.py
  studio/backend/tests/test_chat_generation_lease_compat.py
  studio/backend/tests/test_chat_generation_run_lease.py -q`:
  Initial **318 passed**, 36.92 seconds; final post-review run **333 passed**,
  38.29 seconds (`.scratch/ticket246-checks/backend-final.log`).
- Focused protection/GPU arbiter/kept-model/keepwarm regressions: **150 passed**.
- Existing auto-switch/generation/Transformers/llama update/load-intent/named-model
  regressions: **1083 passed, 1 skipped** (no provisioned Transformers overlay).
- Protection/maintenance/update/Transformers repair regressions: **607 passed**,
  125.46 seconds. Maintenance reproducers failed before their fixes.
- Independent review identified cold-SSE startup, shutdown-versus-credential-mint,
  and already-reaped EOF credential retirement races. New controlled tests:
  **4 failed before**, then **96 passed** including existing coding transport tests.
- Repeated direct cancellation during credential mint was separately reproduced:
  **1 failed, 2 passed before**, then **17 passed** with independent retained mint
  retirement and downloaded-catalog/launch-preference checks.
- Frontend production and test typechecking and production build passed. The full
  coding/loaded-model Node test run initially had **266 passed**; final run
  **270 passed**, 0 failed/skipped, with production/test typechecking and production
  build passing. Logs are task-owned under `.scratch/ticket246-checks/`.
- Real browser validation exposed a saved invocation-start checkpoint pruning live
  running rows. Controlled projection tests reproduced **2 failed / 45 passed**;
  after the fix **47 passed**. Checkpoints now suppress provisional rows only for
  genuine terminal tool results, and initial/reconnect capture reconciles saved
  starts against exact native `live_invocations` without mutating saved history.
  Completed/failed results stay terminal/historical; removing a live identity does
  not leave an invented running state. Final full Node suite has **270 passed**.
- Python/native origin mismatch reproduced: **6 failed, 6 passed before**; aligned
  numeric-loopback HTTP validation then yielded **105 passed** with transport/runtime
  regressions. Framing fixtures now await EOF shutdown with faithful process doubles,
  rather than leaving unobserved teardown-task errors.
- Private bootstrap exposure/descriptor ownership tests: **6 failed before**, then
  **111 passed** with transport/runtime regressions. Installer and native environments
  strip old bootstrap variables; the credential crosses a bounded one-use inherited
  read-only pipe, closed on spawn success/error/cancellation. It is not an ambient
  provider, shell or Wasm environment credential.
- Failed mint-retirement/retry ownership reproduced: **1 failed before**; the final
  combined **333 passed** includes storage recovery before replacement minting.
  A failed credential revocation retains its receipt and cannot be overwritten by
  a new setup attempt.
- Packaged SDK verification rebuilt extracted SDK/template and external-frontend
  fixtures, validated/installed both packages, exercised native commands/state and
  shared-owner lifecycle, then observed clean EOF/remove. Actual command:
  `MIMIR_SDK_VERIFY_DIR=../mimir/target/ticket246-sdk-verification .venv/bin/python
  ../mimir/tools/quality/verify_sdk.py` (with an absolute verification path): **exit 0**,
  354 seconds; log `.scratch/ticket246-checks/packaged-sdk.log`. Repeated against the
  reviewed `fa9f0f69…` native build with fresh extracted fixtures/profile in
  `../mimir/target/ticket246-sdk-final`: **exit 0**, 481 seconds; both retained native
  executable hashes matched. Log `.scratch/ticket246-checks/packaged-sdk-final.log`.
- `git diff --check` passed. Scoped Biome formatting was applied; repository
  snake-case wire-contract/style diagnostics prevent treating broad Biome checking
  as a clean lint result. No wire identities were renamed to silence those checks.

## Live setup, not workload completion

The task-owned Studio installer and model downloader verified the CUDA13/sm100
llama-server build and Qwen3-4B-Instruct-2507 Q4_K_M checksum. See
`studio/tools/coding_local_acceptance.md` for reproducible setup and the real-router
composition. Setup HTTP probes verified production login/authenticated inference
listing and zero idle protections; they did not load a GPU model or execute coding.

GPU authority: operator-coordinated shared GPU 6,
`GPU-2bdfcc31-cf97-42d6-c898-40700d02fd40`, peak **24 GiB**, grant expiry
`1791980523`; GPU 7 excluded. Current capacity must be checked immediately before
any live run. Acceptance launch preferences bound model context to 32768, one slot,
and disabled speculative decoding through Studio's existing isolated saved settings.

## Verified native artifacts and contracts

The paired Mimir implementation uses host-owned authenticated HTTP for inventory,
admission, inspection and release, and its built-in OpenAI provider for inference.
No companion provider plugin is installed. Exact operation identity reconciles
uncertain admission; failed cleanup retains protection and prevents successors.
Native children inherit the protected transport rather than resolving a new default.

The SDK carrier versions are **Session Control 13 / Tool Invocation 11**. The
`studio.frontend` Wasm package was rebuilt against those versions; old exact versions
are not compatibility aliases. The native development executable is
`../mimir/target/studio-local/mimir`, with package
`../mimir/target/studio-frontend-package`.

Final native worker checks: Studio lifecycle **14**, controller execution **13**,
compression **14**, provider **188**, host-process carrier **7**, frontend **77**.
Earlier model inventory **10**, child lifecycle **105**, session-control **2**, and
scoped native provider VCR **9** also passed. Four credential-isolation regressions
and three summary-operation regressions failed before their fixes and pass after.
`/compress`, compression API and summary navigation now acquire whole-operation
protection at the same execution boundary. Two stale SDK guest fixtures were rebuilt;
the frontend-adapter suite then had **69 passed**, one reproduced baseline failure
and two pre-existing ignored tests (not claimed fully green).

Final executable SHA256
`fa9f0f6997c93d4d766278561bde93c434690a29911714b71c9af366f2d53840`;
product Wasm SHA256
`1866538d21861d5cb5b4a4ee341400e91e23f2c63bb7ad1d9a292d6313f11c5f`.
Native consumes the private bootstrap before Tokio; reserved names are denied generic
provider authentication and removed from shell, guest subprocess and Wasm environments.
The inherited-pipe bootstrap is **Unix-only**; no Windows secret-channel implementation
is included. Origin contract is numeric IPv4/IPv6 loopback HTTP.

Native build, rebuilt Wasm package, formatting and diff checks passed. An isolated-profile
actual executable + installed Wasm frontend smoke observed catalog/create, exact local
acquire, authenticated built-in inference and release/close against an HTTP contract
fixture, plus key absence from process environment and bootstrap descriptor closure.
This is integration evidence, **not a live-model workload**. Detailed commands and
reports: `../mimir/target/verification/native-handoff.md`.

Broader native navigation/strict VCR, entry-tail and PowerShell failures were reproduced
on unchanged HEAD; scoped Clippy remains blocked by unchanged baseline warnings, not
claimed clean. The full workspace suite and release-profile executable were not built.

A final narrow re-review found successful compression terminal events despite failed
cleanup receipts. That regression failed before the fix and passes after: **15 compression**
and **14 controller execution** tests pass. The terminal now derives from authoritative
cleanup/persistence settlement and preserves prior errors. Fresh executable
`../mimir/target/studio-local/mimir-compression-settled`, SHA256
`a3501fdf9829857c8e8fc447ed67bcf23c45847a370770c76d9dedb0e64f8c43`.
The running `fa9f…` artifact was not replaced or unlinked. Normal-prompt, execution,
admission, inference, bootstrap and Wasm sources/bytes were checksum-verified unchanged;
existing normal-prompt live and SDK evidence remains applicable to those paths, not
claimed as a new compression-specific live workload. Exact scope and reproducers:
`../mimir/target/verification/compression-settlement/handoff.md`.

## First real cold-load run (pre-review artifacts; partial acceptance)

`.scratch/ticket246-live/live-b6d6bbe1/` used the actual Studio auth/coding/inference
routers, installed product Wasm frontend, native executable and downloaded Qwen3
model, with no provider/transport fixtures or synthetic outcomes. Native request
`prompt-2026-10-13T14-00-34-870Z_f3e41f14-5c50-4b44-99ef-0a7736e8556c` in
conversation `2026-10-13T14-00-33-913Z_24f6cf07-91f8-4349-8c2e-15411c1532da`
completed actual `write_file`, eight-second `shell` (exit 0) and `read_file` tools.
Provider `studio-local`, model
`local-880c18525644a33cf0dc41f6e20e2334eaa315f262a87653ec282cab6c882a8e`.

Parent verified actual file SHA256
`04c0d821d3151a420f16d3d773d0ac516f6863bb046ec3a7c56bb2e1bc1c657e`, native
completed status, zero holds after terminal cleanup, completed Studio lifespan,
native exit 0, model unloaded and server/llama PIDs absent. GPU6 model-process
samples reached 7,794 MiB, with context 32768 and one slot (grant 24 GiB).

**The driver exited 1**, having missed the rendered running-shell interval; this
run does not pass destructive-unload refusal, busy/retry, ordinary-chat smoke or
process recovery. It also predates the credential/summary-operation review fixes.
The prepared recovery driver must run again against the reviewed artifacts.

Parent visually inspected actual loading screenshots at **1440×1000** and
**390×844**: readable loading/preparation and exact request/next-model status,
responsive composer and no measured horizontal overflow. Narrow running-model
placeholder wrapped mid-word, so that paragraph now uses word-aware wrapping;
the final production frontend is rebuilt for the recovery run.

## Reviewed workload and independent recovery (partial)

`live-f879090d` used native `fa9f…`: exact request
`prompt-2026-10-13T15-13-00-758Z_c2c566f5-f763-4b6f-a31b-fbc2be92e063`
completed actual write/shell/read tools. During native shell invocation
`22e76f23-67d2-4931-9a58-08761c228ebd`, hold count was **1** and destructive
production unload returned **409**. Terminal holds were **0**. Ordinary authenticated
`/v1/chat/completions` returned **200**, `READY`; the written file hash matched the
first run. Owned llama GPU6 samples reached **7,794 MiB**.

That run's driver correctly failed because the DOM labeled the running tool as saved
historical output, and then stopped before busy retry. Its shutdown wait timed out;
**clean lifespan was false**, although exact server/native/llama PIDs were subsequently
verified absent. Those facts are not a clean overall acceptance pass. The frontend
projection defect is now reproduced/fixed/tested as recorded above.

`recovery-216976c5` separately passed real rendered reopening and verified idle
native-process fault/reopen/catalog refresh on new `a350…`: authentic completed
native session records, unchanged source file hash and tool IDs, actual native
exit **-9**, new PID, refresh **200**, zero holds/no model, then clean native exit **0**
and completed Studio lifespan. Parent inspected the narrow recovered screenshot;
error/identity text wraps and no horizontal overflow was measured. This no-GPU run
is independent recovery evidence, not a GPU workload or combined single-run pass.

Additional attempts encountered genuine shared-host NVML timeouts and an owned llama
process in uninterruptible disk sleep before model load. No tool effects occurred in
that failed request; its native journal ended errored and exact owned PIDs disappeared.
Failed cleanup remains explicit in `studio/tools/coding_local_acceptance.md` and the
individual reports. Parent's subsequent bounded capacity query succeeded (GPU6
83,456 MiB free), so one final bounded revalidation was attempted after the UI fix.

## Final outcome: needs-human, infrastructure-blocked acceptance

Final command (600-second shell ceiling):

```sh
.venv/bin/python studio/tools/coding_local_launch.py \
  --native ../mimir/target/studio-local/mimir-compression-settled \
  --gpu-capacity-confirmed --browser firefox --deadline-seconds 480
```

**Exit 1, 589.9 seconds**, evidence `.scratch/ticket246-live/live-8c9e7ca4/`.
Current native SHA256 `a350…`, unchanged product Wasm `1866538d…`, rebuilt frontend
index SHA256 `76d67a806492d7f503b22cfcf7781f4cfc346e771dc42995bfefab08f19b266e`.
Immediate capacity preflight found **63,380 MiB free**, above the 24 GiB grant.
Model SHA256 was reverified. Subsequent production GPU/NVML and 60-second memory
queries timed out; owned llama PID3018108 entered uninterruptible disk sleep during
initialization. Final-run peak memory could not be certified.

Exact native request
`prompt-2026-10-13T15-56-44-657Z_7241188b-d452-4926-bd39-641aab4ad8e9`
was independently observed via authenticated native SSE as **failed**, active request
null, holds **0**, journal **errored**. No tools or project files were created.
Native exited **1**, Studio **-15**; **clean lifespan false**, with model shutdown
timeout. Parent verified all exact launcher/helper/server/native/llama PIDs absent;
this eventual absence is not a clean lifecycle pass. Reports:
`native-terminal-observation.json`, `launcher-report.json`, `final-evidence.json`.

Parent visually inspected actual cleanup-error screenshots at **1440×1000** and
**390×844**: readable truthful pending/error text, disabled composer, wrapped IDs and
no measured horizontal document overflow. Final rendered-running, protected tool
gap, explicit busy retry/no replay, ordinary chat and combined recovery were not
reached. Earlier successful individual checks remain separate evidence, not a full
final-artifact acceptance pass.

No further GPU retry was attempted. Required next action: coordinate shared-host
NVML/CUDA initialization and storage/D-state diagnosis without disturbing other
workloads, then rerun the same authenticated final driver under renewed/revalidated
GPU capacity and grant. The running-tool projection fix is deterministically verified
but still needs real rendered revalidation; explicit busy retry and clean combined
shutdown/recovery also remain. Changes are preserved uncommitted in both supplied
worktrees; `worker/ticket-result.json` records **needs-human**, not candidate.

Full parent PoC acceptance additionally combines catalog refresh, process recovery
and the user's implemented-UI review; those are not implied by deterministic tests
or the partial runs above.

## Operator recovery: final combined live check passed

After the shared-host failure, the operator verified that GPU/NVML queries worked,
GPU 6 had 119,222 MiB free, and the entire model read in 3.28 seconds with its
expected SHA256. No host services or other users' workloads were changed.

The same final driver and reviewed `a3501fdf…` native executable were rerun without
starting another coding session. The launcher and browser both exited **0**.
Evidence: `.scratch/ticket246-live/live-246cf79f/launcher-report.json` and
`browser/report.json`; command receipt: `../operator-live-recheck/`.

Actual request `prompt-2026-10-14T03-36-14-988Z_efc38601-b272-442b-857f-875d873e0bb9`
completed write_file/shell/read_file. During the rendered running shell, protection
was **1** and destructive unload returned **409**. The exact file SHA256 matched;
terminal protection was **0**. Ordinary authenticated inference returned **200**
with `READY`. Busy selection failed explicitly; retry returned **200**, did not
replay a prompt, and preserved the resident model PID. Model unload returned **200**.
The actual idle native process was then faulted and reopened, with a new PID,
catalog refresh **200**, the same conversation and unchanged file effects.

GPU samples peaked at **7,794 MiB**, within the coordinated 24 GiB budget. Final
Studio lifespan confirmed clean native exit **0**, zero holds and no active/loaded
model; launcher confirmed clean server shutdown, and exact model/server PIDs were
absent. The operator inspected desktop protected-shell and narrow recovered UI.
The earlier failed runs remain preserved, not relabeled as passes. This closes
#246's infrastructure-blocked live check; cross-feature and human acceptance remain
separate.

Publication refreshed the Studio worktree to include #253. Two import/documentation
conflicts were resolved while preserving reading controls and local-model evidence.
Combined production/test typechecking and **290 coding tests** passed. The first
combined build hit the command ceiling on the busy host; a separate production
build completed successfully. The live report above was captured before that
reading-slice merge; full integrated cross-feature live acceptance remains #255.
