// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { McpInventory } from "./mcp-types";

/** Empty and unavailable are distinct native observations, never inferred from diagnostics. */
export function McpAppliedState({ inventory }: { inventory: McpInventory }) {
  return (
    <div
      className="space-y-3 rounded-xl border p-4"
      data-testid="mcp-applied-state"
    >
      <h3 className="font-medium">Currently applied connections</h3>
      <p className="text-xs text-muted-foreground">
        Native session-owned connections at the last read. Saving does not apply
        or reconnect them. Live apply/reconnect is a separate operation, not
        provided by this save tab.
      </p>
      {inventory.live_available !== true ? (
        <p role="status" className="text-sm">
          Applied status unavailable — refresh inventory to read the current
          native state.
        </p>
      ) : (
        <>
          {!inventory.live.some(
            (item) => item.ownership === "configured" && item.status,
          ) && (
            <p className="text-sm">
              No configured connections currently applied in this conversation.
            </p>
          )}
          {inventory.live.map((item) => (
            <div
              key={`${item.ownership}:${item.name}`}
              className="space-y-1 text-sm"
            >
              <p className="break-all">
                {item.name} ·{" "}
                {item.ownership === "configured"
                  ? "Persistent configuration"
                  : "Transient connection (not a Settings entry)"}
              </p>
              <p>
                {item.status
                  ? item.status.connected
                    ? "Connected"
                    : "Disconnected"
                  : "Not applied"}{" "}
                ·{" "}
                {item.ownership === "configured"
                  ? item.pending_apply
                    ? "Saved configuration pending apply"
                    : "No pending configuration change reported"
                  : "Owned separately from persistent configuration"}
              </p>
              {item.status?.error && (
                <p className="break-words">{item.status.error}</p>
              )}
              {item.diagnostics.map((text, index) => (
                <p key={index} className="break-words text-xs">
                  {text}
                </p>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
