// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { ExternalStoreAdapter } from "@assistant-ui/react";

export const CODING_SEND_UNAVAILABLE =
  "Prompt execution is not available in this opening-only preview. You can open a project or reopen a saved coding conversation.";

/** Read-only assistant-ui presentation: no chat adapter, local execution or history. */
export const codingOpeningAdapter: ExternalStoreAdapter = {
  isDisabled: true,
  isRunning: false,
  messages: [],
  onNew: async () => {
    // Required by the pinned external adapter contract. Reject rather than
    // pretend a prompt was sent if a caller bypasses the disabled controls.
    throw new Error(CODING_SEND_UNAVAILABLE);
  },
  unstable_capabilities: { copy: false },
};
