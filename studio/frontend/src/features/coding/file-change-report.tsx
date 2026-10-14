// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Button } from "@/components/ui/button";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { boundedContentKeyDown } from "./bounded-content";
import {
  type FileChangeFile,
  type FileChangeProfile,
  MAX_DIFF_FILES,
  reportedCounts,
  reportedUnifiedDiffSections,
} from "./file-changes";

function FileRow({
  file,
  historical,
}: { file: FileChangeFile; historical: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState(0);
  const output = useRef<HTMLPreElement>(null);
  const sectionFocus = useRef(false);
  const sections = useMemo(
    () => (expanded ? reportedUnifiedDiffSections(file) : []),
    [expanded, file],
  );
  const current = Math.min(section, Math.max(0, sections.length - 1));
  const text = sections[current];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset focus/scroll only after the selected section text mounts.
  useLayoutEffect(() => {
    if (!sectionFocus.current || !output.current) return;
    sectionFocus.current = false;
    output.current.scrollTop = 0;
    output.current.scrollLeft = 0;
    output.current.focus({ preventScroll: true });
  }, [current, text]);
  const showSection = (next: number) => {
    sectionFocus.current = true;
    setSection(next);
  };
  return (
    <details
      className="min-w-0 rounded-lg border border-border/60 text-xs"
      data-testid="coding-file-change-row"
      data-path={file.path}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (!event.currentTarget.open) setSection(0);
      }}
    >
      <summary className="cursor-pointer rounded-lg px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="break-all font-mono font-medium">{file.path}</span>
        <span className="ml-2 inline-block">
          {file.status} · {reportedCounts(file)}
        </span>
        <span className="mt-1 block text-muted-foreground">
          {historical ? "Historical reported change" : "Reported change"}
          {file.binary && " · Binary metadata only"}
          {file.partial && " · Partial diff"}
          {file.truncated && " · Truncated"}
          {file.unavailable && " · Diff unavailable"}
        </span>
      </summary>
      <div className="min-w-0 space-y-2 border-t border-border/50 p-3">
        {historical && (
          <p>Historical tool output; not current filesystem state.</p>
        )}
        {file.binary ? (
          <p>
            Binary change. No textual diff was supplied; only reported metadata
            is shown.
          </p>
        ) : text ? (
          <>
            {sections.length > 1 && (
              <div className="space-y-2">
                <output className="block" aria-live="polite" aria-atomic="true">
                  Reported diff section {current + 1} of {sections.length}
                  {current > 0 && " · Continued supplied content"}
                </output>
                <p>
                  Supplied diff is divided into bounded sections. Read all
                  supplied content with the section controls; a section may
                  continue a line.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current === 0}
                    data-reading-control={`diff-section-previous:${file.path}`}
                    onClick={() => showSection(current - 1)}
                  >
                    Previous diff section
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current === sections.length - 1}
                    data-reading-control={`diff-section-next:${file.path}`}
                    onClick={() => showSection(current + 1)}
                  >
                    Next diff section
                  </Button>
                </div>
              </div>
            )}
            <pre
              ref={output}
              className="max-h-80 max-w-full overflow-auto overscroll-contain whitespace-pre font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded diffs need keyboard scrolling.
              tabIndex={0}
              onKeyDown={boundedContentKeyDown}
              data-reading-control={`diff-section-content:${file.path}`}
              aria-label={`Reported unified diff for ${file.path}`}
            >
              {text}
            </pre>
          </>
        ) : (
          <p>Textual diff unavailable in this reported output.</p>
        )}
        {file.partial && (
          <p role="note">
            Partial reported content; complete file contents are not available
            here.
          </p>
        )}
        {file.truncated && (
          <p role="note">
            Diff truncated to a presentation bound by the native report; this is
            not the complete change. All supplied content remains accessible
            here.
          </p>
        )}
        <p className="text-muted-foreground">
          Inspection only · record of this tool result, not a cumulative
          workspace patch.
        </p>
      </div>
    </details>
  );
}

/** One renderer for live and saved typed profiles, under their originating result. */
export function FileChangeReport({
  profile,
  historical,
}: { profile: FileChangeProfile; historical: boolean }) {
  return (
    <div
      className="min-w-0 space-y-2"
      data-testid="coding-file-changes"
      aria-label="Reported file changes"
    >
      <p className="text-xs text-muted-foreground">
        {historical
          ? "Historical reported file changes · not current filesystem state"
          : "Reported file changes · inspection only"}
      </p>
      {profile.files.slice(0, MAX_DIFF_FILES).map((file, index) => (
        <FileRow
          key={`${index}:${file.path}`}
          file={file}
          historical={historical}
        />
      ))}
      {(profile.truncated || profile.files.length > MAX_DIFF_FILES) && (
        <p role="note" className="text-xs font-medium">
          File-change profile truncated; additional reported content may be
          unavailable.
        </p>
      )}
    </div>
  );
}
