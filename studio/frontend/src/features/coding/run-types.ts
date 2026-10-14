// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type {
  ChildAttempt,
  ChildDetail,
  ChildPresentation,
} from "./child-types.ts";
import type {
  CodingDiagnostic,
  CommandCatalog,
  CommandOutcome,
  CommandReceipt,
  DiagnosticKind,
  SessionUsage,
} from "./command-types.ts";
import type { ToolOutputProfile } from "./file-changes.ts";
import type { CodingInputExtras } from "./input.ts";
import type {
  CodingConfiguration,
  CodingConfigurationChange,
} from "./model-selection.ts";
import type {
  CodingMode,
  NativePlan,
  PlanActionResult,
  PlanDecision,
} from "./plan-types.ts";
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
export type GoalAction = "start" | "edit" | "pause" | "resume" | "clear";
export interface NativeGoal {
  id: string;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete" | "cleared";
  cause: string;
  reason: string | null;
  review_gap: string | null;
  work_turns: number;
  started_at: string;
  display_clipped?: boolean;
  completion: {
    checklist: { requirement: string; evidence: string }[];
    limitations: string | null;
    completed_at: string;
    omitted_checklist_entries?: number;
  } | null;
}
export interface GoalControls {
  revision: string;
  actions: { action: GoalAction; admitted: boolean; reason: string | null }[];
}
export interface GoalChange {
  revision: string;
  action: GoalAction;
  objective?: string;
  duration_seconds?: number;
}
export interface NativeQuestion {
  id: string;
  prompt: string;
  allow_multiple: boolean;
  options: { label: string; description: string }[];
}
export interface NativeUserRequest {
  id: string;
  questions: NativeQuestion[];
}
export interface NativeAnswer {
  question_id: string;
  selected_options: string[];
  freeform_text: string | null;
}
export interface AnswerTarget {
  subscription: string;
  request_id: string;
  user_request_id: string;
}
export interface NativeState {
  info: CodingConversation;
  /** Authoritative choice for the next request, even while another is running. */
  configuration: CodingConfiguration;
  /** Native inventory/resolution failure, never a health certification. */
  selection_unavailable?: string | null;
  /** Native preparation/cleanup, not inferred from picker or token traffic. */
  execution_preparation?: {
    request_id: string;
    configuration: CodingConfiguration;
    phase: "loading" | "busy" | "failed" | "cleanup_pending";
    error_code: string | null;
    message: string | null;
    retryable: boolean;
  } | null;
  running_configuration: CodingConfiguration | null;
  active_request: string | null;
  requests: NativeRequest[];
  pending_user_request: boolean;
  plan: NativePlan | null;
  action_disabled_reason: string | null;
  goal?: NativeGoal | null;
  goal_controls?: GoalControls;
  user_request: NativeUserRequest | null;
  usage?: SessionUsage | null;
  compression?: {
    status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
    request_id?: string;
    phase?: string | null;
    before_tokens?: number;
    after_tokens?: number;
    error?: string | null;
  } | null;
}
export interface JournalCut {
  journal: "root" | { child: string };
  leaf: string | null;
}
export type EntryAnchor = "latest" | { before: string } | { after: string };
export interface CodingRow {
  id: string;
  kind: "user" | "assistant" | "tool" | "notice" | "plan" | "child";
  child?: ChildAttempt;
  text?: string;
  entry_id?: string | null;
  request_id?: string | null;
  clipped?: boolean;
  historical?: boolean;
  plan?: NativePlan;
  answer?: {
    request_id: string;
    user_request_id: string;
    answers: NativeAnswer[];
  };
  image_count?: number;
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
    subagent?: ChildPresentation | null;
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
export interface ProjectOverlap {
  cwd: string;
  conversations: { id: string }[];
}
export interface RunApi {
  setMode(
    id: string,
    mode: CodingMode,
  ): Promise<{ conversation_id: string; mode: CodingMode }>;
  decidePlan(
    id: string,
    plan: NativePlan,
    decision: PlanDecision,
  ): Promise<PlanActionResult>;
  changeGoal?(
    id: string,
    change: GoalChange,
  ): Promise<{
    conversation_id: string;
    request_id: string | null;
  }>;
  answer(
    id: string,
    target: AnswerTarget,
    answers: NativeAnswer[],
  ): Promise<AnswerTarget & { conversation_id: string; accepted: boolean }>;
  commands?(id: string): Promise<CommandCatalog>;
  command?(
    id: string,
    name: string,
    tail: string,
    operationId: string,
  ): Promise<CommandOutcome>;
  commandReceipt?(id: string, operationId: string): Promise<CommandReceipt>;
  diagnostics?(id: string, kind: DiagnosticKind): Promise<CodingDiagnostic>;
  configure(
    id: string,
    change: CodingConfigurationChange,
  ): Promise<CodingConfiguration>;
  checkOverlap(id: string): Promise<ProjectOverlap>;
  readChild(
    id: string,
    handle: string,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<ChildDetail>;
  submit(
    id: string,
    submissionKey: string,
    text: string,
    extras?: CodingInputExtras,
    overlapConfirmed?: boolean,
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
