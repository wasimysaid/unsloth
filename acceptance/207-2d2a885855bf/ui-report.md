# Issue #207 — parked web-fetch URL visibility: real-browser before/after evidence

Run `ui2`, attempt `rev5`, scene sha256 `9e70dc7b6a7d7e00594ef35dac40e0032f047733d04d83cc981b588766f3626e`
on both sides (comparison is therefore valid).

| side | build SHA | label | prepared worktree / home |
|---|---|---|---|
| before | `f5109b58434da3f5cda352f3477eefa3f2670483` (upstream main) | LATEST-MAIN | `runs/ui2/variants/before/{worktree,home}` |
| after  | `2d2a885855bfb2153e1dfeaf382330003f988af5` (head)          | REPLACEMENT | `runs/ui2/variants/after/{worktree,home}` |

Both were built locally (`install.sh --local`, Node v24.14.0 / npm 11.9.0) and served on
`127.0.0.1:9131` (before) and `127.0.0.1:9132` (after). Each endpoint record was checked for
build SHA, home and PID/process-start identity before driving.

## Observed result

The four `parked` states differ; every post-decision state is byte-identical.

| capture | before sha256 (first 16) | after sha256 (first 16) | identical |
|---|---|---|---|
| parked_card_desktop | 8dabef0f6186fed7 | e43ff191d7c9eff7 | no |
| parked_full_desktop | 2c86cf51bf78e426 | 38369730cfbc442e | no |
| parked_card_narrow  | 4a5dfd9d3eddd13f | 1bf938aa61e89265 | no |
| parked_full_narrow  | 268d50c5c5b3f5c1 | e21be1ba5895996f | no |
| after_allow_card    | b89e0281589fe33b | b89e0281589fe33b | yes |
| after_deny_card     | 6a1ab3f887377b18 | 6a1ab3f887377b18 | yes |
| after_cancel_card   | 586cd6b25f73eb9a | 586cd6b25f73eb9a | yes |
| blocked_card        | 0df2c6cd23861419 | 0df2c6cd23861419 | yes |
| completed_card      | e054fc9210067431 | e054fc9210067431 | yes |

Quantitative facts (same scene, same assertions both sides):

* `desktop_row_appeared` / `narrow_row_appeared`: **false → true**
* parked desktop card text on head, read from the rendered `code` element:
  `https://example.com/reports/q3/private-payroll?team=infosec&note=visible-after-this-point\u202e&and-then-a-tail-nobody-can-read-in-the-trigger`
  → `parked_url_path_present`, `parked_url_query_present`, `parked_url_tail_present`,
  `parked_bidi_escaped` (`\u202e` spelled out), `parked_bidi_raw_absent` all **false → true**
* `parked_row_inert` (row contains **0** anchors): **false → true**; the raw URL is inert text
* height cap: parked desktop card 46 px → 92 px, `scroller_height` null → 30 px;
  narrow (720×900) card 46 px → 158 px with `scroller_height` 96 px, still
  `narrow_card_fits_viewport=true` and both Allow and Deny inside the viewport
* long URL (1555 chars) `narrow_long_url_present`: **false → true**
* unchanged controls: `verdict_completed_card_unchanged=true` both sides, completed card
  `card_anchors=1` with href `https://example.com/docs/already-linked` on both sides
* `verdict_controls_reachable=true` and `verdict_parked_row_present` false → true

Visual inspection of the labelled pairs (`comparison-before-after-rev5-rev5/pair-00.png`,
`pair-04.png`): before shows only `Using tool: Reading example.com…` with no URL row; after
shows the `URL:` row with the complete path/query/fragment and the escaped bidi control, and
the narrow pair shows the long URL inside a capped scroller with Allow/Deny still on screen.

## How the seeded stream relates to a real runtime

* Real: the two frontend builds, both served Studio instances, the loaded GGUF
  (`gemma-3-270m-it-Q6_K`, loaded through the pinned Studio's own `/api/inference/load`),
  the tool card, the parked row, the bidi escaping, the height cap and the Allow/Deny controls.
* Fixture: only the assistant SSE. It reproduces the backend's parked protocol
  (`: keep-alive` while `wait_tool_decision` blocks, then the resolution frame) and is reached
  by `durable-gate.ts` (404 on `/api/inference/chat-runs/active` → legacy
  `POST /v1/chat/completions`, rewritten to loopback). No local model reliably emits one
  specific gated `web_search` call carrying one specific URL.
* The tool-confirm endpoint is stubbed, so the approval landing on the server is not proven
  here; `validation/fetch-runtime-r2/result.json` covers it live (P3 9/9 private-address
  rejections, P4 3/3 approval-gate decisions, P7/P8 real-HTTP pending ownership).

## Cleanup

`cleanup.browser = "closed"` on both sides (one owned Playwright API browser each).
Both `serve` sessions stopped; endpoint records are `state=stopped` for `9131` and `9132`,
both ports free, and no `studio`/`pr_ui_diff` process of this task remains. Port 9015 was
never reused.

## Known limitations

* `blocked_result_rendered=false` on **both** variants: the blocked/denied result is not
  exposed through `[data-slot="tool-fallback-result"]` for this specialised card, so the
  scene's result-text assertion did not read it. This is a scanner limitation, not a
  difference (identical on both sides); the runtime stage proves the rejection text.
* No `tool-fallback-error` slot was ever rendered, because the fixture never emits an error
  frame. The cancellation negative is covered as cancellation (stop while parked → row gone,
  trigger `Cancelled tool: Read example.com`), not as an error message.
* `identical_pairs=[2,5,6,7,8]` is the no-change control for the post-decision states; the
  comparison conclusion is `requires_assertion_review`, as the tool always reports.
