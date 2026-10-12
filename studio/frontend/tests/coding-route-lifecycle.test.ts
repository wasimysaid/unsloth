// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { stubJsxRuntime, type StubElement } from "./helpers/module-stubs.ts";

const root = readFileSync(
  new URL("../src/app/routes/__root.tsx", import.meta.url),
  "utf8",
);

/** Execute the shipped route selector without starting Studio's host engines. */
function shell(initialPath: string) {
  const source = ts.createSourceFile(
    "__root.tsx",
    root,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const selector = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "RootRouteLayout",
  );
  assert.ok(
    selector,
    "the root route must own the coding/general-workspace boundary",
  );
  const { outputText } = ts.transpileModule(
    `export ${selector.getText(source)}`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  );
  let path = initialPath;
  let mounted: boolean | undefined;
  const exports: { RootRouteLayout?: () => StubElement } = {};
  new Function(
    "exports",
    "require",
    "useRouterState",
    "useState",
    "HIDDEN_NAVBAR_ROUTES",
    "AppProvider",
    "RootLayout",
    "RouteBoundary",
    "Outlet",
    outputText,
  )(
    exports,
    () => stubJsxRuntime(),
    () => path,
    (initial: boolean) => {
      mounted ??= initial;
      return [
        mounted,
        (next: boolean) => {
          mounted = next;
        },
      ];
    },
    ["/login", "/change-password"],
    "AppProvider",
    "RootLayout",
    "RouteBoundary",
    "Outlet",
  );
  const render = (next: string) => {
    path = next;
    exports.RootRouteLayout!(); // consume React's render-phase mount latch
    return exports.RootRouteLayout!();
  };
  return { render };
}
function children(element: StubElement): StubElement[] {
  return (element.props.children as unknown[]).filter(
    (node): node is StubElement => !!node && typeof node === "object",
  );
}

test("direct coding and login-to-coding do not mount the general-chat engine shell", () => {
  for (const initial of ["/coding", "/login", "/change-password"]) {
    const s = shell(initial);
    if (initial !== "/coding")
      assert.equal(children(s.render(initial))[0].type, "RootLayout");
    const result = s.render("/coding");
    assert.equal(
      result.type,
      "AppProvider",
      "the shared host/auth/appearance boundary remains",
    );
    assert.deepEqual(
      children(result).map((node) => node.type),
      ["RouteBoundary"],
    );
    assert.equal(
      children(result)[0].props.readyWhenCommitted,
      false,
      "the coding page signals its own readiness",
    );
  }
});

test("already mounted Studio workspaces stay mounted but hidden/inert while coding owns the outlet", () => {
  const s = shell("/chat");
  const original = children(s.render("/chat"))[0];
  assert.equal(original.type, "div");
  assert.equal(original.props.className, "contents");
  const during = children(s.render("/coding"));
  assert.deepEqual(
    during.map((node) => node.type),
    ["div", "RouteBoundary"],
  );
  assert.equal(during[0].props.className, "hidden");
  assert.equal(during[0].props.inert, true);
  assert.equal((during[0].props.children as StubElement).type, "RootLayout");
  assert.equal((during[0].props.children as StubElement).props.parked, true);
  const restored = children(s.render("/chat"));
  assert.equal(restored.length, 1);
  assert.equal(restored[0].props.className, "contents");
  assert.equal((restored[0].props.children as StubElement).props.parked, false);
});

test("parked Studio disables its portals/outlet/chords without removing retained chat/media mounts", () => {
  assert.match(root, /!parked && <AppSidebar/);
  assert.match(
    root,
    /!parked && !isChatRoute && !isImagesRoute && !isVideoRoute && !isAudioRoute/,
  );
  assert.match(
    root,
    /const routeShortcutEnabled = !parked && !isAuthFlowRoute && !settingsDialogOpen/,
  );
  assert.match(root, /shortcutEnabled=\{!parked\}/);
  assert.match(root, /settingsActive=\{!parked\}/);
  for (const workspace of ["Chat", "Images", "Video", "Audio"]) {
    assert.match(root, new RegExp(`shouldMount${workspace} && \\(`));
  }
});
