// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { ToolOutputProfile } from "./file-changes.ts";
import type { CodingConversation } from "./types.ts";

export type RequestStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface NativeRequest {
  id: string;
  status: RequestStatus;
  submission_key: string | null;
}
export interface NativeState {
  info: CodingConversation;
  configuration: {
    provider: string | null;
    model: string | null;
    reasoning: string | null;
    mode: string;
  };
  active_request: string | null;
  requests: NativeRequest[];
  pending_user_request: boolean;
}
export interface JournalCut {
  journal: "root";
  leaf: string | null;
}
export type EntryAnchor = "latest" | { before: string } | { after: string };
export interface CodingRow {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice";
  text?: string;
  entry_id?: string | null;
  request_id?: string | null;
  clipped?: boolean;
  historical?: boolean;
  tool?: {
    invocation_id: string | null;
    call_id: string;
    request_id: string | null;
    name: string;
    title: string;
    status: string;
    output: string;
    clipped: boolean;
    quiet: boolean;
    row_group: { key: string; label: string; item: string } | null;
    semantic_content?: unknown;
    display_kind?: string | null;
    output_profile?: ToolOutputProfile | null;
    historical?: boolean;
  };
}
export interface EntryPage {
  cut: JournalCut;
  rows: CodingRow[];
  older: boolean;
  newer: boolean;
  first_id: string | null;
  last_id: string | null;
}
export interface RunApi {
  submit(
    id: string,
    submissionKey: string,
    text: string,
  ): Promise<{
    conversation_id: string;
    request_id: string;
    submission_key: string;
  }>;
  cancel(
    id: string,
    requestId: string,
  ): Promise<{
    conversation_id: string;
    request_id: string;
    cancel_requested: boolean;
  }>;
  readEntries(
    id: string,
    cut: JournalCut,
    anchor: EntryAnchor,
    signal?: AbortSignal,
  ): Promise<EntryPage>;
  watch(
    id: string,
    signal: AbortSignal,
    connected: () => void,
    onView: (view: unknown) => Promise<void>,
  ): Promise<void>;
}
