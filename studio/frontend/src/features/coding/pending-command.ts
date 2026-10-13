// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { SubmissionStorage } from "./pending-submission.ts";

export interface PendingCommand {
  operation_id: string;
  name: string;
}
export const pendingCommandStorageKey = (id: string) =>
  `unsloth:coding:pending-command:${encodeURIComponent(id)}`;

/** Receipt lookup identity only. Never persist arguments or replay command delivery. */
export function pendingCommandStore(
  id: string,
  storage: () => SubmissionStorage = () => window.localStorage,
) {
  const key = pendingCommandStorageKey(id);
  return {
    load(): PendingCommand | null {
      const raw = storage().getItem(key);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (
        value.version !== 1 ||
        value.conversation_id !== id ||
        typeof value.operation_id !== "string" ||
        !value.operation_id ||
        value.operation_id.length > 128 ||
        typeof value.name !== "string" ||
        !value.name ||
        value.name.length > 256
      )
        throw new Error(
          "Invalid saved command identity. Inspect native effects before another action; no command was replayed.",
        );
      return { operation_id: value.operation_id, name: value.name };
    },
    save(pending: PendingCommand) {
      const target = storage();
      const value = JSON.stringify({
        version: 1,
        conversation_id: id,
        ...pending,
      });
      target.setItem(key, value);
      if (target.getItem(key) !== value)
        throw new Error(
          "Command delivery identity could not be persisted. No command was sent.",
        );
    },
    clear(operation: string) {
      if (this.load()?.operation_id !== operation) return;
      const target = storage();
      target.removeItem(key);
      if (target.getItem(key) !== null)
        throw new Error(
          "Confirmed command delivery identity could not be cleared. Restore browser storage before another action.",
        );
    },
  };
}
