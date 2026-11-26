// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { codingSendBlockedReason, type CodingRunState } from "./run-session.ts";

export function handoffBlockedReason(state: CodingRunState, project = false): string | null {
  if (!state.native || state.viewingEarlier) return "Open the latest messages to hand off.";
  if (project && !state.terminalPermissions) return "Checking terminal permissions.";
  const reason = codingSendBlockedReason(state);
  if (reason) return reason;
  if (state.native.active_request || state.native.requests.some(({ status }) => status === "running" || status === "queued"))
    return "Wait for this run and its follow-ups to finish.";
  return null;
}

const utf8 = new TextEncoder();
export const MAX_HANDOFF_BYTES = 65_536;

export function handoffContextError(context: string): string | null {
  if (!context.trim()) return "Write the context to share.";
  if (context.trimStart().startsWith("/"))
    return "Begin the message with a description. Coding treats a leading slash as a command.";
  if (utf8.encode(context).length > MAX_HANDOFF_BYTES)
    return "Shorten the context to 64 KiB or less.";
  return null;
}

function excerpt(text: string, maxBytes: number, clipped = false): string {
  const bytes = utf8.encode(text);
  if (bytes.length <= maxBytes && !clipped) return text;
  const mark = " […]";
  const prefix = bytes.subarray(0, maxBytes - utf8.encode(mark).length);
  // Streaming decode leaves an incomplete UTF-8 scalar at the cut undisplayed.
  return new TextDecoder().decode(prefix, { stream: true }) + mark;
}

/** Seed the editable first message with visible conversation text. Tool output,
 * reasoning and attachments stay with the source conversation. */
export function handoffContext(state: Pick<CodingRunState, "rows" | "native">): string {
  const messages = state.rows.filter((row) =>
    (row.kind === "user" || row.kind === "assistant") && row.text?.trim(),
  ).slice(-6).map((row) => {
    const author = row.kind === "user" ? "User" : "Assistant";
    return `**${author}**\n\n${excerpt(row.text ?? "", 1200, row.clipped)}`;
  });
  const parts: string[] = [];
  const plan = state.native?.plan;
  if (plan?.markdown && plan.status !== "abandoned") {
    const status = plan.status.replaceAll("_", " ");
    parts.push(`## Plan (${status})\n\n${plan.markdown}${plan.clipped ? " […]" : ""}`);
  }
  if (messages.length) parts.push("## Recent messages\n\n" + messages.join("\n\n"));
  if (!parts.length) return "";
  return excerpt(["Continue this work from the following context.", ...parts].join("\n\n"), MAX_HANDOFF_BYTES);
}
