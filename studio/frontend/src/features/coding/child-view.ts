// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { childKey, sameChild, terminalChild } from "./child-types.ts";
import {
  interruptEntryContent,
  readCompleteEntryPage,
  replaceEntryContent,
} from "./entry-content.ts";
import { trimSavedEntries } from "./entry-window.ts";
import { needsReopen } from "./errors.ts";
import { codingRowSize } from "./file-changes.ts";
import { applyTextDelta, type TextDelta } from "./live-rows.ts";
import { createViewNotifications } from "./view-notifications.ts";
import type {
  ChildAttempt,
  ChildIdentity,
  ChildInspection,
} from "./child-types.ts";
import type {
  CodingRow,
  EntryAnchor,
  EntryPage,
  JournalCut,
  RunApi,
} from "./run-types.ts";

const MAX_ATTEMPTS = 512;
const MAX_ROWS = 200;
const MAX_TEXT = 512 * 1024;
const failure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Native child inspection could not be read.";
const validIdentity = (child: ChildIdentity) =>
  typeof child?.handle === "string" &&
  child.handle.length > 0 &&
  Number.isSafeInteger(child.attempt) &&
  child.attempt > 0;

/** A read-only, ephemeral projection of the parent's ordered native child view.
 * Transcripts are read lazily at its captured cuts; no child scheduler or polling. */
export function createChildView(
  id: string,
  api: Pick<RunApi, "readEntries" | "readPublicEntry" | "readChild">,
  onReopen?: (error: unknown) => void,
) {
  let state: {
    attempts: ChildAttempt[];
    inspection: ChildInspection | null;
    connected: boolean;
    omitted: boolean;
  } = {
    attempts: [],
    inspection: null,
    connected: false,
    omitted: false,
  };
  let saved: CodingRow[] = [];
  const live = new Map<string, CodingRow[]>();
  const liveRows = (identity: ChildIdentity | null = state.inspection) =>
    identity ? (live.get(childKey(identity)) ?? []) : [];
  let abort: AbortController | null = null;
  let generation = 0;
  let historyRevision = 0;
  const notifications = createViewNotifications();
  const update = (patch: Partial<typeof state>, deferred = false) => {
    state = { ...state, ...patch };
    notifications.notify(deferred);
  };
  function put(child: ChildAttempt, historical = false, deferred = false) {
    if (!validIdentity(child))
      throw new Error("Invalid native child attempt identity.");
    if (
      child.cut &&
      (typeof child.cut.journal !== "object" ||
        child.cut.journal.child !== child.handle)
    )
      throw new Error("Native child history belongs to another journal.");
    const index = state.attempts.findIndex((item) => sameChild(item, child));
    // A saved observation cannot turn an attempt live or replace an ordered cut.
    const prior = state.attempts[index];
    if (
      historical &&
      prior &&
      (!prior.historical || (terminalChild(prior) && !terminalChild(child)))
    )
      return;
    const attempts = [...state.attempts];
    if (index >= 0)
      attempts[index] = {
        ...prior,
        ...child,
        cut: child.cut ?? prior.cut,
        historical,
      };
    else attempts.push({ ...child, historical });
    if (!historical) {
      for (let i = 0; i < attempts.length; i++) {
        if (
          attempts[i].handle === child.handle &&
          attempts[i].attempt < child.attempt
        )
          attempts[i] = { ...attempts[i], historical: true };
      }
    }
    let omitted = state.omitted;
    while (attempts.length > MAX_ATTEMPTS) {
      const remove = attempts.findIndex(
        (item) =>
          item.historical &&
          !liveRows(item).length &&
          (!state.inspection || !sameChild(item, state.inspection)),
      );
      if (remove < 0) break;
      attempts.splice(remove, 1);
      omitted = true;
    }
    update({ attempts, omitted }, deferred);
  }
  function history(rows: CodingRow[], deferred = false) {
    for (const row of rows) {
      if (row.child) put(row.child, true, deferred);
      const run = row.tool?.subagent;
      // Agent-looking tools without exact native attempt identity are not children.
      if (run?.attempt && run.agent_id)
        put(
          {
            handle: run.agent_id,
            attempt: run.attempt,
            status: run.status,
            completion_pending: false,
            cut: null,
            description: run.description,
            profile: run.agent,
            model: run.model,
            presentation: run,
          },
          true,
          deferred,
        );
    }
  }
  const selected = () =>
    state.attempts.find(
      (item) => state.inspection && sameChild(item, state.inspection),
    );
  const current = (g: number, identity: ChildIdentity) =>
    generation === g &&
    state.inspection &&
    sameChild(state.inspection, identity) &&
    !abort?.signal.aborted;
  const report = (error: unknown) => {
    if (needsReopen(error)) onReopen?.(error);
    if (state.inspection)
      update({ inspection: { ...state.inspection, error: failure(error) } });
  };
  const readPage = (
    cut: JournalCut,
    anchor: EntryAnchor,
    identity: ChildIdentity,
    g: number,
  ) =>
    readCompleteEntryPage(
      api,
      id,
      cut,
      anchor,
      abort!.signal,
      (ref, rows) => {
        if (!current(g, identity)) return;
        saved = replaceEntryContent(saved, ref, rows);
        if (state.inspection!.earlier) {
          const bounded = trimSavedEntries(
            replaceEntryContent(state.inspection!.rows, ref, rows),
            MAX_ROWS,
            MAX_TEXT,
          );
          update({
            inspection: {
              ...state.inspection!,
              rows: bounded.rows,
              first: bounded.omitted
                ? (bounded.rows.find((row) => row.entry_id)?.entry_id ?? null)
                : state.inspection!.first,
              older: state.inspection!.older || bounded.omitted,
              bounded: state.inspection!.bounded || bounded.omitted,
            },
          });
        } else publish();
      },
      (error) => {
        if (current(g, identity)) report(error);
      },
    );
  function publish(deferred = false) {
    if (!state.inspection || state.inspection.earlier) return;
    const provisional = liveRows();
    const bounded = trimSavedEntries(
      saved,
      MAX_ROWS - provisional.length,
      MAX_TEXT - provisional.reduce((n, row) => n + codingRowSize(row), 0),
    );
    saved = bounded.rows;
    const rows: CodingRow[] = [];
    for (const row of [...saved, ...provisional]) {
      const index = rows.findIndex(
        (prior) =>
          prior.id === row.id ||
          (row.tool?.invocation_id &&
            prior.tool?.invocation_id === row.tool.invocation_id),
      );
      if (index < 0) rows.push(row);
      else {
        const prior = rows[index];
        rows[index] = {
          ...row,
          id: prior.id,
          ...(row.tool && !row.tool.argument && prior.tool?.argument
            ? { tool: { ...row.tool, argument: prior.tool.argument } }
            : {}),
        };
      }
    }
    update(
      {
        inspection: {
          ...state.inspection,
          rows,
          // Paging starts at the first retained complete entry.
          first: bounded.omitted
            ? (saved.find((row) => row.entry_id)?.entry_id ?? null)
            : state.inspection.first,
          older: state.inspection.older || bounded.omitted,
          bounded: state.inspection.bounded || bounded.omitted,
        },
      },
      deferred,
    );
  }
  async function details(identity: ChildIdentity, g: number) {
    const detail = await api.readChild(
      id,
      identity.handle,
      identity.attempt,
      abort?.signal,
    );
    if (!current(g, identity)) return;
    if (
      (detail.child && !sameChild(detail.child, identity)) ||
      (detail.outcome && !sameChild(detail.outcome, identity))
    )
      throw new Error("Native child details belong to another attempt.");
    if (detail.outcome && !terminalChild(detail.outcome))
      throw new Error("Native outcome did not identify a terminal attempt.");
    const prior = selected();
    if (detail.child && prior) {
      // Bounded 'children' reads can advance independently. Only fill descriptive
      // fields; the ordered view, not this read, owns lifecycle and history cuts.
      put(
        {
          ...prior,
          profile: detail.child.profile,
          description: detail.child.description,
          model: detail.child.model,
          background: detail.child.background,
          presentation: prior.presentation ?? detail.child.presentation,
          clipped: detail.child.clipped,
          oversized: false,
        },
        Boolean(prior.historical),
      );
    }
    update({
      inspection: {
        ...state.inspection!,
        outcome: detail.outcome ?? state.inspection!.outcome,
      },
    });
  }
  async function latest(
    identity: ChildIdentity,
    cut: JournalCut | null,
    g: number,
  ) {
    if (!cut) return;
    const revision = ++historyRevision;
    let page: EntryPage;
    try {
      page = await readPage(cut, "latest", identity, g);
    } catch (error) {
      if (current(g, identity) && revision === historyRevision) throw error;
      return; // Superseded failures cannot obscure a newer page or navigation.
    }
    if (!current(g, identity) || revision !== historyRevision) return;
    if (page.newer)
      throw new Error("The native latest child page omitted newer history.");
    saved = page.rows.map((row) => ({ ...row, historical: true }));
    // Initial reads are older than activity arriving during the read. Checkpoints
    // prune their pre-cut suffix before reading, never erase post-cut activity.
    live.set(
      childKey(identity),
      liveRows(identity).filter(
        (row) =>
          !row.tool?.invocation_id ||
          !saved.some(
            (item) =>
              item.tool &&
              item.tool.invocation_id === row.tool?.invocation_id &&
              ["completed", "failed"].includes(item.tool.status),
          ),
      ),
    );
    update({
      inspection: {
        ...state.inspection!,
        cut,
        first: page.first_id,
        older: page.older,
        earlier: false,
        bounded: false,
      },
    });
    publish();
  }
  async function open(identity: ChildIdentity) {
    const child = state.attempts.find((item) => sameChild(item, identity));
    if (!child) return;
    abort?.abort();
    abort = new AbortController();
    const g = ++generation;
    saved = [];
    update({
      inspection: {
        ...identity,
        rows: liveRows(identity),
        outcome: null,
        cut: child.cut,
        loading: true,
        loadingEarlier: false,
        older: false,
        earlier: false,
        first: null,
        error: null,
        bounded: false,
      },
    });
    try {
      await Promise.all([latest(identity, child.cut, g), details(identity, g)]);
    } catch (error) {
      if (current(g, identity)) report(error);
    } finally {
      if (current(g, identity))
        update({ inspection: { ...state.inspection!, loading: false } });
    }
  }
  function close() {
    ++generation;
    abort?.abort();
    abort = null;
    saved = [];
    update({ inspection: null });
  }
  return {
    getSnapshot: () => state,
    subscribe: notifications.subscribe,
    history,
    capture(children: ChildAttempt[], rows: CodingRow[]) {
      const identity = state.inspection;
      // Preserve only the inspected old immutable attempt across reconstruction.
      const retained = selected();
      live.clear();
      update({ attempts: [], omitted: false });
      for (const child of children) put(child);
      history(rows);
      if (retained && !state.attempts.some((item) => sameChild(item, retained)))
        put(retained, true);
      return identity ? open(identity) : Promise.resolve();
    },
    setConnected(connected: boolean) {
      const inspection = state.inspection;
      if (!connected) {
        ++generation;
        abort?.abort();
      }
      update({
        connected,
        inspection:
          state.inspection && !connected
            ? {
                ...state.inspection,
                loading: false,
                loadingEarlier: false,
                rows: interruptEntryContent(state.inspection.rows, () => {
                  if (inspection) void open(inspection);
                }),
              }
            : state.inspection,
      });
    },
    child(child: ChildAttempt) {
      put(child);
      const identity = state.inspection;
      if (!identity || !sameChild(child, identity) || !terminalChild(child))
        return Promise.resolve();
      const g = generation;
      return details(identity, g).catch((error) => {
        if (current(g, identity)) report(error);
      });
    },
    activity(identity: ChildIdentity, rows: CodingRow[]) {
      if (!validIdentity(identity))
        throw new Error("Invalid native child activity identity.");
      const provisional = [...liveRows(identity)];
      for (const row of rows) {
        const index = provisional.findIndex((item) => item.id === row.id);
        if (index < 0) provisional.push(row);
        else provisional[index] = row;
      }
      live.set(childKey(identity), provisional);
      if (state.inspection && sameChild(identity, state.inspection))
        publish(true);
    },
    textDelta(identity: ChildIdentity, event: TextDelta) {
      if (!validIdentity(identity))
        throw new Error("Invalid native child activity identity.");
      live.set(childKey(identity), applyTextDelta(liveRows(identity), event));
      if (state.inspection && sameChild(identity, state.inspection))
        publish(true);
    },
    checkpoint(
      identity: ChildIdentity,
      cut: JournalCut,
      invocations: string[],
    ) {
      if (
        !validIdentity(identity) ||
        typeof cut.journal !== "object" ||
        cut.journal.child !== identity.handle
      )
        throw new Error(
          "Native child checkpoint belongs to another attempt or journal.",
        );
      const child = state.attempts.find((item) => sameChild(item, identity));
      if (child) put({ ...child, cut }, Boolean(child.historical));
      live.set(
        childKey(identity),
        liveRows(identity).filter(
          (row) =>
            row.tool?.invocation_id &&
            invocations.includes(row.tool.invocation_id),
        ),
      );
      if (
        !state.inspection ||
        !sameChild(identity, state.inspection) ||
        state.inspection.earlier
      )
        return Promise.resolve();
      const g = generation;
      return latest(identity, cut, g).catch((error) => {
        if (current(g, identity)) report(error);
      });
    },
    open,
    close,
    async loadEarlier() {
      const inspection = state.inspection;
      if (
        !inspection?.cut ||
        (!inspection.first && !inspection.bounded) ||
        !inspection.older ||
        inspection.loadingEarlier ||
        !state.connected
      )
        return;
      const g = generation;
      const revision = ++historyRevision;
      update({
        inspection: {
          ...inspection,
          loadingEarlier: true,
          earlier: true,
          error: null,
        },
      });
      try {
        const page = await readPage(
          inspection.cut,
          inspection.first ? { before: inspection.first } : "latest",
          inspection,
          g,
        );
        if (!current(g, inspection) || revision !== historyRevision) return;
        if (
          page.older &&
          (!page.first_id || page.first_id === inspection.first)
        )
          throw new Error("Earlier child history made no progress.");
        const bounded = trimSavedEntries(
          page.rows.map((row) => ({ ...row, historical: true })),
          MAX_ROWS,
          MAX_TEXT,
        );
        update({
          inspection: {
            ...state.inspection!,
            rows: bounded.rows,
            first: bounded.omitted
              ? (bounded.rows.find((row) => row.entry_id)?.entry_id ?? null)
              : page.first_id,
            older: page.older || bounded.omitted,
            earlier: true,
            bounded: bounded.omitted,
          },
        });
      } catch (error) {
        if (current(g, inspection) && revision === historyRevision)
          report(error);
      } finally {
        if (current(g, inspection) && revision === historyRevision)
          update({
            inspection: { ...state.inspection!, loadingEarlier: false },
          });
      }
    },
    async showLatest() {
      const child = selected();
      if (child) await open(child);
    },
    detach() {
      close();
      live.clear();
      update({ connected: false });
    },
  };
}
export type ChildView = ReturnType<typeof createChildView>;
