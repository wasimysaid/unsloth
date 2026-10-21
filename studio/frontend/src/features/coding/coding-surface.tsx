// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { watchAnswerFocus } from "./answer-focus";
import { createCodingRunApi } from "./api";
import { ChildActivityRows, ChildInspector } from "./child-inspector";
import { CodingComposer } from "./coding-composer";
import {
  CodingCommandControls,
  CodingDiagnosticsDialog,
} from "./command-controls";
import { GoalSummary } from "./goal-summary";
import type { CodingInputDraft } from "./input";
import { CodingModelPicker } from "./model-configuration-popover";
import { CodingModeControl, PlanCard } from "./plan-card";
import { ProjectOverlapDialog } from "./project-overlap-dialog";
import { QuestionCard } from "./question-card";
import { CodingRecoveryControls } from "./recovery-controls";
import { codingRunAdapter } from "./run-runtime";
import {
  type CodingRunState,
  codingCanEdit,
  codingRunCompletion,
  codingRunLabel,
  codingSendBlockedReason,
  createCodingRun,
} from "./run-session";
import type { CodingRuntimeStatus } from "./runtime-maintenance";
import { AnswerFocus, TranscriptBlocks } from "./transcript";
import {
  createTranscriptProjection,
  transcriptWindow,
} from "./transcript-model";
import {
  type TranscriptReader,
  createTranscriptReader,
} from "./transcript-reader";
import { DisclosureMemory } from "./tool-report";
import { CodingUnsentDraft } from "./unsent-draft";

const notice =
  "rounded-2xl border border-border/60 bg-muted/40 px-3.5 py-2.5 dark:bg-card";
const alert =
  "rounded-2xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-destructive";

function StatusNotices({
  state,
  run,
  canAct,
}: {
  state: CodingRunState;
  run: ReturnType<typeof createCodingRun> | null;
  canAct: boolean;
}) {
  const completion = codingRunCompletion(state);
  const preparation = state.native?.execution_preparation;
  return (
    <>
      {state.disconnected && (
        <output
          data-testid="coding-disconnect-banner"
          className={`${notice} flex flex-wrap items-center gap-2 font-medium`}
        >
          <span className="min-w-0 flex-1">
            {state.reopenRequired
              ? "Disconnected · work may still be running. The native view closed; deliberately reopen the saved conversation."
              : "Disconnected · work may still be running. Reconnecting automatically; this stays until native history is rebuilt."}
          </span>
          {!state.reopenRequired && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => run?.connect()}
            >
              Reconnect native events
            </Button>
          )}
        </output>
      )}
      {!state.disconnected &&
        !state.reopenRequired &&
        state.configurationUncertain && (
          <div className={`${notice} flex flex-wrap items-center gap-2`}>
            <span className="min-w-0 flex-1">
              Model configuration is unconfirmed. Reconstruct the native view
              before changing it again.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => run?.connect()}
            >
              Reconnect native events
            </Button>
          </div>
        )}
      {state.native?.selection_unavailable && (
        <output
          className={`${notice} block break-words`}
          data-testid="coding-selection-unavailable"
        >
          Selected model unavailable: {state.native.selection_unavailable}{" "}
          History remains readable. Open the model picker to retry or choose a
          replacement.
        </output>
      )}
      {preparation && preparation.phase !== "loading" && (
        <div
          data-testid="coding-local-preparation"
          className={`${notice} space-y-2 break-words`}
        >
          <p role="alert">
            {preparation.message ??
              "Local preparation or cleanup needs attention. No fallback was used."}
          </p>
          {preparation.retryable &&
            ["busy", "failed"].includes(preparation.phase) && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={!canAct || Boolean(state.native?.active_request)}
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
        <p role="alert" className={`${alert} break-words`}>
          {completion.error}
        </p>
      )}
      {state.error && (
        <p role="alert" className={`${alert} break-words`}>
          {state.error}
        </p>
      )}
      {state.storageError && (
        <p
          role="alert"
          data-testid="coding-submission-storage-error"
          className={`${alert} break-words`}
        >
          {state.storageError}{" "}
          {state.unsentDraft
            ? "Copy the retained unsent draft below before reopening. Restore browser storage before sending."
            : "Restore browser storage and deliberately reopen before sending."}
        </p>
      )}
      {state.planControlError && (
        <p role="alert" className={`${alert} break-words`}>
          {state.planControlError}
        </p>
      )}
      {state.planControlNotice && (
        <output
          data-testid="coding-plan-reconciliation"
          className={`${notice} block break-words`}
        >
          {state.planControlNotice}
        </output>
      )}
      <CodingRecoveryControls state={state} run={run} />
      {(state.reconcilingAction || state.retryStop) && (
        <output
          className={`${notice} block`}
          data-testid="coding-action-reconciliation"
        >
          {state.reconcilingAction
            ? "Inspecting a fresh native view before another action; cancellation was not replayed."
            : "Fresh native view inspected. Explicit retry targets only the same active request; cancellation is not exactly-once."}
        </output>
      )}
      {state.deliveryRecovered && !state.native?.pending_user_request && (
        <output
          className={`${notice} block`}
          data-testid="coding-submission-recovered"
        >
          Native prompt acceptance confirmed. Delivery recovery does not start a
          new continuation.
        </output>
      )}
      {state.uncertainSubmission && (
        <div
          data-testid="coding-delivery-recovery"
          data-submission-key={state.uncertainSubmission.key}
          className={`${notice} flex flex-wrap items-center gap-2`}
        >
          <p className="min-w-0 flex-1">
            Prompt delivery is unconfirmed. The original submission identity is
            saved; no prompt is replayed automatically.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            data-testid="coding-retry-submission"
            disabled={
              state.connection !== "connected" ||
              state.recovering ||
              state.submitting ||
              state.configuring ||
              state.configurationUncertain ||
              Boolean(
                state.stopping || state.storageError || state.reconcilingAction,
              )
            }
            onClick={() => void run?.retrySubmission()}
          >
            Retry same submission
          </Button>
        </div>
      )}
    </>
  );
}

function RunStatus({
  state,
  onDiagnostics,
}: {
  state: CodingRunState;
  onDiagnostics: () => void;
}) {
  const active = state.native?.active_request;
  const completion = codingRunCompletion(state);
  const label = codingRunLabel(state);
  const tone =
    state.connection !== "connected" || completion?.error
      ? "bg-destructive"
      : active || state.stopping
        ? "animate-pulse bg-primary"
        : "bg-muted-foreground/50";
  const configuration = state.native?.configuration;
  const running = state.native?.running_configuration;
  return (
    <Popover>
      <PopoverTrigger asChild={true}>
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Run status: ${label}. Show run details`}
        >
          <span className={`size-1.5 shrink-0 rounded-full ${tone}`} />
          <output
            data-testid="coding-run-status"
            aria-live="polite"
            className="truncate"
          >
            {label}
          </output>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] gap-2 rounded-[21px] border border-border/60 p-4 text-xs shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-card"
        data-testid="coding-event-details"
      >
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">
          {state.connection === "connected"
            ? "Native event stream connected"
            : state.connection === "loading"
              ? "Connecting to native events…"
              : "Native event stream unavailable · lost connection does not mean work stopped"}
        </p>
        {active && (
          <p className="break-words" data-testid="coding-running-model">
            Running coding model:{" "}
            {running
              ? `${running.provider}/${running.model}${running.reasoning ? ` · ${running.reasoning}` : ""}`
              : "Awaiting native execution configuration"}
          </p>
        )}
        {configuration?.provider && (
          <p className="break-all" data-testid="coding-next-model">
            Next request: {configuration.provider}/{configuration.model}
            {configuration.reasoning && ` · ${configuration.reasoning}`}
          </p>
        )}
        <p className="text-muted-foreground">
          Leaving this view does not stop work.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="-mx-2 justify-start rounded-full text-xs"
          onClick={onDiagnostics}
        >
          Diagnostics…
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function CodingSurface({
  conversationId,
  conversationGeneration,
  runtimeStatus,
  onRuntimeLost,
  empty,
  projectChooser,
  draft,
}: {
  conversationId: string | null;
  conversationGeneration?: number;
  runtimeStatus: CodingRuntimeStatus | null;
  onRuntimeLost?: () => void;
  /** Quiet empty state shown before a project is open. */
  empty?: React.ReactNode;
  /** Landing only: contextual project selection inside the composer. */
  projectChooser?: React.ReactNode;
  /** The session-owned composer draft of this view; it may outlive the surface. */
  draft: CodingInputDraft;
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
  const [projection] = useState(createTranscriptProjection);
  const [disclosures] = useState(() => new Map<string, boolean>());
  const [goalRequested, setGoalRequested] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const landing = !conversationId && Boolean(projectChooser);
  const canEdit = landing || codingCanEdit(state, run);
  const sendBlocked = landing
    ? "Choose a project to start."
    : codingSendBlockedReason(state);
  const runtime = useExternalStoreRuntime(
    codingRunAdapter(state, run, draft, projection, canEdit),
  );
  const blocks = projection.project(state?.rows ?? [], transcriptWindow(state));
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
  const placed = new Set<string>();
  for (const block of blocks) {
    if (block.kind === "child") placed.add(block.key);
    if (block.kind === "activity")
      for (const item of block.items)
        if (item.kind === "tool" && item.child)
          placed.add(`child:${item.child.handle}:${item.child.attempt}`);
  }
  const showGoal = Boolean(
    state &&
      run &&
      (state.native?.goal ||
        goalRequested ||
        state.goalNotice ||
        state.goalChanging ||
        state.reconcilingGoal),
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
      <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-1 gap-3 px-3 sm:px-6">
          <section
            ref={viewport}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto focus-visible:outline-none"
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
            <div
              ref={transcriptContent}
              className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col gap-3 py-6"
            >
              {!conversationId && empty}
              {conversationId && !run && (
                <p role="alert" className={`${alert} break-words text-sm`}>
                  The saved conversation has no confirmed opening generation.
                  Deliberately reopen it before sending or controlling native
                  work; runtime status cannot supply its owner identity.
                </p>
              )}
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
                    className="rounded-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
                  Historical reading window · live updates are not merged into
                  this bounded view.
                  {state.newer &&
                    " Newer saved history is not shown; load it below or Jump to latest."}
                  {state.native?.pending_user_request
                    ? " Question controls below still reflect current native state."
                    : " Native work may still be running."}
                </p>
              )}
              <DisclosureMemory value={disclosures}>
                <AnswerFocus.Provider value={answerFocus}>
                  <TranscriptBlocks
                    blocks={blocks}
                    childView={run?.childView ?? null}
                  />
                  {run &&
                    state?.answerForms
                      .filter(
                        (form) =>
                          !(
                            state.viewingEarlier && form.status === "accepted"
                          ) &&
                          !state.rows.some(
                            (row) =>
                              row.answer?.request_id ===
                                form.target.request_id &&
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
                            if (document.activeElement !== document.body)
                              return;
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
                  {run && (
                    <ChildActivityRows view={run.childView} placed={placed} />
                  )}
                </AnswerFocus.Provider>
              </DisclosureMemory>
              {state?.newer && (
                <div className="text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-reading-control="newer"
                    aria-disabled={
                      state.loadingEarlier || state.connection !== "connected"
                    }
                    className="rounded-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
          {(reading.away || state?.viewingEarlier) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/60 bg-background/95 py-1 pl-3 pr-1 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-card">
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
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-full"
                  onClick={() => {
                    run?.showLatest();
                    reader.current?.jump();
                  }}
                >
                  <ArrowDown className="size-3" aria-hidden="true" />
                  Jump to latest
                </Button>
              </div>
            </div>
          )}
        </div>
        <section
          className="shrink-0 px-3 pb-3 sm:px-6"
          aria-label="Prompt and request status"
        >
          <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-2">
            {state && (
              <div
                ref={statusFocus}
                role="region"
                aria-label="Coding request status"
                tabIndex={-1}
                className="flex max-h-[30dvh] flex-col gap-2 overflow-y-auto text-xs empty:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="coding-event-status"
              >
                <StatusNotices state={state} run={run} canAct={!sendBlocked} />
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
            {showGoal && state && run && (
              <GoalSummary
                state={state}
                run={run}
                defaultOpen={goalRequested}
              />
            )}
            {state?.unsentDraft && (
              <CodingUnsentDraft text={state.unsentDraft} />
            )}
            <CodingComposer
              conversationId={conversationId}
              run={run}
              state={state}
              draft={draft}
              canEdit={canEdit}
              sendBlocked={sendBlocked}
              inputRef={promptInput}
              onGoal={run ? () => setGoalRequested(true) : undefined}
              projectChooser={landing ? projectChooser : undefined}
              modeControl={
                state?.native ? (
                  <CodingModeControl state={state} run={run} />
                ) : null
              }
              modelPicker={
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
              }
            />
            {state && run && (
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 px-1">
                <RunStatus
                  state={state}
                  onDiagnostics={() => setDiagnosticsOpen(true)}
                />
                <CodingDiagnosticsDialog
                  run={run}
                  state={state}
                  open={diagnosticsOpen}
                  onOpenChange={setDiagnosticsOpen}
                />
                <CodingCommandControls run={run} state={state} />
              </div>
            )}
          </div>
        </section>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
