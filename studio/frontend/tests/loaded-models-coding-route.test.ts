// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import ts from "@typescript/typescript6";
import { CHAT_SETTINGS_INSET_VAR, COMPOSER_CLEARANCE_VAR, cornerInsetScope } from "../src/lib/toast-offset.ts";
import { readSrc } from "./helpers/kit.ts";
import { stubJsxRuntime, type StubElement } from "./helpers/module-stubs.ts";

// Execute the shipped provider's route selection. Hook effects are not run in
// this node render harness: absence of the indicator subtree is the guarantee
// that its lifecycle subscription and four-runtime polling hook cannot mount.
const source = ts.createSourceFile(
  "provider.tsx",
  readSrc("app/provider.tsx"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const wrapper = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "TauriWrapper",
);
assert.ok(wrapper, "the shared provider must own the overlay rails");
const constants = source.statements.filter(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.every((declaration) =>
      /^(STACK_|HIDDEN_TITLEBAR_SIDEBAR_ROUTES$|WEB_UPDATE_HIDDEN_ROUTES$)/.test(
        declaration.name.getText(source),
      ),
    ),
);
const { outputText } = ts.transpileModule(
  `${constants.map((node) => node.getText(source)).join("\n")}\nexport ${wrapper.getText(source)}`,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
);

function provider(desktop: boolean) {
  let pathname = "/coding";
  const residentWorkspace = { type: "resident-workspace", props: {} };
  const exports: {
    TauriWrapper?: (props: { children: StubElement }) => StubElement;
  } = {};
  const scope = {
    isTauri: desktop,
    useRouterState: () => pathname,
    useTauriBackend: () => ({
      status: "running",
      isExternalServer: false,
      closing: false,
    }),
    useRef: (current: unknown) => ({ current }),
    useMemo: (factory: () => unknown) => factory(),
    // Auth and readiness are settled. Keep numeric counters at their initial
    // value; neither effects nor native setup run in this render-only test.
    useState: (initial: unknown) => [
      typeof initial === "boolean" ? true : initial,
      () => {},
    ],
    useEffect: () => {},
    shouldUseCustomWindowTitlebar: () => false,
    shouldUseNativeMacWindowTitlebar: () => false,
    Z_LAYER: { OVERLAY_STACK: 1 },
    CHAT_SETTINGS_INSET_VAR,
    COMPOSER_CLEARANCE_VAR,
    cornerInsetScope,
    WebUpdateBanner: "WebUpdateBanner",
    LlamaUpdateBanner: "LlamaUpdateBanner",
    DownloadManagerPanel: "DownloadManagerPanel",
    LoadedModelsIndicator: "LoadedModelsIndicator",
    AppReadinessBoundary: "AppReadinessBoundary",
    TauriUpdateLayer: "TauriUpdateLayer",
    NativeIntentDrain: "NativeIntentDrain",
    DesktopChromeVarsEffect: "DesktopChromeVarsEffect",
    TauriRepairContext: { Provider: "TauriRepairProvider" },
  };
  new Function("exports", "require", ...Object.keys(scope), outputText)(
    exports,
    () => stubJsxRuntime(),
    ...Object.values(scope),
  );
  return {
    residentWorkspace,
    render(next: string) {
      pathname = next;
      return exports.TauriWrapper!({ children: residentWorkspace });
    },
  };
}

function nodes(tree: unknown): StubElement[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as StubElement;
  return [
    element,
    ...nodes(element.props.children),
    ...nodes(element.props.appContent),
  ];
}

for (const desktop of [false, true]) {
  const platform = desktop ? "desktop" : "web";
  test(`${platform}: direct coding entry mounts no loaded-model presentation or polling owner`, () => {
    const p = provider(desktop);
    const rendered = nodes(p.render("/coding"));
    assert.equal(
      rendered.filter((node) => node.type === "LoadedModelsIndicator").length,
      0,
    );
    assert.ok(
      rendered.includes(p.residentWorkspace),
      "the route content remains mounted",
    );
    assert.equal(
      rendered.filter((node) => node.type === "DownloadManagerPanel").length,
      1,
    );
  });

  test(`${platform}: ordinary routes keep the card and returning from coding restores it without replacing resident content`, () => {
    const p = provider(desktop);
    for (const path of [
      "/chat",
      "/images",
      "/video",
      "/audio",
      "/projects",
      "/studio",
    ]) {
      const before = nodes(p.render(path));
      const cards = before.filter(
        (node) => node.type === "LoadedModelsIndicator",
      );
      assert.equal(cards.length, 1, path);
      assert.equal(cards[0].props.positioned, false);
      assert.ok(before.includes(p.residentWorkspace));

      const coding = nodes(p.render("/coding"));
      assert.equal(
        coding.filter((node) => node.type === "LoadedModelsIndicator").length,
        0,
        path,
      );
      assert.ok(
        coding.includes(p.residentWorkspace),
        "switching route must not remove resident work",
      );

      const after = nodes(p.render(path));
      assert.equal(
        after.filter((node) => node.type === "LoadedModelsIndicator").length,
        1,
        path,
      );
      assert.ok(after.includes(p.residentWorkspace));
    }
  });
}
