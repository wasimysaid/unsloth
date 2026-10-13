// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Public, bounded reported effects supplied by Mimir. Never workspace snapshots. */
export interface FileChangeLine {
  old_line: number | null;
  new_line: number | null;
  kind: "context" | "added" | "removed";
  content: string;
}
export interface FileChangeFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  replacements?: number | null;
  hunks: { lines: FileChangeLine[] }[];
  binary: boolean;
  partial: boolean;
  truncated: boolean;
  unavailable?: boolean;
}
export interface FileChangeProfile {
  kind: "file_change";
  files: FileChangeFile[];
  truncated: boolean;
}
// The product plugin projects file effects; other native profiles remain null.
export type ToolOutputProfile = FileChangeProfile;

// Defence in depth for the browser projection, in addition to plugin bounds.
export const MAX_DIFF_CHARACTERS = 16 * 1024;
export const MAX_DIFF_LINES = 400;
export const MAX_DIFF_FILES = 64;

export function reportedCounts(file: FileChangeFile): string {
  const added =
    file.additions == null
      ? "Added count unavailable"
      : `+${file.additions} added`;
  const removed =
    file.deletions == null
      ? "Removed count unavailable"
      : `−${file.deletions} removed`;
  return `${added} · ${removed}`;
}

/** Headers use only supplied line positions. A missing position stays unknown. */
function range(
  lines: FileChangeLine[],
  side: "old_line" | "new_line",
  absent: boolean,
): string {
  const positions = lines
    .map((line) => line[side])
    .filter((n): n is number => n !== null && n !== undefined);
  if (positions.length === 0) return absent ? "0,0" : "?,?";
  return `${positions[0]},${positions.length}`;
}

/** Format the reported hunks; do not reconstruct complete contents or run a diff. */
export function reportedUnifiedDiff(file: FileChangeFile): {
  text: string;
  clipped: boolean;
} {
  if (file.binary || !file.hunks.length) return { text: "", clipped: false };
  let text = "";
  let lineCount = 0;
  let clipped = false;
  const append = (value: string) => {
    const lines = value.split("\n").length;
    if (
      lineCount + lines > MAX_DIFF_LINES ||
      text.length + value.length + 1 > MAX_DIFF_CHARACTERS
    ) {
      clipped = true;
      return false;
    }
    text += `${value}\n`;
    lineCount += lines;
    return true;
  };
  append(`--- ${file.status === "created" ? "/dev/null" : file.path}`);
  append(`+++ ${file.status === "deleted" ? "/dev/null" : file.path}`);
  outer: for (const hunk of file.hunks) {
    if (
      !append(
        `@@ -${range(hunk.lines, "old_line", file.status === "created")} +${range(hunk.lines, "new_line", file.status === "deleted")} @@`,
      )
    )
      break;
    for (const line of hunk.lines) {
      const prefix =
        line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
      // Native line contents retain their line ending. Do not add blank diff rows.
      const content = line.content.endsWith("\n")
        ? line.content.slice(0, -1)
        : line.content;
      if (!append(prefix + content)) break outer;
      // Native line contents preserve EOF-newline information. A clipped record
      // cannot establish that a missing terminator is an actual EOF observation.
      if (!file.truncated && !line.content.endsWith("\n")) {
        if (!append("\\ No newline at end of file")) break outer;
      }
    }
  }
  return { text, clipped };
}

/** Include structured effects in the existing ephemeral transcript memory budget. */
export function codingRowSize(row: {
  text?: string;
  tool?: { output: string; output_profile?: ToolOutputProfile | null };
}): number {
  return (
    (row.text?.length ?? 0) +
    (row.tool?.output.length ?? 0) +
    (row.tool?.output_profile
      ? JSON.stringify(row.tool.output_profile).length
      : 0)
  );
}
