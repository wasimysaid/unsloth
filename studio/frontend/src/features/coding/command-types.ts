// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Effective native registry metadata, not a copied terminal menu. */
export interface CodingCommand {
  name: string;
  aliases: string[];
  description: string;
  argument: string | null;
  availability: "any" | "idle-only";
}
export interface CommandCatalog {
  conversation_id: string;
  commands: CodingCommand[];
  clipped?: boolean;
}
export type CommandOutcome = {
  conversation_id: string;
  operation_id: string;
} & (
  | { outcome: "handled" }
  | { outcome: "display"; text: string; clipped?: boolean }
  | { outcome: "submitted"; request_id: string }
);
export interface CommandReceipt {
  conversation_id: string;
  operation_id: string;
  status: "pending" | "completed" | "failed";
  result?: CommandOutcome;
  error?: { code: string; message: string };
}
export type DiagnosticKind = "context" | "tokens" | "retry" | "execution";
export interface CodingDiagnostic {
  conversation_id: string;
  kind: DiagnosticKind;
  // A deliberately sanitized, bounded native projection. No private message JSON.
  data: unknown;
  clipped?: boolean;
}
export interface SessionUsage {
  stale?: boolean;
  context_window?: number | null;
  prompt_tokens?: {
    used_prompt_tokens: number;
    confirmed_prompt_tokens: number;
    estimated_tail_tokens: number;
    provider_confirmed: boolean;
  } | null;
  request_usage?: { input_tokens: number; output_tokens: number } | null;
}

/** Any leading slash is a command attempt, including unknown/terminal-only names. */
export function parseCodingCommand(text: string) {
  const input = text.trimStart();
  if (!input.startsWith("/")) return null;
  const split = input.slice(1).search(/\s/);
  return split < 0
    ? { name: input.slice(1), tail: "" }
    : { name: input.slice(1, split + 1), tail: input.slice(split + 2).trim() };
}

export function commandOutcomeLabel(outcome: CommandOutcome) {
  switch (outcome.outcome) {
    case "handled":
      return "Handled by Mimir · no model request submitted";
    case "display":
      return "Transient native display · not a saved conversation message";
    case "submitted":
      return `Submitted native request · ${outcome.request_id} · completion is reported by the native view`;
  }
}

export function contextUsageLabel(usage?: SessionUsage | null) {
  const prompt = usage?.prompt_tokens;
  if (!prompt) return "Context usage not yet reported";
  const bound = usage?.context_window
    ? ` / ${usage.context_window.toLocaleString()}`
    : "";
  const stale = usage?.stale ? " · stale observation" : "";
  if (!prompt.provider_confirmed)
    return `Context: ${prompt.used_prompt_tokens.toLocaleString()}${bound} tokens · estimated${stale}`;
  return `Context: ${prompt.used_prompt_tokens.toLocaleString()}${bound} tokens · ${prompt.confirmed_prompt_tokens.toLocaleString()} provider-confirmed${prompt.estimated_tail_tokens ? ` · ${prompt.estimated_tail_tokens > 0 ? "+" : ""}${prompt.estimated_tail_tokens.toLocaleString()} estimated tail` : ""}${stale}`;
}
