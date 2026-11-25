// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { PermissionMode } from "../chat/stores/chat-runtime-store";
import type { RunApi } from "./run-types.ts";

export const isTerminalPermissionCommand = (name: string) =>
  name === "terminal-permissions" || name === "studio.sandbox-terminal:terminal-permissions";

export type TerminalPermissions =
  | { kind: "unavailable" }
  | { kind: "ready"; mode: PermissionMode }
  | { kind: "changing"; previous: PermissionMode }
  | { kind: "unknown" };

type PermissionApi = Pick<RunApi, "terminalPermissions">;

async function terminalMode(id: string, api: PermissionApi, mode?: PermissionMode) {
  if (!api.terminalPermissions) return null;
  const reply = await api.terminalPermissions(id, mode);
  if (reply.conversation_id !== id) throw new Error("Mimir returned permissions for a different conversation.");
  switch (reply.mode) {
    case "ask":
    case "auto":
    case "off":
    case "full":
    case null:
      return reply.mode;
    default:
      throw new Error("Mimir returned an unknown terminal permission level.");
  }
}

export async function setTerminalPermissionMode(id: string, api: PermissionApi, mode: PermissionMode) {
  const confirmed = await terminalMode(id, api, mode);
  if (confirmed === null) throw new Error("The Studio terminal plugin is unavailable.");
  if (confirmed !== mode) throw new Error("The terminal permission change did not take effect.");
}

export function createTerminalPermissions(
  id: string,
  api: PermissionApi,
  publish: (value: TerminalPermissions) => void,
) {
  let revision = 0;
  let pendingRead: Promise<void> | null = null;
  let state: TerminalPermissions = { kind: "unavailable" };
  const set = (next: TerminalPermissions) => {
    state = next;
    publish(next);
  };
  function refresh() {
    if (state.kind === "changing") return;
    if (pendingRead) return pendingRead;
    const current = revision;
    pendingRead = terminalMode(id, api).then((mode) => {
      if (current !== revision) return;
      if (mode === null) {
        if (state.kind !== "unavailable") set({ kind: "unavailable" });
      } else if (state.kind !== "ready" || state.mode !== mode) {
        set({ kind: "ready", mode });
      }
    }).catch(() => {
      if (current === revision && state.kind !== "unavailable") set({ kind: "unknown" });
    }).finally(() => {
      if (current === revision) pendingRead = null;
    });
    return pendingRead;
  }
  return {
    refresh,
    async verifyBeforeSend() {
      if (state.kind !== "ready") return;
      const displayed = state.mode;
      await refresh();
      if (state.kind !== "ready") throw new Error("Check terminal permissions before sending.");
      if (state.mode !== displayed)
        throw new Error("Terminal permissions changed in another view. Review the level and send again.");
    },
    async change(mode: PermissionMode) {
      if (state.kind !== "ready" || state.mode === mode) return;
      const current = ++revision;
      pendingRead = null;
      set({ kind: "changing", previous: state.mode });
      try {
        await setTerminalPermissionMode(id, api, mode);
        if (current === revision) set({ kind: "ready", mode });
      } catch (error) {
        if (current !== revision) return;
        set({ kind: "unknown" });
        // The command could already have applied. Read without granting again.
        await refresh();
        throw error;
      }
    },
  };
}
