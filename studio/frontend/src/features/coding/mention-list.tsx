// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Bot, FileText, Folder, Sparkles } from "lucide-react";
import { useEffect } from "react";
import type { MentionGroup, MentionOption } from "./mention-menu";

const optionIcon = ({ choice }: MentionOption) =>
  choice.kind === "skill"
    ? Sparkles
    : choice.kind === "subagent"
      ? Bot
      : choice.file.kind === "directory"
        ? Folder
        : FileText;

export const mentionOptionId = (list: string, index: number) =>
  `${list}-option-${index}`;

/** Floating combobox list. Focus stays in the prompt (aria-activedescendant);
 * pointer selection never steals it. */
export function MentionList({
  id,
  groups,
  options,
  active,
  query,
  onSelect,
  onActive,
  onRetry,
}: {
  id: string;
  groups: MentionGroup[];
  options: MentionOption[];
  active: number | null;
  query: string;
  onSelect: (option: MentionOption) => void;
  onActive: (index: number) => void;
  onRetry: () => void;
}) {
  useEffect(() => {
    if (active === null) {
      return;
    }
    document
      .getElementById(mentionOptionId(id, active))
      ?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  const failed = groups.some((group) => group.status?.endsWith("Retry."));
  return (
    <div
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an aria-activedescendant combobox list; <select> cannot keep focus in the prompt.
      role="listbox"
      aria-label="Skills, subagents and files"
      data-testid="coding-mention-list"
      tabIndex={-1}
      className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-[min(22rem,45dvh)] overflow-y-auto overscroll-contain rounded-[21px] border border-border/60 bg-popover px-[9px] py-2 text-popover-foreground shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-card"
    >
      {groups.map((group) => {
        const heading = `${id}-${group.kind}`;
        return (
          <fieldset
            key={group.kind}
            aria-labelledby={heading}
            className="min-w-0"
          >
            <p
              id={heading}
              className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground"
            >
              {group.label}
            </p>
            {group.options.map((option) => {
              const index = options.indexOf(option);
              const Icon = optionIcon(option);
              return (
                <button
                  type="button"
                  key={option.id}
                  id={mentionOptionId(id, index)}
                  // biome-ignore lint/a11y/useSemanticElements: options of the combobox list above, not a native <select>.
                  role="option"
                  // Focus stays in the prompt; the list is aria-activedescendant driven.
                  tabIndex={-1}
                  aria-selected={index === active}
                  aria-disabled={Boolean(option.disabled) || undefined}
                  data-mention-kind={group.kind}
                  data-mention-name={option.label}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-selected:bg-accent"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (!option.disabled && index !== active) {
                      onActive(index);
                    }
                  }}
                  onClick={() => {
                    if (!option.disabled) {
                      onSelect(option);
                    }
                  }}
                >
                  <Icon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 shrink-0 truncate font-medium max-w-[60%]">
                    {option.label}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {option.disabled ?? option.description}
                  </span>
                </button>
              );
            })}
            {group.options.length === 0 && (
              <p className="px-2.5 py-1.5 text-xs text-muted-foreground">
                {group.status ??
                  (query
                    ? `No ${group.label.toLowerCase()} match “${query}”.`
                    : `No ${group.label.toLowerCase()} in this project.`)}
              </p>
            )}
          </fieldset>
        );
      })}
      {failed && (
        <button
          type="button"
          className="mx-2.5 mt-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
          onClick={onRetry}
        >
          Retry discovery
        </button>
      )}
      <p className="sr-only" aria-live="polite">
        {options.length} {options.length === 1 ? "match" : "matches"}
      </p>
    </div>
  );
}
