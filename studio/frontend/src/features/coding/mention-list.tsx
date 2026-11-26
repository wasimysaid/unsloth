// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { AtSign, LoaderCircle, type LucideIcon } from "lucide-react";
import { Fragment, useEffect } from "react";
import type { CodingFile } from "./input";
import type { MentionCategory } from "./mention-menu";
import { ProjectFileIcon } from "./project-file-icons";

export interface CompletionItem {
  id: string;
  kind: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  /** Honest reason the item cannot be chosen now. */
  disabled: string | null;
  /** File rows: draws the file-type icon and treats `detail` as a folder path. */
  path?: string;
  fileKind?: CodingFile["kind"];
}

export const mentionOptionId = (list: string, index: number) =>
  `${list}-option-${index}`;

const HEADINGS: Record<string, string> = {
  all: "All",
  file: "Files",
  skill: "Skills",
  subagent: "Agents",
  command: "Commands",
};

/** Consecutive runs of one kind. Headed only when the list is several runs of
 * distinct kinds; an interleaved ranking stays one flat list. */
function sections(items: readonly CompletionItem[]) {
  const runs: { kind: string; start: number; items: CompletionItem[] }[] = [];
  items.forEach((item, index) => {
    const last = runs.at(-1);
    if (last?.kind === item.kind) last.items.push(item);
    else runs.push({ kind: item.kind, start: index, items: [item] });
  });
  const kinds = new Set(runs.map((run) => run.kind));
  const headed = runs.length > 1 && kinds.size === runs.length;
  return { runs, headed };
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query
    ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground">
        {text.slice(at, at + query.length)}
      </mark>
      {text.slice(at + query.length)}
    </>
  );
}

function ItemIcon({ item }: { item: CompletionItem }) {
  if (item.path !== undefined)
    return <ProjectFileIcon path={item.path} kind={item.fileKind} />;
  const Icon = item.icon;
  return (
    <Icon
      className="size-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
    />
  );
}

/** Floating combobox list above the composer, start-aligned. Focus stays in
 * the prompt (aria-activedescendant); pointer selection never steals it. */
export function CompletionList({
  id,
  label,
  items,
  active,
  status,
  query = "",
  filter,
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
  /** Typed text, emphasised where it occurs in each label. */
  query?: string;
  filter?: {
    value: MentionCategory;
    search: (query: string) => void;
    onSearchKey: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    leaveSearch: (next: EventTarget | null) => void;
    select: (value: MentionCategory) => void;
    tabs: { kind: MentionCategory; count: number; more: boolean }[];
  };
  onSelect: (index: number) => void;
  onActive: (index: number) => void;
  onRetry?: () => void;
}) {
  const { runs, headed } = sections(items);
  useEffect(() => {
    if (active === null) return;
    const option = document.getElementById(mentionOptionId(id, active));
    // A section's first row brings its heading along.
    const heading = option?.previousElementSibling;
    if (heading instanceof HTMLElement && heading.dataset.heading)
      heading.scrollIntoView({ block: "nearest" });
    option?.scrollIntoView({ block: "nearest" });
  }, [id, active]);
  const failed = status.endsWith("Retry.");
  const pending = !failed && status.endsWith("…");
  const row = (item: CompletionItem, index: number) => {
    const selected = index === active;
    return (
      <button
        type="button"
        key={item.id}
        id={mentionOptionId(id, index)}
        // biome-ignore lint/a11y/useSemanticElements: options of the combobox list above, not a native <select>.
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={Boolean(item.disabled) || undefined}
        data-highlighted={selected || undefined}
        data-mention-kind={item.kind}
        data-mention-name={item.label}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-ui-13 leading-5 text-foreground/90 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-selected:bg-accent aria-selected:text-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (!item.disabled && !selected) onActive(index);
        }}
        onClick={() => {
          if (!item.disabled) onSelect(index);
        }}
      >
        <ItemIcon item={item} />
        <span className="min-w-0 max-w-[60%] shrink-0 truncate">
          <Highlight text={item.label} query={query} />
        </span>
        {item.disabled ? (
          <span className="min-w-0 flex-1 truncate text-ui-12 text-muted-foreground">
            {item.disabled}
          </span>
        ) : item.path !== undefined ? (
          // Long folders lose their start, keeping the nearest parents readable.
          <span
            dir="rtl"
            className="min-w-0 flex-1 truncate text-left text-ui-12 text-muted-foreground"
          >
            <bdi>{item.detail}</bdi>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ui-12 text-muted-foreground">
            {item.detail}
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="menu-soft-surface-up dropdown-surface absolute bottom-full left-0 z-30 mb-1.5 flex w-[min(calc(30rem*var(--ui-space-scale,1)),100%)] flex-col overflow-hidden rounded-xl text-popover-foreground">
      {filter && (
        <div className="px-1 pt-1">
          <label className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-2 py-1.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring/50">
            <AtSign aria-hidden="true" className="size-4 shrink-0" />
            <input
              id={`${id}-search`}
              role="combobox"
              aria-label="Search mentions"
              aria-controls={id}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                active === null ? undefined : mentionOptionId(id, active)
              }
              placeholder="Search files, skills, and agents"
              className="min-w-0 flex-1 bg-transparent text-ui-13 leading-5 text-foreground outline-none placeholder:text-muted-foreground"
              value={query}
              onChange={(event) => filter.search(event.target.value)}
              onKeyDown={filter.onSearchKey}
              onBlur={(event) => filter.leaveSearch(event.relatedTarget)}
            />
          </label>
        </div>
      )}
      {filter && (
        <div
          // biome-ignore lint/a11y/useSemanticElements: a row of filter toggles; a <fieldset> would bring form semantics.
          role="group"
          aria-label="Mention categories"
          className="flex flex-wrap items-center gap-1 border-b border-border/60 px-1 py-1"
        >
          {filter.tabs.map(({ kind, count, more }) => (
            <button
              key={kind}
              type="button"
              tabIndex={-1}
              aria-pressed={filter.value === kind}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => filter.select(kind)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-ui-12 font-medium leading-4 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
            >
              {HEADINGS[kind]}
              <span className="font-normal tabular-nums text-muted-foreground/70">
                {count}
                {more ? "+" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      <div
        id={id}
        // biome-ignore lint/a11y/useSemanticElements: an aria-activedescendant combobox list; <select> cannot keep focus in the prompt.
        role="listbox"
        aria-label={label}
        data-testid="coding-mention-list"
        tabIndex={-1}
        className="max-h-80 min-h-0 overflow-y-auto overscroll-contain p-1"
      >
        {runs.map((run) =>
          headed ? (
            <div
              key={`${run.kind}:${run.start}`}
              // biome-ignore lint/a11y/useSemanticElements: a listbox section; <fieldset> is not allowed in a listbox.
              role="group"
              className="not-first:mt-1"
              aria-labelledby={`${id}-${run.kind}`}
            >
              <div
                id={`${id}-${run.kind}`}
                data-heading="true"
                className="px-2 pb-1 pt-1.5 text-ui-11 font-semibold uppercase tracking-[0.04em] text-muted-foreground/70"
              >
                {HEADINGS[run.kind] ?? run.kind}
              </div>
              {run.items.map((item, offset) => row(item, run.start + offset))}
            </div>
          ) : (
            <Fragment key={`${run.kind}:${run.start}`}>
              {run.items.map((item, offset) => row(item, run.start + offset))}
            </Fragment>
          ),
        )}
        {items.length === 0 && (
          <p
            className={`flex items-center gap-2 px-2 py-1.5 text-ui-13 ${failed ? "text-destructive" : "text-muted-foreground"}`}
          >
            {pending && (
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1">{status}</span>
            {onRetry && failed && (
              <button
                type="button"
                className="shrink-0 rounded-md px-1.5 text-ui-12 font-medium text-foreground hover:bg-accent"
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
      {filter && (
        <div
          aria-hidden="true"
          className="flex items-center gap-3.5 border-t border-border/60 px-3 py-1.5 text-ui-11 text-muted-foreground/80"
        >
          {[
            ["↑↓", "Navigate"],
            ["↵", "Insert"],
            ["Tab", "Category"],
          ].map(([key, action]) => (
            <span key={action} className="flex items-center gap-1.5">
              <kbd className="font-sans font-medium text-muted-foreground">
                {key}
              </kbd>
              {action}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
