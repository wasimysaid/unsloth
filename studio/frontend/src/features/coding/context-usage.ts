// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { ContextUsageBarInput } from "@/features/chat";
import type { SessionUsage } from "./command-types";

export function codingContextUsage(usage: SessionUsage | null | undefined) {
  return {
    used: usage?.prompt_tokens?.used_prompt_tokens,
    total: usage?.context_window,
    estimated: Boolean(
      usage?.prompt_tokens && !usage.prompt_tokens.provider_confirmed,
    ),
    limitAdvice: "none",
    estimateDescription:
      "Includes tokens estimated by Mimir since the last provider count.",
    usageDescription: usage?.stale
      ? "Last reported usage; the current context may have changed."
      : undefined,
  } satisfies ContextUsageBarInput & {
    estimateDescription: string;
    usageDescription: string | undefined;
  };
}
