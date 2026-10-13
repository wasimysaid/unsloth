// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { McpDraft, McpInventory, McpSettingsApi } from "./mcp-types.ts";

export interface McpSettingsState {
  inventory: McpInventory | null;
  draft: McpDraft | null;
  text: string;
  latest: McpDraft | null;
  operation: "refresh" | "edit" | "save" | "compare" | null;
  error: string | null;
  savedRevision: string | null;
  savedConfiguredState: string | null;
  inventoryError: string | null;
}
const emptyState = (): McpSettingsState => ({
  inventory: null,
  draft: null,
  text: "",
  latest: null,
  operation: null,
  error: null,
  savedRevision: null,
  savedConfiguredState: null,
  inventoryError: null,
});
const errorText = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Mimir could not confirm this operation. Your draft is retained.";

/** In-memory forms only, keyed by native conversation. No persisted configuration mirror.
 * A refresh never rebases an edit. Only explicit reconciliation can change its revision.
 */
export function createMcpSettings(api: McpSettingsApi) {
  const forms = new Map<string, McpSettingsState>();
  const listeners = new Set<() => void>();
  function snapshot(id: string) {
    if (!forms.has(id)) forms.set(id, emptyState());
    return forms.get(id)!;
  }
  function update(id: string, patch: Partial<McpSettingsState>) {
    forms.set(id, { ...snapshot(id), ...patch });
    for (const listener of listeners) listener();
  }
  async function perform(
    id: string,
    operation: NonNullable<McpSettingsState["operation"]>,
    work: () => Promise<void>,
  ) {
    if (snapshot(id).operation) return;
    update(id, { operation, error: null });
    try {
      await work();
    } catch (reason) {
      update(id, { error: errorText(reason) });
    } finally {
      update(id, { operation: null });
    }
  }
  async function release(id: string, editId: string) {
    // Edit handles do not own conversations or connections. Cleanup cannot change
    // a confirmed save into a failed save, nor discard the retained form on errors.
    // Process/activation shutdown also drops these resources after disconnect.
    try {
      await api.release(id, editId);
    } catch {
      /* No persistence/apply action to replay. */
    }
  }
  return {
    getSnapshot: snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(id: string) {
      return perform(id, "refresh", async () => {
        update(id, {
          inventory: await api.inventory(id),
          inventoryError: null,
        });
      });
    },
    begin(id: string, source: string, name: string) {
      // Even a clean draft is replaced only by a deliberate discard. No row click
      // or source selector can silently destroy a user's form.
      if (snapshot(id).draft) return Promise.resolve();
      return perform(id, "edit", async () => {
        const draft = await api.edit(id, source, name);
        update(id, {
          draft,
          text: draft.json,
          latest: null,
          savedRevision: null,
          savedConfiguredState: null,
        });
      });
    },
    change(id: string, text: string) {
      if (!snapshot(id).operation) update(id, { text });
    },
    save(id: string) {
      const state = snapshot(id);
      if (!state.draft) return Promise.resolve();
      const draft = state.draft;
      const text = state.text;
      return perform(id, "save", async () => {
        const result = await api.save(id, draft, text);
        const latest = snapshot(id).latest;
        update(id, {
          draft: result.draft,
          text: result.draft.json,
          inventory: result.inventory,
          inventoryError: result.inventory_error,
          savedRevision: result.draft.revision,
          savedConfiguredState: result.configured_state,
          latest: null,
        });
        if (latest) await release(id, latest.edit_id);
        if (draft.edit_id !== result.draft.edit_id)
          await release(id, draft.edit_id);
      });
    },
    compare(id: string) {
      const draft = snapshot(id).draft;
      if (!draft) return Promise.resolve();
      return perform(id, "compare", async () => {
        const latest = await api.edit(id, draft.source, draft.name);
        const previous = snapshot(id).latest;
        update(id, { latest });
        if (previous) await release(id, previous.edit_id);
      });
    },
    async reconcile(id: string, replaceText: boolean) {
      const state = snapshot(id);
      if (!state.latest || state.operation) return;
      update(id, {
        draft: state.latest,
        text: replaceText ? state.latest.json : state.text,
        latest: null,
        error: null,
        savedRevision: null,
        savedConfiguredState: null,
      });
      if (state.draft) await release(id, state.draft.edit_id);
    },
    async discard(id: string) {
      const state = snapshot(id);
      if (state.operation) return;
      update(id, {
        draft: null,
        text: "",
        latest: null,
        error: null,
        savedRevision: null,
        savedConfiguredState: null,
      });
      if (state.draft) await release(id, state.draft.edit_id);
      if (state.latest) await release(id, state.latest.edit_id);
    },
  };
}
export type McpSettings = ReturnType<typeof createMcpSettings>;
