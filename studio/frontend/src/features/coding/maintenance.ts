// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { CodingHttpError } from "./errors.ts";

/** Browser inspection only. Native owners retain inventories and reload operations. */
export interface PluginReloadStatus {
  operation_id: string;
  session_id: string;
  generation: number;
  status: "reconciling" | "deferred" | "applied" | "failed";
  changed: number;
  diagnostic_count: number;
  error: "reconcile-failed" | "session-closed" | null;
}

export interface ExtensionInventory {
  conversation_id: string;
  inventory: {
    session_id: string;
    frontend: "tui" | "headless";
    session_live_available: boolean;
    runtime_live_available: boolean;
    plugins: Array<{
      id: string;
      name: string;
      version: string;
      lifetime: "session" | "runtime";
      installed: boolean;
      selected: boolean;
      enabled: boolean;
      eligible: boolean;
      live: boolean;
      selected_frontend: boolean;
      mounted: boolean;
      pending: boolean;
      retained: boolean;
      load_failed: boolean;
      runtime_failed: boolean;
      missing_requirements: string[];
      mount_id: string | null;
    }>;
    omitted_plugins: number;
    diagnostics: {
      catalog: number;
      selection: number;
      load: number;
      runtime: number;
    };
    reload: PluginReloadStatus | null;
  };
  skills: Array<{
    name: string;
    bundled: boolean;
    source: "native" | "plugin";
  }>;
  omitted_skills: number;
}

export interface RuntimeDiagnostics {
  connection:
    | "not_started"
    | "connected"
    | "closing"
    | "disconnected"
    | "exited";
  frontend_plugin: string;
  protocol: number;
  pending_commands: number;
  open_views: number;
  command_timeout_seconds: number;
  max_frame_bytes: number;
}

export interface MaintenanceApi {
  inspect(id: string, operationId?: string): Promise<ExtensionInventory>;
  reload(id: string, operationId: string): Promise<PluginReloadStatus>;
}

export interface MaintenanceState {
  target: string | null;
  loading: boolean;
  submitting: boolean;
  inventory: ExtensionInventory | null;
  uncertainOperation: string | null;
  error:
    | "inventoryError"
    | "scopeError"
    | "unreconciledError"
    | "unconfirmedError"
    | "refusedError"
    | null;
}

export function createMaintenanceInspection(api: MaintenanceApi) {
  let state: MaintenanceState = {
    target: null,
    loading: false,
    submitting: false,
    inventory: null,
    uncertainOperation: null,
    error: null,
  };
  let revision = 0;
  // Transport correlation only, not a second inventory/execution owner. Retain
  // unresolved IDs across target/view navigation; absent native evidence is unknown.
  const pending = new Map<string, { id: string; acknowledged: boolean }>();
  const listeners = new Set<() => void>();
  const update = (next: Partial<MaintenanceState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const terminal = (reload: PluginReloadStatus) =>
    ["applied", "failed"].includes(reload.status);
  async function refresh() {
    const target = state.target;
    if (!target || state.loading || state.submitting) return;
    const current = revision;
    const correlation = pending.get(target);
    update({ loading: true, error: null });
    try {
      const inventory = await api.inspect(target, correlation?.id);
      if (current !== revision) return;
      const reload = inventory.inventory.reload;
      if (
        inventory.conversation_id !== target ||
        inventory.inventory.session_id !== target ||
        (reload && reload.session_id !== target)
      )
        throw new Error("Unexpected native target");
      const reconciled =
        !correlation || reload?.operation_id === correlation.id;
      if (reconciled && correlation && reload) {
        if (terminal(reload)) pending.delete(target);
        else correlation.acknowledged = true;
      }
      update({
        inventory,
        loading: false,
        uncertainOperation: reconciled ? null : (correlation?.id ?? null),
        error: reconciled ? null : "unreconciledError",
      });
    } catch (error) {
      if (current === revision)
        update({
          loading: false,
          error:
            error instanceof CodingHttpError && error.status === 404
              ? "scopeError"
              : "inventoryError",
        });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select(target: string | null) {
      if (target === state.target) return;
      revision++;
      const correlation = target ? pending.get(target) : undefined;
      update({
        target,
        loading: false,
        submitting: false,
        inventory: null,
        uncertainOperation:
          correlation && !correlation.acknowledged ? correlation.id : null,
        error: null,
      });
      void refresh();
    },
    refresh,
    async reload(operationId: string) {
      const target = state.target;
      if (
        !target ||
        state.loading ||
        state.submitting ||
        pending.has(target) ||
        !state.inventory ||
        state.error ||
        ["deferred", "reconciling"].includes(
          state.inventory.inventory.reload?.status ?? "",
        )
      )
        return;
      if (pending.size >= 32) {
        update({ error: "refusedError" });
        return;
      }
      const current = revision;
      const before = state.inventory;
      const correlation = { id: operationId, acknowledged: false };
      pending.set(target, correlation);
      update({
        submitting: true,
        error: null,
        uncertainOperation: operationId,
      });
      try {
        const reload = await api.reload(target, operationId);
        if (reload.operation_id !== operationId || reload.session_id !== target)
          throw new Error("Unexpected native operation");
        // A detached acknowledgment settles its original target, not the current
        // view. Do not resurrect a correlation already settled by an exact read.
        if (pending.get(target) === correlation) {
          if (terminal(reload)) pending.delete(target);
          else correlation.acknowledged = true;
        }
        if (current !== revision) return;
        update({
          submitting: false,
          uncertainOperation: null,
          inventory: { ...before, inventory: { ...before.inventory, reload } },
        });
        // A terminal acknowledgment is not an inventory refresh. Re-read plugin,
        // skill and diagnostic state; a failed read visibly marks the old view stale.
        await refresh();
      } catch (error) {
        const refused =
          error instanceof CodingHttpError && error.admissionRejected;
        if (refused && pending.get(target) === correlation)
          pending.delete(target);
        if (current === revision)
          update({
            submitting: false,
            uncertainOperation: refused ? null : operationId,
            error: refused ? "refusedError" : "unconfirmedError",
          });
      }
    },
  };
}
