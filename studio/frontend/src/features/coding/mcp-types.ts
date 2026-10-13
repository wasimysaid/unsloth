// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Native configuration metadata. Raw definitions belong only to explicit editor reads. */
export interface McpSource {
  source: string;
  label: string;
  scope: "global" | "workspace";
  trusted: boolean;
  writable: boolean;
  exists: boolean;
  diagnostics: string[];
}
export interface McpEntry {
  source: string;
  name: string;
  state: string;
  contributes: boolean;
  definition_json: string;
  diagnostics: string[];
}
export interface McpEffective {
  name: string;
  state: string;
  source: string;
  field_origins: { field: string; source: string }[];
  transport: string | null;
}
export interface McpLive {
  name: string;
  ownership: "configured" | "session" | "attachment";
  status: {
    connected: boolean;
    tools: number | null;
    error: string | null;
  } | null;
  pending_apply: boolean;
  diagnostics: string[];
}
export interface McpInventory {
  saved_revision: string;
  applied_revision: string | null;
  configured_tools: number;
  documents: McpSource[];
  entries: McpEntry[];
  effective: McpEffective[];
  live: McpLive[];
  live_available: boolean;
  diagnostics: string[];
}
export interface McpDraft {
  edit_id: string;
  revision: string;
  source: string;
  name: string;
  json: string;
}
export interface McpSaveResult {
  draft: McpDraft;
  configured_state: string;
  inventory: McpInventory | null;
  inventory_error: string | null;
}
export interface McpOperation {
  operation_id: string;
  session_id: string;
  kind: "apply" | "reconnect";
  name: string | null;
  status: "running" | "completed" | "failed";
  error: string | null;
  saved_revision: string;
  applied_revision: string | null;
  live_available: boolean;
  configured_tools: number;
}
export interface McpOperationInspection {
  operation: McpOperation | null;
  inventory: McpInventory;
}
export interface McpSettingsApi {
  apply(id: string, operationId: string): Promise<McpOperation>;
  reconnect(
    id: string,
    operationId: string,
    name?: string,
  ): Promise<McpOperation>;
  inspectOperation(
    id: string,
    operationId: string,
  ): Promise<McpOperationInspection>;
  inventory(id: string): Promise<McpInventory>;
  edit(id: string, source: string, name: string): Promise<McpDraft>;
  save(id: string, draft: McpDraft, json: string): Promise<McpSaveResult>;
  release(id: string, editId: string): Promise<void>;
}
