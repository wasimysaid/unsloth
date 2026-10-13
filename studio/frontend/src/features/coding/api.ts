// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { authFetch } from "@/features/auth/api";
import { readFastApiError } from "@/lib/format-fastapi-error";
import { consumeCodingEvents } from "./events";
import type {
  CodingApi,
  CodingConversation,
  CodingProjectDirectory,
} from "./types";

async function codingRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await authFetch(`/api/coding${path}`, init, {
    // A transport failure may follow a committed native creation. Never replay it.
    retryNetworkErrors: false,
  });
  if (!response.ok) {
    throw new Error(await readFastApiError(response, "Coding request failed"));
  }
  return response;
}

export const codingApi: CodingApi = {
  async listConversations() {
    const conversations: CodingConversation[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    // Never present a native page as complete history. Bound a broken/unending
    // catalog and expose the limit explicitly instead of silently truncating.
    for (let page = 0; page < 100; page++) {
      const query =
        cursor === null ? "" : `?${new URLSearchParams({ cursor })}`;
      const response = await codingRequest(`/conversations${query}`);
      const data = (await response.json()) as {
        conversations: CodingConversation[];
        next_cursor: string | null;
      };
      conversations.push(...data.conversations);
      cursor = data.next_cursor;
      if (cursor === null) return conversations;
      if (typeof cursor !== "string" || cursor.length === 0)
        throw new Error(
          "The native conversation catalog returned an invalid page cursor.",
        );
      if (cursors.has(cursor))
        throw new Error(
          "The native conversation catalog repeated a page cursor. Refresh to try again.",
        );
      cursors.add(cursor);
    }
    throw new Error(
      "The native conversation catalog exceeded 100 pages. The full history could not be loaded.",
    );
  },
  async createConversation(cwd) {
    const response = await codingRequest("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    return (await response.json()) as CodingConversation;
  },
  async openConversation(id) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/open`,
      {
        method: "POST",
      },
    );
    return (await response.json()) as CodingConversation;
  },
  async browseProjects(path, signal) {
    const query = new URLSearchParams({ path });
    const response = await codingRequest(`/projects/browse?${query}`, {
      signal,
    });
    return (await response.json()) as CodingProjectDirectory;
  },
};

/** Consume the native view stream without building a browser-owned message history. */
export async function watchCodingConversation(
  id: string,
  signal: AbortSignal,
  onConnected: () => void,
): Promise<void> {
  const response = await codingRequest(
    `/conversations/${encodeURIComponent(id)}/events`,
    {
      signal,
      headers: { Accept: "text/event-stream" },
    },
  );
  if (!response.body)
    throw new Error("The native event stream is unavailable.");
  if (!signal.aborted) onConnected();
  // Opening is acknowledged by the native HTTP result. Disconnection is not
  // hidden by a continuing heartbeat; message projection belongs to a later slice.
  await consumeCodingEvents(response.body, signal);
}
