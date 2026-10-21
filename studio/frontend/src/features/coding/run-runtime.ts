// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type {
  ExternalStoreAdapter,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { parseCodingCommand } from "./command-types.ts";
import type { CodingInputDraft } from "./input.ts";
import {
  type CodingRun,
  type CodingRunState,
  codingCanEdit,
} from "./run-session.ts";
import {
  type TranscriptBlock,
  type TranscriptProjection,
  createTranscriptProjection,
  transcriptWindow,
} from "./transcript-model.ts";

const blockText = (block: TranscriptBlock) =>
  block.kind === "activity"
    ? block.summary.text
    : block.row.text ||
      block.row.tool?.title ||
      block.row.tool?.name ||
      "Native activity";

/** assistant-ui owns the composer and run flags; Mimir owns rows and execution.
 * `isDisabled` means the text cannot be edited at all. Whether it can be sent
 * is `codingSendBlockedReason`, enforced by the composer and by `run.send`. */
export function codingRunAdapter(
  state: CodingRunState | null,
  run: CodingRun | null,
  draft?: CodingInputDraft,
  projection: TranscriptProjection = createTranscriptProjection(),
  canEdit = codingCanEdit(state, run),
): ExternalStoreAdapter<TranscriptBlock> {
  return {
    isDisabled: !canEdit,
    isLoading: state?.connection === "loading",
    isRunning: Boolean(state?.native?.active_request || state?.stopping),
    messages: projection.project(state?.rows ?? [], transcriptWindow(state)),
    convertMessage(block): ThreadMessageLike {
      return {
        id: block.key,
        role: block.kind === "user" ? "user" : "assistant",
        content: blockText(block),
        ...(block.kind !== "user"
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
      const extras = draft?.input(text);
      // This message owns these associations from now on; its outcome must
      // never clear a newer draft. Every refusal keeps them in run state.
      // A slash command takes no rich input, so its images stay attached.
      if (parseCodingCommand(text)) draft?.syncText("");
      else draft?.clear();
      try {
        await run.send(text, extras);
      } catch (reason) {
        // The composer gates Send on `codingSendBlockedReason`; a state change
        // racing that gate must not lose text the runtime already cleared.
        run.retainUnsent({ text, ...extras }, reason);
      }
    },
    onCancel: async () => {
      await run?.stop();
    },
    unstable_capabilities: { copy: false },
  };
}
