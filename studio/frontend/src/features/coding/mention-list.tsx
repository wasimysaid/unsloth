// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";

export interface CompletionItem {
  id: string;
  kind: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  /** Honest reason the item cannot be chosen now. */
  disabled: string | null;
}

export const mentionOptionId = (list: string, index: number) =>
  `${list}-option-${index}`;

/** Floating combobox list above the composer. Focus stays in the prompt
 * (aria-activedescendant); pointer selection never steals it. */
export function CompletionList({
  id,
  label,
  items,
  active,
  status,
  onSelect,
  onActive,
  onRetry,
}: {
  id: string;
  label: string;
  items: readonly CompletionItem[];
  active: number | null;
  /** Shown instead of rows when nothing matches. */
  status: string;
  onSelect: (index: number) => void;
  onActive: (index: number) => void;
  onRetry?: () => void;
}) {
  useEffect(() => {
    if (active === null) return;
    document
      .getElementById(mentionOptionId(id, active))
      ?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  return (
    <div
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an aria-activedescendant combobox list; <select> cannot keep focus in the prompt.
      role="listbox"
      aria-label={label}
      data-testid="coding-mention-list"
      tabIndex={-1}
      className="absolute inset-x-0 bottom-full z-30 mb-1.5 max-h-80 space-y-0.5 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.3)] dark:bg-card"
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            key={item.id}
            id={mentionOptionId(id, index)}
            // biome-ignore lint/a11y/useSemanticElements: options of the combobox list above, not a native <select>.
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            aria-disabled={Boolean(item.disabled) || undefined}
            data-mention-kind={item.kind}
            data-mention-name={item.label}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-selected:bg-accent"
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (!item.disabled && index !== active) onActive(index);
            }}
            onClick={() => {
              if (!item.disabled) onSelect(index);
            }}
          >
            <Icon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 max-w-[55%] shrink-0 truncate font-medium">
              {item.label}
            </span>
            <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
              {item.disabled ?? item.detail}
            </span>
          </button>
        );
      })}
      {items.length === 0 && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-[13px] text-muted-foreground">
          <span className="min-w-0 flex-1">{status}</span>
          {onRetry && status.endsWith("Retry.") && (
            <button
              type="button"
              className="shrink-0 rounded-md px-1.5 text-xs font-medium text-foreground hover:bg-accent"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {items.length} {items.length === 1 ? "match" : "matches"}
      </p>
    </div>
  );
}
