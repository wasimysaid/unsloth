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

test("same-owner invalidation ends only the old view and requests read-only resubscription", async () => {
  const source = stream(
    [
      'event:view\ndata:{"subscription":"old-view","event":{"type":"invalidated","reason":"reopened"}}\n\n',
      'event:view\ndata:{"subscription":"old-view","position":99,"event":{"type":"state"}}\n\n',
    ],
    true,
  );
  const received: unknown[] = [];
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal, (view) => {
      received.push(view);
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.equal("viewInvalidated" in reason && reason.viewInvalidated, true);
      assert.equal("requiresReopen" in reason && reason.requiresReopen, false);
      return true;
    },
  );
  assert.deepEqual(
    received,
    [],
    "invalidation is terminal transport control, not positioned native history",
  );
  assert.equal(source.body.locked, false);
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

const viewFrame = (value: unknown) =>
  `event:view\ndata:${JSON.stringify(value)}\n\n`;
function fragmentFrames(event: unknown, width = 8192) {
  const json = JSON.stringify(event);
  const chars = Array.from(json);
  const frames: string[] = [];
  for (let offset = 0, part = 0; offset < chars.length; offset += width, part++)
    frames.push(
      viewFrame({
        subscription: "fragment-view",
        observation_epoch: "epoch",
        position: 12,
        event: {
          type: "fragment",
          part,
          last: offset + width >= chars.length,
          data: chars.slice(offset, offset + width).join(""),
        },
      }),
    );
  return frames;
}

function deltaReplay(count: number) {
  return Array.from({ length: count }, (_, n) =>
    viewFrame({
      subscription: "replay",
      observation_epoch: "epoch",
      position: n + 1,
      event: {
        type: "text_delta",
        row: { id: "text", entry_id: null, request_id: "r", kind: "assistant" },
        offset: n * 7,
        delta: "漢🙂",
      },
    }),
  ).join("");
}

test("buffered 5000-delta replay yields to controls without skipping ordered Unicode content", async (t) => {
  const source = stream([deltaReplay(5000)]);
  const abort = new AbortController();
  const positions: number[] = [];
  let text = "";
  let controlAt = -1;
  const control = new Promise<void>((resolve) =>
    setTimeout(() => {
      controlAt = positions.length;
      resolve();
    }, 0),
  );
  await consumeCodingEvents(source.body, abort.signal, (value) => {
    const view = value as { position: number; event: { delta: string } };
    positions.push(view.position);
    text += view.event.delta;
    if (positions.length === 5000) abort.abort();
  });
  await control;
  assert.deepEqual(
    positions,
    Array.from({ length: 5000 }, (_, n) => n + 1),
  );
  assert.equal(text, "漢🙂".repeat(5000));
  t.diagnostic(`queued control ran after ${controlAt} of 5000 deltas`);
  assert.ok(controlAt > 0 && controlAt <= 64);
});

test("abort during a buffered replay yield cancels all remaining delivery", async () => {
  const source = stream([deltaReplay(5000)]);
  const abort = new AbortController();
  let received = 0;
  const control = setTimeout(() => abort.abort(), 0);
  try {
    await consumeCodingEvents(source.body, abort.signal, () => {
      received++;
      if (received === 5000) abort.abort();
    });
    assert.ok(received > 0 && received <= 64);
    assert.equal(source.cancelled(), true);
    assert.equal(source.body.locked, false);
  } finally {
    clearTimeout(control);
  }
});

test("fragmented Unicode event larger than the parser frame bound is delivered exactly once", async () => {
  const event = {
    type: "activity",
    rows: [
      {
        id: "large",
        kind: "assistant",
        text: "漢🙂" + "x".repeat(2 * 1024 * 1024),
      },
    ],
  };
  const received: unknown[] = [];
  const source = stream(fragmentFrames(event), true);
  await assert.rejects(
    consumeCodingEvents(source.body, new AbortController().signal, (value) => {
      received.push(value);
    }),
    /disconnected/,
  );
  assert.deepEqual(received, [
    {
      subscription: "fragment-view",
      observation_epoch: "epoch",
      position: 12,
      event,
    },
  ]);
});

test("fragment assembly rejects gaps, changed identities, interleaving and nested events", async () => {
  const first = {
    subscription: "v",
    observation_epoch: "e",
    position: 3,
    event: { type: "fragment", part: 0, last: false, data: '{"type":' },
  };
  const tails = [
    {
      ...first,
      event: { type: "fragment", part: 2, last: true, data: '"activity"}' },
    },
    {
      ...first,
      subscription: "other",
      event: { type: "fragment", part: 1, last: true, data: '"activity"}' },
    },
    {
      ...first,
      position: 4,
      event: { type: "fragment", part: 1, last: true, data: '"activity"}' },
    },
    {
      ...first,
      observation_epoch: "other",
      event: { type: "fragment", part: 1, last: true, data: '"activity"}' },
    },
    { ...first, event: { type: "state" } },
  ];
  for (const tail of tails) {
    const received: unknown[] = [];
    await assert.rejects(
      consumeCodingEvents(
        stream([viewFrame(first), viewFrame(tail)], true).body,
        new AbortController().signal,
        (value) => {
          received.push(value);
        },
      ),
      /fragment/i,
    );
    assert.deepEqual(received, []);
  }
  for (const type of ["fragment", "closed", "invalidated"])
    await assert.rejects(
      consumeCodingEvents(
        stream(fragmentFrames({ type }), true).body,
        new AbortController().signal,
      ),
      /fragment/i,
    );
});

test("terminal envelope discards incomplete fragments without publishing them", async () => {
  for (const type of ["closed", "invalidated"]) {
    const frames = fragmentFrames({
      type: "activity",
      rows: [{ text: "x".repeat(20000) }],
    });
    const received: unknown[] = [];
    await assert.rejects(
      consumeCodingEvents(
        stream(
          [
            frames[0],
            viewFrame({ subscription: "fragment-view", event: { type } }),
          ],
          true,
        ).body,
        new AbortController().signal,
        (value) => {
          received.push(value);
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          type === "closed"
            ? "requiresReopen" in error
            : "viewInvalidated" in error,
          true,
        );
        return true;
      },
    );
    assert.deepEqual(received, []);
  }
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
