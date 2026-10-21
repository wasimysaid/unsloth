// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { CodingImage } from "../src/features/coding/input.ts";
import type {
  PendingImageStore,
  SubmissionStorage,
} from "../src/features/coding/pending-submission.ts";

export function memorySubmissionStorage(): SubmissionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** Durable image bytes for tests, shared by every run given the same instance
 * (a stand-in for IndexedDB surviving a reload; not proof of browser reload). */
export function memoryImageStorage(): PendingImageStore & {
  values: Map<string, { key: string; images: CodingImage[] }>;
} {
  const values = new Map<string, { key: string; images: CodingImage[] }>();
  return {
    values,
    async put(name, value) {
      values.set(name, structuredClone(value));
    },
    async get(name) {
      const value = values.get(name);
      return value ? structuredClone(value) : null;
    },
    async delete(name) {
      values.delete(name);
    },
  };
}
