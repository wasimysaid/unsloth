# Ticket246 real Studio-local acceptance

## Run and evidence

```sh
.venv/bin/python studio/tools/coding_local_setup.py
.venv/bin/python studio/tools/coding_local_setup.py --alternate
.venv/bin/python studio/tools/coding_local_probe.py
.venv/bin/python studio/tools/coding_local_launch.py \
  --gpu-capacity-confirmed --browser firefox --deadline-seconds 480
```

The launcher now defaults to the reviewed compression-settled artifact `../mimir/target/studio-local/mimir-compression-settled` (reported SHA256 `a3501fdf9829857c8e8fc447ed67bcf23c45847a370770c76d9dedb0e64f8c43`); `--native` permits an explicit reviewed path under sibling `mimir/target`. Historical runs below explicitly used the original unchanged `fa9f…` artifact; do not relabel them. Parent verified normal prompt/admission/transport/bootstrap source checksums unchanged by the compression-only fix, so existing normal-prompt evidence is reusable, not proof of exercising the new compression payload.

Use a 600-second shell ceiling and track its actual terminal result. The launcher independently rechecks capacity and grant expiry, creates fresh task-owned state, installs the real native product package, and records hashes of native/plugin/frontend artifacts. `nvidia-smi` queries have a 60-second ceiling (a real 30-second query timed out on this shared host). Model download ceiling300s for the small alternate; initial main download/runtime installer ceiling600s.

The explicit shared grant is GPU6 UUID `GPU-2bdfcc31-cf97-42d6-c898-40700d02fd40`, peak **24576MiB**, expires **1791980523**. GPU7 and other workloads are excluded. Visibility alone is not a reservation. Do not run this after expiry without renewed coordination.

Every actual run has `.scratch/ticket246-live/live-*/launcher-report.json`, `browser/report.json`, screenshots and sanitized logs. A failed overall driver can contain valid individual native checks: do not turn those into a full acceptance pass.

### Established evidence

- `live-b6d6bbe1`: earlier native write/shell/read completed and released protection; driver missed the rendered gap. Partial only, predates reviewed artifacts.
- `live-1c7b695e`: reviewed native SHA256 `fa9f0f6997c93d4d766278561bde93c434690a29911714b71c9af366f2d53840`; actual cold load and real tools. Native stream reported running shell, DOM reported `saved / Historical report`. Driver failed. Launcher observed exact native cancellation and confirmed clean lifespan. Supplemental native results/file evidence preserved; all three owned PIDs verified absent.
- `live-f879090d`: same reviewed native hash; cold native request `prompt-2026-10-13T15-13-00-758Z_c2c566f5-f763-4b6f-a31b-fbc2be92e063` **completed**, real write/shell/read, hold1 during shell, destructive production unload409, terminal hold0, ordinary authenticated `/v1/chat/completions`200 with `READY`. File `project/ticket246-8444b725.txt` SHA256 `04c0d821d3151a420f16d3d773d0ac516f6863bb046ec3a7c56bb2e1bc1c657e`. Owned llama PID718402 sampled peak7794MiB. Running row UI failure retained. Busy request reached actual native `failed` without eviction, but the driver expected the wrong generic status label and stopped before explicit retry/recovery. Shutdown's llama wait timed out after SIGKILL, so lifespan correctly remains `cleanup_confirmed:false`; server684079/native696624/llama718402 were subsequently verified absent. This is not a clean overall acceptance pass.
- `live-212ab433`: capacity inspection timed out before any server/model/prompt launch. No GPU workload submitted.
- `live-fe720175`: initial capacity check passed, then repeated NVML/NVIDIA probes and the60-second owned-PID memory query timed out. Owned llama1199879 was observed in uninterruptible disk sleep before model load completed. Native journal request `prompt-2026-10-13T15-23-48-438Z_202741b0-8d80-4535-ad2c-49ea4f558f88` ended `errored` at15:26:18.557Z; no tool/file effects. Launcher stopped its helper, native exit1 and clean lifespan false. Server1118598/native1123725/llama1199879 all subsequently verified absent. `infrastructure-evidence.json` preserves these facts. No further GPU reruns were attempted.
- `recovery-216976c5`: **independent actual no-GPU recovery passed**, shell exit0 in225.7s, new native hash `a3501fdf9829857c8e8fc447ed67bcf23c45847a370770c76d9dedb0e64f8c43`. Authentic completed native session records copied from `live-f879090d` into a fresh isolated native home, with original project/file effects retained and hash-checked; no fabricated events/provider replies. Real rendered conversation reopen, verified idle native PID1667231 killed/awaited exit-9, actual reopened native PID1668322, catalog refresh200, original main model identity rediscovered, actual completed shell call/output retained, file SHA unchanged, zero holds/model processes throughout, clean lifespan native exit0/server-15, all three exact PIDs verified absent. Future selected identity from the prior failed busy scenario is unavailable in the fresh inventory; UI honestly reports unavailable while history remains readable. This is process-recovery evidence on the new artifact, not a GPU workload on that artifact and not a combined single-run busy/retry pass.

```sh
.venv/bin/python studio/tools/coding_local_recovery.py \\
  --source-run .scratch/ticket246-live/live-f879090d
```

This independent recovery command never loads a model, sets `CUDA_VISIBLE_DEVICES=''`, verifies the reviewed new binary hash, and requires an authentic completed source report. Recovery screenshots at `recovery-216976c5/browser/recovered-{desktop,narrow}.png` were visually inspected: readable state/error wrapping, no horizontal document overflow, preserved desktop tool history; narrow transcript space remains limited above the composer.

The historical continuation driver collected a missing running row as a **required failed assertion** while executing independent checks; it never marked the overall run passed. Parent then reproduced/fixed checkpoint pruning and authoritative live-invocation capture, and confirmed the new production UI build exit0. The final driver uses a direct mandatory rendered `running` assertion, the actual busy label plus exact native `failed`, and an exact two-request-set assertion after explicit retry to forbid replay. It samples owner/unload refusal before the rendering assertion and rechecks GPU6 health/capacity immediately before native cold submission. No responses/events are mocked or substituted. One final fresh run is authorized on the newa350 artifact; earlier evidence remains separate.

## Final single authorized attempt after production UI fix

Parent confirmed production UI build/repro-after exit0 before launch. Ran exactly once:

```sh
.venv/bin/python studio/tools/coding_local_launch.py \\
  --native ../mimir/target/studio-local/mimir-compression-settled \\
  --gpu-capacity-confirmed --browser firefox --deadline-seconds 480
```

Shell ceiling600s; actual exit1 after589.9s, **infrastructure-blocked, not passed**. Fresh artifact evidence at `live-8c9e7ca4/launcher-report.json`: nativea350 hash and unchanged Wasm1866538d hash; rebuilt frontend index SHA256 `76d67a806492d7f503b22cfcf7781f4cfc346e771dc42995bfefab08f19b266e`. Package install/authentication passed. Immediately before native submission, narrow GPU6 capacity query succeeded: total183359/used119979/free63380MiB, utilization99. Native main identity remained `studio-local/local-880c18525644a33cf0dc41f6e20e2334eaa315f262a87653ec282cab6c882a8e`. Final file checksum reverified main GGUF SHA256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`.

Production full-device GPU/NVML probes subsequently timed out, actual llama PID3018108 entered uninterruptible disk sleep during CUDA initialization, and owned-PID memory query timed out after60s. No memory sample/peak certification and no successful native tool workload were established. Background load made late progress during shutdown; it is not a successful coding admission/load result.

Exact native request `prompt-2026-10-13T15-56-44-657Z_7241188b-d452-4926-bd39-641aab4ad8e9` was observed through an independently authenticated **actual native SSE snapshot** as `failed`, active_requestnull; durable native journal status `errored`. Owner observation showed holds0/loadedfalse/active true while the failing llama remained. Conversation `2026-10-13T15-56-17-064Z_4019d8f8-ea8a-4e4f-a457-0e176726b4e9`; `native-terminal-observation.json` preserves exact evidence. No project files/tools were created. Exact browser helper2898415 was interrupted after terminal observation so launcher could attempt bounded cleanup; no further workload was launched.

Cleanup: launcher/server exit1/-15, native exit1, clean lifespan **false**; gated model shutdown raised TimeoutExpired after SIGKILL wait. Server2897167/native2900791/helper2898415/launcher2699188 exited; orphaned llama3018108 initially remained D-state and then exited without another signal. `final-evidence.json` verifies all exact PIDs absent and explicitly retains failed-lifecycle status. Eventual PID absence is not a clean lifecycle pass. Credential-pattern scans of published logs: zero matches.

Actual loading/cleanup-error screenshots at `live-8c9e7ca4/browser/local-preparation-{1,2,3}-{desktop,narrow}.png` were preserved; final error desktop/narrow inspected with readable wrapping and no horizontal overflow. The strict running-shell assertion, busy/retry/no-replay/PID stability, ordinary chat and combined recovery **were not reached on this attempt**. Previous successful normal prompt and independent new-artifact recovery remain separate evidence, not a relabeled full final pass. No further GPU attempt authorized/performed after recurrence. Next action requires coordinated diagnosis of shared NVML/CUDA health—not eviction/reset of another workload.

## Verified setup

Main model `.scratch/ticket246-live/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`:
- Anonymous pinned Hub repository `unsloth/Qwen3-4B-Instruct-2507-GGUF`, revision `a06e946bb6b655725eafa393f4a9745d460374c9`.
- Size2497281120 bytes; SHA256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`, equals upstream LFS metadata.
- Qwen3 architecture36layers, embedded tool-call chat template; actual tool execution is separately recorded in live evidence.

Alternate real downloaded model for non-evicting busy admission: `Qwen3-0.6B-Q4_K_M.gguf`, repository `unsloth/Qwen3-0.6B-GGUF`, revision `50968a4468ef4233ed78cd7c3de230dd1d61a56b`, size396705472 bytes, SHA256 `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a`. `alternate-model-setup.json` records verification. It is a second actual GGUF, not an alias, fabricated catalog row or provider fixture. Busy acceptance must not load it over the resident main model.

Runtime `.scratch/ticket246-live/llama.cpp/llama-server` points to `build/bin/llama-server`. Existing Studio prebuilt installer verified approved CUDA13/sm100 release `b11541-mix-2500203`, source `ce8c040212e544facc9eb9d2ee49dba7854eddb8`, archive SHA256 `a7b3583e52fe6469fb87446c08ecb8ee981dc7df4e60fa38066a79d4a80ef194`. `--version` and installer `--check-installed` passed.

Setup installed missing gguf0.19.0/jinja2 3.1.6/nest_asyncio1.6.0 only after coordinating `.venv` writes; cryptography50.0.2 is present. Another worker installed torch2.14.1+cpu; it was preserved. This is not a pristine no-torch environment, but llama.cpp owns all GPU inference here. Setup installed no torch.

## Actual production composition

`coding_local_app:create_app` mounts production auth/coding/inference/inference-studio routers, `/v1`, actual keepwarm middleware, and built frontend. Models are discovered through existing scan-folder registration and native catalog refresh, not a second inventory. Cold load uses existing Studio saved overrides: context32768, slots1, speculativeoff, visiondisabled, manual99layers. Do not use unbounded native262144 context under this grant.

Authenticated acceptance-only endpoints:
- `protection`: read-only actual owner holds, active/loaded/context/slots/PIDs. Cannot inject/release a protection or fabricate a native result.
- `recover-idle-native`: real process fault only after zero holds, model unload and terminal requests. Verifies mugi ownership, exact executable/argv before killing its own native process; awaits exit and uses production close/reopen. No synthetic lifecycle events.

Launcher isolates `HOME`, `MIMIR_CODING_AGENT_DIR`, `UNSLOTH_STUDIO_HOME`, and HF caches beneath the fresh run. `LLAMA_SERVER_PATH` points to the task runtime; native executable/package point to sibling Mimir's built artifacts. Inherited remote-provider credentials and ambient local bootstrap credentials are removed. Password/token remain in memory/env, never argv or published reports.

## Required browser checks

Actual rendered folder selection, native conversation/model refresh/selection, cold load UI, real native write_file/shell/read_file, exact call/invocation identities, structured file-change profile and disk hash. The shell requests a20-second sleep to create an actual inference gap. Owner hold and destructive unload409 must be observed while native shell is running. Exact native completion must release protection before ordinary `/v1` inference.

Busy scenario selects the pinned alternate identity while the main model remains resident. Require native failed state, actionable busy UI, explicit empty-configuration retry, no prompt replay, resident PID unchanged and zero holds. Restore original future selection without another prompt.

After gated model unload, require all observed native requests terminal, verify/kill only the exact idle task native child, reopen the saved conversation using real rendered controls, refresh native catalog, verify a new native PID, zero holds, unchanged disk effects, and retained actual tool identities.

Screenshots use desktop1440x1000 and narrow390x844. Driver checks document horizontal overflow. Representative actual loading/selected/protected-shell/terminal images have been inspected; the protected-shell screenshot exposes the erroneous saved historical tool status. Narrow terminal has little transcript space above the composer, despite no document overflow. Do not claim visual running-state correctness until fixed/reverified.

On helper failure, launcher subscribes before cancelling an exact remaining request, preserves the actual native terminal state rather than merely accepting an ACK, and attempts clean server lifespan shutdown. Never force-drop native holds or evict another user's model. Preserve failed cleanup facts and verify exact owned PIDs independently before ending.
