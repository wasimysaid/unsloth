# Coding opening preview

`/coding` uses the existing `requireAuth` route gate and `authFetch` API client.
It renders a separate coding sidebar and composer, not `AppSidebar`, `ChatPage`,
`Thread`, the general-chat runtime/store, model picker, sandbox, or tool controls.
The shared `AppProvider` still owns host startup, desktop auth and appearance.
An already-visited Studio workspace is retained hidden/inert so unrelated running
chat/media work is not cancelled; its sidebar, modal surfaces, route outlet and
shortcuts are parked. Direct coding visits do not mount that workspace hydration.
Studio does not write coding history to IndexedDB, local storage or a chat store.
Conversation records and the canonical project directory are native API results.

## Pinned assistant-ui audit

Installed from the exact frontend lockfile:

- `@assistant-ui/react` **0.12.28** exports `useExternalStoreRuntime` from
  `@assistant-ui/core/react`; Core is pinned to **0.1.17**, Store **0.2.9**.
- Core's `ExternalStoreAdapter` accepts `isDisabled`, `isRunning`, `messages`,
  and requires `onNew`. Its shipped `ExternalStoreThreadRuntimeCore` enables
  edit/reload/cancel/attachments/voice/feedback only when the corresponding
  optional callbacks/adapters exist. The opening adapter supplies none of them.
- `ComposerPrimitive.Input` ships `submitMode="none"` and `disabled` support.
  `ComposerPrimitive.Root` is a submitting form, so the preview also prevents
  form submission. `onNew` rejects with the same truthful unavailable explanation
  if a caller invokes it directly; it never simulates prompt execution.
- No experimental remote thread list adapter is needed for this slice. The coding
  sidebar lists native records and explicit clicks call native reopening.
- Reusable presentation is `components/ui/sidebar`, `button`, `input`, `dialog`
  plus the existing `unsloth-composer-surface`/`unsloth-composer-input` styles.
  Existing `components/app-sidebar.tsx` and `assistant-ui/thread.tsx` depend on
  general-chat execution, persistence and tools, so they are **not** reused.

## HTTP boundary

All requests use `authFetch`, including SSE; there is no unauthenticated
`EventSource` or second authentication policy. Non-idempotent openings disable
transport retries to avoid duplicating a native creation after a lost response.

- `GET /api/coding/projects/browse?path=<encoded host path>` returns
  `{path,parent,entries:[{name,path}],truncated}`. Empty path selects the backend's
  default browse location. `path` and `entries[].path` are host paths; selecting
  files from a browser device is deliberately unsupported.
- `POST /api/coding/conversations` with `{cwd}` creates and opens a **new** native
  conversation on every deliberate folder selection, including the same folder.
- `GET /api/coding/conversations` returns `{conversations:[...],next_cursor}`.
  The frontend reads cursor pages (encoded `?cursor=`) until completion, with an
  explicit failure for repeated cursors or exceeding 100 pages. It never presents
  a truncated first page as complete native history.
- `POST /api/coding/conversations/{id}/open` explicitly reopens a saved native
  conversation and revalidates its folder. Folder selection never implicitly
  reuses a saved conversation by matching `cwd`.
- Creation/reopening returns native info `{id,cwd,title,live}`; presentation reads
  its identity, folder and title without storing another history. Returned `cwd` is
  authoritative; the browser never normalizes paths or changes cwd on a record.
- `GET /api/coding/conversations/{id}/events` is an authenticated fetch SSE stream
  (`event:view` and heartbeat), with ordered native `{subscription,position,event}`
  view lifecycle envelopes. This preview watches connection health and recognizes
  native `closed`, SSE `disconnected`/`error` and EOF as failures, without duplicating
  native event history or pretending to render prompt responses.
- FastAPI errors use `{detail: string}` and remain visible with retry controls.

The controlled folder picker explicitly restores its invoking button on close
(Cancel, Escape, close button or successful opening). If its mobile sidebar invoker
has disappeared, focus returns to the visible project chooser below the composer.
Typing into the path field invalidates outstanding directory reads as well as the
previous selection, so a late response cannot replace the newer draft. A successful
same-ID reopening advances the view incarnation and reconnects its native stream;
a failed opening preserves the current view and identity.
Working-directory/trust disclosure remains visible for saved-conversation reopening
as well as new-folder opening; no browser trust override is sent.

Send, prompt input and keyboard submission are unavailable in this preview.
Opening a conversation is not evidence that a prompt executed. There is no send
endpoint, runner/model/tool configuration or cancellation API in the frontend.

## Verification

From the Studio repository root:

```sh
npm --prefix studio/frontend ci --no-audit --no-fund
npm --prefix studio/frontend run typecheck
(cd studio/frontend && node --experimental-strip-types --test tests/coding-*.test.ts)
npm --prefix studio/frontend test
npm --prefix studio/frontend run build
```

Behavior tests exercise native-record identity, canonical cwd, distinct creation,
explicit reopening, failed validations, in-flight guards, stale directory reads,
authenticated HTTP/SSE and the installed external runtime's capabilities. Browser
verification must use the real Studio/plugin/native bridge, not these mocks.
