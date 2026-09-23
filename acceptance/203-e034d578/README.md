# #203 live Studio evidence — mid-load model swap (head e034d578 vs main f5109b58)

Orphan evidence branch. Media and reports only; nothing here is part of the code diff.
No credentials, auth state, server logs, or local filesystem paths are included
(host paths are replaced with `<task-root>` / `<home>` in the JSON).

## Pins (verified live at capture and re-verified before publication)

| | value |
| --- | --- |
| Fork PR | `wasimysaid/unsloth#203` "Fix chat model load switching: replace the pending load instead of rejecting it", OPEN, branch `fix-chat-model-load-switching-7405` |
| Head | `e034d5789dad63746b21d98c5d7f80c7e7b27447` (no drift; `gh pr view 203` returned exactly this `headRefOid`) |
| Base used as the *before* control | `f5109b58434da3f5cda352f3477eefa3f2670483` (exact upstream `main` tip at capture; still an ancestor of current `main`) |
| Scene | `swap-scene.py`, sha256 `1432ae8c431064e6ea93c30a882fe0f97d4aa4d89576f47d6ae02983cb807c6b` — **identical on both sides**, so the pair shares one scene revision |

Upstream original: [unslothai/unsloth#7405](https://github.com/unslothai/unsloth/pull/7405) by
[@Imagineer99](https://github.com/Imagineer99).

## Claim

While model A is still loading, picking model B is **refused** on upstream `main` and
**accepted** on the head: the head supersedes the in-flight load and ends with B resident.

## Decisive live observations (both sides, real CPU GGUF, same scene, same clicks)

| fact | before — `f5109b58` (main) | after — `e034d578` (head) |
| --- | --- | --- |
| in-flight A observed | `true` (`loading=["model-a"]`, first poll) | `true` (`loading=["model-a"]`) |
| B clicked while A loading | 2256 ms after in-flight poll | 2356 ms after in-flight poll |
| swap click accepted | **`false`** | **`true`** |
| refusal text | `"Another model is already loading"` / `"Wait for it to finish or cancel it first."` | *(none — `[]`)* |
| final resident | **`model-a`**, `final_loading=[]` | **`model-b`**, `final_loading=[]` |
| settle reason | refusal seen; 20 s window expired without B resident | "model B reported resident" |

Both variants are CPU-only (`CUDA_VISIBLE_DEVICES=""`, `UNSLOTH_ALLOW_CPU=1`), Python 3.13.12,
two real GGUF files (gemma-3-270m-it Q6_K 283 MB and Q8_0 292 MB) served from one local
models directory; the picker showed exactly those two rows on both sides.

## Images

Both PNGs are 3024x1056 side-by-sides: **left = before (main)**, **right = after (head)**.

- `mid-load-swap-refused-vs-accepted.png` — the moment that decides the claim. Left: main
  shows the red chip "Another model is already loading …" with the trigger still
  `model-a GGUF · Q6_K`. Right: the head shows `Starting model…` plus `Stopping model load`
  and no refusal. Same clicks, opposite outcome.
- `final-resident-model-a-vs-model-b.png` — settled state with the picker open. Left:
  `model-a` marked Loaded. Right: `model-b` marked Loaded.

## Hash pins

| artifact | sha256 |
| --- | --- |
| `mid-load-swap-refused-vs-accepted.png` | `3e80ccc57c028ea0602cf63269b1aa6d5687808bd2b33a8252709b1cd60ee234` |
| `final-resident-model-a-vs-model-b.png` | `53b82a93a73094918598421f9f8a8f4403e428b934be82e154eac0ebaa6c42bc` |
| committed `before-facts.json` (subset of the main-side run) | `43129db44a211af9a0ce5a3e76db2a76a83f34bc18caa09ad6ac5c0778e4f211` |
| committed `after-facts.json` (subset of the head-side run) | `9c811f8c65b1e93157b3e3743ed389d6fb452cd6160800d86fd3b0de21cc79c8` |
| committed `comparison-result.json` | `1b35d402dbcb2089c472bc8ab0e403ccf583d6ed8b6e15540e0d079971881494` |
| full unpublished main-side `result.json` | `ce3b33a4cf822874399430c5cea46f5d5cc271c18d3b4c139492e619e6cc86b8` |
| full unpublished head-side `result.json` | `ffc8ce4af0cb31e55cf521958dbe7b648add79a8b6d5157cdeedf4cbf0b135da` |
| scene `swap-scene.py` | `1432ae8c431064e6ea93c30a882fe0f97d4aa4d89576f47d6ae02983cb807c6b` |

`comparison-result.json` records `identical_pairs: []` (no capture pair is byte-identical)
and every capture hash re-verified by the comparison step before pairing.

## Current-head checks re-run for this publication

At `e034d578`, in the task worktree (clean, `HEAD == e034d578`):

- `node --experimental-strip-types --test tests/chat-model-load-replacement.test.ts`
  → **42 pass, 0 fail**.
- Same test file against the pinned `main` source (`f5109b58`) → **1 pass, 41 fail**
  (the single pass is the harness-only `cacheRam` snapshot case; every
  replacement/cancellation/rollback case is red on main).
- `python -m pytest tests/studio/test_new_chat_context_recount.py tests/studio/test_model_picker_contracts.py tests/studio/test_multi_chat_prompt_queue_contract.py -q`
  → **266 passed, 1 skipped**.
- `npx tsc -b` in `studio/frontend` → exit 0.

## Reproduction

Serve each variant from its own pinned worktree with the two real GGUFs in the task-root
`models/` directory (relative path, so the serve cwd must be the task root), then drive the
same scene against each and compare. `endpoint.json` stays `state="cleaning"` on both sides
because terminating the retained serve session interrupts the helper's final write; the
authoritative cleanup evidence is the absent PIDs, free ports, and the graceful-shutdown
lines in the server logs.
