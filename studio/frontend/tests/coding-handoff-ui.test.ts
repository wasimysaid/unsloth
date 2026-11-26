// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import type * as Dialog from "../src/features/coding/model-handoff-dialog.tsx";
import type * as PlanDecision from "../src/features/coding/plan-decision.tsx";
import type * as Targets from "../src/features/coding/model-targets.ts";
import * as handoff from "../src/features/coding/model-handoff.ts";
import * as selection from "../src/features/coding/model-selection.ts";
import {
  loadWithStubs,
  stubJsxRuntime,
  type StubElement,
} from "./helpers/module-stubs.ts";

// A shallow renderer: local components run with shared hook slots; stubs stay elements.
type Hooked = { render: () => StubElement; rerender: () => StubElement };
let slots: unknown[] = [];
let cursor = 0;
const react = {
  useState<T>(initial: T | (() => T)) {
    const index = cursor++;
    if (!(index in slots))
      slots[index] =
        typeof initial === "function" ? (initial as () => T)() : initial;
    const set = (next: T | ((previous: T) => T)) => {
      slots[index] =
        typeof next === "function"
          ? (next as (previous: T) => T)(slots[index] as T)
          : next;
    };
    return [slots[index] as T, set] as const;
  },
  useRef<T>(current: T) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current };
    return slots[index];
  },
  useId: () => "id",
  useMemo: <T>(make: () => T) => make(),
  useEffect: () => {},
  useSyncExternalStore: <T>(_subscribe: unknown, snapshot: () => T) =>
    snapshot(),
};
const stubTypes = new Set<unknown>();
const stub = <T extends Record<string, unknown>>(module: T) => {
  for (const value of Object.values(module)) stubTypes.add(value);
  return module;
};
const named = (...names: string[]) =>
  stub(Object.fromEntries(names.map((name) => [name, function Stub() {}])));

function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  const element = node as StubElement;
  if (typeof element.type === "function" && !stubTypes.has(element.type))
    return expand((element.type as (props: unknown) => unknown)(element.props));
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element.props))
    props[key] = key === "children" || isElement(value) ? expand(value) : value;
  return { type: element.type, props };
}
const isElement = (value: unknown) =>
  Boolean(value && typeof value === "object" && "props" in value);
function mount(
  Component: (props: never) => unknown,
  props: Record<string, unknown>,
): Hooked {
  slots = [];
  const render = () => {
    cursor = 0;
    return expand((Component as (p: unknown) => unknown)(props)) as StubElement;
  };
  return { render, rerender: render };
}
function findAll(
  node: unknown,
  match: (element: StubElement) => boolean,
): StubElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!isElement(node)) return [];
  const element = node as StubElement;
  const nested = Object.values(element.props).flatMap((value) =>
    findAll(value, match),
  );
  return match(element) ? [element, ...nested] : nested;
}
const find = (node: unknown, match: (element: StubElement) => boolean) => {
  const [found] = findAll(node, match);
  assert.ok(found, "element not found");
  return found;
};
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isElement(node)) return "";
  return text((node as StubElement).props.children);
}

const runSession = {
  reasons: {} as Record<string, string | null>,
  codingPlanDecisionReason: (_state: unknown, _plan: unknown, decision?: string) =>
    runSession.reasons[decision ?? "all"] ?? null,
  codingSendBlockedReason: () => null,
};
const calls: unknown[][] = [];
const draft = {
  snapshot: { text: "", images: [] as unknown[], reading: [] as unknown[] },
  subscribe: () => () => {},
  getSnapshot: () => draft.snapshot,
};
let accept = true;
const sessionState = { draft, openingError: null as string | null };
const codingSession = {
  subscribe: () => () => {},
  getSnapshot: () => sessionState,
  async implementPlanWithModel(...args: unknown[]) {
    calls.push(["implementPlanWithModel", ...args]);
    return accept;
  },
  async handoff(...args: unknown[]) {
    calls.push(["handoff", ...args]);
    return accept;
  },
};
const targets = {
  providers: [],
  loaded: true,
  error: null,
  originName: "Qwen3.8-27B-GGUF · UD-Q4_K_XL",
};
const targetsModule = loadWithStubs<typeof Targets>(
  new URL("../src/features/coding/model-targets.ts", import.meta.url),
  {
    "@/features/chat": { useExternalProvidersStore: () => true },
    react,
    "./api": { codingModelApi: {} },
    "./model-selection": selection,
  },
);
const common = {
  react,
  "react/jsx-runtime": stubJsxRuntime(),
  "lucide-react": named(
    "ArrowRight", "ChevronDown", "Ellipsis", "ListChecks", "LoaderCircle", "Pencil", "Shuffle",
  ),
  "@/components/ui/button": named("Button"),
  "./model-target-picker": named("ModelTargetPicker"),
  "./model-targets": { ...targetsModule, useCodingTargets: () => targets },
  "./run-session": runSession,
  "./shared-session": { codingSession },
};
const { PlanDecisionPrompt } = loadWithStubs<typeof PlanDecision>(
  new URL("../src/features/coding/plan-decision.tsx", import.meta.url),
  { ...common, "./composer-decision": named("ComposerDecision") },
);
const { ReplyMenu } = loadWithStubs<typeof Dialog>(
  new URL("../src/features/coding/model-handoff-dialog.tsx", import.meta.url),
  {
    ...common,
    "@/components/markdown/markdown-preview": named("MarkdownPreview"),
    "@/components/ui/dialog": named(
      "Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogHeader", "DialogTitle",
    ),
    "@/components/ui/dropdown-menu": named(
      "DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuTrigger",
    ),
    "./model-handoff": handoff,
  },
);
const picker = common["./model-target-picker"].ModelTargetPicker;

const gguf = {
  provider: "studio-local",
  model: "inkling",
  name: "Inkling-2-Mini-GGUF · UD-Q4_K_M",
  providerName: "Studio local",
};
const plan = {
  id: "plan-1",
  revision: "r1",
  name: "Word count",
  status: "review_pending",
  markdown: "# Plan\n\nDo it.",
  clipped: false,
};
const state = (extra: Record<string, unknown> = {}) => ({
  viewingEarlier: false,
  connection: "connected",
  rows: [
    { kind: "user", text: "Add a word counter." },
    { kind: "assistant", text: "Here is the plan." },
  ],
  terminalPermissions: { kind: "ready", mode: "auto" },
  native: {
    info: { id: "c1", cwd: "/work" },
    configuration: { provider: "studio-local", model: "qwen", mode: "plan" },
    plan,
    active_request: null,
    requests: [],
  },
  ...extra,
});

test("friendly names drop the quant and GGUF suffix; exact names keep both", () => {
  assert.equal(targetsModule.friendlyModelName(gguf.name), "Inkling-2-Mini");
  assert.equal(targetsModule.friendlyModelName("GPT-5.5"), "GPT-5.5");
  assert.equal(targetsModule.friendlyModelName("Qwen3 GGUF · Q8_0"), "Qwen3");
  assert.equal(
    targetsModule.exactTargetName(gguf),
    "Inkling-2-Mini-GGUF · UD-Q4_K_M · Studio local",
  );
});

test("plan decisions stay three, with a short Change selector beside fresh context", () => {
  const decided: unknown[] = [];
  const run = { decidePlan: async (...args: unknown[]) => void decided.push(args) };
  const view = mount(PlanDecisionPrompt, { state: state(), run });
  let tree = view.render();
  const buttons = () =>
    findAll(tree, (element) => typeof element.props["data-decision"] === "string");
  assert.deepEqual(
    buttons().map((button) => button.props["aria-label"]),
    ["Implement", "Implement with fresh context", "Save and stop"],
  );
  const selector = find(tree, (element) => element.type === picker);
  assert.equal(selector.props.includeOrigin, true);
  assert.equal(selector.props.value, null);
  assert.equal(text(selector.props.children).trim(), "Change");

  // Default: the existing native decision.
  (buttons()[1]?.props.onClick as () => void)();
  assert.deepEqual(decided, [[plan, "implement_fresh"]]);

  // Choosing a model only relabels; nothing runs until Implement.
  (selector.props.onChange as (target: unknown) => void)(gguf);
  tree = view.rerender();
  assert.equal(calls.length, 0);
  const fresh = buttons()[1];
  assert.ok(fresh);
  assert.equal(fresh.props["aria-label"], "Implement with Inkling-2-Mini");
  assert.equal(fresh.props.title, "Inkling-2-Mini-GGUF · UD-Q4_K_M · Studio local");
  assert.match(text(fresh.props.children), /Starts a new Build conversation from this plan\./);
  assert.equal(buttons().length, 3);
  const exact = find(tree, (element) => element.type === picker);
  assert.equal(text(exact.props.children).trim(), "Change");
  assert.match(
    String((exact.props.children as StubElement).props.title),
    /UD-Q4_K_M · Studio local/,
  );

  (fresh.props.onClick as () => void)();
  assert.deepEqual(calls.pop(), [
    "implementPlanWithModel",
    state(),
    plan,
    { provider: "studio-local", model: "inkling" },
  ]);
  assert.equal(decided.length, 1);
  // The others still decide natively.
  (buttons()[0]?.props.onClick as () => void)();
  assert.deepEqual(decided.at(-1), [plan, "implement"]);
});

test("reply menu opens a read-first brief and hands off the reviewed text", async () => {
  const source = state();
  const view = mount(ReplyMenu, { state: source });
  let tree = view.render();
  const item = find(tree, (element) => element.props["data-testid"] === "coding-handoff");
  assert.equal(item.props.disabled, false);
  assert.match(text(item.props.children), /Hand off to another model…/);
  assert.equal(
    findAll(tree, (element) => element.props["data-testid"] === "coding-handoff-dialog").length,
    0,
  );

  (item.props.onSelect as () => void)();
  tree = view.rerender();
  const seed = handoff.handoffContext(source as never);
  // Rendered, not raw text, until Edit.
  const preview = find(tree, (element) => element.props["data-testid"] === "coding-handoff-brief");
  assert.equal(find(preview, (element) => "markdown" in element.props).props.markdown, seed);
  assert.equal(
    findAll(tree, (element) => element.type === "textarea").length,
    0,
  );
  const confirm = () =>
    find(tree, (element) => element.props["data-testid"] === "coding-handoff-confirm");
  assert.equal(confirm().props.disabled, true);
  assert.equal(confirm().props.title, "Choose the model to hand off to.");

  const target = find(tree, (element) => element.type === picker);
  assert.equal(target.props.includeOrigin, false);
  (target.props.onChange as (next: unknown) => void)(gguf);
  tree = view.rerender();
  assert.match(text(confirm().props.children), /Hand off to Inkling-2-Mini$/);

  (find(tree, (element) => element.props["data-testid"] === "coding-handoff-edit").props
    .onClick as () => void)();
  tree = view.rerender();
  const editor = find(tree, (element) => element.type === "textarea");
  assert.equal(editor.props.value, seed);
  (editor.props.onChange as (event: unknown) => void)({
    currentTarget: { value: "Finish the word counter." },
  });
  tree = view.rerender();

  (confirm().props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.pop(), [
    "handoff",
    source,
    { provider: "studio-local", model: "inkling" },
    "Finish the word counter.",
  ]);
});

test("a blocked handoff names its reason in the menu", () => {
  const view = mount(ReplyMenu, { state: state({ viewingEarlier: true }) });
  const item = find(view.render(), (element) => element.props["data-testid"] === "coding-handoff");
  assert.equal(item.props.disabled, true);
  assert.match(text(item.props.children), /Open the latest messages to hand off\./);
});

test("a refused handoff keeps the dialog open with the session's reason", async () => {
  accept = false;
  sessionState.openingError = "Mimir refused the new conversation.";
  try {
    const view = mount(ReplyMenu, { state: state() });
    let tree = view.render();
    (find(tree, (element) => element.props["data-testid"] === "coding-handoff").props
      .onSelect as () => void)();
    tree = view.rerender();
    (find(tree, (element) => element.type === picker).props.onChange as (
      next: unknown,
    ) => void)(gguf);
    tree = view.rerender();
    (find(tree, (element) => element.props["data-testid"] === "coding-handoff-confirm")
      .props.onClick as () => void)();
    await new Promise((resolve) => setImmediate(resolve));
    tree = view.rerender();
    assert.equal(calls.pop()?.[0], "handoff");
    const dialog = find(tree, (element) => element.props["data-testid"] === "coding-handoff-dialog");
    assert.match(
      text(find(dialog, (element) => element.props.role === "alert")),
      /Mimir refused the new conversation\./,
    );
  } finally {
    accept = true;
    sessionState.openingError = null;
  }
});
