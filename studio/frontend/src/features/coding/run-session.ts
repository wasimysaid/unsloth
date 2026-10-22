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
import {
  interruptEntryContent,
  readCompleteEntryPage,
  replaceEntryContent,
  resolveEntryPage,
} from "./entry-content.ts";
import { trimEntryPage, trimSavedEntries } from "./entry-window.ts";
import { applyTextDelta, type TextDelta } from "./live-rows.ts";
import { createViewNotifications } from "./view-notifications.ts";
import { codingRowSize } from "./file-changes.ts";
import type { CodingImage, CodingInput, CodingInputExtras } from "./input.ts";
import type { CodingConfigurationChange } from "./model-selection.ts";
import { type PendingCommand, pendingCommandStore } from "./pending-command.ts";
import {
  type PendingImageStore,
  PendingImageStorageError,
  type PendingSubmission,
  type SubmissionStorage,
  imageManifest,
  pendingInput,
  pendingSubmissionStore,
} from "./pending-submission.ts";
import {
  type CodingMode,
  type NativePlan,
  type PendingPlanControl,
  type PlanDecision,
  planDisabledExplanation,
} from "./plan-types.ts";
import type {
  AnswerTarget,
  CodingRow,
  ContentReference,
  EntryAnchor,
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
  /** More saved entries after the bounded reading window, at its captured cut. */
  newer: boolean;
  loadingEarlier: boolean;
  /** Actual public live events only, never capture/checkpoint reconstruction. */
  activityVersion: number;
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
  /** After reload, image bytes are referenced by digest and read back only for retry. */
  uncertainSubmission: PendingSubmission | null;
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
  planControl: PendingPlanControl | null;
  planControlReconciling: boolean;
  planControlUncertain: boolean;
  planControlNotice: string | null;
  planControlError: string | null;
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
    imageStorage?: () => PendingImageStore;
    reconnectDelay?: (attempt: number) => number;
    /** Bound on waiting for ordered native state after a mode command. */
    modeSettleDelay?: number;
    onRuntimeLost?: () => void;
  } = {},
) {
  const pendingStore = pendingSubmissionStore(
    id,
    options.storage,
    options.imageStorage,
  );
  const commandStore = pendingCommandStore(id, options.storage);
  const childView = createChildView(id, api, (error) => {
    requireRuntimeReopen();
    update({ error: errorText(error) });
  });
  let state: CodingRunState = {
    connection: "loading",
    native: null,
    rows: [],
    recovering: false,
    older: false,
    viewingEarlier: false,
    newer: false,
    loadingEarlier: false,
    activityVersion: 0,
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
    planControl: null,
    planControlReconciling: false,
    planControlUncertain: false,
    planControlNotice: null,
    planControlError: null,
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
  let contentAbort = new AbortController();
  let liveInvocations = new Set<string>();
  let cut: JournalCut | null = null;
  let firstEntry: string | null = null;
  let latestOlder = false;
  let historyWindow: EntryPage | null = null;
  let historyTrimEdge: "start" | "end" = "start";
  // A bounded reading snapshot, retained only while away. It protects the reader
  // when the latest window evicts an entry or a reconnect captures a newer page.
  let readingWindow: EntryPage | null = null;
  // Explicit latest navigation supersedes historical UI intent, independently
  // of the native watcher/cut whose authoritative reconstruction must complete.
  let readingIntentRevision = 0;
  let position: number | null = null;
  let subscription: string | null = null;
  // Native views replay from their captured checkpoint. A same-process position
  // already observed is reconstruction, not unread activity. The transport's
  // opaque process epoch prevents suppression after native position numbering restarts.
  let observationEpoch: string | null = null;
  let observedThrough: number | null = null;
  let incarnation = 0;
  // A fresh watcher does not supersede an outstanding exact cancellation.
  // Only detach, a newer Stop attempt, or native settlement does that.
  let stopAttempt = 0;
  let answersAwaitCapture = false;
  // Configuration delivery outlives any one stream incarnation. A view opened
  // before an operation's outcome cannot reconcile that operation's uncertainty.
  let configurationEpoch = 0;
  let abort: AbortController | null = null;
  const notifications = createViewNotifications();
  const update = (patch: Partial<CodingRunState>, deferred = false) => {
    state = { ...state, ...patch };
    notifications.notify(deferred);
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
  const reconcileAnswers = (freshCapture = false, deferred = false) => {
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
    update({ answerTarget: target, answerForms: forms.slice(-8) }, deferred);
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
  let modeAwaiting: { mode: CodingMode; uncertain: boolean } | null = null;
  let modeTimer: ReturnType<typeof setTimeout> | null = null;
  const clearModeWait = () => {
    if (modeTimer !== null) clearTimeout(modeTimer);
    modeTimer = null;
    modeAwaiting = null;
  };
  const settleMode = () => {
    const control = state.planControl;
    if (
      control?.kind !== "mode" ||
      !modeAwaiting ||
      state.planControlReconciling ||
      state.connection !== "connected" ||
      state.recovering ||
      state.native?.configuration.mode !== control.mode
    )
      return;
    const { uncertain } = modeAwaiting;
    clearModeWait();
    update({
      planControl: null,
      planControlUncertain: false,
      planControlError: null,
      planControlNotice: uncertain
        ? `Delivery was unconfirmed, but ordered native state now reports ${control.mode} mode. No command was replayed.`
        : null,
    });
  };
  const reconcilePlanControl = () => {
    const control = state.planControl;
    if (
      !control ||
      !state.planControlReconciling ||
      state.recovering ||
      state.connection !== "connected"
    )
      return;
    const plan = state.native?.plan;
    const observation =
      control.kind === "mode"
        ? `Authoritative mode: ${state.native?.configuration.mode}.`
        : plan?.id !== control.plan_id
          ? "The selected plan is no longer current. Its action was not replayed."
          : `Native plan ${plan.id}: ${plan.status}.`;
    clearModeWait();
    update({
      planControl: null,
      planControlReconciling: false,
      // A mode wait message is superseded by this inspection; plan refusals stay.
      planControlError: control.kind === "mode" ? null : state.planControlError,
      planControlNotice: `${state.planControlUncertain ? "Delivery remains unconfirmed. " : ""}Fresh native view inspected. ${observation} No command was replayed; any further choice must target the current native revision.`,
    });
  };
  // Unchanged native inputs keep the same derived row objects, so presentation
  // reuses work by reference instead of re-comparing transcript content.
  const merged = new WeakMap<CodingRow, WeakMap<CodingRow, CodingRow>>();
  let liveRows = new WeakMap<CodingRow, CodingRow>();
  let liveRowsFor = liveInvocations;
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
        let byRow = merged.get(prior);
        if (!byRow) {
          byRow = new WeakMap();
          merged.set(prior, byRow);
        }
        let next = byRow.get(row);
        if (!next) {
          next = {
            ...row,
            id: prior.id,
            entry_id: prior.entry_id ?? row.entry_id,
            request_id: row.request_id ?? prior.request_id,
          };
          byRow.set(row, next);
        }
        rowsByIdentity[existing] = next;
      }
    }
    return rowsByIdentity;
  };
  const publishRows = (deferred = false) => {
    const bounded = trimSavedEntries(
      saved,
      MAX_ROWS - provisional.length,
      MAX_TEXT -
        provisional.reduce((size, row) => size + codingRowSize(row), 0),
    );
    saved = bounded.rows;
    if (bounded.omitted) {
      latestOlder = true;
      firstEntry = saved.find((row) => row.entry_id)?.entry_id ?? firstEntry;
      if (!historyWindow && readingWindow) historyWindow = readingWindow;
    }
    if (liveRowsFor !== liveInvocations) {
      liveRows = new WeakMap();
      liveRowsFor = liveInvocations;
    }
    // A persisted invocation start is not a terminal tool result. Native's
    // captured live identities remain authoritative, including on reconnect.
    const rows = mergeRows([...saved, ...provisional]).map((row) => {
      if (
        row.tool?.status !== "saved" ||
        !row.tool.invocation_id ||
        !liveInvocations.has(row.tool.invocation_id)
      )
        return row;
      let live = liveRows.get(row);
      if (!live) {
        live = {
          ...row,
          historical: false,
          tool: { ...row.tool, status: "running", historical: false },
        };
        liveRows.set(row, live);
      }
      return live;
    });
    childView.history(historyWindow ? historyWindow.rows : rows, deferred);
    update(
      {
        rows: historyWindow ? mergeRows(historyWindow.rows) : rows,
        older: historyWindow ? historyWindow.older : latestOlder,
        viewingEarlier: historyWindow !== null,
        newer: historyWindow?.newer ?? false,
      },
      deferred,
    );
    // Follow the currently displayed reading rows until an actual eviction or
    // reconnect requires freezing them. Never revive the initial pause snapshot.
    if (readingWindow && !historyWindow && cut)
      readingWindow = readingSnapshot(cut);
  };
  const readingSnapshot = (captured: JournalCut): EntryPage => ({
    cut: captured,
    rows: state.rows.map((row) => ({ ...row, historical: true })),
    older: latestOlder,
    newer: false,
    first_id: firstEntry,
    last_id:
      [...state.rows].reverse().find((row) => row.entry_id)?.entry_id ??
      captured.leaf,
  });
  const contentCallbacks = (
    signal: AbortSignal,
  ): [
    (reference: ContentReference, rows: CodingRow[]) => void,
    (error: unknown) => void,
  ] => [
    (reference, rows) => {
      if (signal.aborted) return;
      saved = replaceEntryContent(saved, reference, rows);
      if (historyWindow)
        Object.assign(
          historyWindow,
          trimEntryPage(
            {
              ...historyWindow,
              rows: replaceEntryContent(historyWindow.rows, reference, rows),
            },
            MAX_ROWS,
            MAX_TEXT,
            historyTrimEdge,
          ),
        );
      if (readingWindow)
        Object.assign(
          readingWindow,
          trimEntryPage(
            {
              ...readingWindow,
              rows: replaceEntryContent(readingWindow.rows, reference, rows),
            },
            MAX_ROWS,
            MAX_TEXT,
            "start",
          ),
        );
      publishRows();
    },
    (error) => {
      if (signal.aborted) return;
      requireRuntimeReopen();
      update({ error: errorText(error) });
    },
  ];
  const readPage = (
    captured: JournalCut,
    anchor: EntryAnchor,
    signal: AbortSignal,
  ) => {
    const lifetime = AbortSignal.any([signal, contentAbort.signal]);
    return readCompleteEntryPage(
      api,
      id,
      captured,
      anchor,
      lifetime,
      ...contentCallbacks(lifetime),
    );
  };
  async function capture(
    root: { cut: JournalCut; live_invocations: string[] },
    recovering: boolean,
    signal: AbortSignal,
    retainedWindow: EntryPage | null,
    retainedIntentRevision: number,
  ) {
    const page = await readPage(root.cut, "latest", signal);
    if (signal.aborted) return;
    if (page.newer)
      throw new Error("The native latest page omitted newer history.");
    saved = page.rows.map((row) => ({ ...row, historical: true }));
    provisional = [];
    liveInvocations = new Set(root.live_invocations);
    cut = root.cut;
    firstEntry = page.first_id;
    latestOlder = page.older;
    historyWindow =
      retainedIntentRevision === readingIntentRevision &&
      retainedWindow &&
      JSON.stringify(retainedWindow.cut.journal) ===
        JSON.stringify(root.cut.journal)
        ? retainedWindow
        : null;
    if (historyWindow) {
      const lifetime = AbortSignal.any([signal, contentAbort.signal]);
      historyWindow = resolveEntryPage(
        api,
        id,
        historyWindow,
        historyWindow.cut,
        lifetime,
        ...contentCallbacks(lifetime),
      );
    }
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
        const page = await readPage(root.cut, "latest", signal);
        if (signal.aborted) return;
        saved = page.rows;
        firstEntry = page.first_id;
        latestOlder = page.older;
      } else {
        let after = cut.leaf;
        for (let n = 0; n < 100; n++) {
          const page = await readPage(root.cut, { after }, signal);
          if (signal.aborted) return;
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
    liveInvocations = new Set(root.live_invocations);
    provisional = provisional.filter(
      (row) =>
        row.tool?.invocation_id &&
        liveInvocations.has(row.tool.invocation_id) &&
        !saved.some(
          (item) =>
            item.tool?.invocation_id === row.tool?.invocation_id &&
            ["completed", "failed", "cancelled", "interrupted"].includes(
              item.tool?.status ?? "",
            ),
        ),
    );
    update({ recovering: false });
    publishRows();
  }
  function applyActivity(event: Record<string, unknown>, fresh: boolean) {
    if (event.type === "text_delta") {
      const delta = event as unknown as TextDelta;
      if (delta.child) childView.textDelta(delta.child, delta);
      else {
        provisional = applyTextDelta(provisional, delta);
        publishRows(true);
      }
      if (fresh) update({ activityVersion: state.activityVersion + 1 }, true);
    } else if (event.type === "activity") {
      const rows = event.rows as CodingRow[];
      if (!Array.isArray(rows))
        throw new Error("Invalid native activity rows.");
      if (event.child) childView.activity(event.child as ChildIdentity, rows);
      else {
        for (const row of rows) {
          const index = provisional.findIndex((item) => item.id === row.id);
          if (index < 0) provisional.push(row);
          else provisional[index] = row;
        }
        publishRows(true);
      }
      if (fresh && rows.length)
        update({ activityVersion: state.activityVersion + 1 }, true);
    } else if (event.type === "completed") {
      const completion = event as unknown as NonNullable<
        CodingRunState["completion"]
      >;
      const stopped = state.stopping === completion.request_id;
      update({
        completion,
        activityVersion: state.activityVersion + (fresh ? 1 : 0),
        stopping: stopped ? null : state.stopping,
        reconcilingAction: stopped ? null : state.reconcilingAction,
        retryStop:
          state.retryStop === completion.request_id ? null : state.retryStop,
        error: stopped ? null : state.error,
      });
    } else throw new Error("Invalid native snapshot activity.");
  }
  async function consume(
    value: unknown,
    signal: AbortSignal,
    configurationCut: number,
  ) {
    if (signal.aborted) return;
    const view = value as {
      subscription: string;
      observation_epoch?: string;
      position: number;
      event: Record<string, unknown>;
    };
    if (
      !view ||
      typeof view.subscription !== "string" ||
      (view.observation_epoch !== undefined &&
        typeof view.observation_epoch !== "string") ||
      !Number.isSafeInteger(view.position) ||
      !view.event
    )
      throw new Error(
        "Invalid native view envelope. Reconnect to reconstruct.",
      );
    const event = view.event;
    const epoch = view.observation_epoch ?? null;
    if (
      position !== null &&
      (view.subscription !== subscription ||
        view.position <= position ||
        epoch !== observationEpoch)
    )
      throw new Error(
        "Native view items were not ordered. Reconnect to reconstruct.",
      );
    // Reset rebuilds the transcript branch, not this runtime's observation
    // lifetime. Its already-seen delivery can be replayed after reconnect too.
    if (epoch !== observationEpoch) {
      observationEpoch = epoch;
      observedThrough = null;
    }
    const freshObservation =
      observedThrough === null || view.position > observedThrough;
    observedThrough = Math.max(observedThrough ?? view.position, view.position);
    position = view.position;
    subscription = view.subscription;
    if (event.type === "start" || event.type === "reset") {
      contentAbort.abort();
      contentAbort = new AbortController();
      answersAwaitCapture = true;
      const native = event.state as NativeState;
      if (native.info.id !== id)
        throw new Error("Native view belongs to another conversation.");
      childView.setConnected(false);
      const retainedWindow =
        event.type === "start" ? (historyWindow ?? readingWindow) : null;
      const retainedIntentRevision = readingIntentRevision;
      if (event.type === "reset") readingWindow = null;
      saved = [];
      provisional = [];
      historyWindow = null;
      cut = null;
      update({
        native,
        // A same-conversation reconnect keeps the existing projection visibly
        // busy until capture, preserving mounted expansion/focus state. A reset
        // must hide the superseded branch immediately.
        rows: event.type === "reset" ? [] : state.rows,
        connection: "loading",
        completion: null,
        recovering: Boolean(event.recovering),
        // Paging controls belong to the retained projection too. Hiding them
        // during same-conversation capture removes the reader's focused node.
        older: event.type === "reset" ? false : state.older,
        newer: event.type === "reset" ? false : state.newer,
        viewingEarlier: event.type === "reset" ? false : state.viewingEarlier,
      });
      await capture(
        event.root as { cut: JournalCut; live_invocations: string[] },
        Boolean(event.recovering),
        signal,
        retainedWindow,
        retainedIntentRevision,
      );
      if (signal.aborted) return;
      // Child metadata/cuts apply synchronously. Optional inspection reads are
      // cancellable and revision-guarded, never a dependency of main-session Stop.
      void childView.capture((event.children ?? []) as ChildAttempt[], saved);
      const activity = event.activity ?? [];
      if (!Array.isArray(activity))
        throw new Error("Invalid native snapshot activity.");
      for (const item of activity)
        applyActivity(item as Record<string, unknown>, false);
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
        activityVersion:
          state.activityVersion +
          // Numeric usage can be reconstructed by a fresh view; it is not new
          // public transcript activity. Keep the diagnostics, not an unread flag.
          (freshObservation &&
          JSON.stringify({ ...native, usage: undefined }) !==
            JSON.stringify({ ...state.native, usage: undefined })
            ? 1
            : 0),
        retryStop:
          state.retryStop && native.active_request === state.retryStop
            ? state.retryStop
            : null,
      });
    } else if (event.type === "child") {
      if (freshObservation)
        update({ activityVersion: state.activityVersion + 1 });
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
    } else if (
      ["activity", "text_delta", "completed"].includes(event.type as string)
    ) {
      applyActivity(event, freshObservation);
    }
    if (signal.aborted) return;
    // Numeric/structural diagnostics travel outside public transcript activity.
    if (state.native && ("usage" in event || "compression" in event)) {
      update(
        {
          native: {
            ...state.native,
            ...("usage" in event
              ? { usage: event.usage as NativeState["usage"] }
              : {}),
            ...("compression" in event
              ? { compression: event.compression as NativeState["compression"] }
              : {}),
          },
        },
        event.type === "text_delta" || event.type === "activity",
      );
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
      reconcilePlanControl();
      void reconcileCommand();
    }
    reconcileAnswers(
      answersAwaitCapture,
      event.type === "text_delta" || event.type === "activity",
    );
    settleMode();
  }
  function requireRuntimeReopen() {
    if (runtimeLost) return;
    runtimeLost = true;
    contentAbort.abort();
    childView.setConnected(false);
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
        if (
          reason instanceof Error &&
          "viewInvalidated" in reason &&
          reason.viewInvalidated === true
        ) {
          // Compatible reopen revoked only this view's capabilities. Keep the
          // projection/drafts and recapture read-only, without owner-loss feedback.
          connect();
          return;
        }
        const requiresReopen = needsReopen(reason);
        if (requiresReopen) requireRuntimeReopen();
        childView.setConnected(false);
        update({
          connection: "disconnected",
          answerTarget: null,
          disconnected: true,
          reopenRequired: requiresReopen,
          rows: requiresReopen
            ? state.rows
            : interruptEntryContent(state.rows, connect),
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
  const sameImages = async (
    existing: PendingSubmission,
    images: CodingImage[] | undefined,
  ) =>
    JSON.stringify(existing.image_manifest ?? []) ===
    JSON.stringify(await imageManifest(images ?? []));
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
      state.planControl ||
      state.goalChanging ||
      state.reconcilingGoal ||
      state.commandBusy ||
      state.uncertainCommand ||
      state.storageError ||
      state.native?.execution_preparation?.phase === "cleanup_pending"
    )
      throw new Error(
        "Wait for a connected, reconstructed native view and confirmed cleanup before sending.",
      );
    // Image persistence is asynchronous: hold the send gate meanwhile, and
    // deliver only through the same view lifetime that admitted this send.
    const lifetime = { attachment, incarnation };
    update({ submitting: true });
    let existing: PendingSubmission | null;
    try {
      existing = pendingStore.load();
      if (
        existing &&
        (existing.key !== key ||
          existing.text !== input.text ||
          JSON.stringify(existing.skill_mentions ?? []) !==
            JSON.stringify(input.skill_mentions ?? []) ||
          JSON.stringify(existing.subagent_mentions ?? []) !==
            JSON.stringify(input.subagent_mentions ?? []) ||
          JSON.stringify(existing.file_mentions ?? []) !==
            JSON.stringify(input.file_mentions ?? []) ||
          !(await sameImages(existing, input.images)))
      )
        throw new Error(
          "Another pending submission must be reconciled before sending.",
        );
      await pendingStore.save({ key, ...input }); // Complete input durable BEFORE HTTP.
    } catch (reason) {
      // The shipped composer clears its text before onNew. Keep this known-unsent
      // draft separately from uncertain delivery and native transcript rows.
      update({
        submitting: false,
        ...(reason instanceof PendingImageStorageError
          ? {
              error: `${reason.message} Nothing was sent; your input is retained.`,
            }
          : {
              storageError: `Submission storage unavailable. No prompt was sent. ${errorText(reason)}`,
            }),
        unsentDraft: input.text,
        rejectedSubmission: input,
      });
      return false;
    }
    if (
      lifetime.attachment !== attachment ||
      lifetime.incarnation !== incarnation ||
      runtimeLost ||
      state.connection !== "connected" ||
      state.recovering
    ) {
      // Known unsent: a fresh record is withdrawn; a retried uncertain one stays.
      if (!existing) clearPending(key, false);
      update({
        submitting: false,
        error:
          "The native view changed while this submission was being saved. Nothing was sent; your input is retained.",
        ...(existing
          ? {}
          : { unsentDraft: input.text, rejectedSubmission: input }),
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
  async function planControl(
    control: PendingPlanControl,
    operation: () => Promise<void>,
  ) {
    const disabled =
      control.kind === "mode"
        ? codingModeControlReason(state)
        : codingPlanControlReason(state);
    if (disabled) {
      update({ planControlError: disabled });
      return;
    }
    const current = attachment;
    update({
      planControl: control,
      planControlReconciling: false,
      planControlUncertain: false,
      planControlError: null,
      planControlNotice: null,
    });
    try {
      await operation();
    } catch (reason) {
      if (current !== attachment) return;
      const rejected =
        reason instanceof Error &&
        "admissionRejected" in reason &&
        reason.admissionRejected === true;
      update({
        planControlUncertain: !rejected,
        planControlError: errorText(reason),
      });
      if (needsReopen(reason)) {
        requireRuntimeReopen();
        return;
      }
    }
    // Acceptance is not authoritative state; reconstruct without replaying.
    if (current !== attachment || abort === null) return;
    update({ planControlReconciling: true });
    connect();
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
    !state.planControl &&
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
  async function loadHistory(direction: "before" | "after") {
    const previousWindow = historyWindow;
    const anchor =
      direction === "before"
        ? (previousWindow?.first_id ?? firstEntry)
        : previousWindow?.last_id;
    if (
      !cut ||
      !anchor ||
      state.loadingEarlier ||
      state.connection !== "connected" ||
      !(direction === "before" ? state.older : state.newer)
    )
      return;
    const current = incarnation;
    const captured = previousWindow?.cut ?? cut;
    const intentRevision = readingIntentRevision;
    const label = direction === "before" ? "Earlier" : "Newer";
    update({ loadingEarlier: true, error: null });
    try {
      const page = await readPage(
        captured,
        direction === "before" ? { before: anchor } : { after: anchor },
        abort!.signal,
      );
      if (
        current !== incarnation ||
        intentRevision !== readingIntentRevision ||
        historyWindow !== previousWindow ||
        (!previousWindow && cut !== captured)
      )
        return;
      const edge = direction === "before" ? page.first_id : page.last_id;
      if (!page.rows.length || !edge || edge === anchor)
        throw new Error(
          `${label} history is incomplete: the native page made no progress. Retry loading ${label.toLowerCase()} history or reconnect for a fresh capture.`,
        );
      const retained = previousWindow?.rows ?? state.rows;
      const seen = new Set<string>();
      const combined =
        direction === "before"
          ? [...page.rows, ...retained]
          : [...retained, ...page.rows];
      const combinedRows = mergeRows(
        combined.filter((row) => {
          if (seen.has(row.id)) return false;
          seen.add(row.id);
          return true;
        }),
      ).map((row) => ({ ...row, historical: true }));
      historyTrimEdge = direction === "before" ? "end" : "start";
      const { rows, omitted: trimmed } = trimSavedEntries(
        combinedRows,
        MAX_ROWS,
        MAX_TEXT,
        historyTrimEdge,
      );
      historyWindow = {
        cut: captured,
        rows,
        older:
          direction === "before"
            ? page.older
            : trimmed || Boolean(previousWindow?.older),
        newer:
          direction === "after"
            ? page.newer
            : trimmed || Boolean(previousWindow?.newer),
        first_id: rows.find((row) => row.entry_id)?.entry_id ?? page.first_id,
        last_id:
          [...rows].reverse().find((row) => row.entry_id)?.entry_id ??
          page.last_id,
      };
      publishRows();
    } catch (reason) {
      if (current === incarnation && intentRevision === readingIntentRevision) {
        if (needsReopen(reason)) requireRuntimeReopen();
        update({ error: errorText(reason) });
      }
    } finally {
      // Even superseded reading intent must release this incarnation's loading
      // flag. Jump does not abort the authoritative native watcher or its reads.
      if (current === incarnation) update({ loadingEarlier: false });
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
    subscribe: notifications.subscribe,
    connect,
    requireRuntimeReopen,
    async continueInterruptedWork() {
      const request = codingInterruptedRequest(state);
      if (!request || !codingCanContinue(state)) return;
      update({ continuationRequested: request.id });
      const sent = await submit(
        {
          text: `Continue the interrupted work from request ${request.id}. Review saved history and the current project state first; do not blindly repeat commands or assume prior actions completed.`,
        },
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
        state.planControl ||
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
        if (needsReopen(reason)) requireRuntimeReopen();
        throw reason;
      } finally {
        ++configurationEpoch;
        update({ configuring: false });
      }
    },
    detach() {
      clearModeWait();
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
    /** Mode-only: the reply is not authority. The already-ordered native view
     * settles it; one fresh capture is read only if that never confirms. */
    async setMode(mode: CodingMode) {
      const disabled = codingModeControlReason(state);
      if (disabled) {
        update({ planControlError: disabled });
        return;
      }
      const current = attachment;
      clearModeWait();
      update({
        planControl: { kind: "mode", mode },
        planControlReconciling: false,
        planControlUncertain: false,
        planControlError: null,
        planControlNotice: null,
      });
      let uncertain = false;
      try {
        const result = await api.setMode(id, mode);
        if (result.conversation_id !== id || result.mode !== mode)
          throw new Error(
            "The native mode selection identity could not be confirmed.",
          );
      } catch (reason) {
        if (current !== attachment) return;
        if (needsReopen(reason)) {
          // The owner is gone: keep the control blocked until deliberate reopen.
          update({
            planControlUncertain: true,
            planControlError: errorText(reason),
          });
          requireRuntimeReopen();
          return;
        }
        if (
          reason instanceof Error &&
          "admissionRejected" in reason &&
          reason.admissionRejected === true
        ) {
          // Definite refusal before native admission: the ordered view still
          // reports the authoritative mode, so nothing needs reconstruction.
          update({ planControl: null, planControlError: errorText(reason) });
          return;
        }
        uncertain = true;
        update({
          planControlUncertain: true,
          planControlError: `${errorText(reason)} Mode delivery is unconfirmed; waiting for ordered native state. No command was replayed.`,
        });
      }
      if (current !== attachment || abort === null) return;
      modeAwaiting = { mode, uncertain };
      settleMode();
      if (state.planControl?.kind !== "mode") return;
      modeTimer = setTimeout(() => {
        modeTimer = null;
        if (current !== attachment || state.planControl?.kind !== "mode")
          return;
        modeAwaiting = null;
        update({ planControlReconciling: true });
        connect();
      }, options.modeSettleDelay ?? 5000);
    },
    async decidePlan(plan: NativePlan, decision: PlanDecision) {
      if (
        state.native?.plan?.id !== plan.id ||
        state.native.plan.revision !== plan.revision
      ) {
        update({
          planControlError:
            "This plan is stale. Inspect the current native plan before choosing an action.",
        });
        return;
      }
      const reason = codingPlanDecisionReason(
        state,
        state.native.plan,
        decision,
      );
      if (reason) {
        update({ planControlError: reason });
        return;
      }
      await planControl(
        { kind: "plan", plan_id: plan.id, revision: plan.revision, decision },
        async () => {
          const result = await api.decidePlan(id, plan, decision);
          if (
            result.conversation_id !== id ||
            result.plan_id !== plan.id ||
            result.decision !== decision
          )
            throw new Error(
              "The native plan decision identity could not be confirmed.",
            );
        },
      );
    },
    async changeGoal(change: GoalChange) {
      const controls = state.native?.goal_controls;
      const admission = controls?.actions.find(
        (item) => item.action === change.action,
      );
      if (
        state.connection !== "connected" ||
        state.recovering ||
        state.planControl ||
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
        state.planControl ||
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
        state.planControl ||
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
      if (!pending) return false;
      let images: CodingImage[] | undefined;
      try {
        // Exactly the original bytes, verified by digest, or no retry at all.
        images = await pendingStore.images(pending);
      } catch (reason) {
        update({ error: errorText(reason) });
        return false;
      }
      return await submit(
        { ...pendingInput(pending), ...(images ? { images } : {}) },
        pending.key,
      );
    },
    clearRejectedSubmission() {
      update({ rejectedSubmission: null });
    },
    /** Composer text already cleared by the shipped runtime, refused before any
     * delivery: keep it restorable. Not a transcript row or uncertain delivery. */
    retainUnsent(input: CodingInput, reason: unknown) {
      update({
        error: `${errorText(reason)} No prompt was sent; your input is retained.`,
        unsentDraft: input.text,
        rejectedSubmission: structuredClone(input),
      });
    },
    async stop() {
      const request = codingStopTarget(state);
      if (!request) return;
      const current = attachment;
      const attempt = ++stopAttempt;
      update({
        stopping: request,
        retryStop: null,
        error: null,
        answerTarget: null,
      });
      try {
        const result = await api.cancel(id, request);
        // Watcher reconstruction (including plan/mode and goal reconciliation)
        // leaves this exact Stop pending. Detach, a later attempt and settlement
        // supersede it.
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
    setReading(away: boolean) {
      if (!away) {
        readingWindow = null;
        return;
      }
      if (cut && state.rows.length)
        readingWindow = historyWindow ?? readingSnapshot(cut);
    },
    showLatest() {
      ++readingIntentRevision;
      historyWindow = null;
      readingWindow = null;
      publishRows();
    },
    loadEarlier() {
      return loadHistory("before");
    },
    loadNewer() {
      return loadHistory("after");
    },
  };
}
export type CodingRun = ReturnType<typeof createCodingRun>;

/** The exact native request Stop may target now, or null: the active request
 * this opened owner last reported. Capture, recovery, a lost or delayed view and
 * navigation keep it, since native judges a stale cancel and request IDs are never
 * reused. Observed completion, a newer native state, or owner loss/a new runtime
 * incarnation retires it; requests are routed only to this opening's generation. */
export function codingStopTarget(state: CodingRunState | null): string | null {
  if (
    !state ||
    state.reopenRequired ||
    state.stopping ||
    state.reconcilingAction
  )
    return null;
  const request = state.native?.active_request ?? null;
  return request && state.completion?.request_id !== request ? request : null;
}

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
      !state.planControl &&
      !state.stopping &&
      !state.reconcilingAction &&
      !state.uncertainSubmission &&
      !state.storageError &&
      state.continuationRequested !== request.id,
  );
}

/** Why a new prompt cannot be admitted now; null when native admission may be tried.
 * One rule for the Send button, Enter, the adapter and `send` itself. */
export function codingSendBlockedReason(
  state: CodingRunState | null,
): string | null {
  if (!state) return "Choose a project folder first.";
  if (state.connection !== "connected" || state.recovering)
    return "Waiting for a connected, reconstructed native view.";
  if (state.storageError) return "Browser storage is unavailable.";
  if (state.uncertainSubmission)
    return "Reconcile the unconfirmed submission first.";
  if (state.submitting) return "Sending…";
  if (state.stopping || state.reconcilingAction)
    return "Waiting for Stop to finish native cleanup.";
  if (state.planControl)
    return state.planControl.kind === "mode"
      ? "Waiting for native mode confirmation."
      : "Waiting for the native plan decision.";
  if (state.configuring || state.configurationUncertain)
    return "Waiting for native model configuration.";
  if (state.goalChanging || state.reconcilingGoal)
    return "Waiting for the native goal change.";
  if (state.commandBusy || state.uncertainCommand)
    return "Waiting for the native command outcome.";
  if (state.overlapWarning) return "Resolve the project overlap warning.";
  if (state.native?.pending_user_request)
    return "Answer the native question first.";
  if (state.native?.execution_preparation?.phase === "cleanup_pending")
    return "Waiting for local model cleanup.";
  return null;
}

/** Typing is never native work; only a missing owner or failed storage stops it. */
export function codingCanEdit(
  state: CodingRunState | null,
  run: CodingRun | null,
): boolean {
  return Boolean(state && run && !state.storageError);
}

export function codingModeControlReason(
  state: CodingRunState | null,
): string | null {
  if (!state?.native) return "Open a coding conversation first.";
  if (
    state.connection !== "connected" ||
    state.disconnected ||
    state.recovering
  )
    return "Wait for a connected, reconstructed native view.";
  if (state.planControl)
    return state.planControlReconciling
      ? "Inspecting a fresh native view; no command is being replayed."
      : "Waiting for native action admission.";
  if (state.goalChanging || state.reconcilingGoal)
    return "Reconcile native goal admission before changing plan or mode controls.";
  if (state.stopping || state.reconcilingAction)
    return "Wait for native Stop reconciliation and terminal cleanup.";
  if (state.submitting || state.uncertainSubmission)
    return "Reconcile prompt delivery before changing native controls.";
  if (state.configuring || state.configurationUncertain)
    return "Reconcile model configuration before changing native controls.";
  if (state.commandBusy || state.uncertainCommand || state.storageError)
    return "Resolve native command delivery and storage before changing native controls.";
  if (state.overlapWarning)
    return "Resolve the project overlap warning before changing native controls.";
  return null;
}

export function codingPlanControlReason(
  state: CodingRunState | null,
): string | null {
  if (state?.native?.pending_user_request)
    return "Resolve the native question or approval before deciding a plan.";
  return (
    codingModeControlReason(state) ??
    planDisabledExplanation(state?.native?.action_disabled_reason)
  );
}

export function codingPlanDecisionReason(
  state: CodingRunState | null,
  plan: NativePlan,
  decision?: PlanDecision,
): string | null {
  if (plan.status === "saved_stopped" && decision === "save_and_stop")
    return "This plan is already saved and stopped. Choose implementation explicitly when ready.";
  return (
    codingPlanControlReason(state) ??
    planDisabledExplanation(plan.action_disabled_reason) ??
    (!["review_pending", "saved_stopped"].includes(plan.status)
      ? "This plan is not awaiting a decision. Implementation will not be replayed."
      : null)
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
  const preparation = state.native?.execution_preparation;
  if (preparation?.phase === "cleanup_pending")
    return "Cleanup pending · local model protection retained";
  if (preparation?.phase === "loading") return "Loading Studio local model…";
  if (preparation?.phase === "busy")
    return "Local model busy · explicit retry required";
  if (preparation?.phase === "failed")
    return "Local model preparation failed · explicit retry required";
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
