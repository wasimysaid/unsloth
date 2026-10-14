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

/** Shared reported hunk formatting: no cumulative patch or invented positions. */
function* reportedHunkLines(file: FileChangeFile): Generator<string> {
  for (const hunk of file.hunks) {
    yield `@@ -${range(hunk.lines, "old_line", file.status === "created")} +${range(hunk.lines, "new_line", file.status === "deleted")} @@`;
    for (const line of hunk.lines) {
      const prefix =
        line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
      // Preserve native embedded/CRLF endings, without adding blank diff rows.
      const content = line.content.endsWith("\n")
        ? line.content.slice(0, -1)
        : line.content;
      yield prefix + content;
      // A native truncated report cannot establish an actual EOF observation.
      if (!file.truncated && !line.content.endsWith("\n"))
        yield "\\ No newline at end of file";
    }
  }
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
  for (const line of reportedHunkLines(file)) {
    if (!append(line)) break;
  }
  return { text, clipped };
}

/**
 * Lossless sections of the supplied unified output. Join with "" to recover the
 * report exactly. Only one section is mounted by the renderer. Bound UTF-8 bytes
 * and physical lines, keeping ordinary reported lines intact where possible;
 * an oversized line/header continues across sections without fabricated prefixes.
 */
export function reportedUnifiedDiffSections(file: FileChangeFile): string[] {
  if (file.binary || !file.hunks.length) return [];
  const sections: string[] = [];
  const encoder = new TextEncoder();
  let text = "";
  let bytes = 0;
  let newlines = 0;
  const flush = () => {
    if (text) sections.push(text);
    text = "";
    bytes = 0;
    newlines = 0;
  };
  const append = (line: string) => {
    const value = `${line}\n`;
    const size = encoder.encode(value).length;
    const breaks = value.split("\n").length - 1;
    if (size <= MAX_DIFF_CHARACTERS && breaks < MAX_DIFF_LINES) {
      if (
        bytes + size > MAX_DIFF_CHARACTERS ||
        newlines + breaks >= MAX_DIFF_LINES
      )
        flush();
      text += value;
      bytes += size;
      newlines += breaks;
      return;
    }
    // Only oversized individual records need splitting inside a line. Iterating
    // Unicode scalars avoids displaying half a surrogate pair at section edges.
    flush();
    for (const character of value) {
      const size = encoder.encode(character).length;
      const breaks = character === "\n" ? 1 : 0;
      if (
        bytes + size > MAX_DIFF_CHARACTERS ||
        newlines + breaks >= MAX_DIFF_LINES
      )
        flush();
      text += character;
      bytes += size;
      newlines += breaks;
    }
  };
  append(`--- ${file.status === "created" ? "/dev/null" : file.path}`);
  append(`+++ ${file.status === "deleted" ? "/dev/null" : file.path}`);
  for (const line of reportedHunkLines(file)) append(line);
  flush();
  return sections;
}

/** Include structured effects in the existing ephemeral transcript memory budget. */
export function codingRowSize(row: {
  text?: string;
  plan?: { markdown: string };
  tool?: { output: string; output_profile?: ToolOutputProfile | null };
}): number {
  return (
    (row.text?.length ?? 0) +
    (row.plan?.markdown.length ?? 0) +
    (row.tool?.output.length ?? 0) +
    (row.tool?.output_profile
      ? JSON.stringify(row.tool.output_profile).length
      : 0)
  );
}
