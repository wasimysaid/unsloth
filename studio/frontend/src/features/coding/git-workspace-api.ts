// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { createCodingRunApi } from "./api";
import { createGitWorkspaceClient } from "./git-workspace-client";
import { codingSession } from "./shared-session";
import type { CodingConversation } from "./types";

export type {
  GitChanges,
  GitComment,
  GitComparison,
  GitFile,
  GitPatch,
  GitWorkspace,
} from "./git-workspace-client";

const clients = new WeakMap<
  CodingConversation,
  ReturnType<typeof createGitWorkspaceClient>
>();

export function gitWorkspace(conversation: CodingConversation) {
  let client = clients.get(conversation);
  if (!client) {
    const generation = conversation.runtime_generation;
    if (!generation || !conversation.cwd)
      throw new Error("Open a project conversation to review changes.");
    client = createGitWorkspaceClient(
      conversation.id,
      createCodingRunApi(generation),
    );
    clients.set(conversation, client);
  }
  return client;
}

function currentSession(source: CodingConversation) {
  const state = codingSession.getSnapshot();
  if (state.active !== source || state.pending) {
    throw new Error(
      "The conversation changed. Reopen the review in its original conversation.",
    );
  }
  return state;
}

export async function openGitWorkspace(
  source: CodingConversation,
  id: string,
): Promise<void> {
  currentSession(source);
  const { checkout } = await gitWorkspace(source).create(id);
  currentSession(source);
  if (!(await codingSession.startConversation(checkout))) {
    throw new Error(
      codingSession.getSnapshot().openingError ??
        "The worktree conversation could not be opened.",
    );
  }
}

export function addReviewToComposer(source: CodingConversation, text: string) {
  currentSession(source).draft.appendText(text);
}
