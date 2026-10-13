// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { ProjectOverlap } from "./run-types.ts";

/** Parse only the public overlap DTO, never native diagnostics or display paths. */
export function projectOverlap(value: unknown): ProjectOverlap | null {
  if (!value || typeof value !== "object") return null;
  const item = value as ProjectOverlap;
  if (
    typeof item.cwd !== "string" ||
    !item.cwd ||
    !Array.isArray(item.conversations) ||
    item.conversations.length > 32 ||
    item.conversations.some(
      (row) => !row || typeof row.id !== "string" || !row.id,
    )
  )
    return null;
  return {
    cwd: item.cwd,
    conversations: item.conversations.map(({ id }) => ({ id })),
  };
}

export class CodingOverlapError extends Error {
  readonly admissionRejected = true;
  readonly overlap: ProjectOverlap;
  constructor(overlap: ProjectOverlap) {
    super(
      "Other coding work is active in this canonical project folder. Review the overlap warning before continuing.",
    );
    this.overlap = overlap;
  }
}

/** Only explicit pre-admission refusals are safe to correct as new input. */
export class CodingHttpError extends Error {
  readonly admissionRejected: boolean;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.admissionRejected = [400, 401, 403, 404, 409, 422, 429].includes(
      status,
    );
  }
}
