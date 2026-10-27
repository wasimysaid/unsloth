// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
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
import { codingModelApi, createCodingRunApi } from "./api";
import { ChildInspector } from "./child-inspector";
import { CodingComposer } from "./coding-composer";
import { CommandFeedback, ComposerFooter } from "./composer-footer";
import { GoalSummary } from "./goal-summary";
import type { CodingInputDraft } from "./input";
import { CodingModelPicker } from "./model-configuration-popover";
import type { CodingConfiguration } from "./model-selection";
import { PlanCard } from "./plan-card";
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
import { ChildActivityRows } from "./subagent-card";
import { DisclosureMemory } from "./tool-report";
import { AnswerFocus, TranscriptBlocks, WorkingLine } from "./transcript";
import {
  createTranscriptProjection,
  transcriptWindow,
} from "./transcript-model";
import {
  type TranscriptReader,
  createTranscriptReader,
} from "./transcript-reader";
import { CodingUnsentDraft } from "./unsent-draft";

const notice = "rounded-xl border border-border/60 bg-muted/40 px-3 py-2";
const alert =
  "rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive";

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
          className={`${notice} flex flex-wrap items-center gap-2`}
        >
          <span className="min-w-0 flex-1">
            {state.reopenRequired
              ? "Disconnected · work may still be running. Reopen this conversation from the sidebar."
              : "Disconnected · work may still be running. Reconnecting…"}
          </span>
          {!state.reopenRequired && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-full"
              onClick={() => run?.connect()}
            >
              Reconnect
            </Button>
          )}
        </output>
      )}
      {!state.disconnected &&
        !state.reopenRequired &&
        state.configurationUncertain && (
          <div className={`${notice} flex flex-wrap items-center gap-2`}>
            <span className="min-w-0 flex-1">
              The model change wasn't confirmed.
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-full"
              onClick={() => run?.connect()}
            >
              Reconnect
            </Button>
          </div>
        )}
      {state.native?.selection_unavailable && (
        <output
          className={`${notice} block break-words`}
          data-testid="coding-selection-unavailable"
        >
          Model unavailable: {state.native.selection_unavailable}. Choose
          another model.
        </output>
      )}
      {preparation && preparation.phase !== "loading" && (
        <div
          data-testid="coding-local-preparation"
          className={`${notice} flex flex-wrap items-center gap-2 break-words`}
        >
          <p role="alert" className="min-w-0 flex-1">
            {preparation.message ?? "The local model needs attention."}
          </p>
          {preparation.retryable &&
            ["busy", "failed"].includes(preparation.phase) && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-full"
                disabled={!canAct || Boolean(state.native?.active_request)}
                onClick={() => void run?.configure({}).catch(() => {})}
              >
                {state.configuring ? "Retrying…" : "Retry"}
              </Button>
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
          {state.storageError}
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
            ? "Checking whether Stop took effect…"
            : "Stop may not have taken effect. Press Stop again to retry it."}
        </output>
      )}
      {state.uncertainSubmission && (
        <div
          data-testid="coding-delivery-recovery"
          data-submission-key={state.uncertainSubmission.key}
          className={`${notice} flex flex-wrap items-center gap-2`}
        >
          <p className="min-w-0 flex-1">
            Your last message may not have been delivered.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-full"
            data-testid="coding-retry-submission"
            disabled={
              state.connection !== "connected" ||
              state.submitting ||
              state.configuring ||
              state.configurationUncertain ||
              Boolean(
                state.stopping || state.storageError || state.reconcilingAction,
              )
            }
            onClick={() => void run?.retrySubmission()}
          >
            Retry
          </Button>
        </div>
      )}
    </>
  );
}

export interface CodingLanding {
  /** Folder chip above the composer. */
  project: React.ReactNode;
  /** Model chip for the first request. */
  modelPicker: React.ReactNode;
  onStart: () => void;
  starting: boolean;
  blocked: string | null;
}

export function CodingSurface({
  conversationId,
  conversationGeneration,
  cwd,
  runtimeStatus,
  onRuntimeLost,
  draft,
  landing,
  autoSend = false,
  onAutoSent,
  onConfigured,
}: {
  conversationId: string | null;
  conversationGeneration?: number;
  cwd?: string | null;
  runtimeStatus: CodingRuntimeStatus | null;
  onRuntimeLost?: () => void;
  /** The session-owned composer draft of this view; it may outlive the surface. */
  draft: CodingInputDraft;
  /** No conversation yet: choose folder and model, then Send creates one. */
  landing?: CodingLanding | null;
  autoSend?: boolean;
  onAutoSent?: () => void;
  /** A confirmed model change, remembered for the next new conversation. */
  onConfigured?: (configuration: CodingConfiguration) => void;
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
  const isLanding = !conversationId && Boolean(landing);
  const canEdit = isLanding
    ? !landing?.starting
    : codingCanEdit(state, run);
  const sendBlocked = isLanding
    ? (landing?.blocked ?? null)
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
        state.goalNotice ||
        state.goalChanging ||
        state.reconcilingGoal),
  );
  // The live tail already shows activity; otherwise a quiet working line does.
  const tail = blocks.at(-1);
  const tailStreaming =
    (tail?.kind === "activity" && tail.live) ||
    (tail?.kind === "prose" && tail.live);
  const configuration = state?.native?.configuration ?? null;
  const modelPicker = isLanding ? (
    landing?.modelPicker
  ) : conversationId ? (
    <CodingModelPicker
      key={conversationId}
      readCatalog={(refresh, signal) =>
        refresh
          ? codingModelApi.refresh(conversationId, signal)
          : codingModelApi.catalog(conversationId, signal)
      }
      configuration={configuration}
      unavailable={state?.native?.selection_unavailable ?? null}
      disabled={
        state?.connection !== "connected" ||
        Boolean(
          state?.configurationUncertain ||
            state?.planControl ||
            state?.goalChanging ||
            state?.reconcilingGoal ||
            state?.commandBusy ||
            state?.uncertainCommand,
        )
      }
      configuring={Boolean(state?.configuring)}
      configure={async (change) => {
        if (!run) throw new Error("This conversation is not connected.");
        const accepted = await run.configure(change);
        if (accepted?.provider && accepted.model) onConfigured?.(accepted);
      }}
    />
  ) : null;
  const composer = (
    <CodingComposer
      conversationId={conversationId}
      run={run}
      state={state}
      draft={draft}
      canEdit={canEdit}
      sendBlocked={sendBlocked}
      inputRef={promptInput}
      modelPicker={modelPicker}
      onStart={isLanding ? landing?.onStart : undefined}
      starting={Boolean(landing?.starting)}
      autoSend={autoSend}
      onAutoSent={onAutoSent}
      footer={
        isLanding ? null : (
          <ComposerFooter cwd={cwd ?? null} state={state} run={run} />
        )
      }
    />
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ProjectOverlapDialog
        overlap={state?.overlapWarning?.overlap ?? null}
        disabled={Boolean(
          !state ||
            state.connection !== "connected" ||
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
        {isLanding ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-3 pb-[12dvh] sm:px-6">
            <div className="flex w-full max-w-3xl flex-col gap-2">
              <h1 className="mb-4 text-center font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                What should we build?
              </h1>
              <div className="flex min-w-0 justify-end px-1">
                {landing?.project}
              </div>
              {composer}
            </div>
          </div>
        ) : (
          <>
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
                  state?.connection === "loading" || state?.loadingEarlier
                }
              >
                <div
                  ref={transcriptContent}
                  className="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col gap-3 py-6"
                >
                  {conversationId && !run && (
                    <p role="alert" className={`${alert} break-words text-sm`}>
                      This conversation needs to be reopened from the sidebar.
                    </p>
                  )}
                  {state?.older && (
                    <div className="text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        // Native disabled drops focus in Firefox during the read.
                        // Keep the control focusable, but refuse repeat activation.
                        aria-disabled={
                          state.loadingEarlier ||
                          state.connection !== "connected"
                        }
                        className="rounded-full text-xs text-muted-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
                          ? "Loading earlier messages…"
                          : "Load earlier messages"}
                      </Button>
                    </div>
                  )}
                  {state?.viewingEarlier && (
                    <p className="text-center text-xs text-muted-foreground">
                      Viewing earlier messages
                      {state.native?.active_request
                        ? " · work is still running"
                        : ""}
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
                                state.viewingEarlier &&
                                form.status === "accepted"
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
                        <ChildActivityRows
                          view={run.childView}
                          placed={placed}
                        />
                      )}
                    </AnswerFocus.Provider>
                  </DisclosureMemory>
                  {state?.native?.active_request &&
                    !state.viewingEarlier &&
                    !state.native.pending_user_request && (
                      // Mounted for the whole request so its timer is stable.
                      <WorkingLine
                        key={state.native.active_request}
                        hidden={tailStreaming}
                      />
                    )}
                  {state?.newer && (
                    <div className="text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-reading-control="newer"
                        aria-disabled={
                          state.loadingEarlier ||
                          state.connection !== "connected"
                        }
                        className="rounded-full text-xs text-muted-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
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
                          ? "Loading…"
                          : "Load newer messages"}
                      </Button>
                    </div>
                  )}
                </div>
              </section>
              {run && <ChildInspector view={run.childView} />}
              {(reading.away || state?.viewingEarlier) && (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    className="pointer-events-auto h-7 gap-1.5 rounded-full bg-background/95 text-xs shadow-sm dark:bg-card"
                    onClick={() => {
                      run?.showLatest();
                      reader.current?.jump();
                    }}
                  >
                    <ArrowDown className="size-3" aria-hidden="true" />
                    {reading.newActivity ? (
                      <output aria-live="polite" data-testid="coding-new-activity">
                        New activity
                      </output>
                    ) : (
                      "Jump to latest"
                    )}
                  </Button>
                </div>
              )}
            </div>
            <section
              className="shrink-0 px-3 pb-2 sm:px-6"
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
                    <StatusNotices
                      state={state}
                      run={run}
                      canAct={!sendBlocked}
                    />
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
                  <GoalSummary state={state} run={run} />
                )}
                {state && run && <CommandFeedback state={state} run={run} />}
                {state?.unsentDraft && (
                  <CodingUnsentDraft text={state.unsentDraft} />
                )}
                {composer}
                {state && (
                  <output
                    data-testid="coding-run-status"
                    aria-live="polite"
                    className="sr-only"
                  >
                    {codingRunLabel(state)}
                  </output>
                )}
              </div>
            </section>
          </>
        )}
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
