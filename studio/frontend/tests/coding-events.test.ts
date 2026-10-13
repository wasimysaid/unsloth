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

test("abort cancels an idle stream and releases its reader without reporting an error", async () => {
  const source = stream(["event:view\ndata:{}\n\n: heartbeat\n\n"]);
  const abort = new AbortController();
  const pending = consumeCodingEvents(source.body, abort.signal);
  abort.abort();
  await pending;
  assert.equal(source.cancelled(), true);
  assert.equal(source.body.locked, false);
});
