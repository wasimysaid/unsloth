// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type { ChildAttempt } from "../src/features/coding/child-types.ts";
import { createChildView } from "../src/features/coding/child-view.ts";
import type {
  EntryPage,
  JournalCut,
} from "../src/features/coding/run-types.ts";
const identity = { handle: "agent-race", attempt: 1 };
const cut = (leaf: string): JournalCut => ({
  journal: { child: identity.handle },
  leaf,
});
const child: ChildAttempt = {
  ...identity,
  status: "running",
  completion_pending: false,
  cut: cut("A"),
};
const page = (capture: JournalCut, text: string, older = false): EntryPage => ({
  cut: capture,
  rows: [{ id: text, kind: "assistant", text }],
  first_id: text,
  last_id: text,
  older,
  newer: false,
});
function harness() {
  const reads: {
    cut: JournalCut;
    resolve: (page: EntryPage) => void;
    reject: (reason: Error) => void;
  }[] = [];
  const view = createChildView("parent", {
    async readChild() {
      return { child: null, outcome: null };
    },
    async readPublicEntry() {
      throw new Error("No referenced entry expected in this fixture.");
    },
    async readEntries(_id, cut) {
      return await new Promise<EntryPage>((resolve, reject) =>
        reads.push({ cut, resolve, reject }),
      );
    },
  });
  return { view, reads };
}

test("superseded opening-history failures cannot cover a newer checkpoint with an error", async () => {
  const h = harness();
  await h.view.capture([child], []);
  const opening = h.view.open(identity);
  const checkpoint = h.view.checkpoint(identity, cut("B"), []);
  h.reads[1].resolve(page(cut("B"), "newer-checkpoint"));
  await checkpoint;
  h.reads[0].reject(new Error("Obsolete opening failure"));
  await opening;
  assert.equal(h.view.getSnapshot().inspection?.error, null);
  assert.equal(
    h.view.getSnapshot().inspection?.rows[0].text,
    "newer-checkpoint",
  );
  h.view.detach();
});

test("local trimming keeps historical pagination contiguous, including when no saved rows remain", async () => {
  for (const liveCount of [100, 150]) {
    const anchors: unknown[] = [];
    const view = createChildView("parent", {
      async readChild() {
        return { child: null, outcome: null };
      },
      async readPublicEntry() {
        throw new Error("No referenced entry expected in this fixture.");
      },
      async readEntries(_id, capture, anchor) {
        anchors.push(anchor);
        const end =
          typeof anchor === "object" && "before" in anchor
            ? Number(anchor.before.slice(1)) - 1
            : 200;
        const rows = Array.from({ length: 100 }, (_, index) => ({
          id: `e${end - 99 + index}`,
          entry_id: `e${end - 99 + index}`,
          kind: "assistant" as const,
          text: "x".repeat(4096),
        }));
        return {
          cut: capture,
          rows,
          older: true,
          newer: false,
          first_id: rows[0].id,
          last_id: rows.at(-1)?.id ?? null,
        };
      },
    });
    await view.capture([child], []);
    view.setConnected(true);
    await view.open(identity);
    view.activity(
      identity,
      Array.from({ length: liveCount }, (_, n) => ({
        id: `live${n}`,
        kind: "assistant" as const,
        text: "z".repeat(4096),
      })),
    );
    assert.equal(view.getSnapshot().inspection?.bounded, true);
    await view.loadEarlier();
    const earlier = view.getSnapshot().inspection?.rows;
    assert.ok(
      earlier?.some((row) => row.entry_id === "e101"),
      "must recover locally omitted saved entries, not jump before original page boundary",
    );
    assert.notDeepEqual(anchors.at(-1), { before: "e101" });
    view.detach();
  }
});

test("late opening history cannot reverse a newer ordered child checkpoint", async () => {
  const h = harness();
  await h.view.capture([child], []);
  const opening = h.view.open(identity);
  const checkpoint = h.view.checkpoint(identity, cut("B"), []);
  h.reads[1].resolve(page(cut("B"), "newer-checkpoint"));
  await checkpoint;
  h.reads[0].resolve(page(cut("A"), "older-opening"));
  await opening;
  assert.deepEqual(h.view.getSnapshot().inspection?.cut, cut("B"));
  assert.equal(
    h.view.getSnapshot().inspection?.rows[0].text,
    "newer-checkpoint",
  );
  h.view.detach();
});

test("opening history preserves newer assistant and tool activity received while its read was pending", async () => {
  const h = harness();
  await h.view.capture([child], []);
  const opening = h.view.open(identity);
  h.view.activity(identity, [
    { id: "new-live", kind: "assistant", text: "Newer live response" },
    {
      id: "tool-exact",
      kind: "tool",
      tool: {
        invocation_id: "invocation",
        call_id: "call",
        request_id: null,
        name: "shell",
        title: "Working",
        status: "running",
        output: "",
        clipped: false,
        quiet: false,
        row_group: null,
      },
    },
  ]);
  h.reads[0].resolve(page(cut("A"), "captured-history"));
  await opening;
  assert.deepEqual(
    h.view.getSnapshot().inspection?.rows.map((row) => row.id),
    ["captured-history", "new-live", "tool-exact"],
  );
  h.view.detach();
});

test("a checkpoint read finishing after historical navigation cannot replace the selected earlier page", async () => {
  const h = harness();
  await h.view.capture([child], []);
  h.view.setConnected(true);
  const opening = h.view.open(identity);
  h.reads[0].resolve(page(cut("A"), "initial", true));
  await opening;
  const checkpoint = h.view.checkpoint(identity, cut("B"), []);
  const earlier = h.view.loadEarlier();
  h.reads[2].resolve(page(cut("A"), "earlier-history"));
  await earlier;
  h.reads[1].resolve(page(cut("B"), "background-checkpoint"));
  await checkpoint;
  assert.equal(h.view.getSnapshot().inspection?.earlier, true);
  assert.equal(
    h.view.getSnapshot().inspection?.rows[0].text,
    "earlier-history",
  );
  assert.deepEqual(
    h.view.getSnapshot().attempts[0].cut,
    cut("B"),
    "ordered metadata still advances independently",
  );
  h.view.detach();
});
