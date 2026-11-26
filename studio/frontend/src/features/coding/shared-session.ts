// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { setTerminalPermissionMode } from "./terminal-permissions";
import { codingApi, codingRuntimeApi, createCodingRunApi } from "./api";
import { createRuntimeMaintenance } from "./runtime-maintenance";
import { createCodingSession } from "./session";

// The app sidebar lists the conversations the page opens, and the two are
// siblings in the shell, so they share one session for the life of the tab.
export const codingMaintenance = createRuntimeMaintenance(codingRuntimeApi);

export function inspectFreshRuntime() {
  codingMaintenance.invalidate();
  void codingMaintenance.refresh();
}

export const codingSession = createCodingSession(codingApi, {
  onOpened: inspectFreshRuntime,
  async setTerminalMode(conversation, mode) {
    if (!conversation.runtime_generation)
      throw new Error("Reopen this project to check terminal permissions.");
    await setTerminalPermissionMode(
      conversation.id,
      createCodingRunApi(conversation.runtime_generation),
      mode,
    );
  },
});
