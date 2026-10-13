// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

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
