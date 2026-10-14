// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export interface CodingRuntimeStatus {
  state:
    | "not_started"
    | "running"
    | "disconnected"
    | "restarting"
    | "maintenance_unconfirmed"
    | "restart_prepared"
    | "stopping"
    | "stopped"
    | "cleanup_failed";
  generation: number;
  cleanup: {
    confirmed: boolean;
    exit_code: number | null;
    forced: boolean;
    message: string;
  } | null;
}
export interface CodingRuntimeApi {
  readStatus(): Promise<CodingRuntimeStatus>;
  restart(): Promise<CodingRuntimeStatus>;
}

/** Maintenance never opens owners or submits prompts. Native admission decides safety. */
export function createRuntimeMaintenance(api: CodingRuntimeApi) {
  let state: {
    status: CodingRuntimeStatus | null;
    reading: boolean;
    restarting: boolean;
    error: string | null;
    statusError: string | null;
    notice: string | null;
    restartUncertainty: boolean;
  } = {
    status: null,
    reading: false,
    restarting: false,
    error: null,
    statusError: null,
    notice: null,
    restartUncertainty: false,
  };
  let revision = 0;
  let activeRestart: number | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const message = (reason: unknown) =>
    reason instanceof Error
      ? reason.message
      : "Runtime operation could not be confirmed.";
  async function refresh() {
    if (state.reading || (state.restarting && activeRestart === revision))
      return;
    const current = ++revision;
    update({ reading: true });
    try {
      const status = await api.readStatus();
      if (current === revision)
        update({
          status,
          restartUncertainty: status.state === "maintenance_unconfirmed",
          statusError: null,
          ...(state.restartUncertainty
            ? {
                notice:
                  "Fresh runtime status/generation inspected. No restart was replayed. Deliberately reopen saved conversations only when the runtime is running; accepted work is not continued automatically.",
              }
            : {}),
        });
    } catch (reason) {
      if (current === revision) update({ statusError: message(reason) });
    } finally {
      if (current === revision) update({ reading: false });
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
    refresh,
    invalidate() {
      // Epochs are opaque across backend replacements. Old cached/read/mutation
      // results must not reach a newly opened owner, irrespective of their number.
      ++revision;
      update({
        status: null,
        reading: false,
        statusError: null,
        notice: null,
        restartUncertainty: true,
      });
    },
    async restart() {
      if (
        state.restarting ||
        state.restartUncertainty ||
        state.status?.state === "restarting" ||
        state.status?.state === "maintenance_unconfirmed" ||
        state.status?.state === "stopping"
      )
        return;
      const current = ++revision; // A pre-restart status response cannot overwrite the result.
      activeRestart = current;
      update({ restarting: true, reading: false, error: null, notice: null });
      try {
        const status = await api.restart();
        if (current === revision)
          update({
            status,
            notice:
              status.state === "running"
                ? "Whole runtime restarted. Deliberately reopen saved conversations; no accepted work, answers or commands were replayed."
                : "Runtime restart has not confirmed a running replacement. Inspect runtime status and cleanup evidence before reopening.",
          });
      } catch (reason) {
        const refused =
          reason instanceof Error &&
          "admissionRejected" in reason &&
          reason.admissionRejected === true;
        if (current === revision)
          update({
            restartUncertainty: !refused,
            error: `${message(reason)} No restart was replayed. ${
              refused
                ? "If busy work was refused, explicitly Stop each affected conversation and wait for confirmed native cleanup before trying again."
                : "Restart is unconfirmed. Inspect fresh runtime status/generation before another action; refresh status if inspection fails."
            }`,
          });
      } finally {
        activeRestart = null;
        update({ restarting: false });
      }
      await refresh(); // Inspection only, never a retry of the mutation.
    },
  };
}
export type RuntimeMaintenance = ReturnType<typeof createRuntimeMaintenance>;
