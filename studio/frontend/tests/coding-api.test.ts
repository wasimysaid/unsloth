// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import type * as Coding from "../src/features/coding/api.ts";
import * as codingErrors from "../src/features/coding/errors.ts";
import {
  CodingHttpError,
  CodingOverlapError,
} from "../src/features/coding/errors.ts";
import { consumeCodingEvents } from "../src/features/coding/events.ts";
import * as fastApiError from "../src/lib/format-fastapi-error.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

function client(response: () => Response) {
  const requests: { path: string; init?: RequestInit; options: unknown }[] = [];
  const api = loadWithStubs<typeof Coding>(
    new URL("../src/features/coding/api.ts", import.meta.url),
    {
      "@/features/auth/api": {
        authFetch: async (
          path: string,
          init?: RequestInit,
          options?: unknown,
        ) => {
          requests.push({ path, init, options });
          return response();
        },
      },
      "@/lib/format-fastapi-error": fastApiError,
      "./events": { consumeCodingEvents },
      "./errors": codingErrors,
    },
  );
  return { api, requests };
}

test("browse uses authenticated host API with query encoding and cancellation", async () => {
  const directory = {
    path: "/canonical",
    parent: "/",
    entries: [{ name: "project", path: "/canonical/project" }],
    truncated: false,
  };
  const c = client(() => Response.json(directory));
  const abort = new AbortController();
  assert.deepEqual(
    await c.api.codingApi.browseProjects("/host/a & b?", abort.signal),
    directory,
  );
  assert.equal(
    c.requests[0].path,
    "/api/coding/projects/browse?path=%2Fhost%2Fa+%26+b%3F",
  );
  assert.equal(c.requests[0].init?.signal, abort.signal);
});

test("native creation sends only cwd with no transport replay, prompts, settings or tools", async () => {
  const native = { id: "native-1", cwd: "/canonical/project" };
  const c = client(() => Response.json(native));
  assert.deepEqual(
    await c.api.codingApi.createConversation("/host/link"),
    native,
  );
  assert.deepEqual(c.requests, [
    {
      path: "/api/coding/conversations",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/host/link" }),
      },
      options: { retryNetworkErrors: false },
    },
  ]);
});

test("list and explicit reopen consume native records; IDs are encoded as one path segment", async () => {
  const row = { id: "native/id?", cwd: "/saved" };
  let listing = true;
  const c = client(() =>
    Response.json(listing ? { conversations: [row], next_cursor: null } : row),
  );
  assert.deepEqual(await c.api.codingApi.listConversations(), [row]);
  listing = false;
  assert.deepEqual(await c.api.codingApi.openConversation(row.id), row);
  assert.equal(c.requests[0].path, "/api/coding/conversations");
  assert.equal(
    c.requests[1].path,
    "/api/coding/conversations/native%2Fid%3F/open",
  );
  assert.deepEqual(c.requests[1].init, { method: "POST" });
});

test("native pagination is fully followed with encoded cursors", async () => {
  let page = 0;
  const c = client(() =>
    Response.json({
      conversations: [{ id: `native-${++page}`, cwd: `/project-${page}` }],
      next_cursor: page === 1 ? "next & page?" : null,
    }),
  );
  assert.deepEqual(
    (await c.api.codingApi.listConversations()).map((row) => row.id),
    ["native-1", "native-2"],
  );
  assert.deepEqual(
    c.requests.map((request) => request.path),
    [
      "/api/coding/conversations",
      "/api/coding/conversations?cursor=next+%26+page%3F",
    ],
  );
});

test("an endless or repeated catalog fails explicitly rather than showing incomplete history", async () => {
  const repeated = client(() =>
    Response.json({ conversations: [], next_cursor: "same" }),
  );
  await assert.rejects(
    repeated.api.codingApi.listConversations(),
    /repeated a page cursor/,
  );
  assert.equal(repeated.requests.length, 2);
  let page = 0;
  const unending = client(() =>
    Response.json({ conversations: [], next_cursor: String(++page) }),
  );
  await assert.rejects(
    unending.api.codingApi.listConversations(),
    /exceeded 100 pages.*full history could not be loaded/,
  );
  assert.equal(unending.requests.length, 100);
});

test("missing or malformed native page cursors cannot silently mean complete history", async () => {
  for (const nextCursor of [undefined, "", 42]) {
    const c = client(() =>
      Response.json({ conversations: [], next_cursor: nextCursor }),
    );
    await assert.rejects(
      c.api.codingApi.listConversations(),
      /invalid page cursor/,
    );
  }
});

test("native auth/validation/availability errors remain errors, not successful openings", async () => {
  for (const status of [401, 403, 404, 422, 503]) {
    const c = client(() =>
      Response.json({ detail: "Native opening rejected" }, { status }),
    );
    await assert.rejects(
      c.api.codingApi.createConversation("/bad"),
      /Native opening rejected/,
    );
  }
  const c = client(() => new Response("gateway failed", { status: 502 }));
  await assert.rejects(
    c.api.codingApi.openConversation("saved"),
    /Coding request failed \(502\)/,
  );
});

test("run and Stop carry exact native identities without implicit transport retries", async () => {
  const c = client(() =>
    Response.json({
      conversation_id: "conversation/id",
      request_id: "request/id",
      submission_key: "same-key",
      cancel_requested: true,
    }),
  );
  await c.api.codingRunApi.submit("conversation/id", "same-key", "Work once");
  await c.api.codingRunApi.cancel("conversation/id", "request/id");
  await c.api.codingRunApi.readEntries(
    "conversation/id",
    { journal: "root", leaf: "captured-leaf" },
    { after: "previous-leaf" },
  );
  assert.deepEqual(
    c.requests.map((request) => request.path),
    [
      "/api/coding/conversations/conversation%2Fid/prompts",
      "/api/coding/conversations/conversation%2Fid/requests/request%2Fid/cancel",
      "/api/coding/conversations/conversation%2Fid/entries",
    ],
  );
  assert.deepEqual(JSON.parse(String(c.requests[0].init?.body)), {
    submission_key: "same-key",
    text: "Work once",
  });
  assert.equal(c.requests[1].init?.body, undefined);
  assert.deepEqual(JSON.parse(String(c.requests[2].init?.body)), {
    cut: { journal: "root", leaf: "captured-leaf" },
    anchor: { after: "previous-leaf" },
    max_entries: 100,
    max_bytes: 262144,
  });
  for (const request of c.requests)
    assert.deepEqual(request.options, { retryNetworkErrors: false });
});

test("child inspection carries exact attempt and immutable child journal through authenticated read-only APIs", async () => {
  const detail = {
    child: null,
    outcome: {
      handle: "agent-native",
      attempt: 7,
      status: "failed",
      result: null,
      error: "Retained failure",
    },
  };
  const c = client(() => Response.json(detail));
  const abort = new AbortController();
  assert.deepEqual(
    await c.api.codingRunApi.readChild(
      "conversation/id?",
      "agent-native",
      7,
      abort.signal,
    ),
    detail,
  );
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/conversation%2Fid%3F/children/agent-native/attempts/7",
  );
  assert.equal(c.requests[0].init?.signal, abort.signal);
  assert.equal(c.requests[0].init?.body, undefined);
  const cut = { journal: { child: "agent-native" }, leaf: "child-cut" };
  await c.api.codingRunApi.readEntries(
    "conversation/id?",
    cut,
    "latest",
    abort.signal,
  );
  assert.deepEqual(JSON.parse(String(c.requests[1].init?.body)), {
    cut,
    anchor: "latest",
    max_entries: 100,
    max_bytes: 262144,
  });
  for (const request of c.requests)
    assert.deepEqual(request.options, { retryNetworkErrors: false });
});

test("effective skills and rich prompt inputs use authenticated exact-ID transport without replay", async () => {
  const discovered = {
    skills: [
      {
        name: "review",
        qualified_name: "plugin:alpha:review",
        description: "Metadata only",
      },
    ],
  };
  const c = client(() => Response.json(discovered));
  const abort = new AbortController();
  assert.deepEqual(
    await c.api.discoverCodingSkills("native/id", abort.signal),
    discovered,
  );
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/native%2Fid/skills",
  );
  assert.equal(c.requests[0].init?.signal, abort.signal);
  const extras = {
    skill_mentions: [{ name: "plugin:alpha:review", start: 0, end: 20 }],
    images: [{ mime_type: "image/png", data: "exact-base64" }],
  };
  await c.api.codingRunApi.submit(
    "native/id",
    "same-key",
    "@plugin:alpha:review",
    extras,
  );
  assert.deepEqual(JSON.parse(String(c.requests[1].init?.body)), {
    submission_key: "same-key",
    text: "@plugin:alpha:review",
    ...extras,
  });
  assert.deepEqual(c.requests[1].options, { retryNetworkErrors: false });
});

test("event stream uses authenticated fetch, exposes a disconnect event and is cancellable", async () => {
  const text = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        text.encode(
          'event:view\ndata:{"native":"view"}\n\nevent:disconnected\ndata:{"detail":"Native frontend stopped"}\n\n: heartbeat\n\n',
        ),
      );
    },
  });
  const c = client(
    () =>
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  );
  const abort = new AbortController();
  let connected = false;
  await assert.rejects(
    c.api.watchCodingConversation("native/id", abort.signal, () => {
      connected = true;
    }),
    /Native frontend stopped/,
  );
  assert.equal(connected, true);
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/native%2Fid/events",
  );
  assert.equal(c.requests[0].init?.signal, abort.signal);
  assert.deepEqual(c.requests[0].init?.headers, {
    Accept: "text/event-stream",
  });
  assert.deepEqual(c.requests[0].options, { retryNetworkErrors: false });
});

test("MCP Settings reads and saves only native scoped identities, without caches or replay", async () => {
  const draft = {
    edit_id: "native-edit",
    revision: "native-revision",
    source: "native-source",
    name: "server",
    json: "{}",
  };
  const c = client(() => Response.json(draft));
  await c.api.mcpSettingsApi.inventory("native/id");
  await c.api.mcpSettingsApi.edit("native/id", "native-source", "server");
  await c.api.mcpSettingsApi.save("native/id", draft, '{"enabled":false}');
  assert.deepEqual(
    c.requests.map((row) => row.path),
    [
      "/api/coding/conversations/native%2Fid/mcp/inventory",
      "/api/coding/conversations/native%2Fid/mcp/edit",
      "/api/coding/conversations/native%2Fid/mcp/save",
    ],
  );
  assert.deepEqual(JSON.parse(c.requests[1].init?.body as string), {
    source: "native-source",
    name: "server",
  });
  assert.deepEqual(JSON.parse(c.requests[2].init?.body as string), {
    edit_id: "native-edit",
    revision: "native-revision",
    json: '{"enabled":false}',
  });
  assert.ok(c.requests.every((row) => row.init?.cache === "no-store"));
  assert.ok(
    c.requests.every(
      (row) =>
        (row.options as { retryNetworkErrors: boolean }).retryNetworkErrors ===
        false,
    ),
  );
});

test("MCP native errors stay actionable refusals, never successful persistence", async () => {
  const draft = {
    edit_id: "native-edit",
    revision: "native-revision",
    source: "native-source",
    name: "server",
    json: "{}",
  };
  for (const status of [400, 403, 409, 502, 504]) {
    const c = client(() =>
      Response.json({ detail: "Native refusal; draft retained" }, { status }),
    );
    await assert.rejects(
      c.api.mcpSettingsApi.save("native-id", draft, "my draft"),
      /Native refusal; draft retained/,
    );
    assert.equal(c.requests.length, 1);
  }
});

test("coding transport failure stays unconfirmed without claiming native work died or suggesting relaunch", async () => {
  const transport = Object.assign(
    new Error("Unsloth isn't running -- please relaunch it."),
    { unslothTransportFailure: true },
  );
  const c = client(() => {
    throw transport;
  });
  await assert.rejects(
    c.api.codingRunApi.readEntries(
      "conversation",
      { journal: "root", leaf: "captured" },
      "latest",
    ),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(
        reason.message,
        /Coding response unconfirmed.*work may still be running/,
      );
      assert.doesNotMatch(reason.message, /relaunch|isn't running/);
      assert.equal(reason.cause, transport);
      assert.equal("admissionRejected" in reason, false);
      return true;
    },
  );
  assert.equal(
    c.requests.length,
    1,
    "transport loss must not replay a coding request",
  );
});

test("coding request preserves abort and non-transport authentication errors", async () => {
  for (const original of [
    new DOMException("Detached", "AbortError"),
    new Error("Another tab is switching accounts; this tab will reload."),
  ]) {
    const c = client(() => {
      throw original;
    });
    await assert.rejects(
      c.api.codingApi.openConversation("saved"),
      (reason: unknown) => reason === original,
    );
    assert.equal(c.requests.length, 1);
  }
});

test("overlap preflight authenticates exact identity and confirmation is explicit", async () => {
  const overlap = {
    cwd: "/canonical/project",
    conversations: [{ id: "other" }],
  };
  const c = client(() => Response.json(overlap));
  assert.deepEqual(await c.api.codingRunApi.checkOverlap("native/id"), overlap);
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/native%2Fid/overlap",
  );
  await c.api.codingRunApi.submit("native/id", "key", "warned draft", undefined, true);
  assert.deepEqual(JSON.parse(String(c.requests[1].init?.body)), {
    submission_key: "key",
    text: "warned draft",
    overlap_confirmed: true,
  });
  assert.deepEqual(c.requests[0].options, { retryNetworkErrors: false });
});

test("structured overlap refusal is distinct from native busy/capacity and malformed preflight fails closed", async () => {
  const overlap = {
    cwd: "/canonical/project",
    conversations: [{ id: "other" }],
  };
  const c = client(() =>
    Response.json(
      {
        detail: {
          code: "overlap_required",
          message: "Review overlap",
          overlap,
        },
      },
      { status: 409 },
    ),
  );
  await assert.rejects(
    c.api.codingRunApi.submit("id", "key", "draft"),
    (error: unknown) => {
      assert.ok(error instanceof CodingOverlapError);
      assert.deepEqual(error.overlap, overlap);
      return true;
    },
  );
  for (const status of [409, 429]) {
    const busy = client(() =>
      Response.json(
        { detail: "Wait for native capacity or close its owner." },
        { status },
      ),
    );
    await assert.rejects(
      busy.api.codingRunApi.submit("id", "key", "draft"),
      (error: unknown) => {
        assert.ok(error instanceof CodingHttpError);
        assert.equal(error.admissionRejected, true);
        return true;
      },
    );
  }
  const malformed = client(() =>
    Response.json({ cwd: "/alias", conversations: [{ id: null }] }),
  );
  await assert.rejects(
    malformed.api.codingRunApi.checkOverlap("id"),
    /could not be confirmed.*No prompt was sent/,
  );
});
