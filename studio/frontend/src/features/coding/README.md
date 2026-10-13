# Coding native run/stop projection (#234–235)

`/coding` keeps Studio’s authenticated route gate, sidebar primitives and composer
CSS, without importing ordinary chat execution, tool orchestration, model loading
or transcript persistence. An already-visited ordinary workspace remains parked,
not cancelled. Direct coding visits do not mount its model observers.

Mimir’s production `studio.frontend` plugin owns Session Control attachments and
saved public history. The browser keeps only an ephemeral Session View projection;
there is no second scheduler, inference loop, provider configuration or transcript
database. Providers and credentials remain configured on the Mimir host.

## Installed assistant-ui contract

React **0.12.28**, Core **0.1.17**, Store **0.2.9** are lockfile-pinned.
`run-runtime.ts` uses the shipped `ExternalStoreAdapter<PresentationRow>` converter,
`messages`, `isDisabled`, `isLoading`, `isRunning`, `onNew`, and `onCancel`.
`ThreadPrimitive.Messages` renders those external rows; `ComposerPrimitive` forwards
text through the authenticated API. No `setMessages`, local optimistic turns,
attachment/tool-result executor, edit/reload adapter or remote transcript store is
provided. The shipped runtime's transient upcoming-assistant placeholder has no
native row and is intentionally invisible, not a fabricated transcript entry.
Shipped-artifact tests exercise the actual runtime, including running before the
first native reply.

## HTTP and authoritative reconstruction

All `/api/coding` routes use established Studio auth, including IDs and fetch SSE:

- Browse/catalog/list/create/open retain the #234 canonical-folder and effective,
  non-persisting trust behavior. Selecting a folder always creates a new native
  conversation; reopening preserves its saved native identity and directory.
- `POST /conversations/{id}/prompts` accepts `{submission_key,text}` plus optional
  `skill_mentions` and `images`, and returns native conversation/submission/request
  identities. Transport retries are disabled.
- `GET /conversations/{id}/skills` discovers the already-open controller's effective
  native skill metadata. It neither loads skill bodies nor creates another registry.
- `POST /conversations/{id}/requests/{request_id}/cancel` targets exactly that native
  request. Acknowledgment is not terminal cleanup. It never closes the owner.
- `POST /conversations/{id}/entries` reads only the native immutable root `cut`, with
  an exact `latest`, `before` or `after` anchor and bounded entry/byte selection.
- `GET /conversations/{id}/events` consumes the native atomic start capture, then
  ordered activity, checkpoints, whole state, completion and reset items. Position
  gaps are allowed; backward positions and wrong conversation IDs are errors.

Initial/reset history is read at the captured root cut before the view is Ready.
Checkpoint reads reconcile saved rows after the previous cut and replace provisional
activity, except exact still-live tool invocations. A reset discards the old branch;
recovery remains visible until a root checkpoint. There is no snapshot-then-subscribe
race or history polling for lifecycle state. Earlier history outside the current
bounded page is explicitly disclosed and can be requested at that same cut. The
projection retains at most 1000 displayed rows / 2 MiB of text; omitted earlier
content is disclosed. Native reads and public text/output have their own smaller,
disclosed bounds; oversized entries are typed public SDK reads, never private
saved-result decoding.

Tool activity uses exact invocation/call identities and native titles/status. Public
output is expandable and keyboard-operable; clipping is labeled. Public presentation
content is authoritative, not model-only output. Starts/results of one invocation
share a compact chronological slot; repeated invocations remain separate. Historical
reports are labeled and are not claims about the current filesystem. There are no
Apply/Revert controls or tool-selection pills.

## Skill mentions and images (#242)

`coding-composer.tsx` retains the shipped assistant-ui text field/Send ownership.
`input.ts` tracks only ephemeral draft associations, not execution or history.
Selecting a skill inserts its exact qualified `@name`, preserving the native disk
`path` where supplied (plugin names are not shortened). Edits shift intact ranges
or invalidate touched/extended tokens. JS UTF-16 offsets are converted to half-open
native UTF-8 byte ranges against the exact untrimmed text at submission. Typing a
short display name alone does not invent a native skill reference or load its body.

Images can be selected or pasted, inspected and removed before Send. Supported
PNG/JPEG/WebP/GIF images are bounded to four, 512 KiB aggregate original bytes, and
4096×4096 dimensions. GIF is image input, not a promise to forward every animation
frame. Browser checks give immediate feedback; authenticated Studio validates the
transport shape/bytes and the plugin independently decodes and enforces bounds.
Native provider image refusal and request failures remain explicit. Images are
base64 bytes, never user-supplied host paths or remote URLs; no upload store exists.
Include text with attachments. Existing 1 MiB private frame bounds remain in place.

Every send snapshots text, exact skill identities/paths/ranges and original image
bytes once under its native submission key. Uncertain delivery retries that whole
snapshot, not the current composer. A definite pre-admission rejection retains
**Restore rejected input**; neither it nor a preview creates an accepted transcript
row. Native acceptance/reconciliation clears draft associations. Cross-reload durable
recovery remains #236; this slice preserves rich input wherever #235's in-memory
uncertain-delivery capability is present.

The mention list supports search, keyboard Arrow/Enter selection from `@` input,
Escape dismissal and focus return. Attachment/mention controls wrap on narrow screens;
they are not ordinary-chat tool-selection pills.

## Delivery and lifetime

Before project selection or complete capture, the composer is disabled. Enter and
Send forward text; queued requests remain native. An unconfirmed prompt retains its
original key for explicit same-submission retry and is reconciled against native
request state. Durable retry across reload/restart is #236, not promised here.

Stop captures the active native request, remains **Stopping…** through its matching
terminal completion/cleanup, and exposes native cleanup failure as failure. A
reconnected atomic capture may settle that request only when its native terminal
status and released active-request admission agree. Other queued or conversation
requests are never substituted. Disconnect stays visible and never means stopped;
detach closes only the view, not the conversation owner. No automatic process restart
or command replay is added. Full recovery/retirement is handled by later tickets.

## Verification

```sh
npm --prefix studio/frontend ci --no-audit --no-fund
npm --prefix studio/frontend run typecheck
(cd studio/frontend && node --experimental-strip-types --test tests/coding-*.test.ts)
npm --prefix studio/frontend run build
```

The route browser driver is `studio/tools/coding_browser_acceptance.py`. It exercises
built UI → authenticated production routes → installed plugin → native Mimir.
Deterministic provider scenarios exercise actual native tools but are not live model
acceptance. See `studio/docs/coding-integration.md` and task-local reports for the
shared acceptance mapping, observed results, browser dimensions and external blockers.
