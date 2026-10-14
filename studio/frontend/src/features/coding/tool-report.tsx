// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { useState } from "react";
import { Streamdown } from "streamdown";
import { boundedContentKeyDown } from "./bounded-content";
import { FileChangeReport } from "./file-change-report";
import type { CodingRow } from "./run-types";

/** Render only the plugin's bounded public output, never tool arguments/model data. */
export function ToolReport({ row }: { row: CodingRow }) {
  const [expanded, setExpanded] = useState(false);
  const tool = row.tool;
  if (!tool) return null;
  const historical = Boolean(row.historical || tool.historical);
  const semantic =
    tool.semantic_content === "answer_markdown" ||
    tool.semantic_content === "report_markdown";
  return (
    <div
      className="min-w-0 space-y-2"
      data-reading-owner={tool.invocation_id ?? tool.call_id}
    >
      {semantic && tool.output && (
        <div
          className="max-h-80 min-w-0 overflow-auto overscroll-contain rounded-lg text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Public semantic output is height-bounded and keyboard scrollable.
          tabIndex={0}
          onKeyDown={boundedContentKeyDown}
          data-reading-control="semantic-output"
          aria-label={
            tool.semantic_content === "answer_markdown"
              ? "Public tool answer"
              : "Public tool report"
          }
        >
          <Streamdown mode="static">{tool.output}</Streamdown>
        </div>
      )}
      <details
        className="min-w-0 rounded-xl border border-border/60 text-sm"
        data-testid="coding-tool-row"
        data-call-id={tool.call_id}
        data-invocation-id={tool.invocation_id ?? undefined}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-medium">
            {tool.title || tool.name || "Tool"}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            {tool.status || "Reported activity"}
          </span>
          {historical && (
            <span className="ml-2 text-xs text-muted-foreground">
              Historical report
            </span>
          )}
        </summary>
        {expanded && (
          <div className="space-y-2 border-t border-border/50 px-3 py-3">
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              Tool {tool.name} · invocation{" "}
              {tool.invocation_id ?? "not supplied"} · call {tool.call_id}
            </p>
            {(row.request_id || tool.request_id) && (
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                Request {row.request_id || tool.request_id}
              </p>
            )}
            <pre
              className="max-h-80 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 font-mono text-xs"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output needs keyboard scrolling.
              tabIndex={0}
              onKeyDown={boundedContentKeyDown}
              aria-label="Actual public tool output"
            >
              {tool.output || "No public output reported yet."}
            </pre>
            {!tool.output_profile &&
              ["completed", "failed"].includes(tool.status) && (
                <p className="text-xs text-muted-foreground">
                  Structured file-change profile unavailable. Inspect the actual
                  public output; filesystem effects are not inferred.
                </p>
              )}
          </div>
        )}
      </details>
      {tool.output_profile?.kind === "file_change" && (
        <FileChangeReport
          profile={tool.output_profile}
          historical={historical}
        />
      )}
      {tool.clipped && (
        <p role="note" className="text-xs font-medium">
          Output clipped to the presentation bound; this is not the complete
          output.
        </p>
      )}
    </div>
  );
}
