// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { useState } from "react";
import {
  type FileChangeFile,
  type FileChangeProfile,
  MAX_DIFF_FILES,
  reportedCounts,
  reportedUnifiedDiff,
} from "./file-changes";

function FileRow({
  file,
  historical,
}: { file: FileChangeFile; historical: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const diff = expanded ? reportedUnifiedDiff(file) : null;
  return (
    <details
      className="min-w-0 rounded-lg border border-border/60 text-xs"
      data-testid="coding-file-change-row"
      data-path={file.path}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
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
        ) : diff?.text ? (
          <pre
            className="max-h-80 max-w-full overflow-auto whitespace-pre font-mono text-xs leading-relaxed"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded diffs need keyboard scrolling.
            tabIndex={0}
            aria-label={`Reported unified diff for ${file.path}`}
          >
            {diff.text}
          </pre>
        ) : (
          <p>Textual diff unavailable in this reported output.</p>
        )}
        {file.partial && (
          <p role="note">
            Partial reported content; complete file contents are not available
            here.
          </p>
        )}
        {(file.truncated || diff?.clipped) && (
          <p role="note">
            Diff truncated to a presentation bound; this is not the complete
            change.
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
