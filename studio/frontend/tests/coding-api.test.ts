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
import { createCodingRun } from "../src/features/coding/run-session.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";
import * as fastApiError from "../src/lib/format-fastapi-error.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

function client(
  response: (path: string, init?: RequestInit) => Response | Promise<Response>,
) {
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
          return response(path, init);
        },
      },
      "@/lib/format-fastapi-error": fastApiError,
      "./events": { consumeCodingEvents },
      "./errors": codingErrors,
    },
  );
  return { api, requests };
}

test("mode and plan decisions are separate authenticated non-replayed commands with exact revision", async () => {
  const c = client(() => Response.json({ conversation_id: "conversation/id" }));
  await c.api.createCodingRunApi(7).setMode("conversation/id", "plan");
  await c.api.createCodingRunApi(7).decidePlan(
    "conversation/id",
    {
      id: "plan-id",
      revision: "native-revision",
      name: "Plan",
      path: "/plan.md",
      markdown: "# Plan",
      status: "review_pending",
    },
    "implement_fresh",
  );
  assert.deepEqual(
    c.requests.map(({ path, init, options }) => ({
      path,
      body: JSON.parse(String(init?.body)),
      options,
    })),
    [
      {
        path: "/api/coding/conversations/conversation%2Fid/mode",
        body: { mode: "plan" },
        options: { retryNetworkErrors: false },
      },
      {
        path: "/api/coding/conversations/conversation%2Fid/plan-actions",
        body: {
          plan_id: "plan-id",
          revision: "native-revision",
          decision: "implement_fresh",
        },
        options: { retryNetworkErrors: false },
      },
    ],
  );
  for (const request of c.requests)
    assert.equal(new Headers(request.init?.headers).get("X-Mimir-Runtime-Generation"), "7");
});

test("goal changes carry exact native revision and action without transport replay or fabricated completion", async () => {
  const result = { conversation_id: "native/id?", request_id: null };
  const c = client(() => Response.json(result));
  const change = {
    action: "pause" as const,
    revision: "native-owner-goal-revision",
  };
  assert.deepEqual(
    await c.api.createCodingRunApi(7).changeGoal!(result.conversation_id, change),
    result,
  );
  assert.deepEqual(c.requests, [
    {
      path: "/api/coding/conversations/native%2Fid%3F/goal",
      init: {
        method: "POST",
        headers: { "X-Mimir-Runtime-Generation": "7", "Content-Type": "application/json" },
        body: JSON.stringify(change),
      },
      options: { retryNetworkErrors: false },
    },
  ]);
  const stale = client(() =>
    Response.json({ detail: "Goal controls are stale" }, { status: 409 }),
  );
  await assert.rejects(
    stale.api.createCodingRunApi(7).changeGoal!("id", change),
    /stale/,
  );
});

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
  const native = {
    id: "native-1",
    cwd: "/canonical/project",
    runtime_generation: 7,
  };
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
  const row = { id: "native/id?", cwd: "/saved", runtime_generation: 7 };
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
  await c.api
    .createCodingRunApi(7)
    .submit("conversation/id", "same-key", "Work once");
  await c.api.createCodingRunApi(7).cancel("conversation/id", "request/id");
  await c.api
    .createCodingRunApi(7)
    .readEntries(
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
  for (const request of c.requests) {
    assert.deepEqual(request.options, { retryNetworkErrors: false });
    assert.equal(
      new Headers(request.init?.headers).get("X-Mimir-Runtime-Generation"),
      "7",
    );
  }
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
    await c.api.createCodingRunApi(7).readChild(
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
  await c.api.createCodingRunApi(7).readEntries(
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
  await c.api.createCodingRunApi(7).submit(
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
    c.api.createCodingRunApi(7).watch(
      "native/id",
      abort.signal,
      () => {
        connected = true;
      },
      async () => {},
    ),
    /Native frontend stopped/,
  );
  assert.equal(connected, true);
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/native%2Fid/events",
  );
  assert.equal(c.requests[0].init?.signal, abort.signal);
  assert.deepEqual(c.requests[0].init?.headers, {
    "X-Mimir-Runtime-Generation": "7",
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

test("picker reads only authenticated native catalog and sends identity patches separately from prompts", async () => {
  const c = client(() => Response.json([]));
  const controller = new AbortController();
  await c.api.codingModelApi.catalog("conversation/id", controller.signal);
  await c.api.createCodingRunApi(7).configure("conversation/id", {
    provider: "provider-id",
    model: "provider-local-id",
  });
  await c.api.createCodingRunApi(7).configure("conversation/id", {
    reasoning: "medium",
  });
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/conversation%2Fid/models",
  );
  assert.equal(c.requests[0].init?.signal, controller.signal);
  assert.equal(
    c.requests[1].path,
    "/api/coding/conversations/conversation%2Fid/configuration",
  );
  assert.deepEqual(JSON.parse(String(c.requests[1].init?.body)), {
    provider: "provider-id",
    model: "provider-local-id",
  });
  assert.deepEqual(JSON.parse(String(c.requests[2].init?.body)), {
    reasoning: "medium",
  });
  for (const request of c.requests.slice(1))
    assert.equal(new Headers(request.init?.headers).get("X-Mimir-Runtime-Generation"), "7");
  assert.ok(
    c.requests.every(
      (request) =>
        JSON.stringify(request.options) === '{"retryNetworkErrors":false}',
    ),
  );
});

test("explicit model refresh updates the native owner without automatic transport retry or prompt options", async () => {
  const c = client(() => Response.json([]));
  const abort = new AbortController();
  await c.api.codingModelApi.refresh("exact/id?", abort.signal);
  assert.deepEqual(c.requests, [
    {
      path: "/api/coding/conversations/exact%2Fid%3F/models/refresh",
      init: { method: "POST", signal: abort.signal, cache: "no-store" },
      options: { retryNetworkErrors: false },
    },
  ]);
  const failure = client(() =>
    Response.json(
      { detail: "Refresh failed; selection retained" },
      { status: 502 },
    ),
  );
  await assert.rejects(
    failure.api.codingModelApi.refresh("c", abort.signal),
    /selection retained/,
  );
  assert.equal(failure.requests.length, 1);
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

test("Settings maintenance encodes exact targets and reconciliation IDs without replay", async () => {
  const c = client(() =>
    Response.json({ operation_id: "one-op", status: "deferred" }),
  );
  await c.api.codingMaintenanceApi.inspect("native/id?", "one-op");
  const result = await c.api.codingMaintenanceApi.reload(
    "native/id?",
    "one-op",
  );
  assert.equal(result.status, "deferred");
  await c.api.readCodingDiagnostics();
  assert.deepEqual(
    c.requests.map((request) => request.path),
    [
      "/api/coding/conversations/native%2Fid%3F/extensions?operation_id=one-op",
      "/api/coding/conversations/native%2Fid%3F/plugins/reload",
      "/api/coding/diagnostics",
    ],
  );
  assert.deepEqual(JSON.parse(c.requests[1].init!.body as string), {
    operation_id: "one-op",
  });
  assert.ok(
    c.requests.every(
      (request) =>
        JSON.stringify(request.options) ===
        JSON.stringify({ retryNetworkErrors: false }),
    ),
  );
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
    c.api
      .createCodingRunApi(7)
      .readEntries(
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

test("answers address exact conversation, request, question and live view without transport replay", async () => {
  const target = {
    subscription: "live-view",
    request_id: "request/id?",
    user_request_id: "question/id?",
  };
  const answers = [
    {
      question_id: "choice",
      selected_options: ["Native label"],
      freeform_text: "Custom answer",
    },
  ];
  const result = {
    conversation_id: "conversation/id?",
    ...target,
    accepted: true,
  };
  const c = client(() => Response.json(result));
  assert.deepEqual(
    await c.api.createCodingRunApi(7).answer(result.conversation_id, target, answers),
    result,
  );
  assert.deepEqual(c.requests, [
    {
      path: "/api/coding/conversations/conversation%2Fid%3F/requests/request%2Fid%3F/questions/question%2Fid%3F/answers",
      init: {
        method: "POST",
        headers: { "X-Mimir-Runtime-Generation": "7", "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: target.subscription, answers }),
      },
      options: { retryNetworkErrors: false },
    },
  ]);
  const loss = client(() => {
    throw new Error("Lost answer acknowledgement");
  });
  await assert.rejects(
    loss.api.createCodingRunApi(7).answer(result.conversation_id, target, answers),
    /Lost answer/,
  );
  assert.equal(loss.requests.length, 1);
});

test("answer HTTP serialization preserves native long fields without truncation or independent caps", async () => {
  const target = { subscription: "live-view", request_id: "request", user_request_id: "user-request" };
  const answers = [{
    question_id: "q".repeat(4096),
    selected_options: ["L".repeat(8192)],
    freeform_text: ` \n${"é".repeat(65537)}\r\n `,
  }];
  const ack = { conversation_id: "conversation", ...target, accepted: true };
  const c = client(() => Response.json(ack));
  assert.deepEqual(await c.api.createCodingRunApi(7).answer("conversation", target, answers), ack);
  assert.equal(c.requests.length, 1);
  assert.deepEqual(JSON.parse(String(c.requests[0].init?.body)), { subscription: target.subscription, answers });
  assert.equal(new Headers(c.requests[0].init?.headers).get("X-Mimir-Runtime-Generation"), "7");
  assert.deepEqual(c.requests[0].options, { retryNetworkErrors: false });
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

test("whole-runtime maintenance carries explicit all-hosted scope and never replays refusal", async () => {
  const status = { state: "running", generation: 2, cleanup: null };
  const c = client(() => Response.json(status));
  assert.deepEqual(await c.api.codingRuntimeApi.readStatus(), status);
  assert.deepEqual(await c.api.codingRuntimeApi.restart(), status);
  assert.deepEqual(
    c.requests.map((request) => request.path),
    ["/api/coding/runtime", "/api/coding/runtime/restart"],
  );
  assert.deepEqual(c.requests[1].init, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "all_hosted_conversations" }),
  });
  assert.deepEqual(c.requests[1].options, { retryNetworkErrors: false });
  const refused = client(() =>
    Response.json(
      { detail: "Native runtime busy; Stop affected work first" },
      { status: 409 },
    ),
  );
  await assert.rejects(
    refused.api.codingRuntimeApi.restart(),
    /Native runtime busy/,
  );
  assert.equal(refused.requests.length, 1);
});

test("create/open must acquire a valid generation; catalog/status cannot supply an inferred fence", async () => {
  for (const generation of [
    undefined,
    0,
    -1,
    1.5,
    "7",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const c = client(() =>
      Response.json({
        id: "saved",
        cwd: "/project",
        runtime_generation: generation,
      }),
    );
    await assert.rejects(
      c.api.codingApi.createConversation("/project"),
      /did not confirm its runtime generation/,
    );
    await assert.rejects(
      c.api.codingApi.openConversation("saved"),
      /did not confirm its runtime generation/,
    );
    assert.equal(c.requests.length, 2, "opening responses are never replayed");
  }
  const c = client(() => Response.json({}));
  for (const generation of [
    undefined,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => c.api.createCodingRunApi(generation as number),
      /confirmed runtime generation.*reopen/,
    );
  assert.deepEqual(
    c.requests,
    [],
    "invalid fences fail before any owner HTTP request",
  );
});

test("owner API retains the exact large opening epoch despite status changes and delayed HTTP delivery", async () => {
  const openingEpoch = 2 ** 49 + 123;
  let liveEpoch = openingEpoch;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted: string[] = [];
  const c = client(async (path, init) => {
    if (path.endsWith("/open"))
      return Response.json({
        id: "saved",
        cwd: "/project",
        runtime_generation: liveEpoch,
      });
    if (path.endsWith("/runtime"))
      return Response.json({
        state: "running",
        generation: liveEpoch,
        cleanup: null,
      });
    await gate;
    if (
      new Headers(init?.headers).get("X-Mimir-Runtime-Generation") !==
      String(liveEpoch)
    )
      return Response.json(
        {
          detail:
            "Stale runtime generation; deliberately reopen the saved conversation",
        },
        {
          status: 409,
          headers: { "X-Mimir-Requires-Reopen": "true" },
        },
      );
    admitted.push(path);
    return Response.json({
      conversation_id: "saved",
      request_id: "new-request",
      submission_key: JSON.parse(String(init?.body)).submission_key,
    });
  });
  const opening = await c.api.codingApi.openConversation("saved");
  const owner = c.api.createCodingRunApi(opening.runtime_generation!);
  const controller = new AbortController();
  const delayed = [
    owner.submit("saved", "original-key", "Original accepted work"),
    owner.cancel("saved", "original-request"),
    owner.configure("saved", { provider: "native-provider", model: "native-model", reasoning: "high" }),
    owner.readEntries("saved", { journal: "root", leaf: "cut" }, "latest"),
    owner.watch(
      "saved",
      controller.signal,
      () => {},
      async () => {},
    ),
  ];
  const results = Promise.allSettled(delayed);
  liveEpoch = 3; // A new backend epoch can be numerically smaller; no retargeting.
  await c.api.codingRuntimeApi.readStatus();
  release();
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof CodingHttpError);
      assert.equal(result.reason.requiresReopen, true);
      assert.match(result.reason.message, /Stale runtime generation/);
    }
  }
  const oldRequests = c.requests.filter(
    (request) =>
      !request.path.endsWith("/open") && !request.path.endsWith("/runtime"),
  );
  assert.equal(
    oldRequests.length,
    5,
    "no delayed operation was automatically retried",
  );
  for (const request of oldRequests)
    assert.equal(
      new Headers(request.init?.headers).get("X-Mimir-Runtime-Generation"),
      String(openingEpoch),
    );
  assert.deepEqual(
    admitted,
    [],
    "old calls cannot act against the replacement incarnation",
  );
  assert.deepEqual(JSON.parse(String(oldRequests[0].init?.body)), {
    submission_key: "original-key",
    text: "Original accepted work",
  });
  assert.ok(oldRequests[1].path.includes("/requests/original-request/cancel"));
  const reopened = await c.api.codingApi.openConversation("saved");
  const replacementOwner = c.api.createCodingRunApi(
    reopened.runtime_generation!,
  );
  await replacementOwner.submit("saved", "new-key", "Explicit new admission");
  assert.equal(
    new Headers(c.requests.at(-1)?.init?.headers).get(
      "X-Mimir-Runtime-Generation",
    ),
    "3",
  );
  assert.equal(
    admitted.length,
    1,
    "only explicitly acquired replacement ownership admits new work",
  );
});

test("HTTP reopen evidence is explicit: stale 409 and loss 503 require reopen, busy 409 does not", async () => {
  for (const [status, requiresReopen] of [
    [409, true],
    [503, true],
    [409, false],
  ] as const) {
    const c = client(() =>
      Response.json(
        {
          detail: requiresReopen
            ? "Owner incarnation lost; deliberately reopen"
            : "Native runtime busy",
        },
        {
          status,
          headers: requiresReopen ? { "X-Mimir-Requires-Reopen": "true" } : {},
        },
      ),
    );
    await assert.rejects(
      c.api.createCodingRunApi(7).watch(
        "saved",
        new AbortController().signal,
        () => {},
        async () => {},
      ),
      (reason: unknown) => {
        assert.ok(reason instanceof CodingHttpError);
        assert.equal(reason.requiresReopen, requiresReopen);
        return true;
      },
    );
    assert.equal(c.requests.length, 1);
  }
});

for (const failure of ["process_loss", "retired_view", "closed_attachment", "view_invalidated", "view_overflow", "busy_view"] as const) {
  test(`production scoped watch handles ${failure} without implicit owner reopen or prompt replay`, async () => {
    let watches = 0;
    const c = client(() => {
      watches++;
      if (watches === 1 && (failure === "retired_view" || failure === "closed_attachment"))
        return Response.json(
          { detail: "Native attachment no longer exists" },
          { status: failure === "retired_view" ? 404 : 502, headers: { "X-Mimir-Requires-Reopen": "true" } },
        );
      if (watches === 1 && failure === "busy_view")
        return Response.json(
          { detail: "Native runtime temporarily busy" },
          { status: 409 },
        );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (watches === 1 && failure === "view_invalidated") {
            controller.enqueue(new TextEncoder().encode(
              'event:view\ndata:{"subscription":"old-view","event":{"type":"invalidated","reason":"reopened"}}\n\n',
            ));
          } else if (watches === 1)
            controller.enqueue(
              new TextEncoder().encode(
                `event:error\ndata:${JSON.stringify({
                  code:
                    failure === "process_loss"
                      ? "disconnected"
                      : "view_overflow",
                  requires_reopen: failure === "process_loss",
                  message:
                    failure === "process_loss"
                      ? "Native process lost; deliberately reopen"
                      : "View buffer overflow; reconnect for fresh capture",
                })}\n\n`,
              ),
            );
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const attempts: number[] = [];
    const run = createCodingRun(
      "saved",
      c.api.createCodingRunApi(7),
      () => "unused-key",
      {
        storage: () => memorySubmissionStorage(),
        reconnectDelay: (attempt) => {
          attempts.push(attempt);
          return 0;
        },
      },
    );
    try {
      run.connect();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (["process_loss", "retired_view", "closed_attachment"].includes(failure)) {
        assert.equal(run.getSnapshot().reopenRequired, true);
        assert.equal(run.getSnapshot().connection, "disconnected");
        assert.deepEqual(attempts, []);
        run.connect();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          watches,
          1,
          "only deliberate native reopen can acquire a replacement owner",
        );
      } else {
        assert.equal(run.getSnapshot().reopenRequired, false);
        assert.deepEqual(attempts, failure === "view_invalidated" ? [] : [0]);
        if (failure === "view_invalidated") {
          assert.equal(run.getSnapshot().disconnected, false);
          assert.equal(run.getSnapshot().error, null);
        }
        assert.equal(
          watches,
          2,
          "transient view failure reconnects the same fenced owner",
        );
      }
      for (const request of c.requests) {
        assert.ok(
          request.path.endsWith("/events"),
          "no open/create/prompt/cancel was replayed",
        );
        assert.equal(
          new Headers(request.init?.headers).get("X-Mimir-Runtime-Generation"),
          "7",
        );
      }
    } finally {
      run.detach();
    }
  });
}

test("overlap preflight authenticates exact identity and confirmation is explicit", async () => {
  const overlap = {
    cwd: "/canonical/project",
    conversations: [{ id: "other" }],
  };
  const c = client(() => Response.json(overlap));
  assert.deepEqual(await c.api.createCodingRunApi(7).checkOverlap("native/id"), overlap);
  assert.equal(
    c.requests[0].path,
    "/api/coding/conversations/native%2Fid/overlap",
  );
  await c.api.createCodingRunApi(7).submit(
    "native/id",
    "key",
    "warned draft",
    undefined,
    true,
  );
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
    c.api.createCodingRunApi(7).submit("id", "key", "draft"),
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
      busy.api.createCodingRunApi(7).submit("id", "key", "draft"),
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
    malformed.api.createCodingRunApi(7).checkOverlap("id"),
    /could not be confirmed.*No prompt was sent/,
  );
});

test("MCP apply/reconnect and read-only reconciliation use exact native identities with no caching or replay", async () => {
  const native = { operation_id: "operation/id?", status: "running" };
  const c = client(() => Response.json(native));
  assert.deepEqual(
    await c.api.mcpSettingsApi.apply("conversation/id?", "operation/id?"),
    native,
  );
  assert.deepEqual(
    await c.api.mcpSettingsApi.reconnect(
      "conversation/id?",
      "reconnect-id",
      "configured",
    ),
    native,
  );
  assert.deepEqual(
    await c.api.mcpSettingsApi.inspectOperation(
      "conversation/id?",
      "operation/id?",
    ),
    native,
  );
  assert.deepEqual(
    c.requests.map((request) => request.path),
    [
      "/api/coding/conversations/conversation%2Fid%3F/mcp/apply",
      "/api/coding/conversations/conversation%2Fid%3F/mcp/reconnect",
      "/api/coding/conversations/conversation%2Fid%3F/mcp/operations/operation%2Fid%3F",
    ],
  );
  assert.deepEqual(JSON.parse(c.requests[0].init!.body as string), {
    operation_id: "operation/id?",
  });
  assert.deepEqual(JSON.parse(c.requests[1].init!.body as string), {
    operation_id: "reconnect-id",
    name: "configured",
  });
  for (const request of c.requests) {
    assert.equal(request.init?.cache, "no-store");
    assert.deepEqual(request.options, { retryNetworkErrors: false });
  }
  assert.equal(c.requests[2].init?.method, undefined);
});
