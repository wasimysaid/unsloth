// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import {
  STARRED_GROUP,
  filterCodingModels,
  findCodingModel,
  modelGroups,
  modelIdentity,
  readCodingFavorites,
} from "./model-selection";
import type {
  CodingConfigurationChange,
  CodingModelChoice,
  CodingProviderChoice,
} from "./model-selection";

const FAVORITES_KEY = "unsloth_coding_model_favorites";
function initialFavorites() {
  try {
    return readCodingFavorites(localStorage.getItem(FAVORITES_KEY));
  } catch {
    return new Set<string>();
  }
}

/** "xhigh" -> "X-High", "medium" -> "Medium". */
export const effortLabel = (level: string) =>
  level
    .replace(/^x(?=high$)/i, "x-")
    .split(/([-_ ])/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
    .replace(/_/g, " ");

/** One native catalog choice; the favorite star appears on hover. */
export function ModelChoiceRow({
  provider,
  model,
  selected,
  favorite,
  disabled,
  onSelect,
  onFavorite,
}: {
  provider: string;
  model: CodingModelChoice;
  selected: boolean;
  favorite: boolean;
  disabled: boolean;
  onSelect: () => void;
  onFavorite: () => void;
}) {
  return (
    <div className="group/model flex min-w-0 items-center rounded-md hover:bg-accent">
      <button
        type="button"
        disabled={disabled}
        data-provider={provider}
        data-model={model.id}
        aria-pressed={selected}
        title={`${provider}/${model.id}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={onSelect}
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {model.name}
        </span>
        {selected && (
          <Check className="size-3.5 shrink-0" aria-label="Selected" />
        )}
      </button>
      <button
        type="button"
        className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${favorite ? "" : "opacity-0 group-hover/model:opacity-100"}`}
        aria-label={`Favorite ${provider}/${model.id}`}
        aria-pressed={favorite}
        onClick={onFavorite}
      >
        <Star
          className={`size-3 ${favorite ? "fill-current" : ""}`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/** Discrete effort rail: drag, click a stop, or use the arrow keys. */
export function EffortSlider({
  levels,
  value,
  disabled,
  onPreview,
  onCommit,
}: {
  levels: readonly string[];
  value: number;
  disabled: boolean;
  onPreview: (index: number) => void;
  onCommit: (index: number) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = levels.length - 1;
  const at = (clientX: number) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box || last <= 0) return value;
    const share = (clientX - box.left - 22) / Math.max(1, box.width - 44);
    return Math.round(Math.min(1, Math.max(0, share)) * last);
  };
  const position = (index: number) =>
    `calc(22px + (100% - 44px) * ${last > 0 ? index / last : 0})`;
  return (
    <div
      ref={rail}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Reasoning effort"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={value}
      aria-valuetext={levels[value] ? effortLabel(levels[value]) : undefined}
      aria-disabled={disabled || undefined}
      data-testid="coding-reasoning-control"
      className={`relative h-9 touch-none select-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${disabled ? "opacity-50" : "cursor-pointer"}`}
      onPointerDown={(event) => {
        if (disabled) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onPreview(at(event.clientX));
      }}
      onPointerMove={(event) => {
        if (dragging.current) onPreview(at(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        onCommit(at(event.clientX));
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onCommit(value);
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        const next =
          event.key === "ArrowRight" || event.key === "ArrowUp"
            ? Math.min(last, value + 1)
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? Math.max(0, value - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? last
                  : null;
        if (next === null) return;
        event.preventDefault();
        if (next !== value) onCommit(next);
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 overflow-hidden rounded-full coding-wash ring-1 ring-inset ring-border">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary/20 transition-[width] duration-150"
          style={{ width: `calc(${position(value)} + 22px)` }}
        />
        {levels.map((level, index) => (
          <span
            key={level}
            aria-hidden="true"
            className={`absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${index <= value ? "bg-primary/70" : "bg-muted-foreground/40"}`}
            style={{ left: position(index) }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="absolute top-1/2 h-8 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background shadow-[0_1px_3px_rgba(0,0,0,0.25)] ring-1 ring-border transition-[left] duration-150 dark:bg-zinc-200"
        style={{ left: position(value) }}
      />
    </div>
  );
}

export interface ModelPickerSelection {
  provider: string | null;
  model: string | null;
  reasoning: string | null;
}

/** Next-request model and effort. The catalog source is a live conversation or,
 * before one exists, the chosen folder's effective settings. Give each source
 * its own `key`: a new source never shows the previous one's inventory. */
export function CodingModelPicker({
  readCatalog,
  configuration,
  unavailable = null,
  disabled,
  configuring,
  configure,
}: {
  readCatalog: (
    refresh: boolean,
    signal: AbortSignal,
  ) => Promise<CodingProviderChoice[]>;
  configuration: ModelPickerSelection | null;
  unavailable?: string | null;
  disabled: boolean;
  configuring: boolean;
  configure: (change: CodingConfigurationChange) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"configuration" | "models">("configuration");
  // Read once on mount (the trigger needs the model's name); Retry and
  // Refresh are further explicit attempts. Loading is the unsettled attempt.
  const [request, setRequest] = useState({ refresh: false, attempt: 1 });
  const [result, setResult] = useState<{
    attempt: number;
    catalog: CodingProviderChoice[] | null;
    error: string | null;
  } | null>(null);
  const [catalog, setCatalog] = useState<CodingProviderChoice[]>([]);
  const loading = result?.attempt !== request.attempt;
  const catalogRead = catalog.length > 0 || Boolean(result?.catalog);
  const catalogError = loading ? null : (result?.error ?? null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(initialFavorites);
  const listId = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const read = useEffectEvent(readCatalog);
  const selected = findCodingModel(catalog, configuration);
  const identity =
    configuration?.provider && configuration.model
      ? modelIdentity(configuration.provider, configuration.model)
      : null;
  const levels =
    selected && selected.model.reasoning !== "unsupported"
      ? selected.model.reasoning.levels
      : [];
  const effort = configuration?.reasoning ?? selected?.model.default_reasoning;
  const effortIndex = levels.indexOf(effort ?? "");
  // An in-progress slider gesture belongs to the choice it started on.
  const gesture = `${identity}:${effort}`;
  const [draft, setDraft] = useState<{ gesture: string; index: number } | null>(
    null,
  );
  const draftIndex = draft?.gesture === gesture ? draft.index : null;
  const setDraftIndex = (index: number | null) =>
    setDraft(index === null ? null : { gesture, index });
  const valueIndex = draftIndex ?? effortIndex;
  const blocked = disabled || configuring || loading;

  useEffect(() => {
    const controller = new AbortController();
    const { attempt, refresh } = request;
    read(refresh, controller.signal).then(
      (choices) => {
        if (controller.signal.aborted) return;
        setCatalog(choices);
        setResult({ attempt, catalog: choices, error: null });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          attempt,
          catalog: null,
          error:
            reason instanceof Error
              ? reason.message
              : "Models could not be loaded.",
        });
      },
    );
    // Aborting browser delivery does not cancel native work; the next read
    // reconciles. A refresh is never repeated automatically.
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    if (!open) return;
    if (page === "models") searchInput.current?.focus();
    else heading.current?.focus();
  }, [page, open]);

  async function apply(
    change: CodingConfigurationChange,
    returnToConfiguration = false,
  ) {
    setError(null);
    try {
      await configure(change);
      setDraftIndex(null);
      if (returnToConfiguration) setPage("configuration");
    } catch (reason) {
      setDraftIndex(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "The model selection was not confirmed.",
      );
    }
  }
  function toggleFavorite(provider: string, model: string) {
    const key = modelIdentity(provider, model);
    const next = new Set(favorites);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFavorites(next);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
    } catch {
      /* Favorites still work for this view if browser storage is unavailable. */
    }
  }
  const groups = modelGroups(filterCodingModels(catalog, search), favorites);
  const modelLabel =
    selected?.model.name ?? configuration?.model ?? "Default model";
  const shownEffort = levels[valueIndex] ?? effort;
  const missing =
    unavailable ||
    (catalogRead && !selected && configuration?.model ? true : null);
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setPage("configuration");
          setError(null);
          if (catalogError)
            setRequest((prior) => ({
              refresh: false,
              attempt: prior.attempt + 1,
            }));
        }
      }}
    >
      <PopoverTrigger asChild={true}>
        <button
          type="button"
          aria-label={`Model: ${modelLabel}${effort ? ` · ${effortLabel(effort)}` : ""}`}
          data-testid="coding-model-trigger"
          className="flex h-8 min-w-0 max-w-[min(15.5rem,46vw)] shrink items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium text-foreground/90 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-accent"
        >
          <span className="min-w-0 truncate">{modelLabel}</span>
          {missing && (
            <span className="shrink-0 text-[11px] font-normal text-destructive">
              Unavailable
            </span>
          )}
          {effort && !missing && (
            <span className="shrink-0 font-normal text-muted-foreground/80 max-sm:hidden">
              {effortLabel(effort)}
            </span>
          )}
          {configuring && (
            <LoaderCircle
              className="size-3 shrink-0 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(16rem,calc(100vw-2rem))] min-h-0 gap-1 rounded-xl border border-border p-1.5 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.3)] dark:bg-card"
        data-testid="coding-model-picker"
        aria-label="Model and reasoning"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Radix handles Escape at document capture, before input onKeyDown.
          if (page === "models") {
            event.preventDefault();
            setPage("configuration");
          }
        }}
      >
        {page === "configuration" ? (
          <>
            <button
              ref={heading}
              type="button"
              aria-label="Choose model"
              className="group/heading flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setPage("models")}
            >
              <span className="min-w-0 flex-1">
                {shownEffort && (
                  <span className="block text-sm font-semibold">
                    {effortLabel(shownEffort)}
                  </span>
                )}
                <span
                  className={`flex min-w-0 items-center gap-1 ${shownEffort ? "text-xs text-muted-foreground" : "text-sm font-semibold"}`}
                >
                  <span className="min-w-0 truncate">{modelLabel}</span>
                  <ChevronRight
                    className="size-3 shrink-0 transition-transform group-hover/heading:translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </span>
              {(configuring || loading) && (
                <LoaderCircle
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                  aria-label={configuring ? "Applying" : "Loading models"}
                />
              )}
            </button>
            {levels.length > 1 &&
              (effortIndex >= 0 ? (
                <div className="px-1 pb-1">
                  <EffortSlider
                    levels={levels}
                    value={valueIndex}
                    disabled={blocked}
                    onPreview={setDraftIndex}
                    onCommit={(index) => {
                      const reasoning = levels[index];
                      if (reasoning && reasoning !== effort)
                        void apply({ reasoning });
                      else setDraftIndex(null);
                    }}
                  />
                </div>
              ) : (
                <p className="px-2 pb-1 text-xs text-muted-foreground">
                  This model doesn't offer the chosen effort.
                </p>
              ))}
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Back"
                onClick={() => setPage("configuration")}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </button>
              <nav
                aria-label="Model providers"
                className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]"
              >
                {groups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs ${tab === group.key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    aria-current={tab === group.key ? "true" : undefined}
                    data-provider-nav={group.key}
                    onClick={() => {
                      setTab(group.key);
                      document
                        .getElementById(`${listId}-${group.key}`)
                        ?.scrollIntoView({ block: "start" });
                    }}
                  >
                    {group.key === STARRED_GROUP && (
                      <Star className="size-3 fill-current" aria-hidden="true" />
                    )}
                    {group.name}
                  </button>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2 pb-1">
              <Search
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={searchInput}
                aria-label="Search models"
                placeholder="Search models…"
                className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    document
                      .querySelector<HTMLButtonElement>(
                        '[data-testid="coding-model-list"] button[data-model]:not(:disabled)',
                      )
                      ?.focus();
                  }
                }}
              />
              <button
                type="button"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50"
                aria-label="Refresh models"
                disabled={blocked}
                onClick={() =>
                  setRequest((prior) => ({
                    refresh: true,
                    attempt: prior.attempt + 1,
                  }))
                }
              >
                <RefreshCw
                  className={`size-3 ${loading && request.refresh ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div
              className="max-h-[min(18rem,45dvh)] min-h-0 space-y-1 overflow-y-auto overscroll-contain"
              data-testid="coding-model-list"
              aria-label="Models"
            >
              {groups.map((group) => (
                <section
                  key={group.key}
                  id={`${listId}-${group.key}`}
                  aria-label={group.name}
                >
                  <h3 className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.name}
                  </h3>
                  {group.models.map(({ provider, model }) => {
                    const key = modelIdentity(provider, model.id);
                    return (
                      <ModelChoiceRow
                        key={`${group.key}:${key}`}
                        provider={provider}
                        model={model}
                        selected={key === identity}
                        favorite={favorites.has(key)}
                        disabled={blocked}
                        onSelect={() =>
                          void apply({ provider, model: model.id }, true)
                        }
                        onFavorite={() => toggleFavorite(provider, model.id)}
                      />
                    );
                  })}
                </section>
              ))}
              {loading && !catalog.length && (
                <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                  <LoaderCircle
                    className="size-3 animate-spin"
                    aria-hidden="true"
                  />
                  Loading models
                </p>
              )}
              {!loading && catalogRead && groups.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">
                  No matching models
                </p>
              )}
            </div>
          </>
        )}
        {missing && (
          <div
            className="space-y-1.5 rounded-lg bg-destructive/5 p-2 text-xs"
            data-testid="coding-model-unavailable"
          >
            <p className="font-medium text-destructive">Model unavailable</p>
            {unavailable && <p className="break-words">{unavailable}</p>}
            <div className="flex gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 hover:bg-accent disabled:opacity-50"
                disabled={blocked}
                onClick={() => void apply({})}
              >
                Retry
              </button>
              {page === "configuration" && (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 hover:bg-accent disabled:opacity-50"
                  disabled={disabled || configuring}
                  onClick={() => setPage("models")}
                >
                  Choose another
                </button>
              )}
            </div>
          </div>
        )}
        {catalogError && (
          <div role="alert" className="flex items-center gap-2 px-2 text-xs">
            <span className="min-w-0 flex-1 text-destructive">
              {catalogError}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 hover:bg-accent disabled:opacity-50"
              disabled={blocked}
              onClick={() =>
                setRequest((prior) => ({
                  refresh: false,
                  attempt: prior.attempt + 1,
                }))
              }
            >
              Retry
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="break-words px-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
