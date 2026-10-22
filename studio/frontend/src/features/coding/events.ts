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
    if (view.event?.type === "invalidated")
      throw Object.assign(
        new Error(
          "The native view was replaced. Refreshing the same conversation view.",
        ),
        { viewInvalidated: true },
      );
    if (view.event?.type === "closed")
      throw Object.assign(
        new Error(
          "The native conversation view closed. Reopen the saved conversation to continue.",
        ),
        { requiresReopen: true },
      );
    await onView?.(view);
    return;
  }
  if (event !== "disconnected" && event !== "error") return;
  let reason = DISCONNECTED;
  let requiresReopen = false;
  try {
    const payload = JSON.parse(data) as {
      detail?: unknown;
      message?: unknown;
      requires_reopen?: unknown;
    };
    if (typeof payload.detail === "string") reason = payload.detail;
    else if (typeof payload.message === "string") reason = payload.message;
    requiresReopen = payload.requires_reopen === true;
  } catch {
    // An invalid error payload still means disconnected, never connected.
  }
  const error = new Error(reason);
  if (requiresReopen) throw Object.assign(error, { requiresReopen: true });
  throw error;
}

function fragmentAssembler() {
  let pending: {
    envelope: Record<string, unknown>;
    next: number;
    parts: string[];
  } | null = null;
  const invalid = () =>
    new Error("Invalid native event fragments. Reconnect for a fresh view.");
  return (value: unknown): unknown | null => {
    const view = value as Record<string, unknown>;
    const event = view?.event as Record<string, unknown> | undefined;
    if (event?.type !== "fragment") {
      if (pending) throw invalid();
      return value;
    }
    if (
      typeof view.subscription !== "string" ||
      !view.subscription ||
      typeof view.observation_epoch !== "string" ||
      !view.observation_epoch ||
      !Number.isSafeInteger(view.position) ||
      !Number.isSafeInteger(event.part) ||
      (event.part as number) < 0 ||
      typeof event.last !== "boolean" ||
      typeof event.data !== "string" ||
      !event.data
    )
      throw invalid();
    if (!pending) {
      if (event.part !== 0) throw invalid();
      pending = { envelope: view, next: 0, parts: [] };
    }
    if (
      event.part !== pending.next ||
      view.subscription !== pending.envelope.subscription ||
      view.observation_epoch !== pending.envelope.observation_epoch ||
      view.position !== pending.envelope.position
    )
      throw invalid();
    pending.parts.push(event.data);
    pending.next++;
    if (!event.last) return null;
    let complete: Record<string, unknown>;
    try {
      complete = JSON.parse(pending.parts.join("")) as Record<string, unknown>;
    } catch {
      throw invalid();
    }
    if (
      !complete ||
      Array.isArray(complete) ||
      typeof complete.type !== "string" ||
      ["fragment", "closed", "invalidated"].includes(complete.type)
    )
      throw invalid();
    const assembled = { ...pending.envelope, event: complete };
    pending = null;
    return assembled;
  };
}

/** Await each complete ordered native item before accepting its successor. */
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
  const assemble = fragmentAssembler();
  let framesSinceYield = 0;
  let deadline = performance.now() + 8;
  const accept = async (value: unknown) => {
    const complete = assemble(value);
    if (complete !== null && !signal.aborted) await onView?.(complete);
  };
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
        await checkFrame(frame.event, accept);
        buffer = frame.remainder;
        frame = takeSseFrame(buffer);
        // Awaiting resolved promises does not let input or paint tasks run.
        if (
          !signal.aborted &&
          (++framesSinceYield >= 64 || performance.now() >= deadline)
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          framesSinceYield = 0;
          deadline = performance.now() + 8;
        }
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
