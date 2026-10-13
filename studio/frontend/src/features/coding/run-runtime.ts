// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type {
  ExternalStoreAdapter,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { CodingInputDraft } from "./input.ts";
import { type PresentationRow, groupCodingRows } from "./presentation.ts";
import type { CodingRun, CodingRunState } from "./run-session.ts";

/** assistant-ui projects native rows; Mimir owns rich input and execution. */
export function codingRunAdapter(
  state: CodingRunState | null,
  run: CodingRun | null,
  draft?: CodingInputDraft,
): ExternalStoreAdapter<PresentationRow> {
  return {
    isDisabled:
      !state ||
      state.connection !== "connected" ||
      state.recovering ||
      state.submitting ||
      Boolean(state.stopping || state.uncertainSubmission),
    isLoading: state?.connection === "loading",
    isRunning: Boolean(state?.native?.active_request || state?.stopping),
    messages: groupCodingRows(state?.rows ?? []),
    convertMessage(row): ThreadMessageLike {
      return {
        id: row.id,
        role: row.kind === "user" ? "user" : "assistant",
        content:
          row.text || row.tool?.title || row.tool?.name || "Native activity",
        metadata: { custom: { nativeRow: row } },
        ...(row.kind !== "user"
          ? {
              status: { type: "complete" as const, reason: "unknown" as const },
            }
          : {}),
      };
    },
    onNew: async (message) => {
      if (!run) throw new Error("Choose a host project folder first.");
      if (
        message.content.some((part) => part.type !== "text") ||
        (message.attachments?.length ?? 0)
      )
        throw new Error(
          "Unsupported composer content. Use the coding image attachment control.",
        );
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (await run.send(text, draft?.input(text))) draft?.clear();
    },
    onCancel: async () => {
      await run?.stop();
    },
    unstable_capabilities: { copy: false },
  };
}
