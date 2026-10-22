// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import * as lucide from "lucide-react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import * as answerFocus from "../src/features/coding/answer-focus.ts";
import * as boundedContent from "../src/features/coding/bounded-content.ts";
import * as childTypes from "../src/features/coding/child-types.ts";
import * as markdownParagraph from "../src/features/coding/markdown-paragraph.ts";
import type * as Transcript from "../src/features/coding/transcript.tsx";
import type * as ToolReport from "../src/features/coding/tool-report.tsx";
import type { CodingRow } from "../src/features/coding/run-types.ts";
import {
  latestWindow,
  projectTranscript,
} from "../src/features/coding/transcript-model.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

// Real React, rendered on the server: actual markup, not a stub tree.
const react = {
  ...React,
  // Server rendering needs a server snapshot; the client one is the same here.
  useSyncExternalStore: <T>(subscribe: () => () => void, snapshot: () => T) =>
    React.useSyncExternalStore(subscribe, snapshot, snapshot),
};
const stubs: Record<string, unknown> = {
  react,
  "react/jsx-runtime": jsxRuntime,
  "lucide-react": lucide,
  "@/components/markdown/markdown-preview": {
    MarkdownPreview: ({ markdown }: { markdown: string }) =>
      React.createElement("div", { "data-markdown": true }, markdown),
  },
  "@/components/ui/button": {
    Button: (props: Record<string, unknown>) =>
      React.createElement("button", props),
  },
  "./answer-focus": answerFocus,
  "./bounded-content": boundedContent,
  "./child-types": childTypes,
  "./markdown-paragraph": markdownParagraph,
  "./file-change-report": { FileChangeReport: () => null },
  "./plan-card": { PlanCard: () => null },
};
const toolReport = loadWithStubs<typeof ToolReport>(
  new URL("../src/features/coding/tool-report.tsx", import.meta.url),
  stubs,
);
stubs["./tool-report"] = toolReport;
stubs["./entry-content-status"] = loadWithStubs(
  new URL("../src/features/coding/entry-content-status.tsx", import.meta.url),
  stubs,
);
stubs["./child-inspector"] = loadWithStubs(
  new URL("../src/features/coding/child-inspector.tsx", import.meta.url),
  stubs,
);
const transcript = loadWithStubs<typeof Transcript>(
  new URL("../src/features/coding/transcript.tsx", import.meta.url),
  stubs,
);
const opened: unknown[] = [];
const childView = {
  subscribe: () => () => {},
  getSnapshot: () => ({
    attempts: [],
    inspection: null,
    connected: true,
    omitted: false,
  }),
  open: async (identity: unknown) => {
    opened.push(identity);
  },
};

test("multi-megabyte literal paragraph renders complete native text without a document parser", () => {
  const text =
    "EVAL_TRANSPORT_BEGIN " + "é中文😀z ".repeat(180000) + "EVAL_TRANSPORT_END";
  const row: CodingRow = {
    id: "large",
    entry_id: null,
    request_id: "r",
    kind: "assistant",
    text,
  };
  const markup = renderToStaticMarkup(
    React.createElement(transcript.TranscriptBlocks, {
      blocks: projectTranscript([row], latestWindow("r")),
      childView: null,
    }),
  );
  const paragraph = markup.match(
    /<p[^>]*data-native-paragraph=""[^>]*>([\s\S]*?)<\/p>/,
  )?.[1];
  assert.ok(paragraph);
  assert.ok((paragraph.match(/<span>/g)?.length ?? 0) > 500);
  assert.equal(paragraph.replace(/<\/?span>/g, ""), text);
  assert.equal(markup.includes("data-markdown"), false);
});

test("formatted prose continues through the Markdown renderer", () => {
  for (const text of [
    "**bold**",
    "_italic_",
    "a\\nb",
    "[link](https://example.com)",
    "x@example.com",
    "    indented code",
    "漢_🙂_字",
  ]) {
    const row: CodingRow = { id: "formatted", kind: "assistant", text };
    const markup = renderToStaticMarkup(
      React.createElement(transcript.TranscriptBlocks, {
        blocks: projectTranscript([row], latestWindow()),
        childView: null,
      }),
    );
    assert.match(markup, /data-markdown/, text);
    assert.doesNotMatch(markup, /data-native-paragraph/, text);
  }
});

test("unresolved saved entries render explicit content feedback and a retry without claiming clipped transcript content", () => {
  const row: CodingRow = {
    id: "entry",
    entry_id: "entry",
    request_id: null,
    kind: "content_ref",
    content_ref: {
      cut: { journal: "root", leaf: "entry" },
      entry_id: "entry",
      total_bytes: 9999999,
    },
    content: { status: "error", error: "Read failed", retry: () => {} },
  };
  const markup = renderToStaticMarkup(
    React.createElement(transcript.TranscriptBlocks, {
      blocks: projectTranscript([row], latestWindow()),
      childView: null,
    }),
  );
  assert.match(markup, /Saved entry content is not loaded/);
  assert.match(markup, /Read failed/);
  assert.match(markup, /Retry loading entry/);
  assert.doesNotMatch(markup, /Content clipped|Native activity|disabled/);
});

test("both subagent invocations render with their public result and an inspector link", () => {
  const subagent = {
    agent_id: "child-h",
    attempt: 1,
    agent: "explorer",
    description: "Survey the repo",
    status: "running" as const,
  };
  const agentTool = (
    id: string,
    title: string,
    status: string,
    output: string,
  ): CodingRow => ({
    id,
    kind: "tool",
    request_id: "request",
    tool: {
      invocation_id: id,
      call_id: `call-${id}`,
      request_id: "request",
      name: "native_agent_tool",
      title,
      status,
      output,
      clipped: false,
      quiet: false,
      row_group: null,
      display_kind: "agent",
      subagent,
    },
  });
  const blocks = projectTranscript(
    [
      agentTool(
        "inv-1",
        "Launch explorer",
        "completed",
        "Launched child-h attempt 1",
      ),
      agentTool(
        "inv-2",
        "Message explorer",
        "failed",
        "Refused: not accepting messages",
      ),
    ],
    latestWindow(),
  );
  // Reader has expanded the refused call; its actual output must be there.
  const memory = new Map([["invocation:inv-2", true]]);
  const markup = renderToStaticMarkup(
    React.createElement(
      toolReport.DisclosureMemory,
      { value: memory },
      React.createElement(transcript.TranscriptBlocks, {
        blocks,
        childView: childView as never,
      }),
    ),
  );
  assert.match(markup, /data-invocation-id="inv-1"/);
  assert.match(markup, /data-invocation-id="inv-2"/);
  assert.match(markup, /data-tool-status="failed"/);
  assert.match(markup, /Refused: not accepting messages/);
  const links = markup.match(
    /data-testid="coding-child-row"[^>]*data-child-handle="child-h"[^>]*data-child-attempt="1"/g,
  );
  assert.equal(links?.length, 2, "each invocation links the exact attempt");
});
