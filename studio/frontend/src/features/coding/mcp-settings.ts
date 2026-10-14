// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { CodingHttpError } from "./errors.ts";
import type {
  McpDraft,
  McpInventory,
  McpOperation,
  McpSettingsApi,
} from "./mcp-types.ts";

interface McpCorrelation {
  id: string;
  kind: McpOperation["kind"];
  name: string | null;
}

export interface McpSettingsState {
  inventory: McpInventory | null;
  draft: McpDraft | null;
  text: string;
  latest: McpDraft | null;
  operation:
    | "refresh"
    | "edit"
    | "save"
    | "compare"
    | "apply"
    | "reconnect"
    | null;
  observing: boolean;
  runtimeOperation: McpOperation | null;
  pendingMcp: McpCorrelation | null;
  runtimeError: string | null;
  recoveryBlocked: boolean;
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
  observing: false,
  runtimeOperation: null,
  pendingMcp: null,
  runtimeError: null,
  recoveryBlocked: false,
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
export function createMcpSettings(
  api: McpSettingsApi,
  storage: () => Pick<
    Storage,
    "getItem" | "setItem" | "removeItem"
  > | null = () =>
    typeof window === "undefined" ? null : window.sessionStorage,
) {
  const forms = new Map<string, McpSettingsState>();
  const listeners = new Set<() => void>();
  // Delivery identity belongs to the submitting tab. sessionStorage survives its
  // reload without another tab overwriting/clearing an unresolved operation.
  // Native safe-idle admission, not browser storage, orders separate tab commands.
  const storageKey = (id: string) =>
    `unsloth:coding:pending-mcp:${encodeURIComponent(id)}`;
  function snapshot(id: string) {
    if (!forms.has(id)) {
      const initial = emptyState();
      try {
        const raw = storage()?.getItem(storageKey(id));
        if (raw !== null && raw !== undefined) {
          const value = JSON.parse(raw);
          if (
            value.version !== 1 ||
            value.conversation_id !== id ||
            typeof value.id !== "string" ||
            !value.id ||
            value.id.length > 128 ||
            !["apply", "reconnect"].includes(value.kind) ||
            (value.name !== null &&
              (typeof value.name !== "string" ||
                !value.name ||
                value.name.length > 256)) ||
            (value.kind === "apply" && value.name !== null)
          )
            throw new Error("Invalid saved MCP delivery identity");
          initial.pendingMcp = {
            id: value.id,
            kind: value.kind,
            name: value.name,
          };
          initial.runtimeError =
            "MCP operation unconfirmed after reopening. Reconcile the retained native identity before another apply or reconnect.";
        }
      } catch {
        initial.recoveryBlocked = true;
        initial.runtimeError =
          "Saved MCP delivery identity cannot be read. Restore browser storage and reload, then inspect native state before another operation. No command was replayed.";
      }
      forms.set(id, initial);
    }
    return forms.get(id)!;
  }
  function persist(id: string, correlation: McpCorrelation | null) {
    const target = storage();
    if (!target) return; // Non-browser callers may deliberately use in-memory correlation.
    const key = storageKey(id);
    if (correlation) {
      const existing = target.getItem(key);
      if (existing && JSON.parse(existing).id !== correlation.id)
        throw new Error(
          "Another MCP operation needs reconciliation in this conversation. Reload to inspect its identity.",
        );
      const value = JSON.stringify({
        version: 1,
        conversation_id: id,
        ...correlation,
      });
      target.setItem(key, value);
      if (target.getItem(key) !== value)
        throw new Error(
          "MCP delivery identity could not be saved; no command was sent.",
        );
    } else {
      target.removeItem(key);
      if (target.getItem(key) !== null)
        throw new Error(
          "Confirmed MCP delivery identity could not be cleared. Restore browser storage before another operation.",
        );
    }
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
  function clearCorrelation(id: string, correlation: McpCorrelation) {
    try {
      const existing = storage()?.getItem(storageKey(id));
      if (existing && JSON.parse(existing).id !== correlation.id)
        throw new Error(
          "Another MCP delivery identity is retained. Reload and reconcile it before another operation.",
        );
      persist(id, null);
    } catch (reason) {
      update(id, { recoveryBlocked: true, runtimeError: errorText(reason) });
    }
  }
  function confirm(
    id: string,
    correlation: McpCorrelation,
    result: McpOperation,
  ) {
    if (
      result.operation_id !== correlation.id ||
      result.session_id !== id ||
      result.kind !== correlation.kind ||
      result.name !== correlation.name ||
      !["running", "completed", "failed"].includes(result.status)
    )
      throw new Error(
        "MCP response did not identify the requested native operation. Reconcile before retrying.",
      );
    update(id, {
      runtimeOperation: result,
      pendingMcp: result.status === "running" ? correlation : null,
      runtimeError:
        result.status === "failed"
          ? (result.error ??
            "Native MCP operation failed; inspect applied connections before retrying.")
          : null,
    });
    if (result.status !== "running") clearCorrelation(id, correlation);
  }
  async function inspect(
    id: string,
    correlation: McpCorrelation,
    publishInventory: () => boolean = () => true,
  ) {
    const result = await api.inspectOperation(id, correlation.id);
    // A newer explicit read/action may have settled or replaced this correlation.
    if (snapshot(id).pendingMcp?.id !== correlation.id) return;
    // An inventory is not evidence that this operation was admitted or settled.
    if (result.operation) confirm(id, correlation, result.operation);
    else
      update(id, {
        runtimeError:
          "MCP operation unconfirmed — native status is not retained or not yet known. No command was replayed. Reconcile before another apply or reconnect.",
      });
    if (publishInventory())
      update(id, { inventory: result.inventory, inventoryError: null });
  }
  async function readInventory(id: string) {
    try {
      update(id, { inventory: await api.inventory(id), inventoryError: null });
    } catch (reason) {
      update(id, { inventory: null, inventoryError: errorText(reason) });
    }
  }
  async function runtimeAction(
    id: string,
    kind: McpOperation["kind"],
    operationId: string,
    name: string | null,
  ) {
    if (
      snapshot(id).operation ||
      snapshot(id).pendingMcp ||
      snapshot(id).recoveryBlocked
    )
      return;
    const correlation = { id: operationId, kind, name };
    try {
      persist(id, correlation);
    } catch (reason) {
      update(id, {
        recoveryBlocked: true,
        runtimeError: `MCP delivery identity could not be saved. No command was sent. Restore browser storage and reload. ${errorText(reason)}`,
      });
      return;
    }
    // Only delivery identity is persisted: no definition, draft or configuration
    // mirror. Never erase it merely because navigation or transport interrupted.
    update(id, {
      operation: kind,
      pendingMcp: correlation,
      runtimeOperation: null,
      runtimeError: null,
      error: null,
    });
    try {
      const result =
        kind === "apply"
          ? await api.apply(id, operationId)
          : await api.reconnect(id, operationId, name ?? undefined);
      confirm(id, correlation, result);
      await readInventory(id);
    } catch (reason) {
      if (
        reason instanceof CodingHttpError &&
        [400, 401, 403, 404, 409, 422, 429].includes(reason.status)
      ) {
        // These are explicit validation/admission refusals, not lost outcomes.
        update(id, { pendingMcp: null, runtimeError: errorText(reason) });
        clearCorrelation(id, correlation);
        await readInventory(id);
      } else {
        update(id, {
          runtimeError: `MCP operation unconfirmed. ${errorText(reason)} No command was replayed.`,
        });
        try {
          await inspect(id, correlation);
        } catch {
          /* Keep exact correlation and unknown state until a successful native read. */
        }
      }
    } finally {
      update(id, { operation: null });
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
    apply(id: string, operationId: string) {
      return runtimeAction(id, "apply", operationId, null);
    },
    reconnect(id: string, operationId: string, name?: string) {
      return runtimeAction(id, "reconnect", operationId, name ?? null);
    },
    async inspectOperation(id: string) {
      const state = snapshot(id);
      const pending = state.pendingMcp;
      if (!pending || state.observing || state.operation) return;
      // Background reads have no editor admission or error ownership. A poll
      // must not disable typing, steal focus or erase a conflict/validation error.
      const currentRead = () =>
        !snapshot(id).operation &&
        snapshot(id).inventory === state.inventory &&
        snapshot(id).draft?.revision === state.draft?.revision;
      update(id, { observing: true });
      try {
        await inspect(id, pending, currentRead);
      } catch (reason) {
        if (currentRead()) update(id, { inventoryError: errorText(reason) });
      } finally {
        update(id, { observing: false });
      }
    },
    refresh(id: string) {
      return perform(id, "refresh", async () => {
        const pending = snapshot(id).pendingMcp;
        if (pending) await inspect(id, pending);
        else
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
