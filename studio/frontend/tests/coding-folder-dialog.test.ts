// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";
import { createCodingSession } from "../src/features/coding/session.ts";
import type { CodingApi } from "../src/features/coding/types.ts";

function nodes(node: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as StubElement;
  return [element, ...nodes(element.props.children)];
}
function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node)
    return text((node as StubElement).props.children);
  return "";
}
function picker(api: CodingApi) {
  let path = "";
  let effectDirectory: unknown = Symbol("unmounted");
  const effects: (() => void)[] = [];
  const changes: boolean[] = [];
  const selected: string[] = [];
  let restores = 0;
  const session = createCodingSession(api);
  const component = loadWithStubs<{
    ProjectFolderDialog: (props: Record<string, unknown>) => StubElement;
  }>(
    new URL(
      "../src/features/coding/project-folder-dialog.tsx",
      import.meta.url,
    ),
    {
      "react/jsx-runtime": stubJsxRuntime(),
      react: {
        useState: () => [
          path,
          (value: string) => {
            path = value;
          },
        ],
        useEffect: (effect: () => void, dependencies: unknown[]) => {
          if (dependencies[0] !== effectDirectory) effects.push(effect);
          effectDirectory = dependencies[0];
        },
      },
      "lucide-react": {
        ArrowUp: "ArrowUp",
        ChevronRight: "ChevronRight",
        Folder: "Folder",
        LoaderCircle: "LoaderCircle",
      },
      "@/components/ui/button": { Button: "Button" },
      "@/components/ui/input": { Input: "Input" },
      "@/components/ui/dialog": Object.fromEntries(
        [
          "Dialog",
          "DialogContent",
          "DialogDescription",
          "DialogFooter",
          "DialogHeader",
          "DialogTitle",
        ].map((name) => [name, name]),
      ),
    },
  );
  const render = () => {
    component.ProjectFolderDialog({
      open: true,
      onOpenChange: (next: boolean) => changes.push(next),
      onRestoreFocus: () => {
        restores++;
      },
      onSelect: (path: string) => selected.push(path),
      session,
      state: session.getSnapshot(),
    });
    for (const effect of effects.splice(0)) effect();
    return nodes(
      component.ProjectFolderDialog({
        open: true,
        onOpenChange: (next: boolean) => changes.push(next),
        onRestoreFocus: () => {
          restores++;
        },
        onSelect: (path: string) => selected.push(path),
        session,
        state: session.getSnapshot(),
      }),
    );
  };
  const button = (label: string) => {
    const result = render().find(
      (node) => node.type === "Button" && text(node.props.children) === label,
    );
    assert.ok(result, `button ${label} exists`);
    return result;
  };
  return {
    session,
    render,
    button,
    changes,
    selected,
    restores: () => restores,
  };
}
function api(overrides: Partial<CodingApi> = {}): CodingApi {
  return {
    listConversations: async () => [],
    browseProjects: async () => ({
      path: "/canonical",
      parent: "/",
      entries: [],
      truncated: false,
    }),
    createConversation: async () => ({ id: "native", cwd: "/canonical" }),
    openConversation: async (id) => ({ id, cwd: "/canonical" }),
    ...overrides,
  };
}

test("controlled picker restores its invoker when Radix closes focus scope after Escape", () => {
  const p = picker(api());
  const dialog = p.render().find((node) => node.type === "Dialog")!;
  (dialog.props.onOpenChange as (open: boolean) => void)(false);
  assert.deepEqual(p.changes, [false]);
  const content = p.render().find((node) => node.type === "DialogContent")!;
  assert.equal(
    typeof content.props.onCloseAutoFocus,
    "function",
    "a controlled dialog has no DialogTrigger for default restoration",
  );
  let prevented = false;
  (content.props.onCloseAutoFocus as (event: unknown) => void)({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(
    prevented,
    true,
    "do not allow Radix's absent trigger fallback to replace explicit focus",
  );
  assert.equal(p.restores(), 1);
});

test("typed path Enter browses rather than choosing; confirm selects only the browsed canonical folder", async () => {
  const browsed: string[] = [];
  const created: string[] = [];
  const p = picker(
    api({
      browseProjects: async (path) => {
        browsed.push(path);
        return {
          path: "/canonical",
          parent: "/",
          entries: [],
          truncated: false,
        };
      },
      createConversation: async (cwd) => {
        created.push(cwd);
        return { id: "native", cwd };
      },
    }),
  );
  assert.equal(p.button("Use this folder").props.disabled, true);
  const input = p.render().find((node) => node.type === "Input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "/host/link" },
  });
  let prevented = false;
  const form = p.render().find((node) => node.type === "form")!;
  (form.props.onSubmit as (event: unknown) => void)({
    preventDefault() {
      prevented = true;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.deepEqual(browsed, ["/host/link"]);
  assert.deepEqual(created, []);
  assert.equal(p.button("Use this folder").props.disabled, false);
  (p.button("Use this folder").props.onClick as () => void)();
  assert.deepEqual(p.selected, ["/canonical"]);
  assert.deepEqual(created, [], "choosing a folder never creates a conversation");
  assert.deepEqual(p.changes, [false]);
  assert.equal(p.session.getSnapshot().directory, null);
});

test("editing the path after browse disables confirm until the new path is browsed", async () => {
  const p = picker(api());
  await p.session.browse("/canonical");
  assert.equal(p.button("Use this folder").props.disabled, false);
  const input = p.render().find((node) => node.type === "Input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "/other" },
  });
  assert.equal(p.button("Use this folder").props.disabled, true);
  (p.button("Use this folder").props.onClick as () => void)();
  assert.deepEqual(
    p.selected,
    [],
    "even direct stale button activation must not choose the old folder",
  );
  const pending = p.session.browse("/other");
  assert.equal(p.button("Use this folder").props.disabled, true);
  await pending;
});

test("editing while a browse is pending preserves the newer draft and invalidates selection", async () => {
  let resolve!: (
    value: Awaited<ReturnType<CodingApi["browseProjects"]>>,
  ) => void;
  let signal: AbortSignal | undefined;
  const p = picker(
    api({
      browseProjects: (_path, current) => {
        signal = current;
        return new Promise((done) => {
          resolve = done;
        });
      },
    }),
  );
  const pending = p.session.browse("/old");
  const input = p.render().find((node) => node.type === "Input")!;
  (input.props.onChange as (event: unknown) => void)({
    target: { value: "/new" },
  });
  resolve({ path: "/old", parent: "/", entries: [], truncated: false });
  await pending;
  assert.equal(
    p.render().find((node) => node.type === "Input")!.props.value,
    "/new",
  );
  assert.equal(signal?.aborted, true);
  assert.equal(p.session.getSnapshot().directory, null);
  assert.equal(p.button("Use this folder").props.disabled, true);
  (p.button("Use this folder").props.onClick as () => void)();
  assert.deepEqual(p.selected, []);
});
