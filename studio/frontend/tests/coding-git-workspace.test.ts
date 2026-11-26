// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { createGitWorkspaceClient } from "../src/features/coding/git-workspace-client.ts";

test("the branch control and panel share an in-flight comparison and a later refresh reads Git again", async () => {
  let calls = 0;
  const client = createGitWorkspaceClient("source", {
    async command(id, name, tail, operation_id) {
      calls++;
      assert.equal(name, "git-workspace");
      assert.deepEqual(JSON.parse(tail), {
        op: "changes",
        comparison: "task",
        offset: 0,
      });
      return {
        conversation_id: id,
        operation_id,
        outcome: "display",
        text: JSON.stringify({
          files: [],
          base: "123",
          total: 0,
          next_offset: null,
        }),
      };
    },
  });
  const first = client.changes("task");
  assert.equal(first, client.changes("task"));
  await first;
  assert.equal(calls, 1);
  await client.changes("task");
  assert.equal(calls, 2);
});

test("a clipped patch is rejected and its rename and untracked selectors reach Git", async () => {
  const client = createGitWorkspaceClient("source", {
    async command(id, _name, tail, operation_id) {
      assert.deepEqual(JSON.parse(tail), {
        op: "patch",
        comparison: "task",
        path: "next",
        old_path: "before",
        untracked: false,
      });
      return {
        conversation_id: id,
        operation_id,
        outcome: "display",
        text: "{}",
        clipped: true,
      };
    },
  });
  await assert.rejects(
    client.patch("task", {
      status: "renamed",
      path: "next",
      old_path: "before",
    }),
    /incomplete/,
  );
});

test("an unrelated worktree result cannot navigate the active conversation", async () => {
  const client = createGitWorkspaceClient("source", {
    async command(id, _name, _tail, operation_id) {
      return {
        conversation_id: id,
        operation_id,
        outcome: "display",
        text: JSON.stringify({
          checkout: "/somewhere",
          id: "another-task",
          head: "abc",
          branch: "mimir/another-task",
          base: "abc",
        }),
      };
    },
  });
  await assert.rejects(client.create("task"), /confirm the requested worktree/);
});
