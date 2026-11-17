// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { createContext } from "react";

export const CodingLayoutHosts = createContext<{
  settingsPanel: HTMLElement | null;
  settingsTrigger: HTMLElement | null;
  contextUsage: HTMLElement | null;
}>({ settingsPanel: null, settingsTrigger: null, contextUsage: null });
