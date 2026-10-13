// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { CodingHttpError } from "../src/features/coding/errors.ts";
import type { RunApi } from "../src/features/coding/run-types.ts";
import { createCodingSession } from "../src/features/coding/session.ts";
import type { CodingApi } from "../src/features/coding/types.ts";
import {
  createRuntimeMaintenance,
  type CodingRuntimeStatus,
} from "../src/features/coding/runtime-maintenance.ts";
import {
  codingCanContinue,
  codingInterruptedRequest,
  codingRunCompletion,
  codingRunLabel,
  createCodingRun,
} from "../src/features/coding/run-session.ts";
import type * as RuntimeControls from "../src/features/coding/runtime-controls.tsx";
import type * as RecoveryControls from "../src/features/coding/recovery-controls.tsx";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";
import { memorySubmissionStorage } from "./coding-storage-fixture.ts";

const running = (generation = 1): CodingRuntimeStatus => ({
  state: "running",
  generation,
  cleanup: null,
});
function nodes(value: unknown): StubElement[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as StubElement;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(" ");
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (value && typeof value === "object" && "props" in value)
    return text((value as StubElement).props.children);
  return "";
}
const controls = loadWithStubs<typeof RuntimeControls>(
  new URL("../src/features/coding/runtime-controls.tsx", import.meta.url),
  {
    "react/jsx-runtime": stubJsxRuntime(),
    "@/components/ui/button": { Button: "button" },
  },
);
const recovery = loadWithStubs<typeof RecoveryControls>(
  new URL("../src/features/coding/recovery-controls.tsx", import.meta.url),
  {
    "react/jsx-runtime": stubJsxRuntime(),
    "@/components/ui/button": { Button: "button" },
    "./run-session": { codingCanContinue, codingInterruptedRequest },
  },
);

test("idle restart is explicit, replaces generation and reports deliberate reopen with no owner or prompt operations", async () => {
  const calls: string[] = [];
  let status = running();
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => {
      calls.push("status");
      return status;
    },
    restart: async () => {
      calls.push("restart");
      status = running(2);
      return status;
    },
  });
  await maintenance.refresh();
  assert.deepEqual(calls, ["status"]);
  const rendered = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  const restart = nodes(rendered).find(
    (node) => node.props["data-testid"] === "coding-runtime-restart",
  )!;
  assert.equal(text(restart), "Restart whole Mimir runtime");
  assert.equal(
    restart.props["aria-describedby"],
    "coding-runtime-restart-scope",
  );
  assert.match(text(rendered), /all hosted conversations/);
  assert.match(text(rendered), /not hot reload/);
  assert.ok(
    nodes(rendered).some(
      (node) =>
        node.type === "summary" &&
        /focus-visible:ring/.test(String(node.props.className)),
    ),
  );
  await (restart.props.onClick as () => void)();
  // JSX handler intentionally returns void; settle the real controller mutation.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["status", "restart", "status"]);
  assert.equal(maintenance.getSnapshot().status?.generation, 2);
  assert.match(
    maintenance.getSnapshot().notice ?? "",
    /Deliberately reopen.*no accepted work/,
  );
});

for (const busy of [
  "running",
  "queued",
  "question",
  "child",
  "tool",
  "MCP",
  "another hosted conversation",
]) {
  test(`native ${busy} refusal remains actionable and does not imply restart or cleanup`, async () => {
    let restarts = 0;
    const maintenance = createRuntimeMaintenance({
      readStatus: async () => running(),
      restart: async () => {
        restarts++;
        throw new CodingHttpError(409, `Refused: ${busy} work is busy`);
      },
    });
    await maintenance.refresh();
    await maintenance.restart();
    assert.equal(restarts, 1);
    assert.equal(maintenance.getSnapshot().status?.generation, 1);
    assert.equal(maintenance.getSnapshot().notice, null);
    assert.match(
      maintenance.getSnapshot().error ?? "",
      /explicitly Stop.*confirmed native cleanup/,
    );
    const rendered = controls.CodingRuntimeControls({
      maintenance,
      state: maintenance.getSnapshot(),
    });
    assert.ok(
      nodes(rendered).some(
        (node) => node.props.role === "alert" && text(node).includes(busy),
      ),
    );
  });
}

test("unknown restart blocks another action until status/generation inspection succeeds, without automatic retry", async () => {
  let reads = 0;
  let restarts = 0;
  let inspect = false;
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => {
      reads++;
      if (!inspect) throw new Error("Status offline");
      return running(2);
    },
    restart: async () => {
      restarts++;
      throw new Error("Restart acknowledgment lost");
    },
  });
  await maintenance.restart();
  assert.equal(maintenance.getSnapshot().restartUncertainty, true);
  const rendered = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  assert.equal(
    nodes(rendered).find(
      (node) => node.props["data-testid"] === "coding-runtime-restart",
    )?.props["aria-disabled"],
    true,
  );
  await maintenance.restart();
  assert.equal(restarts, 1);
  inspect = true;
  await maintenance.refresh();
  assert.equal(reads, 2);
  assert.equal(maintenance.getSnapshot().restartUncertainty, false);
  assert.equal(maintenance.getSnapshot().status?.generation, 2);
  assert.equal(restarts, 1);
});

test("shutdown failure surfaces confirmed=false, native message and exit evidence without success notice", async () => {
  const failed: CodingRuntimeStatus = {
    state: "cleanup_failed",
    generation: 1,
    cleanup: {
      confirmed: false,
      exit_code: null,
      forced: true,
      message: "Native drain did not settle all work",
    },
  };
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => failed,
    restart: async () => {
      throw new CodingHttpError(502, "Incomplete shutdown");
    },
  });
  await maintenance.restart();
  assert.equal(maintenance.getSnapshot().status?.state, "cleanup_failed");
  assert.match(
    maintenance.getSnapshot().notice ?? "",
    /Fresh runtime status\/generation inspected/,
  );
  assert.doesNotMatch(
    maintenance.getSnapshot().notice ?? "",
    /Whole runtime restarted/,
  );
  const rendered = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  const evidence = nodes(rendered).find(
    (node) => node.props["data-testid"] === "coding-runtime-cleanup",
  )!;
  assert.equal(evidence.props.role, "alert");
  assert.match(
    text(evidence),
    /not confirmed.*unknown.*forced termination.*did not settle/,
  );
});

test("duplicate in-flight restart is suppressed and stale earlier status cannot overwrite replacement", async () => {
  let read!: (status: CodingRuntimeStatus) => void;
  let restart!: (status: CodingRuntimeStatus) => void;
  let restarts = 0;
  let reads = 0;
  const maintenance = createRuntimeMaintenance({
    readStatus: async () =>
      ++reads === 1
        ? new Promise((resolve) => {
            read = resolve;
          })
        : running(2),
    restart: async () => {
      restarts++;
      return new Promise((resolve) => {
        restart = resolve;
      });
    },
  });
  const earlier = maintenance.refresh();
  const replacing = maintenance.restart();
  await maintenance.restart();
  assert.equal(restarts, 1);
  restart(running(2));
  await replacing;
  read(running(1));
  await earlier;
  assert.equal(maintenance.getSnapshot().status?.generation, 2);
});

test("rendered interrupted control never auto-submits and explicit click is disabled by uncertain delivery", async () => {
  const run = createCodingRun("saved", {} as never, () => "new-key", {
    storage: () => memorySubmissionStorage(),
  });
  const state = {
    ...run.getSnapshot(),
    connection: "connected" as const,
    native: {
      info: { id: "saved", cwd: "/saved" },
      configuration: {
        provider: "unavailable",
        model: "saved-model",
        reasoning: null,
        mode: "build",
      },
      requests: [
        {
          id: "interrupted",
          status: "interrupted" as const,
          submission_key: "old-key",
        },
      ],
      active_request: null,
      pending_user_request: false,
    },
  };
  let continued = 0;
  const actionRun = {
    ...run,
    continueInterruptedWork: async () => {
      continued++;
    },
  };
  const rendered = recovery.CodingRecoveryControls({ state, run: actionRun });
  assert.equal(continued, 0);
  const button = nodes(rendered).find(
    (node) => node.props["data-testid"] === "coding-continue-interrupted",
  )!;
  assert.equal(text(button), "Continue interrupted work");
  assert.equal(button.props["aria-disabled"], false);
  assert.notEqual(
    button.props.disabled,
    true,
    "control remains focusable across asynchronous state changes",
  );
  assert.equal(
    button.props["aria-describedby"],
    "coding-continuation-explanation",
  );
  assert.match(text(rendered), /new keyed prompt.*not Retry same submission/);
  (button.props.onClick as () => void)();
  assert.equal(continued, 1);
  const uncertain = recovery.CodingRecoveryControls({
    state: {
      ...state,
      uncertainSubmission: { key: "pending", text: "uncertain" },
    },
    run: actionRun,
  });
  const blocked = nodes(uncertain).find(
    (node) => node.props["data-testid"] === "coding-continue-interrupted",
  )!;
  assert.equal(blocked.props["aria-disabled"], true);
  assert.notEqual(
    blocked.props.disabled,
    true,
    "unconfirmed delivery does not remove the focused recovery control",
  );
  (blocked.props.onClick as () => void)();
  assert.equal(
    continued,
    1,
    "aria-disabled continuation rejects both keyboard and pointer activation",
  );
  assert.equal(
    recovery.CodingRecoveryControls({
      state: {
        ...state,
        native: {
          ...state.native,
          requests: [{ ...state.native.requests[0], status: "cancelled" }],
        },
      },
      run: actionRun,
    }),
    null,
  );
});

test("stopping is pending native drain, not stopped, and blocks duplicate maintenance admission", async () => {
  let restarts = 0;
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => ({ ...running(), state: "stopping" }),
    restart: async () => {
      restarts++;
      return running(2);
    },
  });
  await maintenance.refresh();
  const rendered = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  assert.match(
    text(rendered),
    /Stopping.*waiting for native drain.*Shutdown is not yet confirmed/,
  );
  assert.equal(
    nodes(rendered).find(
      (node) => node.props["data-testid"] === "coding-runtime-restart",
    )?.props["aria-disabled"],
    true,
  );
  await maintenance.restart();
  assert.equal(restarts, 0);
  assert.equal(maintenance.getSnapshot().status?.state, "stopping");
});

for (const ownerGeneration of [1, 2, 100]) {
  test(`rendered surface respects owning generation ${ownerGeneration} during first startup/stale reopen and requires deliberate reopen on loss`, async () => {
    let deliver!: (value: unknown) => Promise<void>;
    let liveSignal!: AbortSignal;
    const cancelled: string[] = [];
    const api: RunApi = {
      submit: async () => {
        throw new Error("No prompt should be replayed");
      },
      cancel: async (id, request) => {
        cancelled.push(request);
        return {
          conversation_id: id,
          request_id: request,
          cancel_requested: true,
        };
      },
      readEntries: async (_id, cut) => ({
        cut,
        rows: [],
        older: false,
        newer: false,
        first_id: null,
        last_id: null,
      }),
      watch: async (_id, signal, _connected, onView) => {
        liveSignal = signal;
        deliver = onView;
        await new Promise(() => {});
      },
    };
    const base = createCodingRun("saved", api, () => "key", {
      storage: () => memorySubmissionStorage(),
    });
    base.connect();
    await deliver({
      subscription: "live",
      position: 1,
      event: {
        type: "start",
        recovering: false,
        state: {
          info: {
            id: "saved",
            cwd: "/project",
            runtime_generation: ownerGeneration,
          },
          configuration: {
            provider: "provider",
            model: "model",
            reasoning: null,
            mode: "build",
          },
          active_request: "exact-request",
          pending_user_request: false,
          requests: [
            {
              id: "exact-request",
              status: "running",
              submission_key: "accepted-key",
            },
          ],
        },
        root: { cut: { journal: "root", leaf: null }, live_invocations: [] },
      },
    });
    let invalidations = 0;
    let connections = 0;
    const onRuntimeLost = () => {};
    const acquiredGenerations: number[] = [];
    const states: unknown[] = [];
    let stateIndex = 0;
    const run = {
      ...base,
      connect: () => {
        connections++;
      },
      requireRuntimeReopen: () => {
        invalidations++;
        base.requireRuntimeReopen();
      },
    };
    const refs: { current: unknown }[] = [];
    const effects: unknown[][] = [];
    let refIndex = 0;
    let effectIndex = 0;
    const primitive = {
      Root: "root",
      Input: "input",
      Send: "send",
      Messages: "messages",
    };
    const surface = loadWithStubs<{
      CodingSurface: (props: {
        conversationId: string;
        conversationGeneration?: number;
        runtimeStatus: CodingRuntimeStatus | null;
        onRuntimeLost?: () => void;
        children: unknown;
      }) => StubElement;
    }>(new URL("../src/features/coding/coding-surface.tsx", import.meta.url), {
      "react/jsx-runtime": stubJsxRuntime(),
      "@/components/ui/button": { Button: "button" },
      "@assistant-ui/react": {
        AssistantRuntimeProvider: "provider",
        ThreadPrimitive: primitive,
        ComposerPrimitive: primitive,
        MessagePrimitive: primitive,
        useExternalStoreRuntime: () => ({}),
      },
      "lucide-react": { ArrowDown: "icon", ArrowUp: "icon", Square: "icon" },
      react: {
        useState: (initial: unknown) => {
          const index = stateIndex++;
          if (index >= states.length)
            states[index] =
              typeof initial === "function"
                ? (initial as () => unknown)()
                : initial;
          return [states[index], () => {}];
        },
        useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
          snapshot(),
        useRef: (initial: unknown) =>
          refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
        useLayoutEffect: () => {},
        useEffect: (effect: () => void, deps: unknown[]) => {
          const previous = effects[effectIndex];
          effects[effectIndex++] = deps;
          if (
            !previous ||
            !deps.every((value, index) => value === previous[index])
          )
            effect();
        },
      },
      "./api": {
        createCodingRunApi: (generation: number) => {
          acquiredGenerations.push(generation);
          return {};
        },
      },
      "./presentation": {},
      "./run-runtime": { codingRunAdapter: () => ({}) },
      "./run-session": {
        createCodingRun: (
          _id: string,
          _api: unknown,
          _key: unknown,
          options: { onRuntimeLost?: () => void },
        ) => {
          assert.equal(
            options.onRuntimeLost,
            onRuntimeLost,
            "rendered surface forwards the maintenance freshness boundary to its run",
          );
          return run;
        },
        codingRunCompletion,
        codingRunLabel,
      },
      "./tool-report": { ToolReport: "tool" },
      "./unsent-draft": { CodingUnsentDraft: "draft" },
      "./recovery-controls": { CodingRecoveryControls: "recovery" },
    });
    const render = (runtimeStatus: CodingRuntimeStatus | null) => {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      return surface.CodingSurface({
        conversationId: "saved",
        conversationGeneration: ownerGeneration,
        runtimeStatus,
        onRuntimeLost,
        children: null,
      });
    };
    // Session opening has invalidated all pre-opening observations. The new
    // surface sees null until an actual post-opening status response arrives.
    render(null);
    render(running(ownerGeneration));
    assert.equal(
      invalidations,
      0,
      "first startup/reopen without stale observations preserves the new owner",
    );
    for (const state of [
      "restarting",
      "maintenance_unconfirmed",
      "restart_prepared",
      "stopping",
    ] as const) {
      const pending = render({ ...running(ownerGeneration), state });
      assert.equal(
        invalidations,
        0,
        `same-generation ${state} is not process loss`,
      );
      assert.equal(
        liveSignal.aborted,
        false,
        "maintenance polling never aborts the connected stream",
      );
      assert.equal(
        nodes(pending).find((node) => node.props["aria-label"] === "Stop")
          ?.props.disabled,
        false,
      );
    }
    const refused = render(running(ownerGeneration));
    const stop = nodes(refused).find(
      (node) => node.props["aria-label"] === "Stop",
    )!;
    (stop.props.onClick as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      cancelled,
      ["exact-request"],
      "busy refusal leaves Stop usable for the exact native request",
    );
    assert.equal(base.getSnapshot().connection, "connected");
    assert.equal(
      invalidations,
      0,
      "same generation/refusal never disconnects the owner",
    );
    render({ ...running(ownerGeneration), state: "disconnected" });
    assert.equal(invalidations, 1);
    assert.equal(base.getSnapshot().reopenRequired, true);
    render(running(ownerGeneration + 1));
    assert.equal(invalidations, 2);
    if (ownerGeneration === 100) {
      render(running(50));
      assert.equal(
        invalidations,
        3,
        "a fresh lower backend epoch is replacement evidence, not stale by numeric order",
      );
    }
    assert.equal(
      connections,
      1,
      "replacement never auto-connects or reopens the old owner",
    );
    assert.equal(base.getSnapshot().connection, "disconnected");
    assert.deepEqual(
      acquiredGenerations,
      [ownerGeneration],
      "status never retargets the production owner API",
    );
    base.detach();
    states.length = 0;
    refs.length = 0;
    effects.length = 0;
    stateIndex = refIndex = effectIndex = 0;
    const unfenced = surface.CodingSurface({
      conversationId: "saved",
      runtimeStatus: running(ownerGeneration + 1),
      children: null,
    });
    assert.match(
      text(unfenced),
      /no confirmed opening generation.*Deliberately reopen/,
    );
    assert.equal(
      nodes(unfenced).find(
        (node) => node.props["aria-label"] === "Coding prompt",
      )?.props.disabled,
      true,
    );
    assert.deepEqual(
      acquiredGenerations,
      [ownerGeneration],
      "missing opening stamp cannot fall back to runtime status",
    );
  });
}

test("unconfirmed native maintenance remains blocked through inspection until prepared; completion needs another explicit Restart", async () => {
  let status: CodingRuntimeStatus = {
    ...running(),
    state: "maintenance_unconfirmed",
  };
  let restarts = 0;
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => status,
    restart: async () => {
      restarts++;
      status = running(2);
      return status;
    },
  });
  await maintenance.refresh();
  await maintenance.restart();
  assert.equal(restarts, 0);
  assert.equal(maintenance.getSnapshot().restartUncertainty, true);
  const unknown = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  assert.equal(
    nodes(unknown).find(
      (node) => node.props["data-testid"] === "coding-runtime-restart",
    )?.props["aria-disabled"],
    true,
  );
  assert.match(
    text(unknown),
    /original process remains live.*Stop and views remain available/,
  );
  await maintenance.refresh();
  assert.equal(
    restarts,
    0,
    "read-only inspection never replays maintenance admission",
  );
  status = { ...running(), state: "restart_prepared" };
  await maintenance.refresh();
  assert.equal(maintenance.getSnapshot().restartUncertainty, false);
  const prepared = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  const restart = nodes(prepared).find(
    (node) => node.props["data-testid"] === "coding-runtime-restart",
  )!;
  assert.equal(restart.props["aria-disabled"], false);
  assert.match(
    text(prepared),
    /preparation is confirmed.*process replacement is not complete.*Explicitly select/,
  );
  assert.equal(restarts, 0);
  (restart.props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    restarts,
    1,
    "only the deliberate second action finishes replacement",
  );
  assert.equal(maintenance.getSnapshot().status?.generation, 2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function openingApi(generation: number, calls: string[]): CodingApi {
  return {
    listConversations: async () => [{ id: "saved", cwd: "/project" }],
    createConversation: async () => {
      calls.push("create");
      return { id: "saved", cwd: "/project", runtime_generation: generation };
    },
    openConversation: async () => {
      calls.push("open");
      return { id: "saved", cwd: "/project", runtime_generation: generation };
    },
    browseProjects: async () => ({
      path: "/project",
      parent: "/",
      entries: [],
      truncated: false,
    }),
  };
}
for (const kind of ["create", "open"] as const) {
  for (const [priorEpoch, openedEpoch] of [
    [0, 1],
    [100, 50],
  ] as const) {
    test(`${kind} observation boundary clears cached epoch ${priorEpoch} and late pre-opening reads before exposing owner ${openedEpoch}`, async () => {
      const late = deferred<CodingRuntimeStatus>();
      const fresh = deferred<CodingRuntimeStatus>();
      let reads = 0;
      let restarts = 0;
      const cached: CodingRuntimeStatus = {
        ...running(priorEpoch),
        state: priorEpoch === 0 ? "not_started" : "cleanup_failed",
        cleanup:
          priorEpoch === 0
            ? null
            : {
                confirmed: false,
                forced: false,
                exit_code: null,
                message: "Previous backend cleanup was unconfirmed",
              },
      };
      const maintenance = createRuntimeMaintenance({
        readStatus: async () =>
          ++reads === 1 ? cached : reads === 2 ? late.promise : fresh.promise,
        restart: async () => {
          restarts++;
          return running(openedEpoch + 1);
        },
      });
      await maintenance.refresh();
      const obsoleteRead = maintenance.refresh();
      const calls: string[] = [];
      let postOpeningRead: Promise<void> | undefined;
      const session = createCodingSession(openingApi(openedEpoch, calls), {
        onOpened: () => {
          maintenance.invalidate();
          postOpeningRead = maintenance.refresh();
        },
      });
      const exposed: (CodingRuntimeStatus | null)[] = [];
      session.subscribe(() => {
        if (session.getSnapshot().active)
          exposed.push(maintenance.getSnapshot().status);
      });
      assert.equal(
        await (kind === "create"
          ? session.createConversation("/project")
          : session.openConversation("saved")),
        true,
      );
      assert.equal(
        session.getSnapshot().active?.runtime_generation,
        openedEpoch,
      );
      assert.equal(
        maintenance.getSnapshot().status,
        null,
        "cached higher epoch cannot reach the newly opened owner",
      );
      assert.ok(exposed.length > 0);
      assert.ok(
        exposed.every((status) => status === null),
        "invalidation precedes every publication of the new active identity",
      );
      assert.equal(
        maintenance.getSnapshot().reading,
        true,
        "fresh read starts despite a pre-opening read still being in flight",
      );
      if (kind === "create") late.resolve(cached);
      else late.reject(new Error("Late error from the previous backend"));
      await obsoleteRead;
      assert.equal(maintenance.getSnapshot().status, null);
      assert.equal(maintenance.getSnapshot().statusError, null);
      assert.equal(
        maintenance.getSnapshot().reading,
        true,
        "obsolete completion cannot settle the fresh read",
      );
      const confirmed = running(openedEpoch);
      fresh.resolve(confirmed);
      await postOpeningRead;
      assert.equal(
        maintenance.getSnapshot().status,
        confirmed,
        "only actual post-opening evidence is published; cleanup/running is not synthesized",
      );
      assert.deepEqual(calls, [kind], "opening is never replayed");
      assert.equal(
        restarts,
        0,
        "opening freshness uses only read-only status inspection",
      );
      assert.equal(reads, 3);
    });
  }
}

for (const outcome of ["status", "error"] as const) {
  test(`successful reopen fences late pre-opening restart ${outcome} without blocking fresh status inspection`, async () => {
    const lateRestart = deferred<CodingRuntimeStatus>();
    const fresh = deferred<CodingRuntimeStatus>();
    let reads = 0;
    let restarts = 0;
    const maintenance = createRuntimeMaintenance({
      readStatus: async () => (++reads === 1 ? running(100) : fresh.promise),
      restart: async () => {
        restarts++;
        return lateRestart.promise;
      },
    });
    await maintenance.refresh();
    const pendingRestart = maintenance.restart();
    const calls: string[] = [];
    let postOpeningRead: Promise<void> | undefined;
    const session = createCodingSession(openingApi(50, calls), {
      onOpened: () => {
        maintenance.invalidate();
        postOpeningRead = maintenance.refresh();
      },
    });
    assert.equal(await session.openConversation("saved"), true);
    assert.equal(maintenance.getSnapshot().status, null);
    assert.equal(
      maintenance.getSnapshot().restarting,
      true,
      "the actual pending mutation still suppresses duplicate requests",
    );
    assert.equal(
      maintenance.getSnapshot().reading,
      true,
      "obsolete mutation progress cannot block a fresh post-opening GET",
    );
    const observed: (CodingRuntimeStatus | null)[] = [
      maintenance.getSnapshot().status,
    ];
    maintenance.subscribe(() =>
      observed.push(maintenance.getSnapshot().status),
    );
    const confirmed = running(50);
    fresh.resolve(confirmed);
    await postOpeningRead;
    if (outcome === "status")
      lateRestart.resolve({
        ...running(101),
        state: "cleanup_failed",
        cleanup: {
          confirmed: false,
          forced: true,
          exit_code: null,
          message: "Old backend shutdown failed",
        },
      });
    else lateRestart.reject(new Error("Late transport error from old backend"));
    await pendingRestart;
    assert.equal(maintenance.getSnapshot().status, confirmed);
    assert.equal(
      maintenance.getSnapshot().error,
      null,
      "an obsolete reply cannot invent a current restart failure",
    );
    assert.equal(maintenance.getSnapshot().restarting, false);
    assert.ok(
      observed.every((status) => status === null || status === confirmed),
    );
    assert.doesNotMatch(
      maintenance.getSnapshot().notice ?? "",
      /Whole runtime restarted/,
    );
    assert.deepEqual(calls, ["open"]);
    assert.equal(
      restarts,
      1,
      "native maintenance is not replayed at opening or inspection",
    );
    assert.equal(reads, 3);
  });
}

test("stream process loss retires cached cleanup and pre-loss reads before exposing disconnected owner", async () => {
  const stale = deferred<CodingRuntimeStatus>();
  const fresh = deferred<CodingRuntimeStatus>();
  const stream = deferred<void>();
  const previous: CodingRuntimeStatus = {
    ...running(100),
    cleanup: {
      confirmed: true,
      exit_code: 0,
      forced: false,
      message: "Previous cleanup confirmed",
    },
  };
  let reads = 0;
  let boundaries = 0;
  let freshRead: Promise<void> | undefined;
  const maintenance = createRuntimeMaintenance({
    readStatus: async () =>
      ++reads === 1 ? previous : reads === 2 ? stale.promise : fresh.promise,
    restart: async () => {
      throw new Error("No restart is authorized by stream loss");
    },
  });
  await maintenance.refresh();
  const oldRead = maintenance.refresh();
  const run = createCodingRun(
    "saved",
    {
      watch: async () => stream.promise,
      submit: async () => {
        throw new Error("No prompt replay");
      },
      cancel: async () => {
        throw new Error("No cancellation replay");
      },
      readEntries: async () => {
        throw new Error("No entries replay");
      },
    },
    () => "unused",
    {
      storage: () => memorySubmissionStorage(),
      onRuntimeLost: () => {
        boundaries++;
        maintenance.invalidate();
        freshRead = maintenance.refresh();
      },
    },
  );
  const exposed: (CodingRuntimeStatus | null)[] = [];
  run.subscribe(() => {
    if (run.getSnapshot().reopenRequired)
      exposed.push(maintenance.getSnapshot().status);
  });
  run.connect();
  stream.reject(new CodingHttpError(503, "Supervised process lost", true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.getSnapshot().reopenRequired, true);
  assert.equal(boundaries, 1);
  assert.equal(
    maintenance.getSnapshot().status,
    null,
    "prior running and confirmed cleanup are retired synchronously",
  );
  assert.ok(exposed.length > 0);
  assert.ok(exposed.every((status) => status === null));
  stale.resolve(previous);
  await oldRead;
  assert.equal(
    maintenance.getSnapshot().status,
    null,
    "late pre-loss inspection cannot restore cleanup success",
  );
  const unavailable = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  assert.match(text(unavailable), /Runtime:\s+unavailable/);
  assert.doesNotMatch(text(unavailable), /Cleanup\s+confirmed/);
  fresh.resolve({ ...running(100), state: "disconnected", cleanup: null });
  await freshRead;
  const disconnected = controls.CodingRuntimeControls({
    maintenance,
    state: maintenance.getSnapshot(),
  });
  assert.match(text(disconnected), /Runtime:\s+disconnected/);
  assert.doesNotMatch(text(disconnected), /Cleanup\s+confirmed/);
  run.requireRuntimeReopen();
  assert.equal(
    boundaries,
    1,
    "repeated loss evidence does not continuously invalidate fresh inspection",
  );
  assert.equal(reads, 3);
  run.detach();
});

test("failed reopen does not retire observations belonging to the unchanged owner", async () => {
  const calls: string[] = [];
  const status = running(50);
  const maintenance = createRuntimeMaintenance({
    readStatus: async () => status,
    restart: async () => status,
  });
  let boundaries = 0;
  let inspection: Promise<void> | undefined;
  const api = openingApi(50, calls);
  const session = createCodingSession(api, {
    onOpened: () => {
      boundaries++;
      maintenance.invalidate();
      inspection = maintenance.refresh();
    },
  });
  assert.equal(await session.createConversation("/project"), true);
  await inspection;
  api.openConversation = async () => {
    throw new CodingHttpError(404, "Saved project unavailable");
  };
  assert.equal(await session.openConversation("missing"), false);
  assert.equal(boundaries, 1);
  assert.equal(session.getSnapshot().active?.id, "saved");
  assert.equal(session.getSnapshot().openingGeneration, 1);
  assert.equal(maintenance.getSnapshot().status, status);
  assert.equal(session.getSnapshot().openingError, "Saved project unavailable");
});
