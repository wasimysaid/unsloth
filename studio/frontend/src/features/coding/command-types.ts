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

/** Browser-side commands, offered only when the native registry lacks them. */
export const LOCAL_COMMANDS: readonly CodingCommand[] = [
  {
    name: "build",
    aliases: [],
    description: "Leave plan mode",
    argument: null,
    availability: "any",
  },
];
