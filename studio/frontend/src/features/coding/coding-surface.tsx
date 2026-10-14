// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
} from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { restoreAnswerFocus, watchAnswerFocus } from "./answer-focus";
import { createCodingRunApi } from "./api";
import { boundedContentKeyDown } from "./bounded-content";
import { ChildActivityRows, ChildInspector } from "./child-inspector";
import { CodingComposer } from "./coding-composer";
import { CodingCommandControls } from "./command-controls";
import { GoalSummary } from "./goal-summary";
import { createInputDraft } from "./input";
import { CodingModelPicker } from "./model-configuration-popover";
import { CodingModeControl, PlanCard } from "./plan-card";
import { nativeMessageRow, readingRowKey } from "./presentation";
import { ProjectOverlapDialog } from "./project-overlap-dialog";
import { QuestionCard } from "./question-card";
import { codingRunAdapter } from "./run-runtime";
import {
  codingRunCompletion,
  codingRunLabel,
  createCodingRun,
} from "./run-session";
import { ToolReport } from "./tool-report";
import {
  type TranscriptReader,
  createTranscriptReader,
} from "./transcript-reader";
import { CodingUnsentDraft } from "./unsent-draft";
import { CodingRecoveryControls } from "./recovery-controls";
import type { CodingRuntimeStatus } from "./runtime-maintenance";

// Focus intent only, not another answer/history store. assistant-ui may project
// a native row one render after its question controls have disappeared.
const AnswerFocus = createContext<{ current: string | null } | null>(null);

function NativeMessage() {
  const message = useMessage();
  const row = nativeMessageRow(message);
  const root = useRef<HTMLDivElement>(null);
  const questionId = row?.answer?.user_request_id;
  const answerFocus = useContext(AnswerFocus);
  useLayoutEffect(() => {
    const element = root.current;
    if (questionId && answerFocus)
      restoreAnswerFocus(
        answerFocus,
        questionId,
        element,
        document.activeElement,
        document.body,
      );
    return () => {
      // A checkpoint replaces a provisional answer with its saved identity.
      // Carry only focus owned by that row across the native replacement.
      if (
        questionId &&
        answerFocus &&
        element?.contains(document.activeElement)
      )
        answerFocus.current = questionId;
    };
  }, [questionId, answerFocus]);
  if (!row || row.child || row.tool?.subagent?.attempt) return null;
  const tool = row.tool;
  const longText =
    (row.text?.length ?? 0) > 4000 || (row.text?.split("\n").length ?? 0) > 80;
  const tools = row.grouped ?? [row];
  const visible = tools.filter(
    (item) =>
      !item.tool?.quiet ||
      item.tool?.status === "failed" ||
      item.tool?.semantic_content ||
      item.tool?.output_profile?.kind === "file_change",
  );
  const quiet = tools.filter((item) => !visible.includes(item));
  const reports = (
    <>
      {visible.map((item) => (
        <ToolReport key={readingRowKey(item)} row={item} />
      ))}
      {quiet.length > 0 && (
        <details className="rounded-xl border border-border/50 text-xs">
          <summary className="cursor-pointer rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {quiet.length} quiet tool{" "}
            {quiet.length === 1 ? "activity" : "activities"} · expand details
          </summary>
          <div className="space-y-2 p-3">
            {quiet.map((item) => (
              <ToolReport key={readingRowKey(item)} row={item} />
            ))}
          </div>
        </details>
      )}
    </>
  );
  return (
    <MessagePrimitive.Root
      ref={root}
      className={`min-w-0 break-words ${row.kind === "user" ? "ml-auto max-w-[90%] rounded-2xl bg-muted px-4 py-3" : "w-full py-2"}`}
      data-native-entry={row.id}
      data-reading-key={readingRowKey(row)}
      data-native-answer={row.answer?.user_request_id}
      tabIndex={row.answer ? -1 : undefined}
    >
      {tool ? (
        row.grouped ? (
          <details className="rounded-xl border border-border/60 text-sm">
            <summary className="cursor-pointer rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {tool.row_group?.label} ·{" "}
              {visible
                .map((item) => item.tool?.row_group?.item)
                .filter(Boolean)
                .join(", ") || "expand activity details"}
            </summary>
            <div className="space-y-2 p-3">{reports}</div>
          </details>
        ) : (
          <div className="space-y-2">{reports}</div>
        )
      ) : row.plan ? (
        <PlanCard plan={row.plan} historical={true} />
      ) : (
        <>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            {row.answer
              ? "You · accepted answer"
              : row.kind === "user"
                ? "You"
                : row.kind === "notice"
                  ? "Native activity"
                  : "Mimir"}
          </p>
          <div
            className={`whitespace-pre-wrap text-sm leading-relaxed ${longText ? "max-h-96 overflow-auto overscroll-contain rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" : ""}`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Long native messages need keyboard scrolling.
            tabIndex={longText ? 0 : undefined}
            onKeyDown={longText ? boundedContentKeyDown : undefined}
            data-reading-control={longText ? "message-content" : undefined}
            aria-label={longText ? "Bounded native message content" : undefined}
          >
            {row.text}
          </div>
          {longText && (
            <p className="mt-1 text-xs text-muted-foreground">
              Long message · scroll within the content to read all supplied
              text.
            </p>
          )}
          {row.kind === "user" && (row.image_count ?? 0) > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Native saved input · {row.image_count}{" "}
              {row.image_count === 1 ? "image" : "images"} · request outcome
              shown separately
            </p>
          )}
          {row.clipped && (
            <p className="mt-2 text-xs font-medium">
              Content clipped to the presentation bound.
            </p>
          )}
        </>
      )}
    </MessagePrimitive.Root>
  );
}
const messageComponents = {
  UserMessage: NativeMessage,
  AssistantMessage: NativeMessage,
  SystemMessage: NativeMessage,
};

export function CodingSurface({
  conversationId,
  conversationGeneration,
  runtimeStatus,
  onRuntimeLost,
  children,
}: {
  conversationId: string | null;
  conversationGeneration?: number;
  runtimeStatus: CodingRuntimeStatus | null;
  onRuntimeLost?: () => void;
  children: React.ReactNode;
}) {
  const [run] = useState(() => {
    if (
      !conversationId ||
      typeof conversationGeneration !== "number" ||
      !Number.isSafeInteger(conversationGeneration) ||
      conversationGeneration < 1
    )
      return null;
    return createCodingRun(
      conversationId,
      createCodingRunApi(conversationGeneration),
      undefined,
      { onRuntimeLost },
    );
  });
  const state = useSyncExternalStore(
    run?.subscribe ?? (() => () => {}),
    run?.getSnapshot ?? (() => null),
  );
  const [draft] = useState(createInputDraft);
  const runtime = useExternalStoreRuntime(codingRunAdapter(state, run, draft));
  const viewport = useRef<HTMLElement>(null);
  const answerFocus = useRef<string | null>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const statusFocus = useRef<HTMLDivElement>(null);
  const transcriptContent = useRef<HTMLDivElement>(null);
  const reader = useRef<TranscriptReader | null>(null);
  const [reading, setReading] = useState({ away: false, newActivity: false });
  useLayoutEffect(() => {
    if (!viewport.current || !transcriptContent.current) return;
    const controller = createTranscriptReader(
      viewport.current,
      transcriptContent.current,
      (next) => {
        run?.setReading(next.away);
        setReading((prior) =>
          prior.away === next.away && prior.newActivity === next.newActivity
            ? prior
            : next,
        );
      },
    );
    reader.current = controller;
    return () => {
      controller.dispose();
      reader.current = null;
    };
  }, [run]);
  useEffect(() => {
    const releaseFocus = watchAnswerFocus(answerFocus, document, window);
    run?.connect();
    return () => {
      releaseFocus();
      run?.detach();
    };
  }, [run]);
  useEffect(() => {
    if (!run || !runtimeStatus || conversationGeneration === undefined) return;
    // Successful create/open invalidates prior observations before this owner is
    // published. Fresh epochs are opaque: inequality, not numeric order, is loss.
    const replaced = runtimeStatus.generation !== conversationGeneration;
    // Same-generation restart preparation/uncertainty is not proof of process
    // loss. A refused attempt must leave the connected view and Stop available.
    if (
      replaced ||
      ["disconnected", "stopped", "cleanup_failed"].includes(
        runtimeStatus.state,
      )
    )
      run.requireRuntimeReopen();
  }, [runtimeStatus, conversationGeneration, run]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore geometry after row/question DOM replacement, not only new activity.
  useLayoutEffect(() => {
    reader.current?.activity(
      state?.activityVersion ?? 0,
      Boolean(state?.viewingEarlier),
    );
    reader.current?.restore();
  }, [
    state?.rows,
    state?.native?.user_request,
    state?.activityVersion,
    state?.viewingEarlier,
  ]);
  const active = state?.native?.active_request;
  const completion = codingRunCompletion(state);
  const canSend = Boolean(
    state?.connection === "connected" &&
      !state.recovering &&
      !state.stopping &&
      !state.submitting &&
      !state.configuring &&
      !state.configurationUncertain &&
      !state.uncertainSubmission &&
      !state.storageError &&
      !state.reconcilingAction &&
      !state.planControl &&
      !state.goalChanging &&
      !state.reconcilingGoal &&
      !state.native?.pending_user_request &&
      !state.commandBusy &&
      !state.uncertainCommand &&
      !state.overlapWarning &&
      state.native?.execution_preparation?.phase !== "cleanup_pending",
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ProjectOverlapDialog
        overlap={state?.overlapWarning?.overlap ?? null}
        disabled={Boolean(
          !state ||
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
            state.storageError,
        )}
        onContinue={() => void run?.continueOverlap()}
        onCancel={() => run?.cancelOverlap()}
        onCloseFocus={() =>
          requestAnimationFrame(() => {
            const input = promptInput.current;
            if (input && !input.disabled) input.focus({ preventScroll: true });
            else statusFocus.current?.focus({ preventScroll: true });
          })
        }
      />
      <ThreadPrimitive.Root className="flex min-h-min min-w-0 flex-1 flex-col gap-3">
        {conversationId && !run && (
          <p role="alert" className="break-words text-sm text-destructive">
            The saved conversation has no confirmed opening generation.
            Deliberately reopen it before sending or controlling native work;
            runtime status cannot supply its owner identity.
          </p>
        )}
        {state && (
          <div
            ref={statusFocus}
            role="region"
            aria-label="Coding request status"
            tabIndex={-1}
            className="max-h-[35dvh] shrink-0 space-y-2 overflow-y-auto rounded-xl border border-border/60 px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="coding-event-status"
          >
            <output
              data-testid="coding-run-status"
              className="block font-medium"
              aria-live="polite"
            >
              {codingRunLabel(state)}
            </output>
            <p className="text-muted-foreground">
              {state.connection === "connected"
                ? "Native event stream connected"
                : state.connection === "loading"
                  ? "Connecting to native events…"
                  : "Native event stream unavailable · lost connection does not mean work stopped"}
            </p>
            {(active || state.stopping || completion?.request_id) && (
              <p
                className={`break-all font-mono text-[11px] text-muted-foreground ${state.native?.pending_user_request ? "max-sm:hidden" : ""}`}
                data-testid="coding-request-id"
              >
                {state.stopping || active || completion?.request_id}
              </p>
            )}
            {active && (
              <p
                className="break-words text-muted-foreground"
                data-testid="coding-running-model"
              >
                Running coding model:{" "}
                {state.native?.running_configuration
                  ? `${state.native.running_configuration.provider}/${state.native.running_configuration.model}${state.native.running_configuration.reasoning ? ` · ${state.native.running_configuration.reasoning}` : ""}`
                  : "Awaiting native execution configuration"}
              </p>
            )}
            {state.native?.configuration.provider && (
              <p
                className={`break-all text-muted-foreground ${state.native?.pending_user_request ? "max-sm:hidden" : ""}`}
                data-testid="coding-next-model"
              >
                Next request: {state.native.configuration.provider}/
                {state.native.configuration.model}
                {state.native.configuration.reasoning &&
                  ` · ${state.native.configuration.reasoning}`}
              </p>
            )}
            {state.native?.selection_unavailable && (
              <output
                className="block break-words"
                data-testid="coding-selection-unavailable"
              >
                Selected model unavailable: {state.native.selection_unavailable}{" "}
                History remains readable. Open the model picker to retry or
                choose a replacement.
              </output>
            )}
            {state.native?.execution_preparation && (
              <div
                data-testid="coding-local-preparation"
                className="space-y-2 break-words"
              >
                <p
                  role={
                    state.native.execution_preparation.phase === "loading"
                      ? "status"
                      : "alert"
                  }
                >
                  {state.native.execution_preparation.message ??
                    (state.native.execution_preparation.phase === "loading"
                      ? "Preparing the exact native local-model selection without evicting other workloads."
                      : "Local preparation or cleanup needs attention. No fallback was used.")}
                </p>
                {state.native.execution_preparation.retryable &&
                  ["busy", "failed"].includes(
                    state.native.execution_preparation.phase,
                  ) && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canSend || Boolean(active)}
                        onClick={() => void run?.configure({}).catch(() => {})}
                      >
                        {state.configuring
                          ? "Retrying local selection…"
                          : "Retry local selection"}
                      </Button>
                      <p className="text-muted-foreground">
                        Retry checks the same selection. Resend failed work
                        explicitly; no prompt is replayed and no idle model is
                        reserved.
                      </p>
                    </>
                  )}
              </div>
            )}
            {completion?.error && (
              <p role="alert" className="break-words text-destructive">
                {completion.error}
              </p>
            )}
            {state.error && (
              <p role="alert" className="break-words text-destructive">
                {state.error}
              </p>
            )}
            {state.storageError && (
              <p
                role="alert"
                data-testid="coding-submission-storage-error"
                className="break-words text-destructive"
              >
                {state.storageError}{" "}
                {state.unsentDraft
                  ? "Copy the retained unsent draft below before reopening. Restore browser storage before sending."
                  : "Restore browser storage and deliberately reopen before sending."}
              </p>
            )}
            {state.disconnected && (
              <output
                data-testid="coding-disconnect-banner"
                className="block break-words font-medium"
              >
                {state.reopenRequired
                  ? "Disconnected · work may still be running. The native view closed; deliberately reopen the saved conversation."
                  : "Disconnected · work may still be running. Reconnecting automatically; this warning stays until native history is rebuilt."}
              </output>
            )}
            <CodingRecoveryControls state={state} run={run} />
            {(state.reconcilingAction || state.retryStop) && (
              <output
                className="block"
                data-testid="coding-action-reconciliation"
              >
                {state.reconcilingAction
                  ? "Inspecting a fresh native view before another action; cancellation was not replayed."
                  : "Fresh native view inspected. Explicit retry targets only the same active request; cancellation is not exactly-once."}
              </output>
            )}
            {state.deliveryRecovered && !state.native?.pending_user_request && (
              <output
                className="block"
                data-testid="coding-submission-recovered"
              >
                Native prompt acceptance confirmed. Delivery recovery does not
                start a new continuation.
              </output>
            )}
            {!state.reopenRequired &&
              (state.disconnected || state.configurationUncertain) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => run?.connect()}
                >
                  Reconnect native events
                </Button>
              )}
            {state.uncertainSubmission && (
              <div
                data-testid="coding-delivery-recovery"
                data-submission-key={state.uncertainSubmission.key}
                className="space-y-2"
              >
                <p>
                  Prompt delivery is unconfirmed. The original submission
                  identity is saved; no prompt is replayed automatically.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="coding-retry-submission"
                  disabled={
                    state.connection !== "connected" ||
                    state.recovering ||
                    state.submitting ||
                    state.configuring ||
                    state.configurationUncertain ||
                    Boolean(
                      state.stopping ||
                        state.storageError ||
                        state.reconcilingAction,
                    )
                  }
                  onClick={() => void run?.retrySubmission()}
                >
                  Retry same submission
                </Button>
              </div>
            )}
          </div>
        )}
        {state?.native?.plan && (
          <PlanCard
            key={state.native.plan.id}
            plan={state.native.plan}
            state={state}
            run={run}
          />
        )}
        {state && run && <GoalSummary state={state} run={run} />}
        {/* Retain scrollable history beside the lazy child inspector when a plan expands. */}
        <div className="relative flex h-[clamp(12rem,35dvh,28rem)] min-w-0 shrink-0 gap-3">
          <section
            ref={viewport}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ overflowAnchor: "none" }}
            data-testid="coding-transcript"
            aria-label="Coding transcript"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Main reading viewport needs keyboard scrolling and jump focus.
            tabIndex={0}
            aria-busy={
              state?.connection === "loading" ||
              state?.recovering ||
              state?.loadingEarlier
            }
          >
            <div ref={transcriptContent} className="min-w-0 space-y-3">
              {state?.older && (
                <div className="text-center text-xs text-muted-foreground">
                  <p>Earlier history is not shown in this bounded view.</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    // Native disabled drops focus in Firefox during the read.
                    // Keep the control focusable, but refuse repeat activation.
                    aria-disabled={
                      state.loadingEarlier || state.connection !== "connected"
                    }
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    data-reading-control="earlier"
                    onClick={() => {
                      if (
                        state.loadingEarlier ||
                        state.connection !== "connected"
                      )
                        return;
                      reader.current?.pause();
                      void run?.loadEarlier();
                    }}
                  >
                    {state.loadingEarlier
                      ? "Loading earlier history…"
                      : "Load earlier history"}
                  </Button>
                </div>
              )}
              {state?.viewingEarlier && (
                <p className="text-center text-xs text-muted-foreground">
                  Historical reading window · live transcript updates are not
                  merged into this bounded view.
                  {state.newer &&
                    " Newer saved history is not shown; load it below or Jump to latest."}
                  {state.native?.pending_user_request
                    ? " Question controls below still reflect current native state."
                    : " Native work may still be running."}
                </p>
              )}
              <AnswerFocus.Provider value={answerFocus}>
                <ThreadPrimitive.Messages components={messageComponents} />
                {run &&
                  state?.answerForms
                    .filter(
                      (form) =>
                        !(state.viewingEarlier && form.status === "accepted") &&
                        !state.rows.some(
                          (row) =>
                            row.answer?.request_id === form.target.request_id &&
                            row.answer.user_request_id ===
                              form.target.user_request_id,
                        ),
                    )
                    .map((form) => (
                      <QuestionCard
                        key={`${form.target.request_id}:${form.target.user_request_id}`}
                        form={form}
                        run={run}
                        live={Boolean(
                          state.answerTarget &&
                            state.answerTarget.subscription ===
                              form.target.subscription &&
                            state.answerTarget.request_id ===
                              form.target.request_id &&
                            state.answerTarget.user_request_id ===
                              form.target.user_request_id,
                        )}
                        focus={
                          (reader.current?.following ?? true) &&
                          !state.viewingEarlier
                        }
                        onReleaseFocus={(questionId) => {
                          if (document.activeElement !== document.body) return;
                          answerFocus.current = questionId;
                          const answer =
                            viewport.current?.querySelector<HTMLElement>(
                              `[data-native-answer="${CSS.escape(questionId)}"]`,
                            );
                          if (answer?.isConnected) {
                            answer.focus();
                            answerFocus.current = null;
                          }
                        }}
                      />
                    ))}
              </AnswerFocus.Provider>
              {run && <ChildActivityRows view={run.childView} />}
              {state?.newer && (
                <div className="text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-reading-control="newer"
                    aria-disabled={
                      state.loadingEarlier || state.connection !== "connected"
                    }
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    onClick={() => {
                      if (
                        state.loadingEarlier ||
                        state.connection !== "connected"
                      )
                        return;
                      reader.current?.pause();
                      void run?.loadNewer();
                    }}
                  >
                    {state.loadingEarlier
                      ? "Loading history…"
                      : "Load newer history"}
                  </Button>
                </div>
              )}
            </div>
          </section>
          {run && <ChildInspector view={run.childView} />}
        </div>
        {(reading.away || state?.viewingEarlier) && (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
            {reading.newActivity && (
              <output
                aria-live="polite"
                data-testid="coding-new-activity"
                className="text-xs font-medium"
              >
                New activity
              </output>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                run?.showLatest();
                reader.current?.jump();
              }}
            >
              <ArrowDown className="size-3" aria-hidden="true" />
              Jump to latest
            </Button>
          </div>
        )}
        <section
          className="shrink-0 space-y-3"
          aria-label="Coding project and prompt"
        >
          <CodingModeControl state={state} run={run} />
          {state && run && <CodingCommandControls run={run} state={state} />}
          {state?.unsentDraft && <CodingUnsentDraft text={state.unsentDraft} />}
          <CodingComposer
            conversationId={conversationId}
            run={run}
            state={state}
            draft={draft}
            canSend={canSend}
            inputRef={promptInput}
          >
            <CodingModelPicker
              key={conversationId}
              conversationId={conversationId}
              configuration={state?.native?.configuration ?? null}
              unavailable={state?.native?.selection_unavailable ?? null}
              disabled={
                state?.connection !== "connected" ||
                Boolean(
                  state?.recovering ||
                    state?.configurationUncertain ||
                    state?.planControl ||
                    state?.goalChanging ||
                    state?.reconcilingGoal ||
                    state?.commandBusy ||
                    state?.uncertainCommand,
                )
              }
              configuring={Boolean(state?.configuring)}
              configure={(change) =>
                run
                  ? run.configure(change)
                  : Promise.reject(new Error("Choose a project first."))
              }
            />
          </CodingComposer>
          {children}
          <p
            id="coding-send-explanation"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {conversationId
              ? "Mimir owns execution, tools and saved history. Stop cancels the running native request; leaving this view does not stop work."
              : "Choose a host project folder before sending a coding prompt."}
          </p>
        </section>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
