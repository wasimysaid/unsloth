// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComposerPrimitive, useComposerRuntime } from "@assistant-ui/react";
import {
  ArrowUp,
  AtSign,
  Bot,
  FileText,
  Folder,
  LoaderCircle,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  Target,
  X,
} from "lucide-react";
import { flushResourcesSync } from "@assistant-ui/tap";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import {
  discoverCodingFiles,
  discoverCodingSkills,
  discoverCodingSubagents,
} from "./api";
import {
  type CodingFile,
  type CodingInputDraft,
  type CodingSkill,
  type CodingSubagent,
  type DraftImage,
  type DraftMention,
  IMAGE_LIMITS,
  IMAGE_TYPES,
} from "./input";
import { MentionList, mentionOptionId } from "./mention-list";
import {
  type MentionOption,
  mentionGroups,
  mentionQuery,
  stepMention,
} from "./mention-menu";
import { pendingImageCount } from "./pending-submission";
import {
  type CodingRun,
  type CodingRunState,
  codingStopTarget,
} from "./run-session";

const LIST_ID = "coding-mention-options";
const megabytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
interface Catalog {
  skills: CodingSkill[];
  subagents: CodingSubagent[];
  files: CodingFile[];
  skillStatus: string | null;
  subagentStatus: string | null;
  fileStatus: string | null;
}
const failure = (reason: unknown, what: string) =>
  `${reason instanceof Error ? reason.message : `${what} discovery failed.`} Retry.`;

export function CodingComposer({
  conversationId,
  run,
  state,
  draft,
  canEdit,
  sendBlocked,
  inputRef,
  modelPicker,
  modeControl,
  onGoal,
  projectChooser,
}: {
  conversationId: string | null;
  run: CodingRun | null;
  state: CodingRunState | null;
  draft: CodingInputDraft;
  /** Typing is allowed whenever an owner exists; Send has its own gate. */
  canEdit: boolean;
  sendBlocked: string | null;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  modelPicker?: React.ReactNode;
  modeControl?: React.ReactNode;
  onGoal?: () => void;
  /** Landing: project selection replaces the conversation-only controls. */
  projectChooser?: React.ReactNode;
}) {
  const composer = useComposerRuntime();
  const input = inputRef;
  const files = useRef<HTMLInputElement>(null);
  const model = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [catalog, setCatalog] = useState<Catalog>({
    skills: [],
    subagents: [],
    files: [],
    skillStatus: "Select a project to discover skills.",
    subagentStatus: "Select a project to discover subagents.",
    fileStatus: null,
  });
  const [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  // Escape/selection close synchronously; a late selection event must not reopen.
  const menuOpen = useRef(false);
  const dismissed = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<DraftImage | null>(null);
  const [dragging, setDragging] = useState(false);
  const connected = state?.connection === "connected";
  const composing = useRef(false);
  // The shipped primitive suppresses composer updates during IME input. Keep
  // its controlled DOM value locally until compositionend commits it natively.
  const [compositionText, setCompositionText] = useState<string | null>(null);
  const pendingEdit = useRef<{
    text: string;
    start: number;
    end: number;
    type: string;
  } | null>(null);
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    // Capture only: publishing here would render the old controlled value before
    // assistant-ui's React onChange has accepted the browser edit.
    const before = (event: InputEvent) => {
      pendingEdit.current = {
        text: node.value,
        start: node.selectionStart,
        end: node.selectionEnd,
        type: event.inputType,
      };
    };
    node.addEventListener("beforeinput", before);
    return () => {
      node.removeEventListener("beforeinput", before);
      pendingEdit.current = null;
    };
  }, [draft]);
  // The draft can outlive a composer (a conversation created from the landing
  // takes the landing's draft over). A new, empty composer shows its text; a
  // composer that already has text is never overwritten.
  useEffect(() => {
    const { text } = draft.getSnapshot();
    if (text && !composer.getState().text) composer.setText(text);
  }, [composer, draft]);
  useEffect(() => {
    if (!conversationId || !connected) return;
    const abort = new AbortController();
    setCatalog((prior) => ({
      ...prior,
      skillStatus: "Discovering effective project skills…",
      subagentStatus: "Discovering effective subagents…",
    }));
    void Promise.allSettled([
      discoverCodingSkills(conversationId, abort.signal),
      discoverCodingSubagents(conversationId, abort.signal),
    ]).then(([skills, subagents]) => {
      if (abort.signal.aborted) return;
      setCatalog((prior) => ({
        ...prior,
        skills: skills.status === "fulfilled" ? skills.value.skills : [],
        subagents:
          subagents.status === "fulfilled" ? subagents.value.subagents : [],
        skillStatus:
          skills.status === "rejected" ? failure(skills.reason, "Skill") : null,
        subagentStatus:
          subagents.status === "rejected"
            ? failure(subagents.reason, "Subagent")
            : null,
      }));
    });
    return () => abort.abort();
  }, [conversationId, connected, refresh]);
  // A quoted reference is being typed as `@"path…`; search the path itself.
  const fileQuery = menu ? menu.query.replace(/^"/, "") : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the Retry trigger.
  useEffect(() => {
    if (!conversationId || !connected || fileQuery === null) return;
    const abort = new AbortController();
    setCatalog((prior) => ({
      ...prior,
      files: [],
      fileStatus: "Searching files…",
    }));
    const timer = setTimeout(() => {
      void discoverCodingFiles(conversationId, fileQuery, abort.signal)
        .then((result) => {
          if (abort.signal.aborted) return;
          setCatalog((prior) => ({
            ...prior,
            files: result.files,
            fileStatus: result.files.length ? null : "No matching files.",
          }));
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) return;
          setCatalog((prior) => ({
            ...prior,
            files: [],
            fileStatus: failure(reason, "File"),
          }));
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [conversationId, connected, fileQuery, refresh]);
  const mode = state?.native?.configuration.mode;
  const groups = menu ? mentionGroups(catalog, menu.query, mode) : [];
  const options = groups.flatMap((group) => group.options);
  const current = active !== null ? options[active] : undefined;
  const close = (dismiss = false) => {
    menuOpen.current = false;
    dismissed.current = dismiss ? (menu?.start ?? null) : null;
    setMenu(null);
    setActive(null);
  };
  const focus = () => requestAnimationFrame(() => input.current?.focus());
  // The shipped setText reaches the DOM on a later macrotask, which queued
  // keystrokes overtake under load; React's commit then restores their stale
  // caret. Commit text and caret before the next input event is handled.
  const commitText = (text: string, cursor: number) => {
    flushSync(() => {
      flushResourcesSync(() => composer.setText(text));
    });
    const node = input.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(cursor, cursor);
  };
  const select = (option: MentionOption) => {
    const node = input.current;
    const text = node?.value ?? composer.getState().text;
    draft.syncText(text);
    // The live token at the caret, not a possibly older rendered menu range.
    const live = node ? mentionQuery(text, node.selectionStart) : null;
    const start = live?.start ?? menu?.start ?? text.length;
    const end = live?.end ?? menu?.end ?? start;
    try {
      const next = draft.selectMention(option.choice, start, end);
      close();
      commitText(next.text, next.cursor);
    } catch (reason) {
      setErrors([reason instanceof Error ? reason.message : String(reason)]);
    }
  };
  const openAt = (query: { start: number; end: number; query: string }) => {
    menuOpen.current = true;
    setMenu(query);
    setActive(
      stepMention(
        mentionGroups(catalog, query.query, mode).flatMap((g) => g.options),
        null,
        1,
      ),
    );
  };
  const changed = (node: HTMLTextAreaElement, syncText = true) => {
    // Selection notifications can observe the previous DOM value while the
    // native composer applies setText. They must never undo a selected mention.
    if (syncText) {
      const text = node.value;
      const previous = pendingEdit.current;
      pendingEdit.current = null;
      // React batches this notification with ComposerPrimitive.Input's own
      // onChange. Never publish from a native input listener ahead of it, or
      // setText here: that can restore old text or move the browser's caret.
      if (previous && previous.text === draft.getSnapshot().text) {
        let { start, end } = previous;
        const delta = text.length - previous.text.length;
        let known =
          previous.type.startsWith("insert") ||
          previous.type.startsWith("delete");
        if (start === end && previous.type.startsWith("delete")) {
          if (previous.type.endsWith("Backward")) start += delta;
          else if (previous.type.endsWith("Forward")) end -= delta;
          else known = false;
        }
        draft.syncText(text, known ? { start, end } : undefined);
      } else {
        draft.syncText(text);
      }
    } else if (node.value !== draft.getSnapshot().text) return;
    const query = mentionQuery(node.value, node.selectionStart);
    if (!query) {
      dismissed.current = null;
      if (menuOpen.current) close();
    } else if (dismissed.current !== query.start) {
      if (
        !menuOpen.current ||
        menu?.query !== query.query ||
        menu.start !== query.start
      )
        openAt(query);
    }
  };
  const startMention = () => {
    const node = input.current;
    const text = composer.getState().text;
    const at = node?.selectionStart ?? text.length;
    const pad = at > 0 && !/\s/.test(text[at - 1]) ? " " : "";
    const next = `${text.slice(0, at)}${pad}@${text.slice(at)}`;
    draft.syncText(text);
    draft.syncText(next, { start: at, end: at });
    const start = at + pad.length;
    commitText(next, start + 1);
    dismissed.current = null;
    openAt({ start, end: start + 1, query: "" });
  };
  const attach = (selected: File[]) => {
    setErrors([]);
    void draft.attach(selected);
  };
  const busy = Boolean(state?.native?.active_request || state?.stopping);
  const blocked =
    sendBlocked ??
    (model.reading.length
      ? "Wait for attached images to finish reading."
      : null);
  const recovery = state?.uncertainSubmission ?? state?.rejectedSubmission;
  const rejected = state?.rejectedSubmission;
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative w-full min-w-0"
      aria-label="Coding composer"
      onSubmit={(event) => {
        if (blocked) event.preventDefault();
      }}
    >
      {menu && (
        <MentionList
          id={LIST_ID}
          groups={groups}
          options={options}
          active={active}
          query={menu.query}
          onSelect={select}
          onActive={setActive}
          onRetry={() => setRefresh((value) => value + 1)}
        />
      )}
      <div
        className={`unsloth-composer-surface min-w-0 ${dragging ? "ring-2 ring-primary/60" : ""}`}
        data-testid="coding-composer-surface"
        onDragOver={(event) => {
          if (!canEdit || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (!canEdit || !event.dataTransfer.files.length) return;
          event.preventDefault();
          attach(Array.from(event.dataTransfer.files));
        }}
      >
        {recovery && (
          <div
            className="mx-1 mb-2 space-y-1 rounded-2xl bg-muted/60 p-3 text-xs"
            data-testid="coding-input-recovery"
          >
            <p className="font-medium">
              {state?.uncertainSubmission
                ? "Delivery unconfirmed · these inputs are not confirmed accepted"
                : "Not sent · input retained, not accepted"}
            </p>
            <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {recovery.text}
            </p>
            <p className="text-muted-foreground">
              {recovery.skill_mentions?.length ?? 0} skill ·{" "}
              {recovery.subagent_mentions?.length ?? 0} subagent mentions ·{" "}
              {pendingImageCount(recovery)} images
            </p>
            {rejected && !state?.uncertainSubmission && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEdit}
                onClick={() => {
                  draft.restore(rejected);
                  commitText(rejected.text, rejected.text.length);
                  run?.clearRejectedSubmission();
                }}
              >
                Restore input
              </Button>
            )}
          </div>
        )}
        {(model.images.length > 0 ||
          model.reading.length > 0 ||
          model.mentions.length > 0) && (
          <div className="mx-1 mb-1 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {model.images.length > 0 && (
              <ul aria-label="Attached coding images" className="contents">
                {model.images.map((image) => (
                  <li
                    key={image.id}
                    className="flex min-w-0 max-w-full items-center gap-1 rounded-2xl bg-muted/70 p-1 pr-1.5 dark:bg-accent"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Inspect ${image.filename}`}
                      onClick={() => setPreview(image)}
                    >
                      <img
                        src={`data:${image.mime_type};base64,${image.data}`}
                        alt=""
                        className="size-9 shrink-0 rounded-xl object-cover"
                      />
                      <span className="min-w-0">
                        <span className="block max-w-36 truncate text-xs">
                          {image.filename}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {megabytes(image.bytes)}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-full"
                      aria-label={`Remove ${image.filename}`}
                      disabled={!canEdit}
                      onClick={() => {
                        draft.removeImage(image.id);
                        focus();
                      }}
                    >
                      <X className="size-3" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {model.reading.map((item) => (
              <output
                key={item.id}
                className="flex items-center gap-2 rounded-2xl bg-muted/70 px-2.5 py-2 text-xs dark:bg-accent"
              >
                <LoaderCircle
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
                Reading {item.filename} · {megabytes(item.bytes)}
              </output>
            ))}
            {model.mentions.length > 0 && (
              <ul aria-label="Selected mentions" className="contents">
                {model.mentions.map((mention) => (
                  <MentionChip
                    key={`${mention.kind}:${mention.start}`}
                    mention={mention}
                    ineligible={
                      mention.kind === "subagent" &&
                      mode === "plan" &&
                      catalog.subagents.some(
                        (agent) =>
                          agent.name === mention.name && !agent.plan_eligible,
                      )
                    }
                    disabled={!canEdit}
                    onRemove={() => {
                      const next = draft.removeMention(mention);
                      if (!next) return;
                      commitText(next.text, next.cursor);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
        {(errors.length > 0 || model.attachmentErrors.length > 0) && (
          <div
            role="alert"
            className="mx-1 mb-1 flex items-start gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <ul className="min-w-0 flex-1 space-y-0.5 break-words">
              {[...errors, ...model.attachmentErrors].map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
            <button
              type="button"
              aria-label="Dismiss attachment errors"
              className="shrink-0 rounded-full p-0.5 hover:bg-destructive/10"
              onClick={() => {
                setErrors([]);
                draft.dismissAttachmentErrors();
              }}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="unsloth-composer-line" data-expanded="true">
          <ComposerPrimitive.Input
            ref={input}
            className="aui-composer-input unsloth-composer-input disabled:cursor-not-allowed"
            aria-label="Coding prompt"
            role={menu ? "combobox" : undefined}
            aria-autocomplete={menu ? "list" : undefined}
            aria-haspopup={menu ? "listbox" : undefined}
            aria-describedby="coding-send-explanation coding-image-support"
            aria-controls={menu ? LIST_ID : undefined}
            aria-expanded={menu ? true : undefined}
            aria-activedescendant={
              menu && current
                ? mentionOptionId(LIST_ID, active ?? 0)
                : undefined
            }
            placeholder={
              conversationId
                ? "Ask Mimir to build, fix or explain…"
                : "Choose a project folder to start"
            }
            submitMode="enter"
            disabled={!canEdit}
            minRows={1}
            maxRows={10}
            addAttachmentOnPaste={false}
            cancelOnEscape={false}
            unstable_focusOnThreadSwitched={false}
            unstable_focusOnRunStart={false}
            unstable_focusOnScrollToBottom={false}
            {...(compositionText === null ? {} : { value: compositionText })}
            onChange={(event) => {
              if (
                composing.current ||
                (event.nativeEvent as InputEvent).isComposing
              ) {
                setCompositionText(event.currentTarget.value);
              } else {
                changed(event.currentTarget);
              }
            }}
            onCompositionStart={(event) => {
              composing.current = true;
              setCompositionText(event.currentTarget.value);
            }}
            onCompositionEnd={(event) => {
              composing.current = false;
              setCompositionText(null);
              changed(event.currentTarget);
            }}
            onSelect={(event) => {
              if (menuOpen.current) changed(event.currentTarget, false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (menuOpen.current) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(
                    stepMention(
                      options,
                      active,
                      event.key === "ArrowDown" ? 1 : -1,
                    ),
                  );
                  return;
                }
                if (
                  ((event.key === "Enter" && !event.shiftKey) ||
                    event.key === "Tab") &&
                  current &&
                  !current.disabled
                ) {
                  event.preventDefault();
                  select(current);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && blocked)
                event.preventDefault();
            }}
            onPaste={(event) => {
              const selected = Array.from(event.clipboardData.files);
              if (selected.length) {
                event.preventDefault();
                if (canEdit) attach(selected);
              }
            }}
          />
          <div className="unsloth-composer-left">
            {projectChooser}
            {!projectChooser && (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild={true}>
                  <button
                    type="button"
                    aria-label="Add images, mentions or a goal"
                    className="unsloth-composer-plus"
                    disabled={!canEdit}
                  >
                    <Plus
                      className="size-[calc(22px*var(--ui-space-scale,1))] stroke-[1.75px]"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  className="unsloth-plus-menu w-[calc(272px*var(--ui-space-scale,1))]"
                >
                  <DropdownMenuItem onSelect={() => files.current?.click()}>
                    <Paperclip aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block">Images</span>
                      <span className="block text-xs text-muted-foreground">
                        {IMAGE_LIMITS}
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startMention()}>
                    <AtSign aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block">Skill or subagent</span>
                      <span className="block text-xs text-muted-foreground">
                        Mention a native identity
                      </span>
                    </span>
                  </DropdownMenuItem>
                  {onGoal && (
                    <DropdownMenuItem onSelect={() => onGoal()}>
                      <Target aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block">Goal</span>
                        <span className="block text-xs text-muted-foreground">
                          Set a goal to keep pursuing
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!projectChooser && modeControl}
          </div>
          <div className="aui-composer-action-wrapper flex min-w-0 shrink items-center gap-1">
            {modelPicker}
            {busy ? (
              <Button
                type="button"
                size="icon"
                aria-label={
                  state?.stopping
                    ? "Stopping…"
                    : state?.retryStop
                      ? "Retry Stop for same request"
                      : "Stop"
                }
                title={
                  state?.stopping
                    ? "Waiting for native terminal cleanup"
                    : "Cancel this exact native request"
                }
                disabled={!codingStopTarget(state)}
                className="aui-composer-cancel ml-1 size-9 shrink-0 rounded-full"
                onClick={() => void run?.stop()}
              >
                {state?.stopping ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Square className="size-3 fill-current" aria-hidden="true" />
                )}
              </Button>
            ) : (
              <ComposerPrimitive.Send asChild={true}>
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Send"
                  title={blocked ?? "Send (Enter)"}
                  // Omit otherwise: assistant-ui's own empty/running gate applies.
                  {...(blocked ? { disabled: true } : {})}
                  aria-describedby="coding-send-explanation"
                  className="aui-composer-send ml-1 size-9 shrink-0 rounded-full"
                >
                  <ArrowUp className="size-5" aria-hidden="true" />
                </Button>
              </ComposerPrimitive.Send>
            )}
          </div>
        </div>
        <input
          ref={files}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple={true}
          className="sr-only"
          tabIndex={-1}
          aria-label="Coding image files"
          disabled={!canEdit}
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (selected.length) attach(selected);
          }}
        />
        <p id="coding-image-support" className="sr-only">
          {IMAGE_LIMITS}. The native provider must support images. Include a
          text prompt.
        </p>
        <p id="coding-send-explanation" className="sr-only">
          {blocked ??
            (conversationId
              ? "Mimir owns execution, tools and saved history. Stop cancels the running native request; leaving this view does not stop work."
              : "Choose a host project folder before sending a coding prompt.")}
        </p>
      </div>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            focus();
          }
        }}
      >
        <DialogContent>
          <DialogTitle className="break-all pr-5">
            {preview?.filename}
          </DialogTitle>
          <DialogDescription>
            Attachment preview · not confirmation of accepted visual context.
          </DialogDescription>
          {preview && (
            <img
              src={`data:${preview.mime_type};base64,${preview.data}`}
              alt={preview.filename}
              className="max-h-[60dvh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </ComposerPrimitive.Root>
  );
}

function MentionChip({
  mention,
  ineligible,
  disabled,
  onRemove,
}: {
  mention: DraftMention;
  ineligible: boolean;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [Icon, label] =
    mention.kind === "skill"
      ? [Sparkles, "Skill"]
      : mention.kind === "subagent"
        ? [Bot, "Subagent"]
        : mention.fileKind === "directory"
          ? [Folder, "Folder"]
          : [FileText, "File"];
  return (
    <li
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full py-1 pl-2.5 pr-1 text-xs ${ineligible ? "bg-destructive/10 text-destructive" : "bg-muted/70 dark:bg-accent"}`}
      title={ineligible ? "This subagent is not available in Plan mode" : label}
      data-mention-kind={mention.kind}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{mention.token}</span>
      {ineligible && <span className="shrink-0">· not in Plan</span>}
      <button
        type="button"
        className="shrink-0 rounded-full p-0.5 hover:bg-foreground/10 disabled:opacity-50"
        aria-label={`Remove mention ${mention.token}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </li>
  );
}
