// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { createContext } from "react";

export const CodingPanels = createContext({
  openFiles: () => {},
  openSubagents: () => {},
  openChanges: () => {},
  refreshGit: () => {},
  hasProject: false,
  filesOpen: false,
  subagentsOpen: false,
  changesOpen: false,
  branch: null as string | null,
  changedFiles: null as number | null,
});
