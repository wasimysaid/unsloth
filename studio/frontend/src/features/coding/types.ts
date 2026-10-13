// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Read-only native records. Studio does not persist a second coding history. */
export interface CodingConversation {
  id: string;
  cwd: string;
  title?: string | null;
}

export interface CodingProjectDirectory {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

export interface CodingApi {
  listConversations(): Promise<CodingConversation[]>;
  createConversation(cwd: string): Promise<CodingConversation>;
  openConversation(id: string): Promise<CodingConversation>;
  browseProjects(
    path: string,
    signal: AbortSignal,
  ): Promise<CodingProjectDirectory>;
}
