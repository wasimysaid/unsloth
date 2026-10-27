// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { needsReopen } from "./errors.ts";
import type {
  CodingRow,
  ContentReference,
  EntryAnchor,
  EntryPage,
  JournalCut,
  RunApi,
} from "./run-types.ts";

export const sameCut = (a: JournalCut, b: JournalCut) =>
  a?.leaf === b?.leaf &&
  (a?.journal === "root"
    ? b?.journal === "root"
    : typeof a?.journal === "object" &&
      typeof b?.journal === "object" &&
      a.journal.child === b.journal.child);
const sameReference = (a: ContentReference, b: ContentReference) =>
  a.entry_id === b.entry_id && sameCut(a.cut, b.cut);
const invalid = () =>
  new Error(
    "Native saved entry content did not match its immutable cut or entry identity. Retry loading this entry.",
  );

export function replaceEntryContent(
  rows: CodingRow[],
  ref: ContentReference,
  replacement: CodingRow[],
) {
  return rows.flatMap((row) =>
    row.kind === "content_ref" &&
    row.content_ref &&
    sameReference(row.content_ref, ref)
      ? replacement.map((next) => ({ ...next, historical: row.historical }))
      : [row],
  );
}

export function interruptEntryContent(rows: CodingRow[], retry: () => void) {
  return rows.map((row): CodingRow =>
    row.kind === "content_ref"
      ? {
          ...row,
          content: {
            status: "error",
            error:
              "Content loading was interrupted. Retry to reconnect and load this entry.",
            retry,
          },
        }
      : row,
  );
}

export async function assemblePublicEntry(
  api: Pick<RunApi, "readPublicEntry">,
  id: string,
  ref: ContentReference,
  signal: AbortSignal,
): Promise<CodingRow[]> {
  signal.throwIfAborted();
  const rows = await api.readPublicEntry(id, ref, signal);
  signal.throwIfAborted();
  const seen = new Set<string>();
  if (
    !Array.isArray(rows) ||
    rows.some((row) => {
      if (
        !row ||
        row.entry_id !== ref.entry_id ||
        typeof row.id !== "string" ||
        !row.id ||
        seen.has(row.id) ||
        ![
          "user",
          "assistant",
          "reasoning",
          "tool",
          "notice",
          "plan",
          "child",
        ].includes(row.kind) ||
        row.content_ref !== undefined
      )
        return true;
      seen.add(row.id);
      return false;
    })
  )
    throw invalid();
  return rows;
}

/** History paging awaits its page, never its independently retryable content. */
export async function readCompleteEntryPage(
  api: Pick<RunApi, "readEntries" | "readPublicEntry">,
  id: string,
  cut: JournalCut,
  anchor: EntryAnchor,
  signal: AbortSignal,
  onContent: (reference: ContentReference, rows: CodingRow[]) => void,
  onFatal: (error: unknown) => void,
): Promise<EntryPage> {
  const raw = await api.readEntries(id, cut, anchor, signal);
  return resolveEntryPage(api, id, raw, cut, signal, onContent, onFatal);
}

export function resolveEntryPage(
  api: Pick<RunApi, "readPublicEntry">,
  id: string,
  raw: EntryPage,
  cut: JournalCut,
  signal: AbortSignal,
  onContent: (reference: ContentReference, rows: CodingRow[]) => void,
  onFatal: (error: unknown) => void,
): EntryPage {
  signal.throwIfAborted();
  if (!raw || !sameCut(raw.cut, cut) || !Array.isArray(raw.rows))
    throw new Error("Native history did not match the captured view cut.");
  const page = { ...raw, rows: [...raw.rows] };
  const references: { row: CodingRow; ref: ContentReference }[] = [];
  for (const row of page.rows) {
    if (row.kind !== "content_ref") continue;
    const ref = row.content_ref;
    if (
      !ref ||
      !sameCut(ref.cut, cut) ||
      row.id !== ref.entry_id ||
      row.entry_id !== ref.entry_id ||
      row.request_id !== null ||
      !ref.entry_id
    )
      throw invalid();
    references.push({ row, ref });
  }
  for (const { row, ref } of references) {
    let attempt: AbortController | null = null;
    const publish = (rows: CodingRow[]) => onContent(ref, rows);
    const load = async (notify: boolean) => {
      if (signal.aborted) return;
      attempt?.abort();
      const controller = new AbortController();
      attempt = controller;
      const lifetime = AbortSignal.any([signal, controller.signal]);
      if (notify)
        publish([
          { ...row, content: { status: "loading", error: null, retry } },
        ]);
      try {
        const rows = await assemblePublicEntry(api, id, ref, lifetime);
        if (!lifetime.aborted) publish(rows);
      } catch (error) {
        if (lifetime.aborted) return;
        if (needsReopen(error)) {
          onFatal(error);
          return;
        }
        publish([
          {
            ...row,
            content: {
              status: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Saved entry content is unavailable.",
              retry,
            },
          },
        ]);
      }
    };
    const retry = () => {
      void load(true);
    };
    page.rows = replaceEntryContent(page.rows, ref, [
      { ...row, content: { status: "loading", error: null, retry } },
    ]);
    // Commit the page before even an immediately fulfilled content read updates it.
    queueMicrotask(() => {
      void load(false);
    });
  }
  return page;
}
