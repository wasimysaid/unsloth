// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  type CodingFile,
  type CodingSkill,
  type CodingSubagent,
  MAX_MENTIONS,
  createInputDraft,
  fileMentionToken,
} from "../src/features/coding/input.ts";
import {
  mentionGroups,
  mentionQuery,
  stepMention,
} from "../src/features/coding/mention-menu.ts";
import {
  type PendingImageStore,
  pendingSubmissionStorageKey,
} from "../src/features/coding/pending-submission.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const review: CodingSkill = {
  name: "review",
  qualified_name: "plugin:alpha:review",
  description: "Review a change",
  path: "/project/.agents/skills/review/SKILL.md",
};
const lint: CodingSkill = {
  name: "lint",
  qualified_name: "lint",
  description: "Run project lint",
};
const explorer: CodingSubagent = {
  name: "explorer",
  description: "Read-only codebase exploration",
  plan_eligible: true,
};
const writer: CodingSubagent = {
  name: "writer",
  description: "Edits files",
  plan_eligible: false,
};
const catalog = {
  skills: [review, lint],
  subagents: [explorer, writer],
  files: [] as CodingFile[],
  skillStatus: null,
  subagentStatus: null,
  fileStatus: null,
};

test("@ opens only at a token start, including after brackets, never inside words or e-mail", () => {
  assert.deepEqual(mentionQuery("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionQuery("ask @exp now", 8), {
    start: 4,
    end: 8,
    query: "exp",
  });
  assert.deepEqual(mentionQuery("(@rev", 5), {
    start: 1,
    end: 5,
    query: "rev",
  });
  assert.equal(mentionQuery("mail me@example.com", 19), null);
  assert.equal(mentionQuery("@a@b", 4), null);
  assert.equal(mentionQuery("@review done", 12), null);
  // Caret inside a token still replaces the whole token on selection.
  assert.deepEqual(mentionQuery("@explorer later", 3), {
    start: 0,
    end: 9,
    query: "ex",
  });
});

test("the menu groups native Skills then Subagents; Plan disables ineligible subagents honestly", () => {
  const build = mentionGroups(catalog, "", "build");
  assert.deepEqual(
    build.map((group) => [group.label, group.options.map((o) => o.label)]),
    [
      ["Skills", ["plugin:alpha:review", "lint"]],
      ["Subagents", ["explorer", "writer"]],
      ["Files", []],
    ],
  );
  assert.ok(build.flatMap((g) => g.options).every((o) => !o.disabled));
  const plan = mentionGroups(catalog, "", "plan");
  const options = plan.flatMap((group) => group.options);
  assert.equal(
    options.find((o) => o.label === "writer")?.disabled,
    "Not available in Plan mode",
  );
  assert.equal(options.find((o) => o.label === "explorer")?.disabled, null);
  // Prefix and qualified-segment matches rank before description matches.
  const filtered = mentionGroups(catalog, "rev", "build");
  assert.deepEqual(
    filtered[0].options.map((o) => o.label),
    ["plugin:alpha:review"],
  );
  assert.deepEqual(filtered[1].options, []);
  const described = mentionGroups(catalog, "exploration", "build");
  assert.deepEqual(
    described[1].options.map((o) => o.label),
    ["explorer"],
  );
});

test("Files lists host search results in server order with exact path identity", () => {
  const files: CodingFile[] = [
    { path: "src/app.ts", kind: "file" },
    { path: "docs/My Notes", kind: "directory" },
    { path: 'say "hi" there.md', kind: "file" },
    { path: "notes#2.md", kind: "file" },
  ];
  const [, , group] = mentionGroups({ ...catalog, files }, "zzz", "build");
  assert.equal(group.label, "Files");
  // The host already matched the query; the menu never re-filters or re-ranks.
  assert.deepEqual(
    group.options.map((o) => [o.label, o.description, o.disabled]),
    [
      ["src/app.ts", "", null],
      ["docs/My Notes", "Folder", null],
      [
        'say "hi" there.md',
        "",
        "This path cannot be written as an @ reference",
      ],
      ["notes#2.md", "", "This path cannot be written as an @ reference"],
    ],
  );
  assert.deepEqual(group.options[1].choice, { kind: "file", file: files[1] });
  const options = mentionGroups({ ...catalog, files }, "zzz", "build").flatMap(
    (g) => g.options,
  );
  assert.equal(stepMention(options, 1, 1), 0, "unquotable paths are skipped");
});

test('file references use the native @path and @"path" grammar with exact UTF-8 ranges', () => {
  assert.equal(
    fileMentionToken({ path: "src/é.ts", kind: "file" }),
    "@src/é.ts",
  );
  assert.equal(fileMentionToken({ path: "src", kind: "directory" }), "@src/");
  assert.equal(fileMentionToken({ path: "src//", kind: "directory" }), "@src/");
  assert.equal(
    fileMentionToken({ path: "My Docs", kind: "directory" }),
    '@"My Docs/"',
  );
  assert.equal(fileMentionToken({ path: "a b.md", kind: "file" }), '@"a b.md"');
  assert.equal(fileMentionToken({ path: 'a "b".md', kind: "file" }), null);
  assert.equal(fileMentionToken({ path: "a\tb", kind: "file" }), null);
  const draft = createInputDraft();
  draft.syncText("😀 read ");
  let next = draft.selectMention(
    { kind: "file", file: { path: "src/é.ts", kind: "file" } },
    8,
    8,
  );
  next = draft.selectMention(
    { kind: "file", file: { path: "My Docs", kind: "directory" } },
    next.text.length,
    next.text.length,
  );
  assert.equal(next.text, '😀 read @src/é.ts @"My Docs/" ');
  const extras = draft.input(next.text);
  const bytes = new TextEncoder().encode(next.text);
  // Native identity is the canonical catalog path, not the visible token.
  assert.deepEqual(extras.file_mentions, [
    { path: "src/é.ts", kind: "file", start: 10, end: 20 },
    { path: "My Docs", kind: "directory", start: 21, end: 32 },
  ]);
  const decode = (start: number, end: number) =>
    new TextDecoder().decode(bytes.slice(start, end));
  assert.equal(decode(10, 20), "@src/é.ts");
  assert.equal(decode(21, 32), '@"My Docs/"');
  // A typed path alone is never a reference.
  const typed = createInputDraft();
  typed.syncText("@src/é.ts ");
  assert.deepEqual(typed.input("@src/é.ts "), {});
  // Restore rebuilds the exact identities and the chip tokens.
  const restored = createInputDraft();
  restored.restore({ text: next.text, ...extras });
  assert.deepEqual(restored.input(next.text), extras);
  assert.deepEqual(
    restored.getSnapshot().mentions.map((m) => m.token),
    ["@src/é.ts", '@"My Docs/"'],
  );
  // Editing inside a quoted reference drops it rather than resending it.
  const edited = next.text.replace("My Docs", "My Dogs");
  draft.syncText(edited);
  assert.deepEqual(
    draft.input(edited).file_mentions?.map((m) => m.path),
    ["src/é.ts"],
  );
  assert.throws(
    () =>
      createInputDraft().selectMention(
        { kind: "file", file: { path: 'a "b" c', kind: "file" } },
        0,
        0,
      ),
    /cannot be written as an @ reference/,
  );
});

test("keyboard stepping wraps and skips disabled identities; no selectable option means no trap", () => {
  const options = mentionGroups(catalog, "", "plan").flatMap((g) => g.options);
  const writerIndex = options.findIndex((o) => o.label === "writer");
  assert.equal(stepMention(options, null, 1), 0);
  assert.equal(stepMention(options, writerIndex - 1, 1), 0, "skips writer");
  assert.equal(stepMention(options, 0, -1), writerIndex - 1);
  const onlyDisabled = mentionGroups(
    { ...catalog, skills: [], subagents: [writer] },
    "",
    "plan",
  ).flatMap((g) => g.options);
  assert.equal(stepMention(onlyDisabled, null, 1), null);
  assert.equal(stepMention([], null, 1), null);
});

test("selected subagents and skills keep exact native identity and UTF-8 ranges", () => {
  const draft = createInputDraft();
  draft.syncText("😀 use ");
  let next = draft.selectMention(
    { kind: "subagent", subagent: explorer },
    7,
    7,
  );
  next = draft.selectMention(
    { kind: "skill", skill: review },
    next.text.length,
    next.text.length,
  );
  const extras = draft.input(next.text);
  assert.equal(next.text, "😀 use @explorer @plugin:alpha:review ");
  assert.deepEqual(extras.subagent_mentions, [
    { name: "explorer", start: 9, end: 18 },
  ]);
  assert.deepEqual(extras.skill_mentions, [
    { name: "plugin:alpha:review", path: review.path, start: 19, end: 39 },
  ]);
  // A typed name alone never authorizes an identity.
  const typed = createInputDraft();
  typed.syncText("@explorer ");
  assert.deepEqual(typed.input("@explorer "), {});
  // Same token text for a skill and a subagent stays distinguished by selection.
  const same = createInputDraft();
  same.selectMention(
    { kind: "skill", skill: { ...lint, qualified_name: "explorer" } },
    0,
    0,
  );
  assert.deepEqual(
    same.input("@explorer ").skill_mentions?.[0].name,
    "explorer",
  );
  assert.equal(same.input("@explorer ").subagent_mentions, undefined);
  // Restore (rejected/pending input) rebuilds both kinds exactly.
  const restored = createInputDraft();
  restored.restore({ text: next.text, ...extras });
  assert.deepEqual(restored.input(next.text), extras);
  assert.deepEqual(
    restored.getSnapshot().mentions.map((m) => [m.kind, m.token]),
    [
      ["subagent", "@explorer"],
      ["skill", "@plugin:alpha:review"],
    ],
  );
});

test("undo and other unknown edits keep unique mentions, drop repeated ones, never guess", () => {
  const draft = createInputDraft();
  const { text } = draft.selectMention(
    { kind: "subagent", subagent: explorer },
    0,
    0,
  );
  draft.syncText(`${text}scan the repo`, {
    start: text.length,
    end: text.length,
  });
  // historyUndo reports no range: inferred from the diff, the mention survives.
  draft.syncText(text);
  assert.deepEqual(draft.input(text).subagent_mentions, [
    { name: "explorer", start: 0, end: 9 },
  ]);
  // A repeated token with an unknown edit is dropped rather than guessed.
  draft.syncText(`${text}@explorer `);
  assert.deepEqual(draft.input(`${text}@explorer `), {});
});

test("removing a mention chip removes exactly its identity and token text", () => {
  const draft = createInputDraft();
  const first = draft.selectMention({ kind: "skill", skill: lint }, 0, 0);
  draft.selectMention(
    { kind: "subagent", subagent: explorer },
    first.text.length,
    first.text.length,
  );
  const [skillMention] = draft.getSnapshot().mentions;
  const removed = draft.removeMention(skillMention);
  assert.deepEqual(removed, { text: "@explorer ", cursor: 0 });
  assert.deepEqual(draft.input("@explorer ").subagent_mentions, [
    { name: "explorer", start: 0, end: 9 },
  ]);
  assert.equal(
    draft.removeMention(skillMention),
    null,
    "stale chip is a no-op",
  );
});

test(`at most ${MAX_MENTIONS} selected mentions are admitted`, () => {
  const draft = createInputDraft();
  for (let index = 0; index < MAX_MENTIONS; index++) {
    const end = draft.getSnapshot().text.length;
    draft.selectMention({ kind: "skill", skill: lint }, end, end);
  }
  const end = draft.getSnapshot().text.length;
  assert.throws(
    () => draft.selectMention({ kind: "skill", skill: lint }, end, end),
    /at most 64 mentions/,
  );
});

function memoryImages(): PendingImageStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async put(name, value) {
      values.set(name, structuredClone(value));
    },
    async get(name) {
      return (values.get(name) as never) ?? null;
    },
    async delete(name) {
      values.delete(name);
    },
  };
}
async function harness(
  storage = memorySubmissionStorage(),
  images = memoryImages(),
) {
  const calls: unknown[] = [];
  let deliver!: (value: unknown) => Promise<void>;
  let failure: Error | null = null;
  const api: RunApi = {
    async setMode(id, mode) {
      return { conversation_id: id, mode };
    },
    async decidePlan() {
      throw new Error("No plan decisions in mention tests");
    },
    async answer() {
      throw new Error("No answers in mention tests");
    },
    async configure() {
      throw new Error("No configuration in mention tests");
    },
    async checkOverlap() {
      return { cwd: "/project", conversations: [] };
    },
    async readChild() {
      throw new Error("No child reads in mention tests");
    },
    async submit(id, key, text, extras) {
      calls.push(structuredClone({ id, key, text, ...extras }));
      if (failure) throw failure;
      return { conversation_id: id, submission_key: key, request_id: "r" };
    },
    async cancel(id, request) {
      return {
        conversation_id: id,
        request_id: request,
        cancel_requested: true,
      };
    },
    async readEntries(_id, cut) {
      return {
        cut,
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      };
    },
    async watch(_id, signal, _connected, onView) {
      deliver = onView;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  const run = createCodingRun("conversation", api, () => "submission", {
    storage: () => storage,
    imageStorage: () => images,
  });
  run.connect();
  await deliver({
    subscription: "view",
    position: 1,
    event: {
      type: "start",
      recovering: false,
      root: { cut: { journal: "root", leaf: null }, live_invocations: [] },
      state: {
        info: { id: "conversation", cwd: "/project" },
        configuration: {
          provider: "p",
          model: "m",
          mode: "build",
          reasoning: null,
        },
        active_request: null,
        requests: [],
        pending_user_request: false,
      },
    },
  });
  return {
    run,
    calls,
    storage,
    images,
    fail(reason: Error | null) {
      failure = reason;
    },
  };
}

test("both mention kinds and exact image bytes survive uncertain delivery, reload and retry", async () => {
  const storage = memorySubmissionStorage();
  const images = memoryImages();
  const first = await harness(storage, images);
  first.fail(new Error("Lost response"));
  const input = {
    skill_mentions: [{ name: "lint", start: 10, end: 15 }],
    subagent_mentions: [{ name: "explorer", start: 0, end: 9 }],
    images: [{ mime_type: "image/png", data: "b3JpZ2luYWw=" }],
  };
  await first.run.send("@explorer @lint go", input);
  const record = JSON.parse(
    storage.getItem(pendingSubmissionStorageKey("conversation")) ?? "{}",
  );
  assert.equal(record.version, 2);
  assert.equal(record.images, undefined, "bytes never enter localStorage");
  assert.deepEqual(record.subagent_mentions, input.subagent_mentions);
  first.run.detach();
  const reopened = await harness(storage, images);
  assert.deepEqual(
    reopened.run.getSnapshot().uncertainSubmission?.subagent_mentions,
    input.subagent_mentions,
  );
  assert.equal(await reopened.run.retrySubmission(), true);
  assert.deepEqual(reopened.calls, [first.calls[0]]);
  assert.deepEqual(
    (reopened.calls[0] as { images: unknown }).images,
    input.images,
  );
  reopened.run.detach();
});

test("file references survive uncertain delivery, reload and retry with the same identity", async () => {
  const storage = memorySubmissionStorage();
  const first = await harness(storage);
  first.fail(new Error("Lost response"));
  const text = 'check @"My Docs/" @src/a.ts';
  const file_mentions = [
    { path: "My Docs", kind: "directory" as const, start: 6, end: 17 },
    { path: "src/a.ts", kind: "file" as const, start: 18, end: 27 },
  ];
  await first.run.send(text, { file_mentions });
  const record = JSON.parse(
    storage.getItem(pendingSubmissionStorageKey("conversation")) ?? "{}",
  );
  assert.deepEqual(record.file_mentions, file_mentions);
  first.run.detach();
  const reopened = await harness(storage);
  assert.deepEqual(
    reopened.run.getSnapshot().uncertainSubmission?.file_mentions,
    file_mentions,
  );
  assert.equal(await reopened.run.retrySubmission(), true);
  assert.deepEqual(reopened.calls, [first.calls[0]]);
  assert.deepEqual(
    (reopened.calls[0] as { file_mentions: unknown }).file_mentions,
    file_mentions,
  );
  reopened.run.detach();
});

test("retry refuses when stored image bytes are missing or altered; nothing different is sent", async () => {
  for (const damage of ["missing", "altered"] as const) {
    const storage = memorySubmissionStorage();
    const images = memoryImages();
    const first = await harness(storage, images);
    first.fail(new Error("Lost response"));
    await first.run.send("look", {
      images: [{ mime_type: "image/png", data: "b3JpZ2luYWw=" }],
    });
    first.run.detach();
    const name = pendingSubmissionStorageKey("conversation");
    if (damage === "missing") images.values.delete(name);
    else
      images.values.set(name, {
        key: "submission",
        images: [{ mime_type: "image/png", data: "Y2hhbmdlZA==" }],
      });
    const reopened = await harness(storage, images);
    assert.equal(await reopened.run.retrySubmission(), false, damage);
    assert.deepEqual(reopened.calls, [], damage);
    assert.match(
      reopened.run.getSnapshot().error ?? "",
      /original images.*not retried with different content/,
    );
    assert.ok(reopened.run.getSnapshot().uncertainSubmission, damage);
    reopened.run.detach();
  }
});

test("a send refused after the composer cleared its text keeps that input restorable", async () => {
  const h = await harness();
  h.fail(new Error("Lost response"));
  await h.run.send("first", {});
  const draft = createInputDraft();
  draft.syncText("@explorer next ");
  draft.selectMention(
    { kind: "subagent", subagent: explorer },
    0,
    "@explorer ".length,
  );
  const text = draft.getSnapshot().text;
  const onNew = codingRunAdapter(h.run.getSnapshot(), h.run, draft).onNew;
  assert.ok(onNew);
  await onNew({
    parentId: null,
    sourceId: null,
    role: "user",
    content: [{ type: "text", text }],
    attachments: [],
    createdAt: new Date(),
    metadata: { custom: {} },
    runConfig: {},
  });
  assert.equal(h.calls.length, 1, "nothing new is delivered");
  const retained = h.run.getSnapshot().rejectedSubmission;
  assert.equal(retained?.text, text);
  assert.deepEqual(retained?.subagent_mentions, [
    { name: "explorer", start: 0, end: 9 },
  ]);
  assert.match(h.run.getSnapshot().error ?? "", /Reconcile.*input is retained/);
  h.run.detach();
});
