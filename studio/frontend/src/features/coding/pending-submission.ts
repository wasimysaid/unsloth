// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { CodingImage, CodingInput } from "./input.ts";

/** Digest of one exact image payload, so a retry can prove it resends the original. */
export interface ImageManifestEntry {
  mime_type: string;
  length: number;
  sha256: string;
}
export interface PendingSubmission extends CodingInput {
  key: string;
  /** Present when the original image bytes live in the image store, not here. */
  image_manifest?: ImageManifestEntry[];
}
export type SubmissionStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
/** Durable bytes for one conversation's single pending submission. */
export interface PendingImageStore {
  put(
    name: string,
    value: { key: string; images: CodingImage[] },
  ): Promise<void>;
  get(name: string): Promise<{ key: string; images: CodingImage[] } | null>;
  delete(name: string): Promise<void>;
}
export const pendingSubmissionStorageKey = (id: string) =>
  `unsloth:coding:pending-submission:${encodeURIComponent(id)}`;

/** Image bytes could not be made durable: only this image submission is refused. */
export class PendingImageStorageError extends Error {}

// Bytes that would not survive a reload cannot back a retryable delivery.
const unavailable = async (): Promise<never> => {
  throw new Error("IndexedDB is not available in this browser.");
};
const unavailableImageStore: PendingImageStore = {
  put: unavailable,
  get: unavailable,
  delete: async () => {},
};

function indexedDbImageStore(): PendingImageStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("unsloth-coding-pending-images", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("submissions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  async function transact<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ) {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("submissions", mode);
        const request = operation(transaction.objectStore("submissions"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }
  return {
    async put(name, value) {
      await transact("readwrite", (store) => store.put(value, name));
    },
    async get(name) {
      const value = (await transact("readonly", (store) => store.get(name))) as
        | { key: string; images: CodingImage[] }
        | undefined;
      return value && Array.isArray(value.images) ? value : null;
    },
    async delete(name) {
      await transact("readwrite", (store) => store.delete(name));
    },
  };
}
export const defaultPendingImageStore = (): PendingImageStore =>
  typeof indexedDB === "undefined"
    ? unavailableImageStore
    : indexedDbImageStore();

export async function imageManifest(
  images: readonly CodingImage[],
): Promise<ImageManifestEntry[]> {
  return await Promise.all(
    images.map(async (image) => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(image.data),
      );
      return {
        mime_type: image.mime_type,
        length: image.data.length,
        sha256: Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
    }),
  );
}
/** The exact text and mention identities of a pending submission, no bytes. */
export const pendingInput = ({
  text,
  skill_mentions,
  subagent_mentions,
  file_mentions,
}: PendingSubmission | CodingInput): CodingInput => ({
  text,
  ...(skill_mentions ? { skill_mentions } : {}),
  ...(subagent_mentions ? { subagent_mentions } : {}),
  ...(file_mentions ? { file_mentions } : {}),
});
export const pendingImageCount = (pending: PendingSubmission | CodingInput) =>
  pending.images?.length ??
  ("image_manifest" in pending ? (pending.image_manifest?.length ?? 0) : 0);

/** Only delivery metadata, never history. Storage failure must prevent HTTP send.
 * The small record (text, exact mention identities, image digests) is written
 * and read back synchronously; image bytes are written first to the image store. */
export function pendingSubmissionStore(
  id: string,
  storage: () => SubmissionStorage = () => window.localStorage,
  images: () => PendingImageStore = defaultPendingImageStore,
) {
  const name = pendingSubmissionStorageKey(id);
  return {
    load(): PendingSubmission | null {
      const raw = storage().getItem(name);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (
        value.version !== 2 ||
        value.conversation_id !== id ||
        typeof value.key !== "string" ||
        !value.key ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        (value.skill_mentions !== undefined &&
          !Array.isArray(value.skill_mentions)) ||
        (value.subagent_mentions !== undefined &&
          !Array.isArray(value.subagent_mentions)) ||
        (value.file_mentions !== undefined &&
          !Array.isArray(value.file_mentions)) ||
        (value.image_manifest !== undefined &&
          !Array.isArray(value.image_manifest))
      )
        throw new Error(
          "Invalid saved submission identity; delivery cannot be safely retried.",
        );
      return {
        key: value.key,
        text: value.text,
        ...(value.skill_mentions !== undefined
          ? { skill_mentions: value.skill_mentions }
          : {}),
        ...(value.subagent_mentions !== undefined
          ? { subagent_mentions: value.subagent_mentions }
          : {}),
        ...(value.file_mentions !== undefined
          ? { file_mentions: value.file_mentions }
          : {}),
        ...(value.image_manifest !== undefined
          ? { image_manifest: value.image_manifest }
          : {}),
      };
    },
    async save(pending: PendingSubmission) {
      const bytes = pending.images;
      const record = { key: pending.key, ...pendingInput(pending) };
      let manifest: ImageManifestEntry[] | undefined;
      if (bytes?.length) {
        manifest = await imageManifest(bytes);
        try {
          await images().put(name, { key: pending.key, images: bytes });
        } catch {
          throw new PendingImageStorageError(
            "Durable image storage is unavailable in this browser, so images cannot be sent safely.",
          );
        }
      }
      const target = storage();
      const value = JSON.stringify({
        version: 2,
        conversation_id: id,
        ...record,
        ...(manifest ? { image_manifest: manifest } : {}),
      });
      target.setItem(name, value);
      if (target.getItem(name) !== value)
        throw new Error(
          "The pending submission identity could not be persisted.",
        );
    },
    /** The exact original images, or a refusal: never a different payload.
     * A submission still held in memory carries its bytes directly. */
    async images(
      pending: PendingSubmission,
    ): Promise<CodingImage[] | undefined> {
      if (pending.images) return pending.images;
      if (!pending.image_manifest?.length) return undefined;
      const stored = await images()
        .get(name)
        .catch(() => null);
      const verified =
        stored?.key === pending.key &&
        JSON.stringify(await imageManifest(stored.images)) ===
          JSON.stringify(pending.image_manifest);
      if (!stored || !verified)
        throw new Error(
          "The original images for this unconfirmed submission are unavailable in this browser. It was not retried with different content.",
        );
      return stored.images;
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
        void images()
          .delete(name)
          .catch(() => undefined);
      }
    },
  };
}
