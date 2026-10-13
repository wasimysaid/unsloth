// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { ChildAttempt, ChildIdentity } from "./child-types.ts";
import { createChildView } from "./child-view.ts";
import {
  type CodingCommand,
  type CodingDiagnostic,
  type CommandOutcome,
  type DiagnosticKind,
  parseCodingCommand,
} from "./command-types.ts";
import { CodingOverlapError } from "./errors.ts";
import { codingRowSize } from "./file-changes.ts";
import type { CodingInput, CodingInputExtras } from "./input.ts";
import type { CodingConfigurationChange } from "./model-selection.ts";
import { type PendingCommand, pendingCommandStore } from "./pending-command.ts";
import {
  type SubmissionStorage,
  pendingSubmissionStore,
} from "./pending-submission.ts";
import type {
  AnswerTarget,
  CodingRow,
  EntryPage,
  GoalAction,
  GoalChange,
  JournalCut,
  NativeAnswer,
  NativeState,
  NativeUserRequest,
  ProjectOverlap,
  RunApi,
} from "./run-types.ts";

export interface QuestionAnswerForm {
  target: AnswerTarget;
  question: NativeUserRequest;
  answers: NativeAnswer[];
  status:
    | "waiting"
    | "submitting"
    | "accepted"
    | "uncertain"
    | "error"
    | "inactive";
  error: string | null;
}
export interface CodingRunState {
  connection: "loading" | "connected" | "disconnected";
  native: NativeState | null;
  rows: CodingRow[];
  recovering: boolean;
  older: boolean;
  viewingEarlier: boolean;
  loadingEarlier: boolean;
  submitting: boolean;
  configuring: boolean;
  configurationUncertain: boolean;
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
  storageError: string | null;
  unsentDraft: string | null;
  deliveryRecovered: boolean;
  disconnected: boolean;
  reopenRequired: boolean;
  reconcilingAction: string | null;
  retryStop: string | null;
  continuationRequested: string | null;
  goalChanging: GoalAction | null;
  reconcilingGoal: GoalAction | null;
  goalNotice: string | null;
  answerTarget: AnswerTarget | null;
  answerForms: QuestionAnswerForm[];
  commands: CodingCommand[] | null;
  commandsClipped?: boolean;
  discoveringCommands: boolean;
  commandBusy: boolean;
  commandOutcome: CommandOutcome | null;
  commandError: string | null;
  uncertainCommand: (PendingCommand & { reconciled: boolean }) | null;
  reconcilingCommand: boolean;
  diagnostic: CodingDiagnostic | null;
  inspectingDiagnostic: DiagnosticKind | null;
  overlapWarning:
    | (CodingInput & { key: string; overlap: ProjectOverlap })
    | null;
}
const needsReopen = (reason: unknown) =>
  reason instanceof Error &&
  "requiresReopen" in reason &&
  reason.requiresReopen === true;
const MAX_ROWS = 1000;
const MAX_TEXT = 2 * 1024 * 1024;
const errorText = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "The native operation could not be confirmed.";

/** Ephemeral Session View; the only durable browser record is pending delivery identity. */
export function createCodingRun(
  id: string,
  api: RunApi,
  makeKey: () => string = () => crypto.randomUUID(),
  options: {
    storage?: () => SubmissionStorage;
    reconnectDelay?: (attempt: number) => number;
    onRuntimeLost?: () => void;
  } = {},
) {
  const pendingStore = pendingSubmissionStore(id, options.storage);
  const commandStore = pendingCommandStore(id, options.storage);
  const childView = createChildView(id, api);
  let state: CodingRunState = {
    connection: "loading",
    native: null,
    rows: [],
    recovering: false,
    older: false,
    viewingEarlier: false,
    loadingEarlier: false,
    submitting: false,
    configuring: false,
    configurationUncertain: false,
    stopping: null,
    error: null,
    completion: null,
    uncertainSubmission: null,
    storageError: null,
    unsentDraft: null,
    deliveryRecovered: false,
    disconnected: false,
    reopenRequired: false,
    reconcilingAction: null,
    retryStop: null,
    continuationRequested: null,
    goalChanging: null,
    reconcilingGoal: null,
    goalNotice: null,
    answerTarget: null,
    answerForms: [],
    commands: null,
    discoveringCommands: false,
    commandBusy: false,
    commandOutcome: null,
    commandError: null,
    uncertainCommand: null,
    reconcilingCommand: false,
    diagnostic: null,
    inspectingDiagnostic: null,
    overlapWarning: null,
  };
  try {
    state.uncertainSubmission = pendingStore.load();
  } catch (reason) {
    state.storageError = `Submission storage unavailable. No prompt was sent. ${errorText(reason)}`;
  }
  try {
    const pending = commandStore.load();
    if (pending) state.uncertainCommand = { ...pending, reconciled: false };
  } catch (reason) {
    state.storageError = `Command storage unavailable. No command was replayed. ${errorText(reason)}`;
  }
  let attachment = 0;
  let diagnosticRevision = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let runtimeLost = false;
  let saved: CodingRow[] = [];
  let provisional: CodingRow[] = [];
  let cut: JournalCut | null = null;
  let firstEntry: string | null = null;
  let latestOlder = false;
  let historyWindow: EntryPage | null = null;
  let position: number | null = null;
  let subscription: string | null = null;
  let incarnation = 0;
  // A fresh watcher does not supersede an outstanding exact cancellation.
  // Only detach, a newer Stop attempt, or native settlement does that.
  let stopAttempt = 0;
  let answersAwaitCapture = false;
  // Configuration delivery outlives any one stream incarnation. A view opened
  // before an operation's outcome cannot reconcile that operation's uncertainty.
  let configurationEpoch = 0;
  let abort: AbortController | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CodingRunState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const sameQuestion = (left: AnswerTarget, right: AnswerTarget) =>
    left.request_id === right.request_id &&
    left.user_request_id === right.user_request_id;
  const sameTarget = (left: AnswerTarget, right: AnswerTarget) =>
    sameQuestion(left, right) && left.subscription === right.subscription;
  const updateAnswer = (
    target: AnswerTarget,
    patch: Partial<QuestionAnswerForm>,
  ) =>
    update({
      answerForms: state.answerForms.map((form) =>
        sameQuestion(form.target, target) ? { ...form, ...patch } : form,
      ),
    });
  const reconcileAnswers = (freshCapture = false) => {
    if (state.connection !== "connected" || state.recovering || !subscription)
      return;
    const pending = state.native?.user_request;
    const request = state.native?.active_request;
    const terminal =
      request &&
      (state.completion?.request_id === request ||
        state.native?.requests.some(
          (item) =>
            item.id === request &&
            ["completed", "cancelled", "failed", "interrupted"].includes(
              item.status,
            ),
        ));
    const target =
      pending && request && !terminal && !state.stopping
        ? { subscription, request_id: request, user_request_id: pending.id }
        : null;
    let forms = state.answerForms.map((form): QuestionAnswerForm => {
      const accepted = saved.find(
        (row) =>
          row.answer?.request_id === form.target.request_id &&
          row.answer.user_request_id === form.target.user_request_id,
      );
      if (accepted?.answer)
        return {
          ...form,
          answers: accepted.answer.answers,
          status: "accepted",
          error: null,
        };
      if (target && sameQuestion(form.target, target)) {
        if (freshCapture && ["uncertain", "submitting"].includes(form.status))
          return {
            ...form,
            target,
            status: "error",
            error:
              "Fresh native state confirms this question is still waiting. Delivery was not confirmed and was not replayed. Review your retained draft and explicitly submit again.",
          };
        if (form.status === "inactive")
          return {
            ...form,
            target,
            status: "error",
            error:
              "Native state confirms this exact question is still waiting. Review the retained draft before answering.",
          };
        return { ...form, target };
      }
      // Stop disables controls provisionally; it is not question cancellation.
      if (
        state.stopping === form.target.request_id &&
        pending?.id === form.target.user_request_id &&
        !terminal
      )
        return form;
      if (form.status === "accepted") return form;
      if (["submitting", "uncertain"].includes(form.status) && !freshCapture)
        return form;
      return {
        ...form,
        status: "inactive",
        error:
          "This question is no longer live. Its answer was not confirmed in the available native history. This draft cannot answer another question.",
      };
    });
    if (
      target &&
      pending &&
      !forms.some((form) => sameQuestion(form.target, target))
    ) {
      forms = [
        ...forms,
        {
          target,
          question: pending,
          answers: pending.questions.map((question) => ({
            question_id: question.id,
            selected_options: [],
            freeform_text: null,
          })),
          status: "waiting",
          error: null,
        },
      ];
    }
    // These are bounded, ephemeral form drafts, not a transcript/history store.
    update({ answerTarget: target, answerForms: forms.slice(-8) });
    answersAwaitCapture = false;
  };
  const clearPending = (key: string, recovered: boolean) => {
    try {
      pendingStore.clear(key);
      if (state.uncertainSubmission?.key === key)
        update({
          uncertainSubmission: null,
          deliveryRecovered: recovered,
          storageError: null,
        });
    } catch (reason) {
      update({
        storageError: `Submission storage unavailable. Sending is disabled. ${errorText(reason)}`,
      });
    }
  };
  const reconcileAction = () => {
    const request = state.reconcilingAction;
    if (!request || state.recovering || state.connection !== "connected")
      return;
    const terminal = state.native?.requests.some(
      (item) =>
        item.id === request &&
        ["completed", "cancelled", "failed", "interrupted"].includes(
          item.status,
        ),
    );
    const stillActive = state.native?.active_request === request;
    const canRetry = stillActive && !terminal;
    update({
      reconcilingAction: null,
      stopping: canRetry || (terminal && !stillActive) ? null : state.stopping,
      retryStop: canRetry ? request : null,
      error: canRetry
        ? "Fresh native view confirms this request is still active. Cancellation delivery remains unconfirmed; you may explicitly retry Stop for this exact request."
        : terminal && !stillActive
          ? null
          : "Fresh native view has not confirmed released terminal cleanup for the cancellation target. No action was replayed; wait for native cleanup or deliberately reopen saved history to inspect again.",
    });
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
    let bytes = rows.reduce((size, row) => size + codingRowSize(row), 0);
    let omitted = false;
    while (rows.length > MAX_ROWS || (bytes > MAX_TEXT && rows.length > 1)) {
      const row = rows.shift();
      if (!row) break;
      bytes -= codingRowSize(row);
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
          bytes -= codingRowSize(removed);
        }
      }
      omitted = true;
    }
    if (omitted) {
      latestOlder = true;
      firstEntry = saved.find((row) => row.entry_id)?.entry_id ?? firstEntry;
    }
    childView.history(historyWindow ? historyWindow.rows : rows);
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
      (row) =>
        row.tool?.invocation_id &&
        live.has(row.tool.invocation_id) &&
        !saved.some(
          (item) =>
            item.tool?.invocation_id === row.tool?.invocation_id &&
            item.tool?.status !== "running",
        ),
    );
    update({ recovering: false });
    publishRows();
  }
  async function consume(
    value: unknown,
    signal: AbortSignal,
    configurationCut: number,
  ) {
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
      answersAwaitCapture = true;
      const native = event.state as NativeState;
      if (native.info.id !== id)
        throw new Error("Native view belongs to another conversation.");
      childView.setConnected(false);
      saved = [];
      provisional = [];
      historyWindow = null;
      cut = null;
      update({
        native,
        rows: [],
        connection: "loading",
        completion: null,
        recovering: Boolean(event.recovering),
        older: false,
        viewingEarlier: false,
      });
      await capture(
        event.root as { cut: JournalCut; live_invocations: string[] },
        Boolean(event.recovering),
        signal,
      );
      if (signal.aborted) return;
      // Child metadata/cuts apply synchronously. Optional inspection reads are
      // cancellable and revision-guarded, never a dependency of main-session Stop.
      void childView.capture((event.children ?? []) as ChildAttempt[], saved);
      // A recovering capture still owns a fresh inspection read generation.
      // Leave it offline until the root checkpoint; do not abort it a second time.
      if (!event.recovering) childView.setConnected(true);
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
        configurationUncertain:
          !state.configuring && configurationCut === configurationEpoch
            ? false
            : state.configurationUncertain,
        stopping: stopped ? null : state.stopping,
        retryStop:
          state.retryStop === native.active_request ? state.retryStop : null,
      });
      reconcileAction();
    } else if (event.type === "state") {
      const native = event.state as NativeState;
      if (native.info.id !== id)
        throw new Error("Native state belongs to another conversation.");
      update({
        native,
        retryStop:
          state.retryStop && native.active_request === state.retryStop
            ? state.retryStop
            : null,
      });
    } else if (event.type === "child") {
      void childView.child(event.child as ChildAttempt);
    } else if (event.type === "checkpoint") {
      if (event.child) {
        void childView.checkpoint(
          event.child as ChildIdentity,
          event.cut as JournalCut,
          event.live_invocations as string[],
        );
      } else {
        await checkpoint(
          event as unknown as { cut: JournalCut; live_invocations: string[] },
          signal,
        );
        childView.setConnected(true);
      }
    } else if (event.type === "activity") {
      if (event.child) {
        childView.activity(
          event.child as ChildIdentity,
          event.rows as CodingRow[],
        );
      } else {
        for (const row of event.rows as CodingRow[]) {
          const index = provisional.findIndex((item) => item.id === row.id);
          if (index < 0) provisional.push(row);
          else provisional[index] = row;
        }
        publishRows();
      }
    } else if (event.type === "completed") {
      const completion = event as unknown as CodingRunState["completion"];
      if (!completion) throw new Error("Invalid native completion.");
      const stopped = state.stopping === completion.request_id;
      update({
        completion,
        stopping: stopped ? null : state.stopping,
        reconcilingAction: stopped ? null : state.reconcilingAction,
        retryStop:
          state.retryStop === completion.request_id ? null : state.retryStop,
        error: stopped ? null : state.error,
      });
    }
    if (signal.aborted) return;
    // Numeric/structural diagnostics travel outside public transcript activity.
    if (state.native && ("usage" in event || "compression" in event)) {
      update({
        native: {
          ...state.native,
          ...("usage" in event
            ? { usage: event.usage as NativeState["usage"] }
            : {}),
          ...("compression" in event
            ? { compression: event.compression as NativeState["compression"] }
            : {}),
        },
      });
    }
    const accepted =
      state.uncertainSubmission &&
      state.native?.requests.find(
        (request) => request.submission_key === state.uncertainSubmission?.key,
      );
    if (accepted && !state.recovering && state.connection === "connected") {
      update({ acceptedSubmissionKey: accepted.submission_key!, error: null });
      clearPending(accepted.submission_key!, true);
    }
    if (
      (event.type === "start" ||
        event.type === "reset" ||
        (event.type === "checkpoint" && !event.child)) &&
      state.connection === "connected" &&
      !state.recovering
    ) {
      reconnectAttempt = 0;
      update({ disconnected: false, reopenRequired: false });
      if (state.reconcilingGoal) {
        update({
          reconcilingGoal: null,
          goalChanging: null,
          goalNotice:
            "Fresh native goal state inspected. Check its phase, cause and objective before choosing another action. No goal action was replayed; command acceptance is not verified completion.",
        });
      }
      update({
        disconnected: false,
        reopenRequired: false,
        uncertainCommand: state.uncertainCommand
          ? { ...state.uncertainCommand, reconciled: true }
          : null,
      });
      reconcileAction();
      void reconcileCommand();
    }
    reconcileAnswers(answersAwaitCapture);
  }
  function requireRuntimeReopen() {
    if (runtimeLost) return;
    runtimeLost = true;
    // Retire cached/in-flight maintenance evidence before publishing owner loss.
    options.onRuntimeLost?.();
    ++incarnation;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    abort?.abort();
    abort = null;
    update({
      connection: "disconnected",
      disconnected: true,
      reopenRequired: true,
      answerTarget: null,
      loadingEarlier: false,
    }); // Retain saved rows, model identity, errors and pending delivery keys.
  }
  function connect() {
    if (runtimeLost) return; // Only a deliberately reopened owner gets a new run.
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    abort?.abort();
    childView.setConnected(false);
    const current = ++incarnation;
    ++diagnosticRevision;
    const configurationCut = configurationEpoch;
    const controller = new AbortController();
    abort = controller;
    position = null;
    subscription = null;
    update({
      connection: "loading",
      answerTarget: null,
      error: state.reconcilingAction ? state.error : null,
      loadingEarlier: false,
      reconcilingGoal: state.reconcilingGoal ?? state.goalChanging,
      discoveringCommands: false,
      inspectingDiagnostic: null,
      diagnostic: null,
      reconcilingCommand: false,
    });
    void api
      .watch(
        id,
        controller.signal,
        () => {},
        (view) => consume(view, controller.signal, configurationCut),
      )
      .then(() => {
        if (!controller.signal.aborted)
          throw new Error("The native event stream disconnected.");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || current !== incarnation) return;
        controller.abort();
        const requiresReopen = needsReopen(reason);
        if (requiresReopen) requireRuntimeReopen();
        childView.setConnected(false);
        update({
          connection: "disconnected",
          answerTarget: null,
          disconnected: true,
          reopenRequired: requiresReopen,
          error: errorText(reason),
        });
        // Every attempt obtains a new atomic capture. Never replay an event cursor
        // or reopen/take over the native conversation owner.
        if (requiresReopen) return;
        const delay =
          options.reconnectDelay?.(reconnectAttempt) ??
          Math.min(500 * 2 ** Math.min(reconnectAttempt, 5), 15000);
        reconnectAttempt++;
        reconnectTimer = setTimeout(connect, delay);
      });
  }
  async function submit(
    input: CodingInput,
    key: string,
    overlapConfirmed = false,
  ): Promise<boolean> {
    if (
      state.connection !== "connected" ||
      state.recovering ||
      state.submitting ||
      state.native?.pending_user_request ||
      state.configuring ||
      state.configurationUncertain ||
      state.stopping ||
      state.reconcilingAction ||
      state.goalChanging ||
      state.reconcilingGoal ||
      state.commandBusy ||
      state.uncertainCommand ||
      state.storageError
    )
      throw new Error(
        "Wait for a connected, reconstructed native view before sending.",
      );
    try {
      const existing = pendingStore.load();
      if (
        existing &&
        (existing.key !== key ||
          existing.text !== input.text ||
          JSON.stringify(existing.skill_mentions ?? []) !==
            JSON.stringify(input.skill_mentions ?? []) ||
          JSON.stringify(existing.images ?? []) !==
            JSON.stringify(input.images ?? []))
      )
        throw new Error(
          "Another pending submission must be reconciled before sending.",
        );
      pendingStore.save({ key, ...input }); // Complete input durable BEFORE HTTP.
    } catch (reason) {
      // The shipped composer clears its text before onNew. Keep this known-unsent
      // draft separately from uncertain delivery and native transcript rows.
      update({
        storageError: `Submission storage unavailable. No prompt was sent. ${errorText(reason)}`,
        unsentDraft: input.text,
        rejectedSubmission: input,
      });
      return false;
    }
    update({
      submitting: true,
      error: null,
      uncertainSubmission: { key, ...input },
      rejectedSubmission: null,
      acceptedSubmissionKey: undefined,
      unsentDraft: null,
      deliveryRecovered: false,
    });
    try {
      const { text, ...extras } = input;
      const result = await api.submit(id, key, text, extras, overlapConfirmed);
      if (
        result.conversation_id !== id ||
        result.submission_key !== key ||
        !result.request_id
      )
        throw new Error(
          "The native acceptance identity could not be confirmed.",
        );
      update({ acceptedSubmissionKey: key });
      clearPending(key, true);
      // No optimistic transcript or running state: both come from the view.
      return true;
    } catch (reason) {
      if (state.acceptedSubmissionKey === key) return true;
      if (needsReopen(reason)) {
        requireRuntimeReopen();
        update({
          error: `${errorText(reason)} Deliberately reopen before reconciling this same submission identity. This rejection does not resolve an earlier uncertain acceptance; no prompt was replayed.`,
        });
      } else if (reason instanceof CodingOverlapError) {
        clearPending(key, false);
        update({
          overlapWarning: { key, ...input, overlap: reason.overlap },
          error: null,
        });
      } else if (
        reason instanceof Error &&
        "admissionRejected" in reason &&
        reason.admissionRejected === true
      ) {
        clearPending(key, false);
        update({
          rejectedSubmission: input,
          error: errorText(reason),
          unsentDraft: input.text,
        });
        return false;
      } else if (state.uncertainSubmission?.key === key) {
        update({
          error: `${errorText(reason)} Delivery is unconfirmed; do not send a new copy. Reconnect or retry the same submission identity.`,
        });
      }
      return false;
    } finally {
      update({ submitting: false });
    }
  }
  const readyForCommand = () =>
    state.connection === "connected" &&
    !state.recovering &&
    !state.submitting &&
    !state.configuring &&
    !state.configurationUncertain &&
    !state.goalChanging &&
    !state.reconcilingGoal &&
    !state.stopping &&
    !state.reconcilingAction &&
    !state.uncertainSubmission &&
    !state.commandBusy;
  async function discoverCommands() {
    if (
      !api.commands ||
      state.discoveringCommands ||
      state.connection !== "connected" ||
      state.recovering
    )
      return;
    const current = incarnation;
    update({ discoveringCommands: true, commandError: null });
    try {
      const result = await api.commands(id);
      if (current !== incarnation) return;
      if (result.conversation_id !== id || !Array.isArray(result.commands))
        throw new Error(
          "Native command catalog identity could not be confirmed.",
        );
      update({
        commands: result.commands,
        commandsClipped: Boolean(result.clipped),
      });
    } catch (reason) {
      if (current === incarnation) update({ commandError: errorText(reason) });
    } finally {
      if (current === incarnation) update({ discoveringCommands: false });
    }
  }
  function verifyCommandOutcome(result: CommandOutcome, operation: string) {
    if (
      result.conversation_id !== id ||
      result.operation_id !== operation ||
      !["handled", "display", "submitted"].includes(result.outcome) ||
      (result.outcome === "submitted" && !result.request_id) ||
      (result.outcome === "display" && typeof result.text !== "string") ||
      JSON.stringify(result).length > 65536
    )
      throw new Error("Native command outcome could not be confirmed.");
  }
  function settleCommand(
    operation: string,
    outcome: CommandOutcome | null,
    error: string | null,
  ) {
    try {
      commandStore.clear(operation);
      update({
        commandOutcome: outcome,
        uncertainCommand: null,
        commandError: error,
        storageError: null,
      });
    } catch (reason) {
      update({
        commandOutcome: outcome,
        storageError: `Command storage unavailable. Sending is disabled. ${errorText(reason)}`,
      });
    }
  }
  async function reconcileCommand() {
    const pending = state.uncertainCommand;
    if (
      !pending ||
      !pending.reconciled ||
      !api.commandReceipt ||
      state.connection !== "connected" ||
      state.recovering ||
      state.reconcilingCommand ||
      state.commandBusy
    )
      return;
    const current = incarnation;
    update({ reconcilingCommand: true });
    try {
      const receipt = await api.commandReceipt(id, pending.operation_id);
      if (
        current !== incarnation ||
        state.uncertainCommand?.operation_id !== pending.operation_id
      )
        return;
      if (
        receipt.conversation_id !== id ||
        receipt.operation_id !== pending.operation_id
      )
        throw new Error("Native command receipt identity did not match.");
      if (receipt.status === "completed" && receipt.result) {
        verifyCommandOutcome(receipt.result, pending.operation_id);
        settleCommand(pending.operation_id, receipt.result, null);
      } else if (receipt.status === "failed" && receipt.error) {
        settleCommand(pending.operation_id, null, receipt.error.message);
      } else if (receipt.status === "pending") {
        update({
          commandError:
            "Native command handling is still pending. Inspect its outcome again before another action; no command was replayed.",
        });
      } else throw new Error("Native command receipt is incomplete.");
    } catch (reason) {
      if (current === incarnation)
        update({
          commandError: `${errorText(reason)} Native command outcome remains unknown. Inspect its effects; do not repeat it. No command was replayed.`,
        });
    } finally {
      if (current === incarnation) update({ reconcilingCommand: false });
    }
  }
  async function executeCommand(name: string, tail = "") {
    if (!readyForCommand() || state.uncertainCommand || state.storageError)
      throw new Error(
        "Inspect the reconstructed native state and resolve uncertain commands before another action. No command was replayed.",
      );
    if (!name || !api.command) {
      update({
        commandError:
          "Native command dispatch is unavailable or the command name is empty. No model prompt was submitted.",
      });
      return;
    }
    const operation = makeKey();
    const pending = { name, operation_id: operation, reconciled: false };
    const lifetime = attachment;
    try {
      if (commandStore.load())
        throw new Error("Another command outcome must be reconciled first.");
      commandStore.save(pending); // BEFORE HTTP; identity only, no arguments.
    } catch (reason) {
      update({
        storageError: `Command storage unavailable. No command was sent. ${errorText(reason)}`,
      });
      return;
    }
    // Native admission is final. No optimistic public turn or completion.
    update({
      commandBusy: true,
      commandOutcome: null,
      commandError: null,
      uncertainCommand: pending,
    });
    try {
      const result = await api.command(id, name, tail, operation);
      if (lifetime !== attachment) return; // Detached views cannot resurrect a watcher.
      verifyCommandOutcome(result, operation);
      settleCommand(operation, result, null);
    } catch (reason) {
      if (lifetime !== attachment) return;
      const rejected =
        reason instanceof Error &&
        "admissionRejected" in reason &&
        reason.admissionRejected === true;
      if (rejected) settleCommand(operation, null, errorText(reason));
      else {
        update({
          commandError: `${errorText(reason)} Command outcome is unknown. Inspecting a fresh native view and exact receipt; no retry was issued.`,
        });
        connect();
      }
    } finally {
      if (lifetime === attachment) {
        update({ commandBusy: false });
        void reconcileCommand();
      }
    }
  }
  async function inspectDiagnostic(kind: DiagnosticKind) {
    if (
      !api.diagnostics ||
      state.connection !== "connected" ||
      state.recovering ||
      state.inspectingDiagnostic
    )
      return;
    const current = incarnation;
    const inspection = ++diagnosticRevision;
    update({
      inspectingDiagnostic: kind,
      diagnostic: null,
      commandError: null,
    });
    try {
      const result = await api.diagnostics(id, kind);
      if (current !== incarnation || inspection !== diagnosticRevision) return;
      if (
        result.conversation_id !== id ||
        result.kind !== kind ||
        JSON.stringify(result).length > 65536
      )
        throw new Error(
          "Native diagnostics exceeded their bound or did not match this conversation.",
        );
      update({ diagnostic: result });
    } catch (reason) {
      if (current === incarnation && inspection === diagnosticRevision)
        update({ commandError: errorText(reason) });
    } finally {
      if (current === incarnation && inspection === diagnosticRevision)
        update({ inspectingDiagnostic: null });
    }
  }
  return {
    discoverCommands,
    executeCommand,
    reconcileCommand,
    inspectDiagnostic,
    clearDiagnostic() {
      ++diagnosticRevision;
      update({ diagnostic: null, inspectingDiagnostic: null });
    },
    childView,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect,
    requireRuntimeReopen,
    async continueInterruptedWork() {
      const request = codingInterruptedRequest(state);
      if (!request || !codingCanContinue(state)) return;
      update({ continuationRequested: request.id });
      const sent = await submit(
        { text: `Continue the interrupted work from request ${request.id}. Review saved history and the current project state first; do not blindly repeat commands or assume prior actions completed.` },
        makeKey(),
      );
      // Uncertain delivery stays locked to its new key, not another continuation.
      if (sent === false) update({ continuationRequested: null });
    },
    editAnswer(target: AnswerTarget, answers: NativeAnswer[]) {
      const form = state.answerForms.find((item) =>
        sameTarget(item.target, target),
      );
      if (
        !state.answerTarget ||
        !sameTarget(state.answerTarget, target) ||
        !form ||
        !["waiting", "error"].includes(form.status)
      )
        return;
      updateAnswer(target, { answers, error: null });
    },
    async answer(target: AnswerTarget) {
      const form = state.answerForms.find((item) =>
        sameTarget(item.target, target),
      );
      if (
        !form ||
        !state.answerTarget ||
        !sameTarget(state.answerTarget, target) ||
        state.connection !== "connected" ||
        state.recovering ||
        state.stopping ||
        !["waiting", "error"].includes(form.status)
      )
        return;
      const current = incarnation;
      updateAnswer(target, { status: "submitting", error: null });
      try {
        const result = await api.answer(id, target, form.answers);
        if (current !== incarnation) return;
        if (
          result.conversation_id !== id ||
          !sameTarget(result, target) ||
          result.accepted !== true
        )
          throw new Error(
            "Native answer acceptance identity could not be confirmed.",
          );
        updateAnswer(target, { status: "accepted", error: null });
      } catch (reason) {
        if (current !== incarnation) return;
        const latest = state.answerForms.find((item) =>
          sameQuestion(item.target, target),
        );
        if (latest?.status === "accepted") {
          if (needsReopen(reason)) requireRuntimeReopen();
          return; // Public native evidence supersedes a lost ACK, not owner loss.
        }
        const rejected =
          reason instanceof Error &&
          "admissionRejected" in reason &&
          reason.admissionRejected === true;
        updateAnswer(target, {
          status: rejected ? "error" : "uncertain",
          error: rejected
            ? errorText(reason)
            : `${errorText(reason)} Answer delivery is unconfirmed. Inspecting native state and history; no answer was replayed.`,
        });
        if (needsReopen(reason)) {
          requireRuntimeReopen();
        } else {
          // Even a rejection can race cancellation/replacement. Rebuild authority
          // before admitting a new action, retaining the exact question's draft.
          connect();
        }
      }
    },
    async configure(change: CodingConfigurationChange) {
      if (
        state.connection !== "connected" ||
        state.recovering ||
        state.configuring ||
        state.configurationUncertain ||
        state.goalChanging ||
        state.reconcilingGoal ||
        state.commandBusy ||
        state.uncertainCommand
      )
        throw new Error(
          "Wait for a connected, reconstructed native view before changing configuration.",
        );
      ++configurationEpoch;
      update({ configuring: true, error: null });
      try {
        await api.configure(id, change);
        // Ordered native state, not this response, owns the next-request choice.
      } catch (reason) {
        const rejected =
          reason instanceof Error &&
          "admissionRejected" in reason &&
          reason.admissionRejected === true;
        update({
          configurationUncertain: !rejected,
          error: rejected
            ? errorText(reason)
            : `${errorText(reason)} Configuration is unconfirmed; reconnect to reconstruct before changing it again. It was not retried.`,
        });
        throw reason;
      } finally {
        ++configurationEpoch;
        update({ configuring: false });
      }
    },
    detach() {
      ++attachment;
      ++incarnation;
      ++diagnosticRevision;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      abort?.abort();
      abort = null;
      update({ answerTarget: null });
      childView.detach();
    },
    async changeGoal(change: GoalChange) {
      const controls = state.native?.goal_controls;
      const admission = controls?.actions.find(
        (item) => item.action === change.action,
      );
      if (
        state.connection !== "connected" ||
        state.recovering ||
        state.goalChanging ||
        state.reconcilingGoal ||
        state.stopping ||
        state.reconcilingAction ||
        state.submitting ||
        state.uncertainSubmission ||
        state.configuring ||
        state.configurationUncertain ||
        state.commandBusy ||
        state.uncertainCommand ||
        state.storageError ||
        state.overlapWarning
      ) {
        update({
          goalNotice:
            "Wait for a connected, reconstructed native view and settled action before changing the goal. Main-session Stop remains available.",
        });
        return false;
      }
      if (
        !controls ||
        controls.revision !== change.revision ||
        !admission?.admitted ||
        !api.changeGoal
      ) {
        update({
          goalNotice:
            controls?.revision !== change.revision
              ? "These goal controls are stale. Inspect the current native state and choose the action again."
              : (admission?.reason ??
                "Native goal management is not available."),
        });
        return false;
      }
      const current = incarnation;
      update({ goalChanging: change.action, goalNotice: null });
      try {
        const result = await api.changeGoal(id, change);
        if (current !== incarnation) return false;
        if (
          result.conversation_id !== id ||
          !(result.request_id === null || typeof result.request_id === "string")
        )
          throw new Error(
            "The native goal action identity could not be confirmed.",
          );
        update({
          goalChanging: null,
          goalNotice:
            "Native goal command accepted. Its phase and independent verification come only from native state, not this acknowledgment.",
        });
        if (state.native?.goal_controls?.revision === change.revision) {
          update({ reconcilingGoal: change.action });
          connect();
        }
        return true;
      } catch (reason) {
        if (current !== incarnation) return false;
        // Reconstruct stale/busy refusals, but never retarget a lost owner or
        // automatically retry a non-idempotent goal command.
        const requiresReopen = needsReopen(reason);
        update({
          goalChanging: null,
          reconcilingGoal: change.action,
          goalNotice: requiresReopen
            ? `${errorText(reason)} Deliberately reopen saved history before another goal action; no action was replayed.`
            : `${errorText(reason)} Inspecting a fresh native view before another goal action; no action was replayed.`,
        });
        if (requiresReopen) requireRuntimeReopen();
        else connect();
        return false;
      }
    },
    async send(text: string, extras: CodingInputExtras = {}) {
      if (!text.trim()) return false;
      const command = parseCodingCommand(text);
      if (command) return executeCommand(command.name, command.tail);
      if (state.commandBusy || state.uncertainCommand)
        throw new Error(
          "Resolve the uncertain native command before sending another action.",
        );
      if (state.uncertainSubmission)
        throw new Error(
          "Reconcile the unconfirmed submission before sending new input.",
        );
      if (
        state.overlapWarning ||
        state.submitting ||
        state.configuring ||
        state.configurationUncertain ||
        state.goalChanging ||
        state.reconcilingGoal ||
        state.stopping ||
        state.reconcilingAction ||
        state.storageError ||
        state.recovering ||
        state.connection !== "connected"
      )
        throw new Error(
          "Wait for a connected, reconstructed native view and resolve the current warning before sending.",
        );
      // Freeze rich input before preflight and retain it through confirmation/retry.
      const input = structuredClone({ text, ...extras });
      const key = makeKey();
      const current = incarnation;
      update({ submitting: true, error: null, unsentDraft: null });
      let overlap: ProjectOverlap;
      try {
        overlap = await api.checkOverlap(id);
      } catch (reason) {
        update({
          submitting: false,
          error:
            current === incarnation
              ? `Project overlap check failed. No prompt was sent. ${errorText(reason)}`
              : state.error,
          unsentDraft: input.text,
          rejectedSubmission: input,
        });
        return false;
      }
      if (
        current !== incarnation ||
        state.connection !== "connected" ||
        state.recovering ||
        state.stopping ||
        state.reconcilingAction
      ) {
        update({
          submitting: false,
          unsentDraft: input.text,
          rejectedSubmission: input,
        });
        return false; // Reconnect/detach invalidated preflight, not permission to send.
      }
      update({ submitting: false });
      if (overlap.conversations.length) {
        update({ overlapWarning: { key, ...input, overlap } });
        return false;
      }
      return await submit(input, key);
    },
    async continueOverlap() {
      const warning = state.overlapWarning;
      if (
        !warning ||
        state.connection !== "connected" ||
        state.recovering ||
        state.submitting ||
        state.configuring ||
        state.configurationUncertain ||
        state.stopping ||
        state.reconcilingAction ||
        state.goalChanging ||
        state.reconcilingGoal ||
        state.commandBusy ||
        state.uncertainCommand ||
        state.storageError
      )
        return false;
      const { key, overlap: _overlap, ...input } = warning;
      update({ overlapWarning: null });
      return await submit(input, key, true);
    },
    cancelOverlap() {
      const warning = state.overlapWarning;
      if (!warning) return;
      const { key: _key, overlap: _overlap, ...input } = warning;
      // Only abandon this known-unadmitted draft; never cancel another request.
      update({
        overlapWarning: null,
        unsentDraft: input.text,
        rejectedSubmission: input,
        error: null,
      });
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
      if (
        !request ||
        state.stopping ||
        state.reconcilingAction ||
        state.recovering ||
        state.connection !== "connected"
      )
        return;
      const current = attachment;
      const attempt = ++stopAttempt;
      update({ stopping: request, retryStop: null, error: null, answerTarget: null });
      try {
        const result = await api.cancel(id, request);
        // Watcher reconstruction (including goal reconciliation) leaves this
        // exact Stop pending. Detach, a later attempt and settlement supersede it.
        if (
          current !== attachment ||
          attempt !== stopAttempt ||
          state.stopping !== request
        )
          return;
        if (result.conversation_id !== id || result.request_id !== request)
          throw new Error(
            "The native cancellation identity could not be confirmed.",
          );
        if (!result.cancel_requested) {
          update({
            reconcilingAction: request,
            error:
              "Native cancellation did not match that request. Inspecting a fresh native view before another action.",
          });
          connect();
        }
      } catch (reason) {
        if (
          current !== attachment ||
          attempt !== stopAttempt ||
          state.stopping !== request
        )
          return;
        if (needsReopen(reason)) {
          requireRuntimeReopen();
          update({
            error: `${errorText(reason)} Cancellation is unconfirmed. Deliberately reopen saved history before another action; no cancellation was replayed.`,
          });
          return;
        }
        update({
          reconcilingAction: request,
          error:
            errorText(reason) +
            " Cancellation is unconfirmed. Inspecting a fresh native view; no action was replayed.",
        });
        connect();
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
      update({ loadingEarlier: true, error: null });
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
        if (
          page.rows.length === 0 ||
          (page.older && (!page.first_id || page.first_id === anchor))
        )
          throw new Error(
            "Earlier history is incomplete: the native page made no progress. Retry loading earlier history or reconnect for a fresh capture.",
          );
        if (
          page.rows.length > MAX_ROWS ||
          page.rows.reduce((size, row) => size + codingRowSize(row), 0) >
            MAX_TEXT
        )
          throw new Error(
            "Earlier history is incomplete: the native page exceeded the presentation bound. Reconnect for a fresh bounded capture.",
          );
        const rows = page.rows.map((row) => ({ ...row, historical: true }));
        historyWindow = { ...page, rows };
        publishRows();
      } catch (reason) {
        if (current === incarnation) {
          if (needsReopen(reason)) requireRuntimeReopen();
          update({ error: errorText(reason) });
        }
      } finally {
        if (current === incarnation) update({ loadingEarlier: false });
      }
    },
  };
}
export type CodingRun = ReturnType<typeof createCodingRun>;

export function codingInterruptedRequest(state: CodingRunState | null) {
  const latest = state?.native?.requests.at(-1);
  return latest?.status === "interrupted" ? latest : null;
}

export function codingCanContinue(state: CodingRunState | null): boolean {
  const request = codingInterruptedRequest(state);
  return Boolean(
    state &&
      request &&
      state.connection === "connected" &&
      !state.recovering &&
      !state.native?.active_request &&
      !state.native?.pending_user_request &&
      !state.native?.requests.some(
        (item) => item.status === "queued" || item.status === "running",
      ) &&
      !state.submitting &&
      !state.goalChanging &&
      !state.reconcilingGoal &&
      !state.stopping &&
      !state.reconcilingAction &&
      !state.uncertainSubmission &&
      !state.storageError &&
      state.continuationRequested !== request.id,
  );
}

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
