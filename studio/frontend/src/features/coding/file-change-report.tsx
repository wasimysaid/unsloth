// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { boundedContentKeyDown } from "./bounded-content";
import {
  type FileChangeFile,
  type FileChangeProfile,
  MAX_DIFF_FILES,
  reportedUnifiedDiffSections,
} from "./file-changes";

const lineTone = (line: string) =>
  line.startsWith("+")
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : line.startsWith("-")
      ? "bg-red-500/10 text-red-700 dark:text-red-300"
      : line.startsWith("@@")
        ? "text-muted-foreground/60"
        : "text-muted-foreground";

function FileDiff({ file }: { file: FileChangeFile }) {
  const sections = useMemo(() => reportedUnifiedDiffSections(file), [file]);
  const [section, setSection] = useState(0);
  const current = Math.min(section, Math.max(0, sections.length - 1));
  const text = sections[current];
  const notes = [
    file.binary && "binary",
    file.partial && "partial",
    file.truncated && "truncated",
    file.unavailable && "diff unavailable",
  ].filter(Boolean);
  return (
    <div
      className="min-w-0"
      data-testid="coding-file-change-row"
      data-path={file.path}
    >
      <p className="flex min-w-0 items-center gap-2 py-1 text-[12px]">
        <span className="min-w-0 truncate font-mono text-foreground/80">
          {file.path}
        </span>
        <span className="shrink-0 text-muted-foreground">{file.status}</span>
        {file.additions != null && (
          <span className="shrink-0 font-mono text-emerald-600 dark:text-emerald-400">
            +{file.additions}
          </span>
        )}
        {file.deletions != null && (
          <span className="shrink-0 font-mono text-red-600 dark:text-red-400">
            −{file.deletions}
          </span>
        )}
        {notes.length > 0 && (
          <span className="shrink-0 text-muted-foreground/70">
            {notes.join(" · ")}
          </span>
        )}
        {sections.length > 1 && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground">
            <button
              type="button"
              aria-label="Previous diff section"
              disabled={current === 0}
              className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
              onClick={() => setSection(current - 1)}
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </button>
            <output aria-live="polite">
              {current + 1}/{sections.length}
            </output>
            <button
              type="button"
              aria-label="Next diff section"
              disabled={current === sections.length - 1}
              className="rounded p-0.5 hover:bg-muted disabled:opacity-40"
              onClick={() => setSection(current + 1)}
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        )}
      </p>
      {text && (
        <pre
          className="max-h-108 max-w-full overflow-auto overscroll-contain rounded-md coding-wash-faint py-1 font-mono text-[12px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded diffs need keyboard scrolling.
          tabIndex={0}
          onKeyDown={boundedContentKeyDown}
          aria-label={`Diff for ${file.path}`}
        >
          {text
            .replace(/\n$/, "")
            .split("\n")
            .map((line, index) =>
              // The ---/+++ path header repeats the file line above.
              current === 0 && index < 2 ? null : (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Diff lines are positional within an immutable section.
                  key={index}
                  className={`block min-w-max px-2 ${lineTone(line)}`}
                >
                  {line || " "}
                </span>
              ),
            )}
        </pre>
      )}
    </div>
  );
}

/** Reported effects of one tool result, never current workspace state. */
export function FileChangeReport({ profile }: { profile: FileChangeProfile }) {
  return (
    <div
      className="min-w-0 space-y-1.5 py-1"
      data-testid="coding-file-changes"
      aria-label="Reported file changes"
    >
      {profile.files.slice(0, MAX_DIFF_FILES).map((file, index) => (
        <FileDiff key={`${index}:${file.path}`} file={file} />
      ))}
      {(profile.truncated || profile.files.length > MAX_DIFF_FILES) && (
        <p role="note" className="text-[11px] text-muted-foreground">
          More changed files were not reported
        </p>
      )}
    </div>
  );
}
