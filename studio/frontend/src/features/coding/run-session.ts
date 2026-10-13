// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { CodingInput, CodingInputExtras } from "./input.ts";
import type {
  CodingRow,
  EntryPage,
  JournalCut,
  NativeState,
  RunApi,
} from "./run-types.ts";

export interface CodingRunState {
  connection: "loading" | "connected" | "disconnected";
  native: NativeState | null;
  rows: CodingRow[];
  recovering: boolean;
  older: boolean;
  viewingEarlier: boolean;
  loadingEarlier: boolean;
  submitting: boolean;
  stopping: string | null;
  error: string | null;
  completion: {
    request_id: string;
    stop_reason: string;
    error: string | null;
  } | null;
  uncertainSubmission: (CodingInput & { key: string }) | null;
  rejectedSubmission?: CodingInput | null;
  acceptedSubmissionKey?: string;
}
const MAX_ROWS = 1000;
const MAX_TEXT = 2 * 1024 * 1024;
const errorText = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "The native operation could not be confirmed.";

/** An ephemeral, ordered Session View projection. No storage, scheduler, or local turns. */
export function createCodingRun(
  id: string,
  api: RunApi,
  makeKey: () => string = () => crypto.randomUUID(),
) {
  let state: CodingRunState = {
    connection: "loading",
    native: null,
    rows: [],
    recovering: false,
    older: false,
    viewingEarlier: false,
    loadingEarlier: false,
    submitting: false,
    stopping: null,
    error: null,
    completion: null,
    uncertainSubmission: null,
  };
  let saved: CodingRow[] = [];
  let provisional: CodingRow[] = [];
  let cut: JournalCut | null = null;
  let firstEntry: string | null = null;
  let latestOlder = false;
  let historyWindow: EntryPage | null = null;
  let position: number | null = null;
  let subscription: string | null = null;
  let incarnation = 0;
  let abort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CodingRunState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const mergeRows = (source: CodingRow[]) => {
    // Saved starts/results and live activity refer to the same native invocation.
    // Collapse only that exact identity, preserving its first chronological slot.
    const tools = new Map<string, number>();
    const rowsByIdentity: CodingRow[] = [];
    for (const row of source) {
      const invocation = row.tool?.invocation_id;
      const existing = invocation ? tools.get(invocation) : undefined;
      if (existing === undefined) {
        if (invocation) tools.set(invocation, rowsByIdentity.length);
        rowsByIdentity.push(row);
      } else {
        const prior = rowsByIdentity[existing];
        rowsByIdentity[existing] = {
          ...row,
          id: prior.id,
          entry_id: prior.entry_id ?? row.entry_id,
          request_id: row.request_id ?? prior.request_id,
        };
      }
    }
    return rowsByIdentity;
  };
  const publishRows = () => {
    const rows = mergeRows([...saved, ...provisional]);
    let bytes = rows.reduce(
      (size, row) =>
        size + (row.text?.length ?? 0) + (row.tool?.output.length ?? 0),
      0,
    );
    let omitted = false;
    while (rows.length > MAX_ROWS || (bytes > MAX_TEXT && rows.length > 1)) {
      const row = rows.shift();
      if (!row) break;
      bytes -= (row.text?.length ?? 0) + (row.tool?.output.length ?? 0);
      const keep = (item: CodingRow) =>
        item.id !== row.id &&
        !(row.entry_id && item.entry_id === row.entry_id) &&
        !(
          row.tool?.invocation_id &&
          item.tool?.invocation_id === row.tool.invocation_id
        );
      saved = saved.filter(keep);
      provisional = provisional.filter(keep);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!keep(rows[i])) {
          const removed = rows.splice(i, 1)[0];
          bytes -=
            (removed.text?.length ?? 0) + (removed.tool?.output.length ?? 0);
        }
      }
      omitted = true;
    }
    if (omitted) {
      latestOlder = true;
      firstEntry = saved.find((row) => row.entry_id)?.entry_id ?? firstEntry;
    }
    update({
      rows: historyWindow ? mergeRows(historyWindow.rows) : rows,
      older: historyWindow ? historyWindow.older : latestOlder,
      viewingEarlier: historyWindow !== null,
    });
  };
  const verifyPage = (page: EntryPage, expected: JournalCut) => {
    if (
      JSON.stringify(page.cut) !== JSON.stringify(expected) ||
      !Array.isArray(page.rows)
    )
      throw new Error(
        "Native history did not match the captured view cut. Reconnect to reconstruct.",
      );
  };
  async function capture(
    root: { cut: JournalCut; live_invocations: string[] },
    recovering: boolean,
    signal: AbortSignal,
  ) {
    const page = await api.readEntries(id, root.cut, "latest", signal);
    if (signal.aborted) return;
    verifyPage(page, root.cut);
    if (page.newer)
      throw new Error("The native latest page omitted newer history.");
    saved = page.rows.map((row) => ({ ...row, historical: true }));
    provisional = [];
    cut = root.cut;
    firstEntry = page.first_id;
    latestOlder = page.older;
    historyWindow = null;
    update({ recovering, loadingEarlier: false });
    publishRows();
  }
  async function checkpoint(
    root: { cut: JournalCut; live_invocations: string[] },
    signal: AbortSignal,
  ) {
    if (!cut)
      throw new Error("A checkpoint arrived before the native view capture.");
    if (JSON.stringify(cut.journal) !== JSON.stringify(root.cut.journal))
      return;
    if (cut.leaf !== root.cut.leaf) {
      if (cut.leaf === null) {
        const page = await api.readEntries(id, root.cut, "latest", signal);
        if (signal.aborted) return;
        verifyPage(page, root.cut);
        saved = page.rows;
        firstEntry = page.first_id;
        latestOlder = page.older;
      } else {
        let after = cut.leaf;
        for (let n = 0; n < 100; n++) {
          const page = await api.readEntries(id, root.cut, { after }, signal);
          if (signal.aborted) return;
          verifyPage(page, root.cut);
          const existing = new Set(saved.map((row) => row.id));
          saved.push(...page.rows.filter((row) => !existing.has(row.id)));
          if (!firstEntry) firstEntry = page.first_id;
          if (!page.newer) break;
          if (!page.last_id || page.last_id === after || n === 99)
            throw new Error(
              "Native checkpoint history exceeded the reconstruction bound. Reconnect for a fresh view.",
            );
          after = page.last_id;
        }
      }
    }
    cut = root.cut;
    const live = new Set(root.live_invocations);
    provisional = provisional.filter(
      (row) => row.tool?.invocation_id && live.has(row.tool.invocation_id),
    );
    update({ recovering: false });
    publishRows();
  }
  async function consume(value: unknown, signal: AbortSignal) {
    if (signal.aborted) return;
    const view = value as {
      subscription: string;
      position: number;
      event: Record<string, unknown>;
    };
    if (
      !view ||
      typeof view.subscription !== "string" ||
      !Number.isSafeInteger(view.position) ||
      !view.event
    )
      throw new Error(
        "Invalid native view envelope. Reconnect to reconstruct.",
      );
    const event = view.event;
    if (
      position !== null &&
      (view.subscription !== subscription || view.position <= position)
    )
      throw new Error(
        "Native view items were not ordered. Reconnect to reconstruct.",
      );
    position = view.position;
    subscription = view.subscription;
    if (event.type === "start" || event.type === "reset") {
      const native = event.state as NativeState;
      if (native.info.id !== id)
        throw new Error("Native view belongs to another conversation.");
      update({ native, connection: "loading", completion: null });
      await capture(
        event.root as { cut: JournalCut; live_invocations: string[] },
        Boolean(event.recovering),
        signal,
      );
      if (!signal.aborted) {
        // Native active_request remains held through cleanup; journal terminal
        // status alone is insufficient, but this atomic capture can settle Stop.
        const stopped =
          state.stopping &&
          native.active_request !== state.stopping &&
          native.requests.some(
            (request) =>
              request.id === state.stopping &&
              ["completed", "cancelled", "failed", "interrupted"].includes(
                request.status,
              ),
          );
        update({
          connection: "connected",
          stopping: stopped ? null : state.stopping,
        });
      }
    } else if (event.type === "state") {
      const native = event.state as NativeState;
      if (native.info.id !== id)
        throw new Error("Native state belongs to another conversation.");
      update({ native });
    } else if (event.type === "checkpoint") {
      await checkpoint(
        event as unknown as { cut: JournalCut; live_invocations: string[] },
        signal,
      );
    } else if (event.type === "activity") {
      for (const row of event.rows as CodingRow[]) {
        const index = provisional.findIndex((item) => item.id === row.id);
        if (index < 0) provisional.push(row);
        else provisional[index] = row;
      }
      publishRows();
    } else if (event.type === "completed") {
      const completion = event as unknown as CodingRunState["completion"];
      if (!completion) throw new Error("Invalid native completion.");
      update({
        completion,
        stopping:
          state.stopping === completion.request_id ? null : state.stopping,
      });
    }
    const accepted =
      state.uncertainSubmission &&
      state.native?.requests.find(
        (request) => request.submission_key === state.uncertainSubmission?.key,
      );
    if (accepted)
      update({
        acceptedSubmissionKey: state.uncertainSubmission?.key,
        uncertainSubmission: null,
        error: null,
      });
  }
  function connect() {
    abort?.abort();
    const current = ++incarnation;
    const controller = new AbortController();
    abort = controller;
    position = null;
    subscription = null;
    update({ connection: "loading", error: null, loadingEarlier: false });
    void api
      .watch(
        id,
        controller.signal,
        () => {},
        (view) => consume(view, controller.signal),
      )
      .catch((reason: unknown) => {
        if (controller.signal.aborted || current !== incarnation) return;
        update({ connection: "disconnected", error: errorText(reason) });
      });
  }
  async function submit(input: CodingInput, key: string): Promise<boolean> {
    if (
      state.connection !== "connected" ||
      state.recovering ||
      state.submitting ||
      state.stopping
    )
      throw new Error(
        "Wait for a connected, reconstructed native view before sending.",
      );
    update({
      submitting: true,
      error: null,
      uncertainSubmission: { key, ...input },
      rejectedSubmission: null,
      acceptedSubmissionKey: undefined,
    });
    try {
      const { text, ...extras } = input;
      const result = await api.submit(id, key, text, extras);
      if (
        result.conversation_id !== id ||
        result.submission_key !== key ||
        !result.request_id
      )
        throw new Error(
          "The native acceptance identity could not be confirmed.",
        );
      update({ uncertainSubmission: null, acceptedSubmissionKey: key });
      // No optimistic transcript or running state: both come from the view.
      return true;
    } catch (reason) {
      if (state.acceptedSubmissionKey === key) return true;
      if (
        reason instanceof Error &&
        "admissionRejected" in reason &&
        reason.admissionRejected === true
      ) {
        update({
          uncertainSubmission: null,
          rejectedSubmission: input,
          error: errorText(reason),
        });
      } else {
        update({
          error: `${errorText(reason)} Delivery is unconfirmed; do not send a new copy. Reconnect or retry the same submission identity.`,
        });
      }
      return false;
    } finally {
      update({ submitting: false });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect,
    detach() {
      ++incarnation;
      abort?.abort();
      abort = null;
    },
    async send(text: string, extras: CodingInputExtras = {}) {
      if (!text.trim()) return false;
      if (state.uncertainSubmission)
        throw new Error(
          "Reconcile the unconfirmed submission before sending new input.",
        );
      // Snapshot the complete input once. Later edits/removals never change an
      // uncertain delivery retry, including its image bytes and mention ranges.
      return await submit(structuredClone({ text, ...extras }), makeKey());
    },
    async retrySubmission() {
      const pending = state.uncertainSubmission;
      if (pending) {
        const { key, ...input } = pending;
        return await submit(input, key);
      }
      return false;
    },
    clearRejectedSubmission() {
      update({ rejectedSubmission: null });
    },
    async stop() {
      const request = state.native?.active_request;
      if (!request || state.stopping || state.connection !== "connected")
        return;
      update({ stopping: request, error: null });
      try {
        const result = await api.cancel(id, request);
        if (state.stopping !== request) return; // Terminal native evidence supersedes a late reply.
        if (result.conversation_id !== id || result.request_id !== request)
          throw new Error(
            "The native cancellation identity could not be confirmed.",
          );
        if (!result.cancel_requested)
          update({
            error:
              "Native cancellation did not match that request. Waiting for authoritative terminal evidence; no other request was cancelled.",
          });
      } catch (reason) {
        if (state.stopping !== request) return;
        update({
          error:
            errorText(reason) +
            " Cancellation is unconfirmed. Work may still be running; it was not retried.",
        });
      }
    },
    showLatest() {
      historyWindow = null;
      publishRows();
    },
    async loadEarlier() {
      if (
        !cut ||
        !firstEntry ||
        !state.older ||
        state.loadingEarlier ||
        state.connection !== "connected"
      )
        return;
      const current = incarnation;
      const captured = historyWindow?.cut ?? cut;
      const anchor = historyWindow?.first_id ?? firstEntry;
      const previousWindow = historyWindow;
      update({ loadingEarlier: true });
      try {
        const page = await api.readEntries(
          id,
          captured,
          { before: anchor },
          abort?.signal,
        );
        if (
          current !== incarnation ||
          historyWindow !== previousWindow ||
          (!previousWindow && cut !== captured)
        )
          return;
        verifyPage(page, captured);
        const rows = page.rows
          .slice(0, MAX_ROWS)
          .map((row) => ({ ...row, historical: true }));
        if (page.rows.length > MAX_ROWS)
          rows[rows.length - 1] = {
            id: "history:clipped",
            kind: "notice",
            text: "Historical page clipped to the row bound; newer content is not shown.",
            clipped: true,
            historical: true,
          };
        historyWindow = { ...page, rows };
        publishRows();
      } catch (reason) {
        if (current === incarnation) update({ error: errorText(reason) });
      } finally {
        if (current === incarnation) update({ loadingEarlier: false });
      }
    },
  };
}
export type CodingRun = ReturnType<typeof createCodingRun>;

/** Current status feedback is request-scoped; earlier failures stay in native history. */
export function codingRunCompletion(state: CodingRunState | null) {
  if (!state?.completion) return null;
  const completion = state.completion;
  const request =
    state.stopping ??
    state.native?.active_request ??
    state.native?.requests.at(-1)?.id;
  return !request || request === completion.request_id ? completion : null;
}

export function codingRunLabel(state: CodingRunState): string {
  if (state.connection === "disconnected")
    return state.stopping
      ? "Disconnected · stopping unconfirmed"
      : "Disconnected · work may still be running";
  if (state.connection === "loading") return "Loading native conversation…";
  if (state.stopping) return "Stopping… waiting for terminal cleanup";
  if (state.recovering) return "Recovering native history…";
  if (state.native?.pending_user_request) return "Waiting for user input";
  if (state.native?.active_request) return "Running";
  if (state.native?.requests.some((request) => request.status === "queued"))
    return "Queued";
  const latest = state.native?.requests.at(-1)?.status;
  if (codingRunCompletion(state)?.error)
    return "Failed · native request or cleanup failure";
  if (latest === "failed") return "Failed";
  if (latest === "interrupted")
    return "Interrupted · explicit continuation required";
  if (latest === "cancelled") return "Stopped · native request cancelled";
  return latest === "completed" ? "Completed" : "Ready";
}
