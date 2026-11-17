// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { codingRequest } from "./api";
import type {
  DirectoryPage,
  FileDocument,
  ProjectEntry,
  ProjectFilesApi,
  SearchPage,
} from "./project-files";

const invalid = () =>
  new Error("The file viewer received an invalid response.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalid();
  return value;
}
function entries(value: unknown): ProjectEntry[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((item) => {
    const entry = record(item);
    const kind = entry.kind;
    if (
      kind !== "file" &&
      kind !== "directory" &&
      kind !== "symlink" &&
      kind !== "other"
    )
      throw invalid();
    return { name: string(entry.name), path: string(entry.path), kind };
  });
}
export function parseSearchPage(value: unknown): SearchPage {
  const page = record(value);
  if (typeof page.truncated !== "boolean") throw invalid();
  return { entries: entries(page.entries), truncated: page.truncated };
}
export function parseDirectoryPage(value: unknown): DirectoryPage {
  return { ...parseSearchPage(value), path: string(record(value).path) };
}
export function parseFileDocument(value: unknown): FileDocument {
  const file = record(value);
  const metadata = {
    path: string(file.path),
    size: number(file.size),
    revision: string(file.revision),
    offset: number(file.offset),
    next_offset: file.next_offset === null ? null : number(file.next_offset),
  };
  if (
    metadata.next_offset !== null &&
    (metadata.next_offset <= metadata.offset ||
      metadata.next_offset > metadata.size)
  )
    throw invalid();
  if (file.kind === "text")
    return { ...metadata, kind: "text", text: string(file.text) };
  if (
    (file.kind === "binary" || file.kind === "unsupported") &&
    file.text === null
  )
    return { ...metadata, kind: file.kind, text: null };
  throw invalid();
}
async function request(
  kind: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<unknown> {
  return (await codingRequest(`/project/${kind}?${params}`, { signal })).json();
}
export const projectFilesApi: ProjectFilesApi = {
  async directory(root, path, hidden, signal) {
    return parseDirectoryPage(
      await request(
        "directory",
        new URLSearchParams({
          project_path: root,
          path,
          show_hidden: String(hidden),
        }),
        signal,
      ),
    );
  },
  async search(root, query, hidden, signal) {
    return parseSearchPage(
      await request(
        "search",
        new URLSearchParams({
          project_path: root,
          query,
          show_hidden: String(hidden),
        }),
        signal,
      ),
    );
  },
  async file(root, path, offset, revision, signal) {
    const params = new URLSearchParams({
      project_path: root,
      path,
      offset: String(offset),
      limit: "131072",
    });
    if (revision) params.set("revision", revision);
    return parseFileDocument(await request("file", params, signal));
  },
};
