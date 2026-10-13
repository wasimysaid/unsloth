// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export interface PendingSubmission {
  key: string;
  text: string;
}
export type SubmissionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
export const pendingSubmissionStorageKey = (id: string) =>
  `unsloth:coding:pending-submission:${encodeURIComponent(id)}`;

/** Only delivery metadata, never history. Storage failure must prevent HTTP send. */
export function pendingSubmissionStore(
  id: string,
  storage: () => SubmissionStorage = () => window.localStorage,
) {
  const name = pendingSubmissionStorageKey(id);
  return {
    load(): PendingSubmission | null {
      const raw = storage().getItem(name);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (
        value.version !== 1 ||
        value.conversation_id !== id ||
        typeof value.key !== "string" ||
        !value.key ||
        typeof value.text !== "string" ||
        !value.text.trim()
      )
        throw new Error(
          "Invalid saved submission identity; delivery cannot be safely retried.",
        );
      return { key: value.key, text: value.text };
    },
    save(pending: PendingSubmission) {
      const target = storage();
      const value = JSON.stringify({
        version: 1,
        conversation_id: id,
        ...pending,
      });
      target.setItem(name, value);
      if (target.getItem(name) !== value)
        throw new Error(
          "The pending submission identity could not be persisted.",
        );
    },
    clear(key: string) {
      // A late reply must never remove a newer submission's identity.
      if (this.load()?.key === key) {
        const target = storage();
        target.removeItem(name);
        if (target.getItem(name) !== null)
          throw new Error(
            "The reconciled submission identity could not be cleared.",
          );
      }
    },
  };
}
