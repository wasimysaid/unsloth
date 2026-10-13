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
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { codingRunApi } from "./api";
import { CodingComposer } from "./coding-composer";
import { createInputDraft } from "./input";
import { CodingModelPicker } from "./model-configuration-popover";
import { nativeMessageRow } from "./presentation";
import { codingRunAdapter } from "./run-runtime";
import {
  codingRunCompletion,
  codingRunLabel,
  createCodingRun,
} from "./run-session";
import { ToolReport } from "./tool-report";
import { CodingUnsentDraft } from "./unsent-draft";

function NativeMessage() {
  const message = useMessage();
  const row = nativeMessageRow(message);
  if (!row) return null;
  const tool = row.tool;
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
        <ToolReport key={item.id} row={item} />
      ))}
      {quiet.length > 0 && (
        <details className="rounded-xl border border-border/50 text-xs">
          <summary className="cursor-pointer rounded-xl px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {quiet.length} quiet tool{" "}
            {quiet.length === 1 ? "activity" : "activities"} · expand details
          </summary>
          <div className="space-y-2 p-3">
            {quiet.map((item) => (
              <ToolReport key={item.id} row={item} />
            ))}
          </div>
        </details>
      )}
    </>
  );
  return (
    <MessagePrimitive.Root
      className={`min-w-0 break-words ${row.kind === "user" ? "ml-auto max-w-[90%] rounded-2xl bg-muted px-4 py-3" : "w-full py-2"}`}
      data-native-entry={row.id}
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
      ) : (
        <>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            {row.kind === "user"
              ? "You"
              : row.kind === "notice"
                ? "Native activity"
                : "Mimir"}
          </p>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {row.text}
          </div>
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
  children,
}: { conversationId: string | null; children: React.ReactNode }) {
  const [run] = useState(() =>
    conversationId ? createCodingRun(conversationId, codingRunApi) : null,
  );
  const state = useSyncExternalStore(
    run?.subscribe ?? (() => () => {}),
    run?.getSnapshot ?? (() => null),
  );
  const [draft] = useState(createInputDraft);
  const runtime = useExternalStoreRuntime(codingRunAdapter(state, run, draft));
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    run?.connect();
    return () => run?.detach();
  }, [run]);
  useLayoutEffect(() => {
    if (state?.rows.length && follow.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [state?.rows]);
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
      !state.reconcilingAction,
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {state && (
          <div
            className="space-y-2 rounded-xl border border-border/60 px-3 py-2 text-xs"
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
                className="break-all font-mono text-[11px] text-muted-foreground"
                data-testid="coding-request-id"
              >
                {state.stopping || active || completion?.request_id}
              </p>
            )}
            {active && (
              <p
                className="break-all text-muted-foreground"
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
                className="break-all text-muted-foreground"
                data-testid="coding-next-model"
              >
                Next request: {state.native.configuration.provider}/
                {state.native.configuration.model}
                {state.native.configuration.reasoning &&
                  ` · ${state.native.configuration.reasoning}`}
              </p>
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
              <p
                role="status"
                data-testid="coding-disconnect-banner"
                className="break-words font-medium"
              >
                {state.reopenRequired
                  ? "Disconnected · work may still be running. The native view closed; deliberately reopen the saved conversation."
                  : "Disconnected · work may still be running. Reconnecting automatically; this warning stays until native history is rebuilt."}
              </p>
            )}
            {(state.reconcilingAction || state.retryStop) && (
              <p role="status" data-testid="coding-action-reconciliation">
                {state.reconcilingAction
                  ? "Inspecting a fresh native view before another action; cancellation was not replayed."
                  : "Fresh native view inspected. Explicit retry targets only the same active request; cancellation is not exactly-once."}
              </p>
            )}
            {state.deliveryRecovered && (
              <p role="status" data-testid="coding-submission-recovered">
                Native prompt acceptance confirmed. Delivery recovery does not
                start a new continuation.
              </p>
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
        <div
          ref={viewport}
          className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto"
          data-testid="coding-transcript"
          aria-label="Coding transcript"
          aria-busy={state?.connection === "loading" || state?.recovering}
          onScroll={() => {
            const node = viewport.current;
            if (!node) return;
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            setAway(!follow.current);
          }}
        >
          {state?.older && (
            <div className="text-center text-xs text-muted-foreground">
              <p>Earlier history is not shown in this bounded view.</p>
              <Button
                variant="ghost"
                size="sm"
                disabled={state.loadingEarlier}
                onClick={() => {
                  follow.current = false;
                  void run
                    ?.loadEarlier()
                    .then(() => viewport.current?.scrollTo({ top: 0 }));
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
              Historical page · newer messages and live activity are not shown.
              Native work may still be running.
            </p>
          )}
          <ThreadPrimitive.Messages components={messageComponents} />
        </div>
        {(away || state?.viewingEarlier) && (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            onClick={() => {
              follow.current = true;
              run?.showLatest();
              setAway(false);
              viewport.current?.scrollTo({
                top: viewport.current.scrollHeight,
              });
            }}
          >
            <ArrowDown className="size-3" aria-hidden="true" />
            Jump to latest
          </Button>
        )}
        <section
          className="shrink-0 space-y-3"
          aria-label="Coding project and prompt"
        >
          {state?.unsentDraft && <CodingUnsentDraft text={state.unsentDraft} />}
          <CodingComposer
            conversationId={conversationId}
            run={run}
            state={state}
            draft={draft}
            canSend={canSend}
          >
            <CodingModelPicker
              cwd={state?.native?.info.cwd ?? null}
              configuration={state?.native?.configuration ?? null}
              disabled={
                state?.connection !== "connected" ||
                Boolean(state?.recovering || state?.configurationUncertain)
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
