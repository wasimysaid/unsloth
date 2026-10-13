// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { takeSseFrame } from "../../lib/sse-framing.ts";

const DISCONNECTED =
  "The native event stream disconnected. Reconnect to continue watching.";

async function checkFrame(
  frame: string,
  onView?: (view: unknown) => Promise<void> | void,
): Promise<void> {
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
    await onView?.(view);
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

/** Await each ordered native item, including immutable-cut reads, before the next. */
export async function consumeCodingEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onView?: (view: unknown) => Promise<void> | void,
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
      while (frame && !signal.aborted) {
        if (frame.event.length > 2 * 1024 * 1024)
          throw new Error(
            "The native event exceeded the delivery bound. Reconnect for a fresh view.",
          );
        await checkFrame(frame.event, onView);
        buffer = frame.remainder;
        frame = takeSseFrame(buffer);
      }
      if (buffer.length > 2 * 1024 * 1024)
        throw new Error(
          "The native event exceeded the delivery bound. Reconnect for a fresh view.",
        );
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
