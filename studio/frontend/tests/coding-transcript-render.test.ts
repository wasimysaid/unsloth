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
stubs["./subagent-card"] = loadWithStubs(
  new URL("../src/features/coding/subagent-card.tsx", import.meta.url),
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

test("multi-megabyte prose passes complete native text to the shared Markdown renderer", () => {
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
  const markdown = markup.match(
    /<div data-markdown="true">([\s\S]*?)<\/div>/,
  )?.[1];
  assert.equal(markdown, text);
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

test("an agent launch is its own inspectable card; calls about the agent stay rows with their output", () => {
  const subagent = {
    agent_id: "child-h",
    attempt: 1,
    agent: "explorer",
    description: "Survey the repo",
    model: "gpt-test",
    status: "running" as const,
  };
  const agentTool = (
    id: string,
    name: string,
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
      name,
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
        "agent",
        "Explorer: Survey the repo",
        "completed",
        "Launched child-h attempt 1",
      ),
      agentTool(
        "inv-2",
        "send_subagent_message",
        "Send agent guidance",
        "failed",
        "Refused: not accepting messages",
      ),
    ],
    latestWindow(),
  );
  assert.deepEqual(
    blocks.map((block) => [
      block.kind,
      block.kind === "activity" ? block.agents : null,
    ]),
    [
      ["activity", true],
      ["activity", false],
    ],
  );
  // Reader has expanded the refused call; its actual output must be there.
  const memory = new Map([
    [blocks[1].key, true],
    ["invocation:inv-2", true],
  ]);
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
  const cards = markup.match(
    /data-testid="coding-child-row"[^>]*data-child-handle="child-h"[^>]*data-child-attempt="1"/g,
  );
  assert.equal(cards?.length, 1, "only the launch is a card");
  assert.match(markup, /Survey the repo/);
  assert.match(markup, /gpt-test/);
  assert.doesNotMatch(markup, /data-invocation-id="inv-1"/);
  assert.match(markup, /data-invocation-id="inv-2"/);
  assert.match(markup, /data-tool-status="failed"/);
  assert.match(markup, /Refused: not accepting messages/);
});

test("tool rows show the verb with its argument, and groups are titled even for one call", () => {
  const shell: CodingRow = {
    id: "shell",
    kind: "tool",
    request_id: "request",
    tool: {
      invocation_id: "shell",
      call_id: "call-shell",
      request_id: "request",
      name: "shell",
      title: "Run command",
      argument: "rg --files -g '*.md' | head -100",
      status: "completed",
      output: "README.md\n",
      clipped: false,
      quiet: false,
      row_group: null,
      display_kind: "shell",
    },
  };
  const read: CodingRow = {
    id: "read",
    kind: "tool",
    request_id: "request",
    tool: {
      invocation_id: "read",
      call_id: "call-read",
      request_id: "request",
      name: "read_file",
      title: "Read: crates/mimir-cli/src/main.rs",
      status: "completed",
      output: "fn main() {}",
      clipped: false,
      quiet: false,
      row_group: null,
      display_kind: "file_read",
    },
  };
  assert.deepEqual(toolReport.toolLabel(shell.tool!), {
    verb: "Run",
    subject: "rg --files -g '*.md' | head -100",
  });
  assert.deepEqual(toolReport.toolLabel(read.tool!), {
    verb: "Read",
    subject: "crates/mimir-cli/src/main.rs",
  });
  assert.deepEqual(
    toolReport.toolLabel({ ...shell.tool!, argument: null }),
    { verb: "Run command", subject: "" },
  );
  const blocks = projectTranscript([shell], latestWindow());
  const settled = renderToStaticMarkup(
    React.createElement(transcript.TranscriptBlocks, {
      blocks,
      childView: null,
    }),
  );
  assert.match(settled, /Ran 1 command/);
  assert.doesNotMatch(settled, /data-testid="coding-tool-row"/, "settled groups fold");
  const live = renderToStaticMarkup(
    React.createElement(transcript.TranscriptBlocks, {
      blocks: projectTranscript(
        [{ ...shell, tool: { ...shell.tool!, status: "running" } }, read],
        latestWindow("request"),
      ),
      childView: null,
    }),
  );
  assert.match(live, /coding-shimmer/, "a live group title shimmers");
  assert.match(live, /Running<\/span>/);
  assert.match(live, /head -100/);
  assert.match(live, /title="crates\/mimir-cli\/src\/main.rs"[^>]*>main.rs</);
});
