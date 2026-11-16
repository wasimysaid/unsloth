// SPDX-License-Identifier: AGPL-3.0-only
import { formatApiErrorBody } from "./format-fastapi-error.ts";
import { assertCompletedPaddedBody } from "./padded-response.ts";

export function parseErrorText(status: number, body: unknown): string {
  return formatApiErrorBody(body) ?? `Request failed (${status})`;
}

/** `/api/inference/load` and `/unload` pad their body so a proxy cannot time the request out,
 *  which commits the status early: a later failure can only arrive as `_deferred_error`. */
function deferredError(
  body: unknown,
): { status: number; message: string; detail: unknown } | null {
  const deferred =
    body && typeof body === "object"
      ? (
          body as {
            _deferred_error?: { status_code?: unknown; detail?: unknown };
          }
        )._deferred_error
      : undefined;
  if (!deferred || typeof deferred !== "object") return null;
  const status =
    typeof deferred.status_code === "number" ? deferred.status_code : 500;
  return {
    status,
    message: parseErrorText(status, { detail: deferred.detail }),
    detail: deferred.detail,
  };
}

/** Keeps the server's `detail`, so a structured audio.cpp failure (`{code, message}`) reaches the caller. */
export class LoadModelError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** `paddedLabel` opts a caller into `assertCompletedPaddedBody`; only the two padded routes may,
 *  since a truncated body means unfinished there but is legitimate elsewhere. */
export async function parseJsonOrThrow<T>(
  response: Response,
  paddedLabel?: string,
): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    throw new LoadModelError(parseErrorText(response.status, body), response.status, detail);
  }
  const deferred = deferredError(body);
  if (deferred) {
    throw new LoadModelError(deferred.message, deferred.status, deferred.detail);
  }
  if (paddedLabel !== undefined) {
    assertCompletedPaddedBody(body, paddedLabel);
  }
  return body as T;
}
