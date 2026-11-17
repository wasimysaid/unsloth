// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { IconSvgElement } from "@hugeicons/react";

const stroke = {
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: "1.5",
} as const;

export const EnterFullViewIcon: IconSvgElement = [
  ["path", { d: "M13.5 6.5H17.5V10.5", ...stroke, key: "0" }],
  ["path", { d: "M10.5 17.5H6.5V13.5", ...stroke, key: "1" }],
];

export const ExitFullViewIcon: IconSvgElement = [
  ["path", { d: "M17.5 10.5H13.5V6.5", ...stroke, key: "0" }],
  ["path", { d: "M6.5 13.5H10.5V17.5", ...stroke, key: "1" }],
];
