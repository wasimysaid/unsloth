# Coding opening preview and Mimir Settings

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

## Mimir Settings (#250)

The focused **Mimir Settings** view uses the open native conversation's effective
trust and project directory to inspect MCP's global/workspace layers. Native source
identities, configured states, effective field origins and live ownership/status
are preserved; inventory is redacted. The explicit editor reads raw source JSON
(including secrets), never expanded/merged transport values for persistence.

Authenticated endpoints under `/api/coding/conversations/{id}/mcp`:

- `GET /inventory`: native scoped documents, source entries, effective values and
  live connection metadata; does not open an owner or apply changes.
- `POST /edit` with `{source,name}`: begins an edit of that exact native source.
  Missing names create a draft. Returns `{edit_id,source,name,revision,json}`.
- `POST /save` with `{edit_id,revision,json}`: native validation and revision-checked
  persistence; returns `{draft,configured_state,inventory,inventory_error}` with the
  actual committed editor revision and configured state at the saved source.
  Inventory is a separate best-effort observation: if it exceeds transport bounds,
  `inventory` is null and `inventory_error` explains how to refresh. A completed
  persistence operation is never reported as failed because observation is unavailable.
  Raw and normalized editor JSON are bounded to 512 KiB before persistence.
  It never applies/reconnects connections, attaches transient servers, cancels work,
  or closes/reopens conversations. Live apply/reconnect belongs to #251.
- `POST /release` with `{edit_id}`: drops only an obsolete native editor resource
  after comparison/reconciliation/discard, never its conversation or connections.

No endpoint accepts arbitrary file paths. Responses are `no-store`; raw drafts
are never logged or included in request-validation diagnostics. The browser
uses authenticated fetch with transport replay disabled. A lost save reply is
**uncertain**, not a failed write: compare the saved version before deliberate retry.

`mcp-settings.ts` holds ephemeral forms keyed by native conversation ID, retaining
draft text and edit revision through errors, conflicts, tab switches and conversation
changes within this mounted coding page. It does not use browser storage or persist
secrets. A browser reload/navigation away loses these in-memory unsaved drafts.
Refresh reads inventory without rebasing edits. Comparison reads a new native draft
separately; only **Keep draft and use latest revision** or **Replace draft with saved
version** adopts it. Another intervening writer can still conflict. Discard is
confirmed; selecting another row never silently replaces a draft. Operations are
serialized per form, with focused native errors and keyboard-operable reconciliation.

Saved status and native live connection status are separate. The persisted revision
is an editor revision, not evidence that servers have reconfigured. Native inventory's
`live_available` explicitly distinguishes unknown observation from known-empty connections;
unavailable status offers refresh instead of inferring no applied servers. Refresh is a
read, not an apply mechanism. Extensions/maintenance sections are supplied by #252.

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
