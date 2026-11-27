// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { McpServerConfig, SkillRecord } from "@/features/chat";

/**
 * Whether new Coding conversations get a Studio skill or MCP server. Coding has no switch of its
 * own: it follows the item's Chat setting, minus what the Coding runtime cannot use.
 */
export type CodingReach =
  | { state: "available" }
  | { state: "off" }
  | { state: "limited"; reason: CodingLimit };

export type CodingLimit = SkillCodingLimit | McpCodingLimit;

export type SkillCodingLimit =
  /** The skill's manifest does not parse, so nothing loads it. */
  | "invalid"
  /** Another source's copy of the same name loads instead. */
  | "shadowed";

/** The host's `coding_limit` values. */
export type McpCodingLimit = NonNullable<McpServerConfig["coding_limit"]>;

export const AVAILABLE: CodingReach = { state: "available" };
export const OFF: CodingReach = { state: "off" };

export function isHttpMcpAddress(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

export function skillCodingReach(
  skill: Pick<SkillRecord, "valid" | "shadowed" | "enabled">,
): CodingReach {
  if (!skill.valid) return { state: "limited", reason: "invalid" };
  if (skill.shadowed) return { state: "limited", reason: "shadowed" };
  return skill.enabled ? AVAILABLE : OFF;
}

/**
 * What an unsaved form would get. Only a preview: Studio's internal endpoints look like ordinary
 * HTTP, so a saved server's limit comes from the host (`coding_limit`).
 */
export function mcpTransportLimit(transport: {
  http: boolean;
  useOauth: boolean;
}): McpCodingLimit | null {
  if (!transport.http) return "local-command";
  if (transport.useOauth) return "oauth";
  return null;
}

/** A limit outranks the switch: turning a Chat-only server on would still not reach Coding. */
export function mcpCodingReach(
  server: Pick<McpServerConfig, "url" | "use_oauth" | "is_enabled" | "coding_limit">,
): CodingReach {
  // Absent only from a host older than the field: fall back to the transport preview.
  const limit =
    server.coding_limit === undefined
      ? mcpTransportLimit({
          http: isHttpMcpAddress(server.url),
          useOauth: server.use_oauth,
        })
      : server.coding_limit;
  if (limit) return { state: "limited", reason: limit };
  return server.is_enabled ? AVAILABLE : OFF;
}

export interface CodingReachSummary {
  total: number;
  available: number;
  off: number;
  limited: number;
}

export function summarizeCodingReach(
  reaches: Iterable<CodingReach>,
): CodingReachSummary {
  const summary: CodingReachSummary = { total: 0, available: 0, off: 0, limited: 0 };
  for (const reach of reaches) {
    summary.total += 1;
    summary[reach.state] += 1;
  }
  return summary;
}
