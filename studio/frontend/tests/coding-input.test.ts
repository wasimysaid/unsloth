// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import {
  MAX_IMAGE_BYTES,
  createInputDraft,
  editMentions,
  imageSignature,
  readCodingImage,
} from "../src/features/coding/input.ts";
import { codingRunAdapter } from "../src/features/coding/run-runtime.ts";
import { createCodingRun } from "../src/features/coding/run-session.ts";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const skill = {
  name: "review",
  qualified_name: "plugin:alpha:review",
  description: "Review A",
};
test("qualified-name collisions stay distinct, edits track exact mentions and Unicode native ranges", () => {
  const draft = createInputDraft();
  draft.syncText("Please ");
  draft.selectSkill(skill, 7, 7);
  let text = draft.getSnapshot().text;
  draft.selectSkill(
    { ...skill, qualified_name: "plugin:beta:review" },
    text.length,
    text.length,
  );
  text = draft.getSnapshot().text;
  draft.syncText(`😀 ${text}`);
  const value = draft.input(`😀 ${text}`);
  assert.deepEqual(
    value.skill_mentions?.map(({ name }) => name),
    ["plugin:alpha:review", "plugin:beta:review"],
  );
  assert.equal(value.skill_mentions?.[0].start, 12); // 5 UTF-8 emoji/space bytes + 7 ASCII bytes
  assert.equal(value.skill_mentions?.[0].end, 32);
  const changed = draft
    .getSnapshot()
    .text.replace("alpha:review", "alpha:reviews");
  draft.syncText(changed);
  assert.deepEqual(
    draft.input(changed).skill_mentions?.map(({ name }) => name),
    ["plugin:beta:review"],
  );
  draft.syncText("replaced everything");
  assert.deepEqual(draft.input("replaced everything"), {});
});
test("disk skill input preserves its exact native descriptor path, including restored Unicode ranges", () => {
  const draft = createInputDraft();
  draft.syncText("😀 ");
  const selected = draft.selectSkill(
    {
      name: "review",
      qualified_name: "review",
      description: "Disk skill",
      path: "/effective/project/.agents/skills/review/SKILL.md",
    },
    3,
    3,
  );
  const extras = draft.input(selected.text);
  assert.deepEqual(extras.skill_mentions, [
    {
      name: "review",
      path: "/effective/project/.agents/skills/review/SKILL.md",
      start: 5,
      end: 12,
    },
  ]);
  const restored = createInputDraft();
  restored.restore({ text: selected.text, ...extras });
  assert.deepEqual(restored.input(selected.text), extras);
});

test("repeated selected skill insertion and replacement use explicit editing ranges without overlaps", () => {
  const draft = createInputDraft();
  const disk = {
    name: "review",
    qualified_name: "review",
    description: "Disk skill",
    path: "/project/review/SKILL.md",
  };
  draft.selectSkill(disk, 0, 0);
  draft.selectSkill(disk, 0, 0);
  let text = draft.getSnapshot().text;
  assert.equal(text, "@review @review ");
  assert.deepEqual(draft.input(text).skill_mentions, [
    { name: "review", path: disk.path, start: 0, end: 7 },
    { name: "review", path: disk.path, start: 8, end: 15 },
  ]);
  draft.selectSkill(disk, 0, 7);
  text = draft.getSnapshot().text;
  assert.equal(draft.input(text).skill_mentions?.length, 2);
  const length = text.length;
  draft.selectSkill(disk, length, length);
  assert.equal(draft.input(draft.getSnapshot().text).skill_mentions?.length, 3);
});

test("deleting selected versus literal repeated text respects the actual edit range", () => {
  const disk = {
    ...skill,
    qualified_name: "review",
    path: "/project/review/SKILL.md",
  };
  const selected = createInputDraft();
  selected.selectSkill(disk, 0, 0);
  selected.syncText("@review @review ", { start: 8, end: 8 });
  selected.syncText("@review ", { start: 0, end: 8 });
  assert.deepEqual(selected.input("@review "), {});

  const literal = createInputDraft();
  literal.selectSkill(disk, 0, 0);
  literal.syncText("@review @review ", { start: 8, end: 8 });
  literal.syncText("@review ", { start: 8, end: 16 });
  assert.deepEqual(literal.input("@review ").skill_mentions, [
    { name: "review", path: disk.path, start: 0, end: 7 },
  ]);
  // Replacing the selected occurrence with equal literal bytes still removes it.
  literal.syncText("@review ", { start: 0, end: 7 });
  assert.deepEqual(literal.input("@review "), {});

  const uncertain = createInputDraft();
  uncertain.selectSkill(disk, 0, 0);
  uncertain.syncText("@review @review ");
  assert.deepEqual(uncertain.input("@review @review "), {});
});

test("insertions at mention boundaries preserve the token; insertions inside invalidate it", () => {
  const mention = { name: "qualified", start: 0, end: 10, token: "@qualified" };
  assert.deepEqual(editMentions("@qualified", "x@qualified", [mention]), [
    { ...mention, start: 1, end: 11 },
  ]);
  assert.deepEqual(editMentions("@qualified", "@qualified ", [mention]), [
    mention,
  ]);
  assert.deepEqual(editMentions("@qualified", "@qualifiedx", [mention]), []);
  assert.deepEqual(editMentions("@qualified", "@quxalified", [mention]), []);
  assert.deepEqual(editMentions("@qualified", "", [mention]), []);
});
test("image attachment contract rejects unsupported, empty, oversized and spoofed images without silently adding them", async () => {
  await assert.rejects(
    readCodingImage(
      new File(["<svg/>"], "script.svg", { type: "image/svg+xml" }),
    ),
    /supported images/,
  );
  await assert.rejects(
    readCodingImage(new File([], "empty.png", { type: "image/png" })),
    /nonempty/,
  );
  await assert.rejects(
    readCodingImage(
      new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.png", {
        type: "image/png",
      }),
    ),
    /512 KiB/,
  );
  await assert.rejects(
    readCodingImage(new File(["not a PNG"], "fake.png", { type: "image/png" })),
    /do not match/,
  );
  assert.equal(
    imageSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    "image/png",
  );
  assert.equal(imageSignature(new Uint8Array([255, 216, 255])), "image/jpeg");
  const draft = createInputDraft();
  const image = {
    id: "image",
    filename: "visual.png",
    mime_type: "image/png",
    data: "AA==",
    bytes: MAX_IMAGE_BYTES,
  };
  draft.addImages([image]);
  assert.throws(
    () => draft.addImages([{ ...image, id: "extra", bytes: 1 }]),
    /total at most/,
  );
  assert.equal(draft.getSnapshot().images.length, 1);
  draft.removeImage("image");
  assert.equal(draft.getSnapshot().images.length, 0);
  assert.throws(
    () =>
      draft.addImages(
        Array.from({ length: 5 }, (_, index) => ({
          ...image,
          id: String(index),
          bytes: 1,
        })),
      ),
    /at most 4/,
  );
});

async function harness(storage = memorySubmissionStorage()) {
  const calls: unknown[] = [];
  let deliver!: (value: unknown) => Promise<void>;
  let failure: Error | null = null;
  const api: RunApi = {
    async configure() {
      throw new Error("Unexpected configuration change in rich-input test");
    },
    async submit(id, key, text, extras) {
      calls.push(structuredClone({ id, key, text, ...extras }));
      if (failure) throw failure;
      return {
        conversation_id: id,
        submission_key: key,
        request_id: "native-request",
      };
    },
    async cancel(id, requestId) {
      return {
        conversation_id: id,
        request_id: requestId,
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
  const run = createCodingRun("conversation", api, () => "submission-exact", {
    storage: () => storage,
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
          provider: "external",
          model: "vision",
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
    fail(reason: Error | null) {
      failure = reason;
    },
  };
}
test("reopening preserves the full rich-input payload and retries its original identity", async () => {
  const storage = memorySubmissionStorage();
  const first = await harness(storage);
  first.fail(new Error("Lost response"));
  const extras = {
    skill_mentions: [
      { name: "review", path: "/project/skill.md", start: 0, end: 7 },
    ],
    images: [{ mime_type: "image/png", data: "original-image-bytes" }],
  };
  await first.run.send("@review inspect", extras);
  const expected = structuredClone(first.calls[0]);
  first.run.detach();
  extras.images[0].data = "changed after send";
  const reopened = await harness(storage);
  assert.equal(
    reopened.calls.length,
    0,
    "reopen must not replay automatically",
  );
  assert.equal(
    reopened.run.getSnapshot().uncertainSubmission?.images?.[0].data,
    "original-image-bytes",
  );
  assert.equal(await reopened.run.retrySubmission(), true);
  assert.deepEqual(reopened.calls, [expected]);
  assert.equal(reopened.run.getSnapshot().uncertainSubmission, null);
  reopened.run.detach();
});

test("uncertain delivery retains the exact text/skill/image snapshot and retries the same key, with no accepted local row", async () => {
  const h = await harness();
  h.fail(new Error("Lost response"));
  const input = {
    skill_mentions: [{ name: skill.qualified_name, start: 0, end: 20 }],
    images: [{ mime_type: "image/png", data: "exact-image-bytes" }],
  };
  await h.run.send("@plugin:alpha:review", input);
  input.images[0].data = "later edit";
  input.skill_mentions[0].name = "other";
  assert.equal(
    h.run.getSnapshot().uncertainSubmission?.images?.[0].data,
    "exact-image-bytes",
  );
  assert.deepEqual(h.run.getSnapshot().rows, []);
  h.fail(null);
  await h.run.retrySubmission();
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  h.run.detach();
});
test("native rejection retains actionable rich input for restoration; adapter never marks it accepted", async () => {
  const h = await harness();
  h.fail(new CodingHttpError(422, "Provider does not support images"));
  const draft = createInputDraft();
  draft.syncText("@plugin:alpha:review ");
  draft.selectSkill(skill, 0, draft.getSnapshot().text.length);
  draft.addImages([
    {
      id: "visual",
      filename: "visual.png",
      mime_type: "image/png",
      data: "AA==",
      bytes: 1,
    },
  ]);
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
  const rejected = h.run.getSnapshot().rejectedSubmission;
  assert.ok(rejected);
  assert.equal(rejected.text, text);
  assert.equal(rejected.images?.length, 1);
  assert.equal(draft.getSnapshot().images.length, 1);
  assert.equal(h.run.getSnapshot().uncertainSubmission, null);
  assert.deepEqual(h.run.getSnapshot().rows, []);
  const restored = createInputDraft();
  restored.restore(rejected);
  assert.deepEqual(restored.input(text), {
    skill_mentions: rejected.skill_mentions,
    images: rejected.images,
  });
  h.run.detach();
});
