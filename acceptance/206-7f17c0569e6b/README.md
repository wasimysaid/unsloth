# #206 live Studio evidence — floating monitor dock (final head `7f17c056` vs main `f5109b58`)

Orphan evidence branch. Media and reports only; nothing here is part of the code diff of the
branch under review. No credentials, auth state, or server logs are included, and task-root /
`HOME` paths are replaced with `<task-root>` / `<home>` in the JSON mirrors. One absolute path
remains: `scene-7f17.py` keeps the shared skills-suite default for `UNSLOTH_WORKSPACE`
(`/home/mugi/unsloth-workbench/skills/pr-ui-evidence`), a public install location rather than
task- or user-private state, kept byte-exact so the scene's sha256 still matches the run record.

Supersedes `acceptance/206-44029cd63c5d/`, which pinned an earlier intermediate head
(`44029cd63`). The head has since moved twice; every claim below is measured on the current head.

## Pins (verified live at capture and re-verified before publication)

| | value |
| --- | --- |
| Fork PR | `wasimysaid/unsloth#206` — "Studio: keep the live monitor visible beside the run settings panel (replacement for #6993)", OPEN |
| Branch | `mimir/rebuild-6993-monitor-dock` |
| Head | `7f17c0569e6b446ca9dbf68d02e931cc6149eb88` (no drift: `git ls-remote fork` and `gh pr view 206 --json headRefOid` both returned exactly this) |
| *Before* control | `f5109b58434da3f5cda352f3477eefa3f2670483` — the reported upstream `main` revision for this PR, built from source |
| Superseded candidate | `e55c9b58018032330fb678fe55c1676d6761bbe6` (the previous head, still reachable in the same branch history) |
| PR merge base | `316e1912db4e82dda4aa44b3eadec5b12d52fb4c` |
| Upstream `main` at collection | `3ef36472dfe1c367cf448f5b4e7ffe444c2cce37` |
| Scene | `scene-7f17.py`, sha256 `fd1fc6364d30411c54aba8cc79c9edd56cc1953861b5ad8ca289d4360bae64ee` — identical on all three variants, so every pair shares one scene revision |

Upstream original: [unslothai/unsloth#6993](https://github.com/unslothai/unsloth/pull/6993).

## Claim

Opening **Run settings** used to bury the floating **Live monitor**: both are anchored to the
bottom-right corner and the panel painted in front of it, so the user had to close the panel to
read the monitor (upstream issue #6988). The replacement docks the monitor immediately to the
panel's left, keeps its right-edge placement when the panel closes, and yields to the
full-screen sheet at narrow widths.

## Decisive live observations

Real authenticated Studio (three source builds), real Chromium via the Playwright API, headless.
No model load is required for this layout check; the monitor paints the system-info resource panel.

### 1 — Wide viewport (1280×800), Run settings open

| fact | before — `f5109b58` (main) | after — `7f17c056` (head) |
| --- | --- | --- |
| monitor x / right | 1008 / 1264 | **748 / 1004** |
| settings panel x / width | 1008 / 272 | 1008 / 272 |
| **horizontal overlap** | **256 px (monitor sits under the panel)** | **0 px (4 px clearance)** |
| docked container right inset | `16px` | **`276px`** (= 272 + 4) |

### 2 — Narrow viewport (720×800), modal Run settings

| fact | before — `f5109b58` (main) | after — `7f17c056` (head) |
| --- | --- | --- |
| `aria-hidden` on monitor | `true` | `true` |
| monitor actually visible | **`true` (paints over the sheet)** | **`false`** |
| drag grip reachable | `true` | **`false`** |

Main already marks the monitor `aria-hidden`, but it still paints on top of the modal controls.
The head suppresses it for real and also makes the grip unreachable.

### 3 — Supported 20 px UI font (the scaled-inset check)

`--ui-space-scale` is `calc(1.25 / .9375)` = 1.3333 at the supported 20 px UI font.

| fact | before — `f5109b58` | after — `7f17c056` |
| --- | --- | --- |
| resting right / bottom inset | 21.3333 px | 21.3333 px |
| 16 px base edge inset × 1.3333 | 21.333 px | 21.333 px |
| overlap with the open panel | **250.672 px** | **0 px** |
| docked container right inset | — | **`277.333px`** (= 272 + 4 × 1.3333) |
| monitor x / right when docked | — | 661.34 / 1002.67 (4 px clearance) |

The scaled rest inset is **not** a differentiator here — both sides scale it to 21.333 px in this
build. What the head adds is that the *dock clearance* scales with it too, so the 20 px font keeps
0 px overlap instead of main's 250.67 px.

### 4 — Docked net-zero drag must not latch a placement (discriminating vs the superseded head)

Regression scenario: the first-ever drag on the docked monitor moves away and returns to its exact
start X before release. After the panel closes, the monitor must fall back to its saved/right rest
position, not to a drag-committed X.

| fact | superseded `e55c9b58` | final head `7f17c056` | main `f5109b58` |
| --- | --- | --- | --- |
| released X (docked) | 748 | 748 | 1008 *(never docks — control only)* |
| X after undock | **748 (latched a drag placement)** | **1008** | 1008 |
| right after undock | 1004 | **1264** | 1264 |
| returned to right rest anchor | **false** | **true** | true |
| same at 20 px font (released → undocked) | 661.34 → **661.34** | 661.34 → **917.34** | — |
| right at 20 px after undock | 1002.67 | **1258.67** | — |

This is the check that separates the final head from the immediately preceding candidate: the
superseded head keeps the docked X after undocking, the final head restores the right anchor, at
both the default and the scaled font.

## Images

All PNGs are two-panel side-by-sides. In `before-after-*`, **left = before (main `f5109b58`)**,
**right = after (head `7f17c056`)**. In `prev-after-*`, **left = previous candidate `e55c9b58`**,
**right = after (head `7f17c056`)**.

- `before-after-run-settings-open.png` (2584×856) — the headline claim. Left: the monitor is
  painted *underneath* the Run settings panel, RAM/VRAM rows clipped by the panel edge. Right: the
  monitor is fully clear to the left of the panel, both readable at once.
- `before-after-narrow-720-sheet.png` (1464×856) — 720 px modal sheet. Left: the monitor paints
  over the sheet's controls. Right: suppressed, no monitor over the modal.
- `before-after-font20-open.png` (2584×856) — the same 1280 px open-panel case at the 20 px UI
  font, where both panels are larger. Left: still overlapping. Right: still clear.
- `prev-after-netzero-undocked.png` (2584×856) — the #4083661736-style regression, after the panel
  is closed again. Left: the superseded candidate's monitor is stranded at the docked X, away from
  the right edge. Right: the final head's monitor is back at the right rest anchor.

## Hash pins

| artifact | sha256 |
| --- | --- |
| `before-after-run-settings-open.png` | `2095dce93c12982a7c69e1dd2426433a62e6918940641b50fc5f5d496372086d` |
| `scene-7f17.py` (scene revision used on all three variants) | `fd1fc6364d30411c54aba8cc79c9edd56cc1953861b5ad8ca289d4360bae64ee` |

`scene-7f17.py` is included byte-exact as run, so the hash above equals the `scene_sha256`
recorded in every variant's `result.json`. Its only absolute path is the shared skills-suite
default noted at the top of this file.
Full per-artifact digests, sanitized per-variant facts, and both comparison results are in
`SHA256SUMS.txt`, `evidence.json`, `facts-*.json`, and `comparison-*-vs-head.json` in this
directory.

## Method and cleanup

- Three variants built and served from source in isolated worktrees with isolated `HOME`s and
  reserved ports: `before` `f5109b58` @ 9161, `prev` `e55c9b58` @ 9162, `after` `7f17c056` @ 9163.
- 22 captures per variant at each of the pinned states; each drive recorded `outcome: observed`,
  `scene_conclusion: completed`, 22 artifacts, `browser: closed`.
- Pair 0 (`wide-closed`, panel shut) is **byte-identical** between main and head, confirming the
  two sides start from the same rendered frame before the panel is opened.
- All three servers were stopped and verified: `state: stopped` in every `endpoint.json`, no PIDs
  remaining in `/proc`, no listener on 9161/9162/9163, no Playwright browser retained. All three
  variant worktrees were left with 0 dirty tracked files.
- No model was loaded; the only live numbers on screen are host RAM/VRAM readings from the
  system-info panel, which differ between runs by design and are not part of any claim.

## Limitations

- The "a saved full-width X survives a later docked net-zero drag" sub-step degenerated in the
  final run to a second at-anchor drag (no non-anchor X had been committed yet), so it is
  supporting evidence only. The decisive first-ever case above is fully covered at the default and
  the 20 px font.
- Monitor *height* varies between runs because system-info rows arrive at different times
  (111.47 → 167.94 → 222.84 px). Horizontal geometry and the bottom-anchored inset are stable;
  only y/height move.
- The "Run settings" `<aside>` stays mounted at zero width when closed, so the scene waits on
  measured width rather than detachment. The first attempt (`r1`) is preserved; every number here
  is from `r2`.
- The comparison tool's own conclusion field reports `requires_assertion_review` for both stacks.
  That is the tool declining to auto-assert on a scene without inline expectations; the facts
  above were read from the recorded geometry and the images, not from that field.
