// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CodingConversation } from "./types";
import type { McpSettings } from "./mcp-settings";
import { McpAppliedState } from "./mcp-applied-state";

export function MimirSettings({
  settings,
  conversation,
}: {
  settings: McpSettings;
  conversation: CodingConversation | null;
}) {
  return (
    <main
      className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-8"
      aria-label="Mimir Settings"
    >
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-2">
          <h1 className="font-heading text-2xl font-semibold">
            Mimir Settings
          </h1>
          <p className="text-sm text-muted-foreground">
            MCP configuration is saved by Mimir on this host, using its native
            configuration layers.
          </p>
          <p className="text-sm">
            Saving does not apply runtime changes or reconnect servers. It never
            stops active work.
          </p>
        </header>
        {conversation ? (
          <McpConfiguration
            key={conversation.id}
            settings={settings}
            conversation={conversation}
          />
        ) : (
          <p role="status" className="rounded-xl border p-4 text-sm">
            Open a project or deliberately reopen a coding conversation to
            inspect its global and workspace configuration.
          </p>
        )}
      </div>
    </main>
  );
}

function McpConfiguration({
  settings,
  conversation,
}: { settings: McpSettings; conversation: CodingConversation }) {
  const id = conversation.id;
  const state = useSyncExternalStore(settings.subscribe, () =>
    settings.getSnapshot(id),
  );
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const error = useRef<HTMLDivElement | null>(null);
  const serverName = useRef<HTMLInputElement | null>(null);
  const focusedDraft = useRef<string | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const busy = state.operation !== null;
  useEffect(() => {
    void settings.refresh(id);
  }, [settings, id]);
  const draftId = state.draft?.edit_id;
  useEffect(() => {
    // An editor can arrive before the operation's finally branch enables it.
    // Focus once per adopted draft, after the DOM control is actually enabled.
    if (draftId && !busy && focusedDraft.current !== draftId) {
      editor.current?.focus();
      focusedDraft.current = draftId;
    } else if (!draftId && focusedDraft.current !== null) {
      serverName.current?.focus();
      focusedDraft.current = null;
    }
  }, [draftId, busy]);
  useEffect(() => {
    if (state.error) error.current?.focus();
  }, [state.error]);
  const draft = state.draft;
  const dirty = draft !== null && draft.json !== state.text;
  const inventory = state.inventory;
  const selectedSource =
    source || inventory?.documents.find((item) => item.writable)?.source || "";
  const buttonClass = "h-auto min-h-9 whitespace-normal text-left";
  return (
    <section
      className="min-w-0 space-y-5"
      aria-label="MCP configuration"
      aria-busy={busy}
    >
      <div className="space-y-2 rounded-xl border p-4">
        <h2 className="font-heading text-lg font-medium">MCP configuration</h2>
        <p className="break-all text-xs text-muted-foreground">
          Project: {conversation.cwd}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void settings.refresh(id)}
          >
            Refresh inventory
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {busy
              ? `${state.operation === "save" ? "Saving" : "Reading"} native configuration…`
              : "Refresh reads saved and applied state; it does not change your draft."}
          </span>
        </div>
      </div>
      {state.error && (
        <div
          ref={error}
          tabIndex={-1}
          role="alert"
          className="space-y-2 rounded-xl border border-destructive/50 p-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p className="break-words font-medium text-destructive">
            {state.error}
          </p>
          <p>
            {draft
              ? "Your draft and original revision are retained."
              : "No draft was replaced or configuration applied."}{" "}
            Check the native error, then retry. For a conflict or uncertain
            save, load the saved version for comparison before deciding what to
            save.
          </p>
        </div>
      )}
      {state.savedRevision && (
        <div
          role="status"
          data-testid="mcp-save-result"
          className="space-y-1 rounded-xl border p-4 text-sm"
        >
          <p className="font-medium">Saved configuration</p>
          <p className="break-all font-mono text-xs">
            Persisted revision: {state.savedRevision}
          </p>
          <p>Saved only — runtime connections were not changed.</p>
          {state.savedConfiguredState && (
            <p>
              Saved configured state at this source:{" "}
              {state.savedConfiguredState}
            </p>
          )}
        </div>
      )}
      {state.inventoryError && (
        <div
          role="status"
          data-testid="mcp-inventory-unavailable"
          className="space-y-2 rounded-xl border p-4 text-sm"
        >
          <p className="break-words">{state.inventoryError}</p>
          <p>
            Current configured/applied inventory is unavailable. Refresh
            inventory to read the latest native state. No save will be replayed.
          </p>
        </div>
      )}
      {draft && (
        <div className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="break-all font-medium">{draft.name}</h3>
          <p role="status" className="text-sm">
            {dirty
              ? "Draft — unsaved changes"
              : state.savedRevision
                ? "Saved — matches the persisted editor revision"
                : "Draft — loaded from native configuration"}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            Source:{" "}
            {inventory?.documents.find((item) => item.source === draft.source)
              ?.label ?? draft.source}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">
            Editing revision: {draft.revision}
          </p>
          <label htmlFor="mcp-definition" className="block text-sm font-medium">
            MCP definition JSON
          </label>
          <p id="mcp-editor-help" className="text-xs text-muted-foreground">
            This is the raw definition in this source, not the merged effective
            value. Removing a field allows inheritance. Secrets are visible only
            in this explicit editor; do not share them. Drafts stay in this
            page's memory, not browser storage.
          </p>
          <textarea
            id="mcp-definition"
            ref={editor}
            value={state.text}
            disabled={busy}
            onChange={(event) => settings.change(id, event.target.value)}
            aria-describedby="mcp-editor-help"
            spellCheck={false}
            className="min-h-64 w-full min-w-0 resize-y rounded-lg border bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              className={buttonClass}
              disabled={busy}
              onClick={() => void settings.save(id)}
            >
              Save configuration
            </Button>
            <Button
              className={buttonClass}
              variant="outline"
              disabled={busy}
              onClick={() => void settings.compare(id)}
            >
              Load saved version for comparison
            </Button>
            <Button
              className={buttonClass}
              variant="ghost"
              disabled={busy}
              onClick={() => setDiscardConfirm(true)}
            >
              Discard draft
            </Button>
          </div>
          {discardConfirm && (
            <div
              className="space-y-2 rounded-lg border p-3 text-sm"
              role="group"
              aria-label="Confirm draft discard"
            >
              <p>
                Discard this editor draft? This does not undo saved
                configuration.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    void settings.discard(id);
                    setDiscardConfirm(false);
                  }}
                >
                  Confirm discard draft
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDiscardConfirm(false)}
                >
                  Keep editing
                </Button>
              </div>
            </div>
          )}
          {state.latest && (
            <div
              className="space-y-3 rounded-lg border p-3"
              aria-label="Saved version comparison"
            >
              <h4 className="text-sm font-medium">
                Latest saved version — review before reconciling
              </h4>
              <p className="break-all font-mono text-xs">
                Revision: {state.latest.revision}
              </p>
              <label htmlFor="mcp-saved-definition" className="block text-sm">
                Saved definition JSON
              </label>
              <textarea
                id="mcp-saved-definition"
                value={state.latest.json}
                readOnly
                spellCheck={false}
                className="min-h-32 w-full rounded-lg border bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                Keeping your draft adopts this revision deliberately; the next
                save can still conflict with a later writer.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={busy}
                  onClick={() => settings.reconcile(id, false)}
                >
                  Keep draft and use latest revision
                </Button>
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={busy}
                  onClick={() => settings.reconcile(id, true)}
                >
                  Replace draft with saved version
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {inventory && (
        <>
          {inventory.diagnostics.length > 0 && (
            <div className="space-y-2 rounded-xl border p-4" role="status">
              <h3 className="text-sm font-medium">
                Native configuration diagnostics
              </h3>
              {inventory.diagnostics.map((text, index) => (
                <p key={index} className="break-words text-xs">
                  {text}
                </p>
              ))}
            </div>
          )}
          <div className="space-y-3 rounded-xl border p-4">
            <h3 className="font-medium">Configured sources</h3>
            <p className="text-xs text-muted-foreground">
              Native order is lowest to highest priority. A source can
              contribute some fields even when a later layer overrides others.
            </p>
            {inventory.documents.map((item) => (
              <div
                key={item.source}
                className="min-w-0 space-y-2 border-t pt-3"
              >
                <p className="text-sm font-medium">
                  {item.scope === "global" ? "Global" : "Workspace"} ·{" "}
                  {item.trusted ? "Trusted" : "Trust blocked"} ·{" "}
                  {item.exists ? "Present" : "Not created"}
                </p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {item.label}
                </p>
                {item.diagnostics.map((text, index) => (
                  <p key={index} className="break-words text-sm">
                    {text}
                  </p>
                ))}
                {inventory.entries
                  .filter((entry) => entry.source === item.source)
                  .map((entry) => (
                    <div
                      key={entry.name}
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="break-all text-sm font-medium">
                          {entry.name}
                        </p>
                        <p className="text-xs">
                          Configured: {entry.state} ·{" "}
                          {entry.contributes
                            ? "Contributes to effective value"
                            : "Not effective"}
                        </p>
                        {entry.diagnostics.map((text, index) => (
                          <p key={index} className="break-words text-xs">
                            {text}
                          </p>
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className={buttonClass}
                        disabled={busy || !!draft || !item.writable}
                        onClick={() =>
                          void settings.begin(id, item.source, entry.name)
                        }
                      >
                        Edit {entry.name}
                      </Button>
                    </div>
                  ))}
              </div>
            ))}
            <div className="space-y-3 border-t pt-3">
              <h4 className="text-sm font-medium">
                Add or override a server in one source
              </h4>
              {draft && (
                <p className="text-xs text-muted-foreground">
                  Discard the current draft deliberately before opening another
                  editor.
                </p>
              )}
              <label htmlFor="mcp-source" className="block text-sm">
                Configuration source
              </label>
              <select
                id="mcp-source"
                value={selectedSource}
                disabled={busy || !!draft}
                onChange={(event) => setSource(event.target.value)}
                className="h-10 w-full min-w-0 rounded-lg border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {inventory.documents.map((item) => (
                  <option
                    key={item.source}
                    value={item.source}
                    disabled={!item.writable}
                  >
                    {item.scope} — {item.label}
                  </option>
                ))}
              </select>
              <label htmlFor="mcp-server-name" className="block text-sm">
                Server name
              </label>
              <Input
                ref={serverName}
                id="mcp-server-name"
                value={name}
                disabled={busy || !!draft}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
              <Button
                disabled={busy || !!draft || !name.trim() || !selectedSource}
                onClick={() => void settings.begin(id, selectedSource, name)}
              >
                Create draft
              </Button>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border p-4">
            <h3 className="font-medium">Effective configured values</h3>
            {!inventory.effective.length && (
              <p className="text-sm text-muted-foreground">
                No effective persistent MCP entries.
              </p>
            )}
            {inventory.effective.map((item) => (
              <div
                key={item.name}
                className="min-w-0 space-y-1 border-t pt-3 text-xs"
              >
                <p className="break-all font-medium">
                  {item.name}: {item.state}
                  {item.transport ? ` · ${item.transport}` : ""}
                </p>
                {item.field_origins.map((origin) => (
                  <p
                    key={origin.field}
                    className="break-all text-muted-foreground"
                  >
                    {origin.field} ←{" "}
                    {inventory.documents.find(
                      (source) => source.source === origin.source,
                    )?.label ?? origin.source}
                  </p>
                ))}
              </div>
            ))}
          </div>
          <McpAppliedState inventory={inventory} />
        </>
      )}
    </section>
  );
}
