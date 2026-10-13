// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ComposerPrimitive, useComposerRuntime } from "@assistant-ui/react";
import { ArrowUp, AtSign, ImagePlus, Square, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { discoverCodingSkills } from "./api";
import {
  type CodingInputDraft,
  type CodingSkill,
  type DraftImage,
  IMAGE_TYPES,
  readCodingImage,
} from "./input";
import type { CodingRun, CodingRunState } from "./run-session";

export function CodingComposer({
  conversationId,
  run,
  state,
  draft,
  canSend,
  inputRef,
}: {
  conversationId: string | null;
  run: CodingRun | null;
  state: CodingRunState | null;
  draft: CodingInputDraft;
  canSend: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const composer = useComposerRuntime();
  const input = inputRef;
  const files = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const model = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  const [skills, setSkills] = useState<CodingSkill[]>([]);
  const [skillStatus, setSkillStatus] = useState(
    "Select a project to discover skills.",
  );
  const [refresh, setRefresh] = useState(0);
  const [panel, setPanel] = useState(false);
  const panelOpen = useRef(false);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<{ start: number; end: number } | null>(
    null,
  );
  const [index, setIndex] = useState(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DraftImage | null>(null);
  const connected = state?.connection === "connected";
  useEffect(() => {
    const node = input.current;
    if (!node) return;
    let pending: {
      text: string;
      start: number;
      end: number;
      type: string;
    } | null = null;
    // Native beforeinput exposes the actual occurrence being edited, including
    // deletion/paste. React's inferred string diff cannot distinguish equal tokens.
    const before = (event: InputEvent) => {
      pending = {
        text: node.value,
        start: node.selectionStart,
        end: node.selectionEnd,
        type: event.inputType,
      };
    };
    const after = () => {
      const previous = pending;
      pending = null;
      if (!previous || previous.text !== draft.getSnapshot().text) return;
      let { start, end } = previous;
      const delta = node.value.length - previous.text.length;
      let known =
        previous.type.startsWith("insert") ||
        previous.type.startsWith("delete");
      if (start === end && previous.type.startsWith("delete")) {
        if (previous.type.endsWith("Backward")) start += delta;
        else if (previous.type.endsWith("Forward")) end -= delta;
        else known = false;
      }
      draft.syncText(node.value, known ? { start, end } : null);
    };
    node.addEventListener("beforeinput", before);
    node.addEventListener("input", after);
    return () => {
      node.removeEventListener("beforeinput", before);
      node.removeEventListener("input", after);
    };
  }, [draft]);
  useEffect(() => {
    // Focus only after deliberate panel opening, never on route mount/discovery.
    if (panel && !range) search.current?.focus();
  }, [panel, range]);
  useEffect(() => {
    if (state?.acceptedSubmissionKey) draft.clear();
  }, [state?.acceptedSubmissionKey, draft]);
  useEffect(() => {
    if (!conversationId || !connected) return;
    const abort = new AbortController();
    setSkillStatus("Discovering effective project skills…");
    void discoverCodingSkills(conversationId, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setSkills(result.skills);
        setSkillStatus(
          result.skills.length
            ? "Discovery lists metadata only; selecting a mention invokes native skill input."
            : "No skills in this project's effective native context.",
        );
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) {
          setSkills([]);
          setSkillStatus(
            reason instanceof Error
              ? reason.message
              : "Skill discovery failed. Refresh to retry.",
          );
        }
      });
    return () => abort.abort();
  }, [conversationId, connected, refresh]);
  const filtered = skills.filter((skill) =>
    `${skill.qualified_name} ${skill.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const close = () => {
    // React selection notifications can follow Escape in the same event batch.
    // Close synchronously so that an old handler cannot reopen the suggestions.
    panelOpen.current = false;
    setPanel(false);
    setRange(null);
  };
  const focus = (cursor?: number) =>
    requestAnimationFrame(() => {
      input.current?.focus();
      if (cursor !== undefined)
        input.current?.setSelectionRange(cursor, cursor);
    });
  const select = (skill: CodingSkill) => {
    const node = input.current;
    const text = composer.getState().text;
    draft.syncText(text);
    const start = range?.start ?? node?.selectionStart ?? text.length;
    const end = range?.end ?? node?.selectionEnd ?? start;
    const next = draft.selectSkill(skill, start, end);
    composer.setText(next.text);
    close();
    focus(next.cursor);
  };
  const changed = (node: HTMLTextAreaElement, syncText = true) => {
    // Selection notifications can observe the previous DOM value while the
    // native composer applies setText. They must never undo a selected mention.
    if (syncText) draft.syncText(node.value);
    else if (node.value !== draft.getSnapshot().text) return;
    const cursor = node.selectionStart;
    const match = /(?:^|\s)(@[^\s@]*)$/.exec(node.value.slice(0, cursor));
    if (match) {
      setRange({ start: cursor - match[1].length, end: cursor });
      setQuery(match[1].slice(1));
      setIndex(0);
      panelOpen.current = true;
      setPanel(true);
    } else close();
  };
  async function attach(selected: File[]) {
    setError(null);
    setReading(true);
    try {
      const images = await Promise.all(selected.map(readCodingImage));
      draft.addImages(images);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Image attachment failed.",
      );
    } finally {
      setReading(false);
      focus();
    }
  }
  const pending = state?.uncertainSubmission;
  const rejected = state?.rejectedSubmission;
  return (
    <ComposerPrimitive.Root
      className="aui-composer-root relative w-full min-w-0"
      aria-label="Coding composer"
    >
      <div className="unsloth-composer-surface min-w-0">
        {(pending || rejected) && (
          <div
            className="mb-2 rounded-xl border border-border p-3 text-xs"
            data-testid="coding-input-recovery"
          >
            <p className="font-medium">
              {pending
                ? "Delivery unconfirmed · these inputs are not confirmed accepted"
                : "Submission rejected · input retained, not accepted"}
            </p>
            <p className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words">
              {(pending ?? rejected)?.text}
            </p>
            <p>
              {(pending ?? rejected)?.skill_mentions?.length ?? 0} skill
              mentions · {(pending ?? rejected)?.images?.length ?? 0} images
            </p>
            {rejected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => {
                  draft.restore(rejected);
                  composer.setText(rejected.text);
                  run?.clearRejectedSubmission();
                  focus();
                }}
              >
                Restore rejected input
              </Button>
            )}
          </div>
        )}
        {model.images.length > 0 && (
          <ul
            aria-label="Attached coding images"
            className="mb-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto"
          >
            {model.images.map((image) => (
              <li
                key={image.id}
                className="flex min-w-0 max-w-full items-center gap-1 rounded-xl border border-border p-1"
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-w-0 gap-2 p-1"
                  aria-label={`Inspect ${image.filename}`}
                  onClick={() => setPreview(image)}
                >
                  <img
                    src={`data:${image.mime_type};base64,${image.data}`}
                    alt=""
                    className="size-10 shrink-0 rounded object-cover"
                  />
                  <span className="max-w-36 truncate text-xs">
                    {image.filename}
                  </span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${image.filename}`}
                  disabled={!canSend || reading}
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
        {model.mentions.length > 0 && (
          <p
            className="mb-2 break-all text-xs text-muted-foreground"
            aria-label="Selected skill mentions"
          >
            Skills: {model.mentions.map((mention) => mention.name).join(", ")} ·
            edit the mention to remove its association
          </p>
        )}
        <div className="flex min-w-0 items-end gap-2">
          <ComposerPrimitive.Input
            ref={input}
            className="unsloth-composer-input disabled:cursor-not-allowed"
            aria-label="Coding prompt"
            role={panel ? "combobox" : undefined}
            aria-autocomplete={panel ? "list" : undefined}
            aria-haspopup={panel ? "listbox" : undefined}
            aria-describedby="coding-send-explanation coding-image-support"
            aria-controls={panel ? "coding-skill-options" : undefined}
            aria-expanded={panel}
            aria-activedescendant={
              panel && filtered[index] ? `coding-skill-${index}` : undefined
            }
            placeholder="What would you like to build?"
            submitMode="enter"
            disabled={!canSend || reading}
            minRows={2}
            maxRows={5}
            addAttachmentOnPaste={false}
            cancelOnEscape={false}
            unstable_focusOnThreadSwitched={false}
            unstable_focusOnRunStart={false}
            unstable_focusOnScrollToBottom={false}
            onChange={(event) => changed(event.currentTarget)}
            onCompositionEnd={(event) => changed(event.currentTarget)}
            onSelect={(event) => {
              if (panelOpen.current && range)
                changed(event.currentTarget, false);
            }}
            onKeyDown={(event) => {
              if (!panelOpen.current || event.nativeEvent.isComposing) return;
              if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                setIndex(
                  (old) =>
                    (old +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      filtered.length) %
                    Math.max(1, filtered.length),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (filtered[index]) select(filtered[index]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            onPaste={(event) => {
              const selected = Array.from(event.clipboardData.files);
              if (selected.length) {
                event.preventDefault();
                if (canSend && !reading) void attach(selected);
              }
            }}
          />
          {state?.native?.active_request || state?.stopping ? (
            <Button
              type="button"
              size="icon"
              aria-label={state?.stopping ? "Stopping…" : state?.retryStop ? "Retry Stop for same request" : "Stop"}
              title={
                state?.stopping
                  ? "Waiting for native terminal cleanup"
                  : "Cancel this exact native request"
              }
              disabled={
                Boolean(state?.stopping || state?.reconcilingAction || state?.recovering) || state?.connection !== "connected"
              }
              className="mb-1 shrink-0 rounded-full"
              onClick={() => void run?.stop()}
            >
              <Square className="size-4" aria-hidden="true" />
            </Button>
          ) : (
            <ComposerPrimitive.Send asChild={true}>
              <Button
                type="submit"
                size="icon"
                aria-label="Send"
                disabled={!canSend || reading || panel}
                aria-describedby="coding-send-explanation"
                className="mb-1 shrink-0 rounded-full"
              >
                <ArrowUp className="size-5" aria-hidden="true" />
              </Button>
            </ComposerPrimitive.Send>
          )}
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canSend || reading}
            onClick={() => files.current?.click()}
          >
            <ImagePlus className="size-4" aria-hidden="true" /> Attach image
          </Button>
          <input
            ref={files}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple={true}
            className="sr-only"
            tabIndex={-1}
            aria-label="Coding image files"
            disabled={!canSend || reading}
            onChange={(event) => {
              const selected = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (selected.length) void attach(selected);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canSend}
            aria-expanded={panel}
            aria-controls="coding-skill-options"
            onClick={() => {
              if (panel) {
                close();
                focus();
              } else {
                setRange(null);
                setQuery("");
                setIndex(0);
                panelOpen.current = true;
                setPanel(true);
              }
            }}
          >
            <AtSign className="size-4" aria-hidden="true" /> Mention skill
          </Button>
          {reading && <output className="text-xs">Validating image…</output>}
        </div>
        <p
          id="coding-image-support"
          className="mt-1 text-[11px] text-muted-foreground"
        >
          PNG, JPEG, WebP, GIF · up to 4 images, 512 KiB total · native provider
          must support images. Include a text prompt.
        </p>
        {error && (
          <p role="alert" className="mt-2 break-words text-xs text-destructive">
            {error}
          </p>
        )}
        {panel && (
          <section
            className="mt-2 min-w-0 rounded-xl border border-border p-2"
            aria-label="Effective project skills"
          >
            <div className="flex min-w-0 items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2 py-1 text-sm"
                aria-label="Search project skills"
                ref={search}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    close();
                    focus();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setRefresh((old) => old + 1)}
              >
                Refresh
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Close skill mentions"
                onClick={() => {
                  close();
                  focus();
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <p
              className="my-1 break-words text-[11px] text-muted-foreground"
              role="status"
            >
              {skillStatus}
            </p>
            <div
              id="coding-skill-options"
              role="listbox"
              aria-label="Project skills"
              className="max-h-40 overflow-y-auto"
            >
              {filtered.map((skill, item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={item === index}
                  id={`coding-skill-${item}`}
                  key={skill.qualified_name}
                  onClick={() => select(skill)}
                  className="block w-full min-w-0 rounded-lg px-2 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-muted"
                >
                  <span className="block break-all text-xs font-medium">
                    {skill.qualified_name}
                  </span>
                  <span className="block break-words text-[11px] text-muted-foreground">
                    {skill.description}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
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
