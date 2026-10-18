# Qwen3.8-Flash-Next in Studio: prompt-cache reuse + Search/Code toggles (GIF demo)

`demo-qwen38-cache.gif` (13.2 s, 960×600) is a screen capture of a **real, unmodified Studio session**
running a **real local GGUF model on real B200 GPUs**. Nothing in the GIF is a mock, an animation, or a
synthetic overlay value — every number is read live from the running llama.cpp server.

## What the GIF shows

1. **Search / Code pills ON** — tools enabled for the thread.
2. **Search / Code OFF** — `web_search`, `python`, `terminal`, and `edit_file` are removed from the
   outgoing request; generic skill tools are retained.
3. **Search / Code ON again** — the tool set is restored.
4. **Three consecutive turns in one thread**, with a labeled metrics box after each turn.

The green box is an annotation layer drawn over the page and says so on its first line
(`live llama.cpp /metrics — annotation, not a Studio UI panel`). It is not Studio chrome; the values
inside it are real.

## Measured numbers (from llama.cpp `/metrics` counter deltas)

| Turn | prompt tokens processed | served from KV cache | prefill seconds | wall time |
| --- | --- | --- | --- | --- |
| 1 — first message in a fresh thread | 4,249 | **0** (nothing reused) | 10.37 s | 12.02 s |
| 2 — same thread | 24 | 4,245 | 0.51 s | 3.05 s |
| 3 — same thread | 24 | 4,265 | 0.42 s | 2.97 s |

Turn 1 was captured on a genuinely cold cache: the server's slot cache was explicitly erased
(`POST /slots/0?action=erase`, `n_erased: 4292`) before recording, so the first turn really did
process its full prompt. Turns 2 and 3 reuse the cached prefix, so only the new message is prefilled.

**Prompt reuse drops prefill from ~10.4 s to ~0.4–0.5 s (~25×) and wall time to ~3 s for the same
thread.** Note that wall time stays in the seconds range because it includes generation of the reply,
not just prefill.

## Reproduction setup

| Item | Value |
| --- | --- |
| Studio | Linux web Studio (`studio/frontend` + `studio/backend`), served on `127.0.0.1` |
| llama.cpp | `unslothai/llama.cpp` CUDA build, launched by Studio with `--metrics` |
| Model | `unsloth/Qwen3.8-Flash-Next-GGUF` → `UD-Q4_K_XL`, 4 shards |
| Devices | 2× NVIDIA B200, `-ngl -1` |
| Context | 16,384 tokens (`--parallel 1`, flash-attn on) |
| Thinking | disabled for these turns, so the whole token budget goes to visible output |
| Browser | Chrome via Playwright CLI, 1280×800 viewport, screen-cast recorded |

## Caveats

- This is a **single-version demonstration**, not a benchmark. Absolute tokens/second figures are only
  indicative of behavior observed on shared B200 devices; no exclusive GPU reservation or matched
  sequential comparison was performed.
- Cache-hit state is **not** surfaced in the Studio UI. The numbers come from the llama.cpp server's
  `/metrics` endpoint, which is why the GIF labels the box as an overlay rather than a product panel.
- The metric box is a presentation aid added at record time. If you want to reproduce the raw session,
  the same steps are: load the model with `--metrics`, erase slot 0 to start cold, then send one long
  message followed by short ones in the same thread and diff the `llamacpp:*_total` counters per turn.
