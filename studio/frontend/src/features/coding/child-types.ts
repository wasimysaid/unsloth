// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { CodingRow, JournalCut } from "./run-types.ts";

export type ChildStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "deadline"
  | "stopped"
  | "interrupted";
export interface ChildIdentity {
  handle: string;
  attempt: number;
}
export interface ChildPresentation {
  agent_id: string;
  attempt: number | null;
  agent: string;
  description: string;
  status: ChildStatus;
  model?: string | null;
  phase?: string;
  turns?: number;
  tool_uses?: number;
  tokens?: number;
  elapsed_ms?: number;
}
export interface ChildAttempt extends ChildIdentity {
  status: ChildStatus;
  completion_pending: boolean;
  cut: JournalCut | null;
  profile?: string;
  description?: string;
  model?: string | null;
  background?: boolean;
  presentation?: ChildPresentation | null;
  oversized?: boolean;
  clipped?: boolean;
  historical?: boolean;
}
export interface ChildOutcome extends ChildIdentity {
  status: ChildStatus;
  result: string | null;
  error: string | null;
  result_clipped?: boolean;
  error_clipped?: boolean;
}
export interface ChildDetail {
  child: ChildAttempt | null;
  outcome: ChildOutcome | null;
}
export interface ChildInspection extends ChildIdentity {
  rows: CodingRow[];
  outcome: ChildOutcome | null;
  cut: JournalCut | null;
  loading: boolean;
  loadingEarlier: boolean;
  older: boolean;
  earlier: boolean;
  first: string | null;
  error: string | null;
  bounded: boolean;
}
export const childKey = (child: ChildIdentity) =>
  JSON.stringify([child.handle, child.attempt]);
export const sameChild = (a: ChildIdentity, b: ChildIdentity) =>
  a.handle === b.handle && a.attempt === b.attempt;
export const terminalChild = (child: ChildIdentity & { status: ChildStatus }) =>
  !["queued", "running"].includes(child.status);
export const childDescription = (child: ChildAttempt) =>
  child.description ||
  child.presentation?.description ||
  child.profile ||
  "Delegated work";
export function childStatusLabel(child: ChildAttempt, connected: boolean) {
  if (child.historical)
    return `Historical · ${child.status} reported (not live)`;
  if (!connected && !terminalChild(child))
    return `Disconnected · last reported ${child.status}; work may still be running`;
  return `${child.status}${child.completion_pending ? " · completion owed to Mimir" : ""}`;
}
