// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** The only coding choices kept in the browser: where and with which model the
 * next new conversation starts. Never conversation content. */
import type { CodingConfigurationChange } from "./model-selection.ts";

export const PROJECT_KEY = "unsloth_coding_project";
export const MODEL_KEY = "unsloth_coding_model";
export type Memory = Pick<Storage, "getItem" | "setItem">;
export const browserMemory = (): Memory | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
export function recall<T>(memory: Memory | null, key: string, valid: (v: unknown) => v is T) {
  try {
    const value: unknown = JSON.parse(memory?.getItem(key) ?? "null");
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0;
export const isProject = (value: unknown): value is string => text(value);
export const isSelection = (value: unknown): value is CodingConfigurationChange =>
  typeof value === "object" &&
  value !== null &&
  text((value as CodingConfigurationChange).provider) &&
  text((value as CodingConfigurationChange).model) &&
  ["undefined", "string"].includes(
    typeof (value as CodingConfigurationChange).reasoning,
  );
