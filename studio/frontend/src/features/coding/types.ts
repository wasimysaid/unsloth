// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { CodingConfigurationChange } from "./model-selection.ts";

/** Read-only native records. Studio does not persist a second coding history. */
export interface CodingConversation {
  id: string;
  cwd: string;
  title?: string | null;
  /** Supervisor incarnation that actually opened this live owner (not catalog identity). */
  runtime_generation?: number;
  /** Native live-owner presence, not proof this frontend owns it or it is busy. */
  live?: boolean;
}

export interface CodingProjectDirectory {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}

export interface CodingApi {
  listConversations(): Promise<CodingConversation[]>;
  /** The first request's model, chosen before the conversation existed. */
  createConversation(
    cwd: string,
    configuration?: CodingConfigurationChange | null,
  ): Promise<CodingConversation>;
  openConversation(
    id: string,
    signal?: AbortSignal,
  ): Promise<CodingConversation>;
  browseProjects(
    path: string,
    signal: AbortSignal,
  ): Promise<CodingProjectDirectory>;
}
