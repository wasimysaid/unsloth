// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { authFetch } from "@/features/auth/api";
import { readFastApiError } from "@/lib/format-fastapi-error";
import { CodingHttpError, CodingOverlapError, projectOverlap } from "./errors";
import { consumeCodingEvents } from "./events";
import type { CodingRuntimeApi } from "./runtime-maintenance";
import type {
  CodingModelApi,
  CodingProviderChoice,
} from "./model-selection";
import type { EntryPage, RunApi } from "./run-types";
import type {
  CodingApi,
  CodingConversation,
  CodingProjectDirectory,
} from "./types";

async function codingRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await authFetch(`/api/coding${path}`, init, {
      // A transport failure may follow a committed native creation. Never replay it.
      retryNetworkErrors: false,
    });
  } catch (reason) {
    if (
      reason instanceof Error &&
      "unslothTransportFailure" in reason &&
      reason.unslothTransportFailure === true
    )
      throw new Error(
        "Coding response unconfirmed; work may still be running. Reconnect or inspect native history before another action. No coding request was replayed.",
        { cause: reason },
      );
    // Aborts and account/authentication policy errors retain their own identity.
    throw reason;
  }
  if (!response.ok) {
    // The host guard closes the preflight race without submitting native work.
    if (response.status === 409) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      const overlap = projectOverlap(body?.detail?.overlap);
      if (
        body?.detail?.code === "overlap_required" &&
        overlap &&
        overlap.conversations.length
      )
        throw new CodingOverlapError(overlap);
    }
    throw new CodingHttpError(
      response.status,
      await readFastApiError(response, "Coding request failed"),
      response.headers.get("X-Mimir-Requires-Reopen") === "true",
    );
  }
  return response;
}

function openedConversation(info: CodingConversation): CodingConversation {
  if (
    typeof info.runtime_generation !== "number" ||
    !Number.isSafeInteger(info.runtime_generation) ||
    info.runtime_generation < 1
  )
    throw new Error(
      "Native opening did not confirm its runtime generation. Inspect shared native history, then deliberately reopen the saved conversation; no owner operation can use an inferred generation.",
    );
  return info;
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
  async createConversation(cwd, configuration) {
    const response = await codingRequest("/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configuration ? { cwd, configuration } : { cwd }),
    });
    return openedConversation((await response.json()) as CodingConversation);
  },
  async openConversation(id, signal) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/open`,
      { method: "POST", signal },
    );
    return openedConversation((await response.json()) as CodingConversation);
  },
  async browseProjects(path, signal) {
    const query = new URLSearchParams({ path });
    const response = await codingRequest(`/projects/browse?${query}`, {
      signal,
    });
    return (await response.json()) as CodingProjectDirectory;
  },
};

export const codingRuntimeApi: CodingRuntimeApi = {
  async readStatus() {
    return await (await codingRequest("/runtime")).json();
  },
  async restart() {
    return await (
      await codingRequest("/runtime/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all_hosted_conversations" }),
      })
    ).json();
  },
};

/** Model choices before a conversation exists: the folder's effective settings,
 * or the host home's when no folder is chosen yet. */
export async function readCodingCatalog(
  cwd: string | null,
  signal: AbortSignal,
): Promise<CodingProviderChoice[]> {
  const query = cwd ? `?${new URLSearchParams({ cwd })}` : "";
  const response = await codingRequest(`/catalog${query}`, {
    signal,
    cache: "no-store",
  });
  return await response.json();
}

export const codingModelApi: CodingModelApi = {
  async catalog(id, signal) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/models`,
      { signal, cache: "no-store" },
    );
    return await response.json();
  },
  async refresh(id, signal) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/models/refresh`,
      { method: "POST", signal, cache: "no-store" },
    );
    return await response.json();
  },
};

export async function discoverCodingSkills(id: string, signal?: AbortSignal) {
  const response = await codingRequest(
    `/conversations/${encodeURIComponent(id)}/skills`,
    { signal },
  );
  return (await response.json()) as { skills: import("./input").CodingSkill[] };
}

/** Bounded host search over project paths; never file contents. */
export async function discoverCodingFiles(
  id: string,
  query: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ query, max_results: "40" });
  const response = await codingRequest(
    `/conversations/${encodeURIComponent(id)}/files?${params}`,
    { signal },
  );
  return (await response.json()) as {
    files: import("./input").CodingFile[];
    truncated: boolean;
  };
}

/** Effective native subagent identities for this open controller; metadata only. */
export async function discoverCodingSubagents(
  id: string,
  signal?: AbortSignal,
) {
  const response = await codingRequest(
    `/conversations/${encodeURIComponent(id)}/subagents`,
    { signal },
  );
  return (await response.json()) as {
    subagents: import("./input").CodingSubagent[];
  };
}

/** Owner execution and views retain the generation confirmed by create/open. */
export function createCodingRunApi(openingGeneration: number): RunApi {
  if (!Number.isSafeInteger(openingGeneration) || openingGeneration < 1)
    throw new Error("A confirmed runtime generation from create/open is required. Deliberately reopen the saved conversation.");
  const generationHeaders = { "X-Mimir-Runtime-Generation": String(openingGeneration) };
  return {
  async changeGoal(id, change) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/goal`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(change),
      },
    );
    return await response.json();
  },
  async setMode(id, mode) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/mode`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    return await response.json();
  },
  async answer(id, target, answers) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/requests/${encodeURIComponent(target.request_id)}/questions/${encodeURIComponent(target.user_request_id)}/answers`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: target.subscription, answers }),
      },
    );
    return await response.json();
  },
  async commands(id) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/commands`,
    );
    return await response.json();
  },
  async commandReceipt(id, operationId) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/commands/${encodeURIComponent(operationId)}`,
    );
    return await response.json();
  },
  async command(id, name, tail, operationId) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/commands`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name, tail, operation_id: operationId }),
      },
    );
    return await response.json();
  },
  async decidePlan(id, plan, decision) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/plan-actions`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: plan.id,
          revision: plan.revision,
          decision,
        }),
      },
    );
    return await response.json();
  },
  async configure(id, change) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/configuration`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(change),
      },
    );
    return await response.json();
  },
  async checkOverlap(id) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/overlap`,
    );
    const overlap = projectOverlap(await response.json());
    if (!overlap)
      throw new Error(
        "The native project overlap check could not be confirmed. No prompt was sent.",
      );
    return overlap;
  },
  async readChild(id, handle, attempt, signal) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/children/${encodeURIComponent(handle)}/attempts/${attempt}`,
      { signal },
    );
    return await response.json();
  },
  async submit(id, submissionKey, text, extras, overlapConfirmed = false) {
    const response = await codingRequest(
      `/conversations/${encodeURIComponent(id)}/prompts`,
      {
        method: "POST",
        headers: { ...generationHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          submission_key: submissionKey,
          text,
          ...extras,
          ...(overlapConfirmed ? { overlap_confirmed: true } : {}),
        }),
      },
    );
    return await response.json();
  },
    async cancel(id, requestId) {
      const response = await codingRequest(
        `/conversations/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}/cancel`,
        { method: "POST", headers: { ...generationHeaders } },
      );
      return await response.json();
    },
    async readPublicEntry(id, reference, signal) {
      const response = await codingRequest(
        `/conversations/${encodeURIComponent(id)}/public-entry`,
        {
          method: "POST",
          headers: { ...generationHeaders, "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            cut: reference.cut,
            entry_id: reference.entry_id,
          }),
        },
      );
      return await response.json();
    },
    async readEntries(id, cut, anchor, signal) {
      const response = await codingRequest(
        `/conversations/${encodeURIComponent(id)}/entries`,
        {
          method: "POST",
          headers: { ...generationHeaders, "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            cut,
            anchor,
            max_entries: 100,
            max_bytes: 262144,
          }),
        },
      );
      return (await response.json()) as EntryPage;
    },
    async watch(id, signal, onConnected, onView) {
      const response = await codingRequest(
        `/conversations/${encodeURIComponent(id)}/events`,
        {
          signal,
          headers: { ...generationHeaders, Accept: "text/event-stream" },
        },
      );
      if (!response.body)
        throw new Error("The native event stream is unavailable.");
      if (!signal.aborted) onConnected();
      await consumeCodingEvents(response.body, signal, onView);
    },
  };
}
