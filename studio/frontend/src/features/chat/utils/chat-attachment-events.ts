// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { sha256Hex } from "../../../lib/sha256.ts";

/** Notifies runtimes of Data tab deletions; otherwise a later sync writes the attachment back. */

export type ChatAttachmentDeletedEvent = {
  messageId: string;
  attachmentId: string;
};

const CONTENT_PART_ID_PREFIX = "content-part-sha256-";
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isLocallyStoredBlob(value: string): boolean {
  const candidate = value.trimStart();
  if (!candidate) return false;
  if (candidate.slice(0, 5).toLowerCase() === "data:") return true;
  if (candidate.startsWith("//") || candidate.startsWith("\\\\")) {
    return false;
  }
  return !URI_SCHEME_RE.test(candidate);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : stableJson(item)))
      .join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function chatContentPartAttachmentSignature(
  part: unknown,
): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  let payload: ["image" | "audio", unknown] | null = null;
  if (
    typeof record.image === "string" &&
    record.image.slice(0, 5).toLowerCase() === "data:"
  ) {
    payload = ["image", record.image];
  } else if (
    typeof record.audio === "string" &&
    isLocallyStoredBlob(record.audio)
  ) {
    payload = ["audio", record.audio];
  } else if (record.audio && typeof record.audio === "object") {
    const data = (record.audio as Record<string, unknown>).data;
    if (typeof data === "string" && isLocallyStoredBlob(data)) {
      payload = ["audio", record.audio];
    }
  }
  if (!payload) return null;

  return stableJson(payload);
}

/** Mirrors the backend's stable content-part identity. */
export async function chatContentPartAttachmentIdFromSignature(
  signature: string,
): Promise<string> {
  return `${CONTENT_PART_ID_PREFIX}${await sha256Hex(signature)}`;
}

/** Call before deleting: loads the hasher an open chat needs to drop this id, so a failed chunk load aborts the delete. */
export async function prepareChatAttachmentDeletion(
  attachmentId: string,
): Promise<void> {
  if (!attachmentId.startsWith(CONTENT_PART_ID_PREFIX)) return;
  await chatContentPartAttachmentIdFromSignature("");
}

type Listener = (event: ChatAttachmentDeletedEvent) => void | Promise<void>;

const listeners = new Set<Listener>();

export function onChatAttachmentDeleted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitChatAttachmentDeleted(
  event: ChatAttachmentDeletedEvent,
): void {
  for (const listener of [...listeners]) {
    void listener(event);
  }
}
