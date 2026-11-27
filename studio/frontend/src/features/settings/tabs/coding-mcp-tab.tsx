// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  type McpServerConfig,
  type McpServerDraftTransport,
  McpServersManager,
} from "@/features/chat";
import { type TranslationKey, useT } from "@/i18n";
import { useMemo, useState } from "react";
import {
  type McpCodingLimit,
  mcpCodingReach,
  mcpTransportLimit,
  summarizeCodingReach,
} from "../coding-agent/coding-reach";
import {
  CodingLimitBadge,
  CodingLimitNotice,
  CodingReachLine,
  SettingsPageHeader,
} from "../coding-agent/coding-reach-view";

const LIMIT_LABEL: Record<McpCodingLimit, TranslationKey> = {
  "local-command": "settings.codingAgent.mcp.reach.localCommand",
  oauth: "settings.codingAgent.mcp.reach.oauth",
  "studio-internal": "settings.codingAgent.mcp.reach.studioInternal",
};

/**
 * Studio's saved MCP connections as Coding sees them. A row's switch is the whole story unless
 * Coding cannot use the server at all; only those rows carry a mark, with the host's reason.
 */
export function CodingMcpTab() {
  const t = useT();
  const [list, setList] = useState<{ servers: McpServerConfig[]; loading: boolean }>({
    servers: [],
    loading: true,
  });
  const summary = useMemo(
    () => summarizeCodingReach(list.servers.map(mcpCodingReach)),
    [list.servers],
  );

  const limitLabel = (reason: string) =>
    // A limit a newer host names before this build knows it still reads as Chat only.
    Object.hasOwn(LIMIT_LABEL, reason)
      ? t(LIMIT_LABEL[reason as McpCodingLimit])
      : t("settings.codingAgent.mcp.reach.other");

  // A preview from the transport alone: the host's own limit lands with the saved row.
  const draftNotice = ({ transport, useOauth }: McpServerDraftTransport) => {
    if (transport === "unknown") return null;
    const limit = mcpTransportLimit({ http: transport === "http", useOauth });
    if (limit === null) return null;
    return (
      <CodingLimitNotice>
        {limit === "oauth"
          ? t("settings.codingAgent.mcp.draft.oauth")
          : t("settings.codingAgent.mcp.draft.localCommand")}
      </CodingLimitNotice>
    );
  };

  return (
    <div className="settings-page">
      <SettingsPageHeader
        title={t("settings.codingAgent.mcp.title")}
        description={t("settings.codingAgent.mcp.description")}
      />
      <McpServersManager
        active={true}
        layout="page"
        onListChange={setList}
        intro={<CodingReachLine summary={summary} ready={!list.loading} />}
        rowAccessory={(server) => {
          const reach = mcpCodingReach(server);
          return reach.state === "limited" ? (
            <div className="mt-1">
              <CodingLimitBadge label={limitLabel(reach.reason)} />
            </div>
          ) : null;
        }}
        formAccessory={draftNotice}
      />
    </div>
  );
}
