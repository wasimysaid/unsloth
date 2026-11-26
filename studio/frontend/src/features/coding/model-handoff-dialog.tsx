// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowRight,
  ChevronDown,
  Ellipsis,
  LoaderCircle,
  Pencil,
  Shuffle,
} from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import {
  handoffBlockedReason,
  handoffContext,
  handoffContextError,
  MAX_HANDOFF_BYTES,
} from "./model-handoff";
import { ModelTargetPicker } from "./model-target-picker";
import {
  type CodingTarget,
  exactTargetName,
  friendlyModelName,
  useCodingTargets,
} from "./model-targets";
import type { CodingRunState } from "./run-session";
import { codingSession } from "./shared-session";

const utf8 = new TextEncoder();
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

/** Quiet actions under the latest finished reply or plan. */
export function ReplyMenu({ state }: { state: CodingRunState }) {
  const [handoff, setHandoff] = useState(false);
  const reason = handoffBlockedReason(state, Boolean(state.native?.info.cwd));
  return (
    <>
      {/* Non-modal: a modal menu sets pointer-events on <body> for the whole transcript. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild={true}>
          <button
            type="button"
            aria-label="More reply actions"
            title="More"
            data-testid="coding-reply-menu"
            className="mt-1 inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground pointer-coarse:size-11"
          >
            <Ellipsis className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="bottom"
          align="start"
          className="unsloth-plus-menu w-[calc(272px*var(--ui-space-scale,1))]"
        >
          <DropdownMenuItem
            disabled={Boolean(reason)}
            data-testid="coding-handoff"
            className="items-start gap-2 py-2"
            onSelect={() => setHandoff(true)}
          >
            <Shuffle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-ui-13 leading-tight">
                Hand off to another model…
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                {reason ?? "Continue in a new conversation from a brief."}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {handoff && (
        <HandoffDialog state={state} onClose={() => setHandoff(false)} />
      )}
    </>
  );
}

function HandoffDialog({
  state,
  onClose,
}: {
  state: CodingRunState;
  onClose: () => void;
}) {
  const briefId = useId();
  const native = state.native;
  const origin = native?.configuration ?? null;
  const targets = useCodingTargets(native?.info.id ?? null, origin);
  const [seed] = useState(() => handoffContext(state));
  const [brief, setBrief] = useState(seed);
  // Read first; the raw text opens only on request, or when there is nothing to read.
  const [editing, setEditing] = useState(!seed.trim());
  const [target, setTarget] = useState<CodingTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const session = useSyncExternalStore(
    codingSession.subscribe,
    codingSession.getSnapshot,
  );
  const draft = useSyncExternalStore(
    session.draft.subscribe,
    session.draft.getSnapshot,
  );
  const briefError = handoffContextError(brief);
  const unavailable =
    handoffBlockedReason(state, Boolean(native?.info.cwd)) ??
    (draft.text.trim() || draft.images.length || draft.reading.length
      ? "Send or clear your composer draft before handing off."
      : null);
  const blocked =
    unavailable ?? (!target ? "Choose the model to hand off to." : briefError);
  const bytes = utf8.encode(brief).length;
  const confirm = async () => {
    if (blocked || !target || sending) return;
    setSending(true);
    setError(null);
    const accepted = await codingSession.handoff(
      state,
      { provider: target.provider, model: target.model },
      brief,
    );
    if (accepted) {
      onClose();
      return;
    }
    setSending(false);
    setError(
      codingSession.getSnapshot().openingError ?? "The handoff did not start.",
    );
  };
  return (
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next && !sending) onClose();
      }}
    >
      <DialogContent
        className="gap-5 sm:max-w-xl"
        data-testid="coding-handoff-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          targetButton.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Hand off to another model</DialogTitle>
          <DialogDescription>
            Starts a new conversation{native?.info.cwd ? " in this project" : ""}{" "}
            from the brief below. This conversation stays as it is.
          </DialogDescription>
        </DialogHeader>
        <div
          role="group"
          aria-label="Handoff route"
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2"
        >
          <div className="grid min-w-0 gap-1">
            <span className="text-xs text-muted-foreground">From</span>
            <span
              className="flex h-9 min-w-0 items-center truncate px-0.5 text-sm text-muted-foreground"
              data-testid="coding-handoff-origin"
              title={targets.originName}
            >
              {friendlyModelName(targets.originName)}
            </span>
          </div>
          <ArrowRight
            className="mb-2.5 size-4 shrink-0 text-muted-foreground/70"
            aria-hidden="true"
          />
          <div className="grid min-w-0 gap-1">
            <span className="text-xs text-muted-foreground">To</span>
            <ModelTargetPicker
              targets={targets}
              origin={origin}
              value={target}
              onChange={(next) => {
                setTarget(next);
                setError(null);
              }}
              open={picking}
              onOpenChange={setPicking}
              includeOrigin={false}
              label="Search models to hand off to"
            >
              <button
                ref={targetButton}
                type="button"
                aria-label={
                  target
                    ? `Hand off to ${exactTargetName(target)}, change model`
                    : "Choose the model to hand off to"
                }
                data-testid="coding-handoff-target"
                title={target ? exactTargetName(target) : undefined}
                className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border/60 px-2.5 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60"
              >
                <span
                  className={`min-w-0 flex-1 truncate ${target ? "font-medium" : "text-muted-foreground"}`}
                >
                  {target ? friendlyModelName(target.name) : "Choose a model"}
                </span>
                {target && (
                  <span className="hidden max-w-[40%] shrink truncate text-xs text-muted-foreground sm:inline">
                    {target.providerName}
                  </span>
                )}
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </ModelTargetPicker>
          </div>
        </div>
        <section aria-labelledby={`${briefId}-label`} className="grid min-w-0 gap-1.5">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h3 id={`${briefId}-label`} className="text-sm font-medium">
              Brief
            </h3>
            <div className="flex items-center gap-1">
              {brief !== seed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  onClick={() => setBrief(seed)}
                >
                  Reset
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={editing}
                data-testid="coding-handoff-edit"
                className="gap-1 text-muted-foreground"
                disabled={editing && Boolean(briefError)}
                onClick={() => setEditing(!editing)}
              >
                {!editing && <Pencil className="size-3" aria-hidden="true" />}
                {editing ? "Done" : "Edit"}
              </Button>
            </div>
          </div>
          {editing ? (
            <textarea
              id={briefId}
              aria-labelledby={`${briefId}-label`}
              aria-describedby={`${briefId}-note`}
              aria-invalid={Boolean(briefError)}
              value={brief}
              autoFocus={Boolean(seed.trim())}
              placeholder="Describe what the new model should pick up."
              onChange={(event) => setBrief(event.currentTarget.value)}
              rows={12}
              className="max-h-[45dvh] min-h-48 w-full resize-y rounded-xl border border-border/60 bg-background p-3.5 text-sm leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-card"
              data-testid="coding-handoff-brief-editor"
            />
          ) : (
            <div
              id={briefId}
              aria-describedby={`${briefId}-note`}
              className="max-h-[45dvh] min-h-24 overflow-y-auto rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 dark:bg-card"
              data-testid="coding-handoff-brief"
            >
              <MarkdownPreview
                markdown={brief}
                className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed"
              />
            </div>
          )}
          <div
            id={`${briefId}-note`}
            aria-live="polite"
            className="flex items-baseline justify-between gap-3 text-xs"
          >
            <p className={briefError ? "text-destructive" : "text-muted-foreground"}>
              {briefError ??
                "The new model sees only this brief. Tool output, reasoning and images stay here."}
            </p>
            <span
              className={`shrink-0 tabular-nums ${bytes > MAX_HANDOFF_BYTES ? "text-destructive" : "text-muted-foreground/70"}`}
            >
              {kib(bytes)}
            </span>
          </div>
        </section>
        {(error ?? unavailable) && (
          <p role="alert" className="text-xs text-destructive">
            {error ?? unavailable}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={sending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={Boolean(blocked) || sending}
            title={blocked ?? undefined}
            data-testid="coding-handoff-confirm"
            onClick={() => void confirm()}
          >
            {sending && (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            )}
            {target ? `Hand off to ${friendlyModelName(target.name)}` : "Hand off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
