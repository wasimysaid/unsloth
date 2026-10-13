// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { takeSseFrame } from "../../lib/sse-framing.ts";

const DISCONNECTED =
  "The native event stream disconnected. Reconnect to continue watching.";

function checkFrame(frame: string): void {
  const lines = frame.split(/\r?\n/);
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim();
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (event === "view") {
    const view = JSON.parse(data) as { event?: { type?: string } };
    if (view.event?.type === "closed")
      throw new Error(
        "The native conversation view closed. Reopen the saved conversation to continue.",
      );
    return;
  }
  if (event !== "disconnected" && event !== "error") return;
  let reason = DISCONNECTED;
  try {
    const payload = JSON.parse(data) as { detail?: unknown; message?: unknown };
    if (typeof payload.detail === "string") reason = payload.detail;
    else if (typeof payload.message === "string") reason = payload.message;
  } catch {
    // An invalid error payload still means disconnected, never connected.
  }
  throw new Error(reason);
}

/** Observe connection lifecycle; native view payloads are not a second history. */
export async function consumeCodingEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (signal.aborted) return;
      if (chunk.done) throw new Error(DISCONNECTED);
      buffer += decoder.decode(chunk.value, { stream: true });
      let frame = takeSseFrame(buffer);
      while (frame) {
        checkFrame(frame.event);
        buffer = frame.remainder;
        frame = takeSseFrame(buffer);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
