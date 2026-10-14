// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { consumeCodingEvents } from "../src/features/coding/events.ts";

function stream(chunks: string[], close = false) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      if (close) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

test("split CRLF disconnect frame is an error even if heartbeats continue", async () => {
  const source = stream([
    'event:view\r\ndata:{"type":"native"}\r\n\r\n: heartbeat\r\n\r\nevent:discon',
    'nected\r\ndata:{"message":"Mimir exited"}\r',
    "\n\r\n: heartbeat\r\n\r\n",
  ]);
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal),
    /Mimir exited/,
  );
  assert.equal(source.cancelled(), true);
});

test("native ordered view lifecycle closed cannot leave the preview connected", async () => {
  const source = stream([
    'event:view\ndata:{"subscription":"native-sub","position":1,"event":{"type":"start"}}\n\n',
    'event:view\ndata:{"subscription":"native-sub","position":2,"event":{"type":"state"}}\n\n',
    'event:view\ndata:{"subscription":"native-sub","position":3,"event":{"type":"reset"}}\n\n',
    'event:view\ndata:{"subscription":"native-sub","position":4,"event":{"type":"closed"}}\n\n: heartbeat\n\n',
  ]);
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal),
    /native conversation view closed.*Reopen/,
  );
  assert.equal(source.cancelled(), true);
});

test("malformed disconnected payload cannot leave the preview connected", async () => {
  const source = stream(["event:disconnected\ndata:not-json\n\n"]);
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal),
    /disconnected/,
  );
});

test("normal EOF is a disconnection; error events remain failures", async () => {
  await assert.rejects(
    consumeCodingEvents(
      stream([": heartbeat\n\n"], true).body,
      new AbortController().signal,
    ),
    /disconnected/,
  );
  await assert.rejects(
    consumeCodingEvents(
      stream(['event:error\ndata:{"detail":"Bridge failed"}\n\n']).body,
      new AbortController().signal,
    ),
    /Bridge failed/,
  );
});

test("ordered native items await cut reconstruction before applying the next item", async () => {
  const source = stream([
    'event:view\ndata:{"position":10,"event":{"type":"start"}}\n\nevent:view\ndata:{"position":12,"event":{"type":"checkpoint"}}\n\n',
  ]);
  const abort = new AbortController();
  const observed: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = consumeCodingEvents(
    source.body,
    abort.signal,
    async (value) => {
      const item = value as { position: number };
      observed.push(item.position);
      if (item.position === 10) await gate;
      else abort.abort();
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [10]);
  release();
  await pending;
  assert.deepEqual(observed, [10, 12]);
  assert.equal(source.cancelled(), true);
});

test("unbounded event fragments fail explicitly", async () => {
  const source = stream([`data:${"x".repeat(2 * 1024 * 1024)}`]);
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal),
    /delivery bound/,
  );
  assert.equal(source.cancelled(), true);
});

test("abort cancels an idle stream and releases its reader without reporting an error", async () => {
  const source = stream(["event:view\ndata:{}\n\n: heartbeat\n\n"]);
  const abort = new AbortController();
  const pending = consumeCodingEvents(source.body, abort.signal);
  abort.abort();
  await pending;
  assert.equal(source.cancelled(), true);
  assert.equal(source.body.locked, false);
});

test("process-loss SSE requires deliberate reopen, unlike transient per-view overflow", async () => {
  for (const payload of [
    {
      code: "disconnected",
      requires_reopen: true,
      message: "Supervised Mimir process lost; deliberately reopen",
    },
    {
      code: "view_overflow",
      requires_reopen: false,
      message: "View overflow; reconnect for a fresh capture",
    },
    {
      code: "disconnected",
      requires_reopen: false,
      message: "Only the view disconnected; the native owner remains live",
    },
  ]) {
    const source = stream([
      `event:error\ndata:${JSON.stringify(payload)}\n\n: heartbeat\n\n`,
    ]);
    await assert.rejects(
      consumeCodingEvents(source.body, new AbortController().signal),
      (reason: unknown) => {
        assert.ok(reason instanceof Error);
        assert.equal(reason.message, payload.message);
        assert.equal(
          "requiresReopen" in reason && reason.requiresReopen === true,
          payload.requires_reopen,
        );
        return true;
      },
    );
    assert.equal(source.cancelled(), true);
  }
});
