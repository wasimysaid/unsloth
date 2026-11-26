// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { cn } from "@/lib/utils";
import { Bot, Sparkles } from "lucide-react";
import type { DraftMention } from "./input";
import { fileIconFor, ProjectFileIcon } from "./project-file-icons";

const ICON = "size-[0.95em] shrink-0";

function MentionIcon({ mention }: { mention: DraftMention }) {
  if (mention.kind === "file")
    return (
      <ProjectFileIcon
        path={mention.path}
        kind={mention.fileKind}
        className={ICON}
      />
    );
  const Icon = mention.kind === "skill" ? Sparkles : Bot;
  return <Icon className={ICON} strokeWidth={2} aria-hidden="true" />;
}

/** A selected mention painted over its raw token in the composer mirror.
 * Advance width equals the plain token: font, weight and spacing are
 * inherited, the `@` keeps its width while hidden, and the icon floats over
 * it. The wash grows past the text with an outline, which takes no layout. */
export function InlineMention({
  mention,
  ineligible,
}: {
  mention: DraftMention;
  ineligible: boolean;
}) {
  const at = mention.token.startsWith("@") ? 1 : 0;
  const tint = mention.kind === "file"
    ? fileIconFor(mention.path, mention.fileKind)?.color ?? "text-muted-foreground"
    : mention.kind === "skill" ? "text-teal-700 dark:text-teal-400" : "text-slate-600 dark:text-slate-400";
  return (
    <span
      data-mention-kind={mention.kind}
      data-mention-ineligible={ineligible || undefined}
      className={cn(
        "rounded-[2px] box-decoration-clone outline-1 outline-current/10 bg-current/10 dark:outline-current/15 dark:bg-current/15",
        ineligible
          ? "text-destructive underline decoration-destructive/60 decoration-wavy underline-offset-[3px]"
          : tint,
      )}
    >
      {at > 0 && (
        <span className="relative">
          <span className="invisible">@</span>
          <span className="absolute inset-0 flex items-center justify-center">
            <MentionIcon mention={mention} />
          </span>
        </span>
      )}
      <span className={ineligible ? undefined : "text-foreground/80"}>{mention.token.slice(at)}</span>
    </span>
  );
}
