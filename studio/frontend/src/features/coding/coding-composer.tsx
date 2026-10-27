// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNativeFileDrop } from "@/features/native-intents";
import { ComposerPrimitive, useComposerRuntime } from "@assistant-ui/react";
import { flushResourcesSync } from "@assistant-ui/tap";
import {
  ArrowUp,
  Bot,
  Command,
  FileText,
  Folder,
  LoaderCircle,
  Paperclip,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import {
  discoverCodingFiles,
  discoverCodingSkills,
  discoverCodingSubagents,
} from "./api";
import { LOCAL_COMMANDS, parseCodingCommand } from "./command-types";
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
import { type CompletionItem, CompletionList, mentionOptionId } from "./mention-list";
import {
  type CommandOption,
  type MentionOption,
  commandItems,
  commandQuery,
  mentionGroups,
  mentionItems,
  mentionQuery,
  mentionStatus,
  stepMention,
} from "./mention-menu";
import { pendingImageCount } from "./pending-submission";
import { runLocalCommand } from "./run-runtime";
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
  skillStatus: string | null;
  subagentStatus: string | null;
}
const failure = (reason: unknown, what: string) =>
  `${reason instanceof Error ? reason.message : `${what} discovery failed.`} Retry.`;
type Menu = {
  kind: "mention" | "command";
  start: number;
  end: number;
  query: string;
};
const parent = (path: string) => {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
};
const leaf = (path: string) =>
  path.replace(/\/+$/, "").split("/").pop() || path;

function mentionItem(option: MentionOption): CompletionItem {
  const { choice } = option;
  if (choice.kind === "file")
    return {
      id: option.id,
      kind: "file",
      icon: choice.file.kind === "directory" ? Folder : FileText,
      label: leaf(choice.file.path),
      detail: parent(choice.file.path),
      disabled: option.disabled,
    };
  return {
    id: option.id,
    kind: choice.kind,
    icon: choice.kind === "skill" ? Sparkles : Bot,
    label: option.label,
    detail: option.description,
    disabled: option.disabled,
  };
}
const commandItem = (option: CommandOption): CompletionItem => ({
  id: option.id,
  kind: "command",
  icon: Command,
  label: option.label,
  detail: option.description,
  disabled: option.disabled,
});

export function CodingComposer({
  conversationId,
  run,
  state,
  draft,
  canEdit,
  sendBlocked,
  inputRef,
  modelPicker,
  onStart,
  starting = false,
  autoSend = false,
  onAutoSent,
  footer,
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
  /** New conversation: Send creates it in the chosen folder first. */
  onStart?: () => void;
  starting?: boolean;
  /** Send the carried new-conversation draft once this owner accepts it. */
  autoSend?: boolean;
  onAutoSent?: () => void;
  footer?: React.ReactNode;
}) {
  const composer = useComposerRuntime();
  const input = inputRef;
  const files = useRef<HTMLInputElement>(null);
  const model = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [catalog, setCatalog] = useState<Catalog>({
    skills: [],
    subagents: [],
    skillStatus: null,
    subagentStatus: null,
  });
  const [found, setFound] = useState<{
    query: string;
    files: CodingFile[];
    error: string | null;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  // Escape/selection close synchronously; a late selection event must not reopen.
  const menuOpen = useRef(false);
  const dismissed = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<DraftImage | null>(null);
  const connected = state?.connection === "connected";
  const landing = Boolean(onStart);
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
  // The first message typed before the conversation existed is sent exactly
  // once, through the ordinary Send path, when this owner can accept it.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoSend || autoSent.current || !connected || sendBlocked) return;
    if (model.reading.length) return;
    autoSent.current = true;
    onAutoSent?.();
    if (composer.getState().text.trim()) composer.send();
  }, [
    autoSend,
    connected,
    sendBlocked,
    model.reading.length,
    composer,
    onAutoSent,
  ]);
  useEffect(() => {
    if (!conversationId || !connected) return;
    const abort = new AbortController();
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
  const fileQuery =
    menu?.kind === "mention" ? menu.query.replace(/^"/, "") : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the Retry trigger.
  useEffect(() => {
    if (!conversationId || !connected || fileQuery === null) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void discoverCodingFiles(conversationId, fileQuery, abort.signal)
        .then((result) => {
          if (abort.signal.aborted) return;
          setFound({ query: fileQuery, files: result.files, error: null });
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) return;
          setFound({
            query: fileQuery,
            files: [],
            error: failure(reason, "File"),
          });
        });
    }, 80);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [conversationId, connected, fileQuery, refresh]);
  const mode = state?.native?.configuration.mode;
  const busy = Boolean(state?.native?.active_request || state?.stopping);
  const commands = [
    ...(state?.commands ?? []),
    ...LOCAL_COMMANDS.filter(
      (local) =>
        !state?.commands?.some(
          (native) =>
            native.name === local.name || native.aliases.includes(local.name),
        ),
    ),
  ];
  // Earlier results stay visible while the next query is searched.
  const fileCatalog = {
    ...catalog,
    files: found?.files ?? [],
    fileStatus:
      found?.query === fileQuery && found
        ? found.error
        : fileQuery === null
          ? null
          : "Searching…",
  };
  const groups =
    menu?.kind === "mention"
      ? mentionGroups(fileCatalog, menu.query, mode)
      : [];
  const mentions = menu?.kind === "mention" ? mentionItems(groups, menu.query) : [];
  const commandOptions =
    menu?.kind === "command" ? commandItems(commands, menu.query, busy) : [];
  const items: CompletionItem[] =
    menu?.kind === "mention"
      ? mentions.map(mentionItem)
      : commandOptions.map(commandItem);
  const status =
    menu?.kind === "mention"
      ? mentionStatus(groups, menu.query)
      : state?.discoveringCommands && !state.commands
        ? "Loading commands…"
        : (state?.commandError ?? "No matching commands");
  const current = active !== null ? items[active] : undefined;
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
  const selectMention = (option: MentionOption) => {
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
  const selectCommand = (option: CommandOption) => {
    const node = input.current;
    const text = node?.value ?? composer.getState().text;
    const live = node ? commandQuery(text, node.selectionStart) : null;
    const start = live?.start ?? menu?.start ?? 0;
    const end = live?.end ?? menu?.end ?? text.length;
    const token = `/${option.name} `;
    const next = `${text.slice(0, start)}${token}${text.slice(end).replace(/^\s+/, "")}`;
    draft.syncText(text);
    draft.syncText(next, { start, end });
    close(true);
    commitText(next, start + token.length);
  };
  const select = (index: number) => {
    if (menu?.kind === "mention" && mentions[index])
      selectMention(mentions[index]);
    else if (menu?.kind === "command" && commandOptions[index])
      selectCommand(commandOptions[index]);
  };
  const openAt = (next: Menu) => {
    menuOpen.current = true;
    setMenu(next);
    if (next.kind === "command" && run && !state?.commands)
      void run.discoverCommands();
    setActive(
      stepMention(
        next.kind === "mention"
          ? mentionItems(
              mentionGroups(fileCatalog, next.query, mode),
              next.query,
            )
          : commandItems(commands, next.query, busy),
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
    // Mentions and commands need a live conversation; a new one has neither.
    const mention = conversationId
      ? mentionQuery(node.value, node.selectionStart)
      : null;
    const command = run ? commandQuery(node.value, node.selectionStart) : null;
    const query: Menu | null = mention
      ? { kind: "mention", ...mention }
      : command
        ? { kind: "command", ...command }
        : null;
    if (!query) {
      dismissed.current = null;
      if (menuOpen.current) close();
    } else if (dismissed.current !== query.start) {
      if (
        !menuOpen.current ||
        menu?.kind !== query.kind ||
        menu.query !== query.query ||
        menu.start !== query.start
      )
        openAt(query);
    }
  };
  // The shipped composer will not send while a request runs, but a command can:
  // native admission decides whether it runs now (an idle-only one is refused).
  const commandWhileBusy = () => {
    const text = input.current?.value ?? composer.getState().text;
    if (!run || !busy || !parseCodingCommand(text)) return false;
    commitText("", 0);
    draft.syncText("");
    void runLocalCommand(run, text)
      .then((local) => (local ? undefined : run.send(text)))
      .catch((reason: unknown) => run.retainUnsent({ text }, reason));
    return true;
  };
  const attach = (selected: File[]) => {
    setErrors([]);
    void draft.attach(selected);
  };
  // Web drops and the desktop app's native drops land in the same draft.
  const {
    ref: dropRef,
    dragging,
    dragHandlers,
  } = useNativeFileDrop({
    onFiles: attach,
    accept: ".png,.jpg,.jpeg,.webp,.gif",
    disabled: !canEdit,
  });
  const blocked =
    sendBlocked ??
    (model.reading.length
      ? "Wait for attached images to finish reading."
      : null);
  const recovery = state?.uncertainSubmission ?? state?.rejectedSubmission;
  const rejected = state?.rejectedSubmission;
  const expanded =
    landing || model.text.includes("\n") || model.text.length > 72;
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative w-full min-w-0"
      aria-label="Coding composer"
      onSubmit={(event) => {
        if (blocked || landing) event.preventDefault();
      }}
    >
      {menu && (
        <CompletionList
          id={LIST_ID}
          label={menu.kind === "mention" ? "Mentions" : "Commands"}
          items={items}
          active={active}
          status={status}
          onSelect={select}
          onActive={setActive}
          onRetry={() =>
            menu.kind === "mention"
              ? setRefresh((value) => value + 1)
              : void run?.discoverCommands()
          }
        />
      )}
      <div
        ref={dropRef}
        className={`unsloth-composer-surface min-w-0 ${dragging ? "ring-2 ring-primary/60" : ""}`}
        data-testid="coding-composer-surface"
        {...dragHandlers}
      >
        {recovery && (
          <div
            className="mx-1 mb-2 space-y-1 rounded-2xl bg-muted/60 p-3 text-xs"
            data-testid="coding-input-recovery"
          >
            <p className="font-medium">
              {state?.uncertainSubmission
                ? "Delivery unconfirmed"
                : "Not sent"}
            </p>
            <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {recovery.text}
            </p>
            {(recovery.skill_mentions?.length ||
              recovery.subagent_mentions?.length ||
              pendingImageCount(recovery) > 0) && (
              <p className="text-muted-foreground">
                {recovery.skill_mentions?.length ?? 0} skills ·{" "}
                {recovery.subagent_mentions?.length ?? 0} agents ·{" "}
                {pendingImageCount(recovery)} images
              </p>
            )}
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
              <ul aria-label="Attached images" className="contents">
                {model.images.map((image) => (
                  <li
                    key={image.id}
                    className="flex min-w-0 max-w-full items-center gap-1 rounded-xl bg-muted/70 p-1 pr-1.5 dark:bg-accent"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Inspect ${image.filename}`}
                      onClick={() => setPreview(image)}
                    >
                      <img
                        src={`data:${image.mime_type};base64,${image.data}`}
                        alt=""
                        className="size-8 shrink-0 rounded-lg object-cover"
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
                    <button
                      type="button"
                      className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                      aria-label={`Remove ${image.filename}`}
                      disabled={!canEdit}
                      onClick={() => {
                        draft.removeImage(image.id);
                        focus();
                      }}
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {model.reading.map((item) => (
              <output
                key={item.id}
                className="flex items-center gap-2 rounded-xl bg-muted/70 px-2.5 py-2 text-xs dark:bg-accent"
              >
                <LoaderCircle
                  className="size-3.5 animate-spin"
                  aria-hidden="true"
                />
                Reading {item.filename}
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
            className="mx-1 mb-1 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
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
        <div
          className="unsloth-composer-line"
          data-expanded={expanded ? "true" : "false"}
        >
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
              menu && current ? mentionOptionId(LIST_ID, active ?? 0) : undefined
            }
            placeholder="Do anything…"
            submitMode={landing ? "none" : "enter"}
            disabled={!canEdit}
            minRows={landing ? 2 : 1}
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
                      items,
                      active,
                      event.key === "ArrowDown" ? 1 : -1,
                    ),
                  );
                  return;
                }
                // A command typed out in full runs on Enter; Tab completes.
                const typed =
                  menu?.kind === "command" &&
                  current?.label === `/${menu.query}` &&
                  event.key === "Enter";
                if (
                  ((event.key === "Enter" && !event.shiftKey) ||
                    event.key === "Tab") &&
                  current &&
                  !current.disabled &&
                  !typed
                ) {
                  event.preventDefault();
                  select(active ?? 0);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  close(true);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                if (blocked) event.preventDefault();
                else if (commandWhileBusy()) event.preventDefault();
                else if (landing) {
                  event.preventDefault();
                  if (!starting && model.text.trim()) onStart?.();
                }
              }
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
            <button
              type="button"
              aria-label="Attach images"
              title={IMAGE_LIMITS}
              className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={!canEdit}
              onClick={() => files.current?.click()}
            >
              <Paperclip className="size-4.5" aria-hidden="true" />
            </button>
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
                title={state?.stopping ? "Stopping" : "Stop"}
                disabled={!codingStopTarget(state)}
                className="aui-composer-cancel ml-1 size-8 shrink-0 rounded-full"
                onClick={() => void run?.stop()}
              >
                {state?.stopping ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Square
                    className="size-2.5 fill-current"
                    aria-hidden="true"
                  />
                )}
              </Button>
            ) : landing ? (
              <Button
                type="button"
                size="icon"
                aria-label="Send"
                title={blocked ?? "Send (Enter)"}
                disabled={Boolean(blocked) || starting || !model.text.trim()}
                aria-describedby="coding-send-explanation"
                className="aui-composer-send ml-1 size-8 shrink-0 rounded-full"
                onClick={() => onStart?.()}
              >
                {starting ? (
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-label="Starting conversation"
                  />
                ) : (
                  <ArrowUp className="size-4" aria-hidden="true" />
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
                  className="aui-composer-send ml-1 size-8 shrink-0 rounded-full"
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
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
          aria-label="Image files"
          disabled={!canEdit}
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (selected.length) attach(selected);
          }}
        />
        <p id="coding-image-support" className="sr-only">
          {IMAGE_LIMITS}. The model must support images.
        </p>
        <p id="coding-send-explanation" className="sr-only">
          {blocked ??
            (conversationId
              ? "Enter sends. Type / for commands and @ to mention files, skills or agents. Leaving this view does not stop work."
              : "Enter starts a new conversation in the chosen folder.")}
        </p>
      </div>
      {footer}
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
          <DialogDescription>Attachment preview</DialogDescription>
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
        ? [Bot, "Agent"]
        : mention.fileKind === "directory"
          ? [Folder, "Folder"]
          : [FileText, "File"];
  return (
    <li
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-lg py-1 pl-2 pr-1 text-xs ${ineligible ? "bg-destructive/10 text-destructive" : "bg-muted/70 dark:bg-accent"}`}
      title={ineligible ? "Not available in plan mode" : label}
      data-mention-kind={mention.kind}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{mention.token}</span>
      {ineligible && <span className="shrink-0">· not in plan mode</span>}
      <button
        type="button"
        className="shrink-0 rounded-full p-0.5 hover:bg-accent disabled:opacity-50"
        aria-label={`Remove mention ${mention.token}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </li>
  );
}
