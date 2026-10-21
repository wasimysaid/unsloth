// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Star,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { codingModelApi } from "./api";
import {
  STARRED_GROUP,
  filterCodingModels,
  findCodingModel,
  modelGroups,
  modelIdentity,
  readCodingFavorites,
} from "./model-selection";
import type {
  CodingConfiguration,
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

/** One native catalog choice. Long native labels wrap inside the choice (the
 * shared Button is `whitespace-nowrap`), never under the Favorite control. */
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
    <div className="flex min-w-0 items-center gap-1 rounded-xl hover:bg-muted/50">
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        data-provider={provider}
        data-model={model.id}
        aria-pressed={selected}
        className="h-auto min-h-10 min-w-0 flex-1 shrink justify-start gap-2 whitespace-normal rounded-xl px-2 py-1.5 text-left"
        onClick={onSelect}
      >
        <Check
          className={`size-3.5 shrink-0 ${selected ? "" : "invisible"}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block [overflow-wrap:anywhere]">
            {model.name}
            {selected && <span className="ml-1 text-[10px]">· Selected</span>}
          </span>
          <span className="block break-all text-[10px] text-muted-foreground">
            {provider}/{model.id}
          </span>
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        aria-label={`Favorite ${provider}/${model.id}`}
        aria-pressed={favorite}
        onClick={onFavorite}
      >
        <Star
          className={`size-3.5 ${favorite ? "fill-current" : ""}`}
          aria-hidden="true"
        />
      </Button>
    </div>
  );
}

/** Selection is native next-request configuration, not a browser prompt option. */
export function CodingModelPicker({
  conversationId,
  configuration,
  unavailable,
  disabled,
  configuring,
  configure,
}: {
  conversationId: string | null;
  configuration: CodingConfiguration | null;
  unavailable: string | null;
  disabled: boolean;
  configuring: boolean;
  configure: (change: CodingConfigurationChange) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"configuration" | "models">("configuration");
  const [catalog, setCatalog] = useState<CodingProviderChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogRead, setCatalogRead] = useState(false);
  const [request, setRequest] = useState<{ refresh: boolean }>({
    refresh: false,
  });
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(initialFavorites);
  const listId = useId();
  const heading = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLButtonElement>(null);
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
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const valueIndex = draftIndex ?? effortIndex;
  const blocked = disabled || configuring || loading;

  // biome-ignore lint/correctness/useExhaustiveDependencies: controller identity is the reset trigger, not a value used inside the reset.
  useEffect(() => {
    // Do not carry a different conversation's inventory into this controller.
    setCatalog([]);
    setCatalogRead(false);
    setTab(null);
  }, [conversationId]);
  useEffect(() => {
    if (!open || !conversationId) return;
    const controller = new AbortController();
    setLoading(true);
    setRefreshing(request.refresh);
    setCatalogError(null);
    const operation = request.refresh
      ? codingModelApi.refresh
      : codingModelApi.catalog;
    void operation(conversationId, controller.signal)
      .then((choices) => {
        if (!controller.signal.aborted) {
          setCatalog(choices);
          setCatalogRead(true);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setCatalogError(
            reason instanceof Error
              ? reason.message
              : "Models could not be loaded.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    // Aborting browser delivery does not cancel native work. Next opening reads
    // the controller to reconcile; it never automatically repeats a refresh.
    return () => controller.abort();
  }, [open, conversationId, request]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: discard only the in-progress slider gesture when authoritative identity/effort changes.
  useEffect(() => {
    setDraftIndex(null);
  }, [identity, effort]);
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
          : "Native configuration was not confirmed.",
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
    selected?.model.name ?? configuration?.model ?? "Choose model";
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) {
          setPage("configuration");
          setError(null);
          setRequest({ refresh: false });
        }
      }}
    >
      <PopoverTrigger asChild={true}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!conversationId || !configuration}
          aria-label="Configure next coding request"
          data-testid="coding-model-trigger"
          className="h-9 min-w-0 max-w-[min(18rem,42vw)] gap-1.5 rounded-full px-3 text-sm font-medium data-[state=open]:bg-muted"
        >
          <span className="truncate">{modelLabel}</span>
          {unavailable && (
            <span className="shrink-0 text-xs text-destructive">
              Unavailable
            </span>
          )}
          {configuration?.reasoning && (
            <span className="shrink-0 font-normal text-muted-foreground max-sm:hidden">
              {configuration.reasoning}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="w-[min(18rem,calc(100vw-2rem))] min-h-0 gap-2 rounded-[21px] border border-border/60 p-3 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-card"
        data-testid="coding-model-picker"
        aria-label="Next coding request configuration"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Radix handles Escape at document capture, before input onKeyDown.
          // Intercept dismissal here so Back navigation restores heading focus.
          if (page === "models") {
            event.preventDefault();
            setPage("configuration");
          }
        }}
      >
        {page === "configuration" ? (
          <>
            <div className="min-w-0">
              {levels.length > 0 && (
                <p className="px-1 text-base font-semibold capitalize">
                  {levels[valueIndex] ?? effort ?? "Default"}
                </p>
              )}
              <Button
                ref={heading}
                type="button"
                variant="ghost"
                aria-label="Choose coding model"
                className={`h-auto min-h-8 max-w-full justify-start gap-1 rounded-xl px-1 py-1 text-left ${levels.length > 0 ? "text-sm font-normal text-muted-foreground" : "text-base font-semibold"}`}
                onClick={() => setPage("models")}
              >
                <span className="min-w-0 truncate">{modelLabel}</span>
                <ChevronRight
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {(configuring || loading) && (
                  <LoaderCircle
                    className="size-3.5 shrink-0 animate-spin"
                    aria-label={configuring ? "Applying" : "Loading models"}
                  />
                )}
              </Button>
            </div>
            {levels.length > 0 &&
              (effortIndex >= 0 ? (
                <div data-testid="coding-reasoning-control">
                  <Slider
                    aria-label="Reasoning effort"
                    min={0}
                    max={levels.length - 1}
                    step={1}
                    value={[valueIndex]}
                    disabled={blocked || levels.length === 1}
                    thumbValueText={(value) => levels[value] ?? "Not offered"}
                    onValueChange={([value]) => setDraftIndex(value)}
                    onValueCommit={([value]) => {
                      const reasoning = levels[value];
                      if (reasoning && reasoning !== effort)
                        void apply({ reasoning });
                      else setDraftIndex(null);
                    }}
                  />
                </div>
              ) : (
                <p className="px-1 text-xs text-muted-foreground">
                  This model doesn't offer the configured effort. Choose a model
                  to use its default.
                </p>
              ))}
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <Button
                ref={back}
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full"
                aria-label="Back to model configuration"
                onClick={() => setPage("configuration")}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Button>
              <nav
                aria-label="Model providers"
                className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
              >
                {groups.map((group) => (
                  <Button
                    key={group.key}
                    type="button"
                    variant={tab === group.key ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 shrink-0 rounded-full px-2.5 text-xs"
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
                      <Star
                        className="size-3 fill-current"
                        aria-hidden="true"
                      />
                    )}
                    {group.name}
                  </Button>
                ))}
              </nav>
            </div>
            <div className="flex items-center gap-1">
              <Input
                ref={searchInput}
                aria-label="Search coding models"
                placeholder="Search models"
                className="h-9 rounded-full"
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
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full"
                aria-label="Refresh model list"
                disabled={blocked}
                onClick={() => setRequest({ refresh: true })}
              >
                <RefreshCw
                  className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
              </Button>
            </div>
            <div
              className="max-h-[min(18rem,45dvh)] min-h-0 space-y-2 overflow-y-auto overscroll-contain"
              data-testid="coding-model-list"
              aria-label="Coding models"
            >
              {groups.map((group) => (
                <section
                  key={group.key}
                  id={`${listId}-${group.key}`}
                  aria-label={group.name}
                  className="space-y-0.5"
                >
                  <h3 className="px-2 text-xs font-medium text-muted-foreground">
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
              {!loading && groups.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">
                  No matching models.
                </p>
              )}
            </div>
          </>
        )}
        {(unavailable ||
          (catalogRead && !selected && configuration?.model)) && (
          <div
            className="space-y-2 rounded-2xl bg-destructive/5 p-3 text-xs"
            data-testid="coding-model-unavailable"
          >
            <p className="font-medium text-destructive">
              Selected model unavailable
            </p>
            {unavailable && <p>{unavailable}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={blocked}
                onClick={() => void apply({})}
              >
                Retry
              </Button>
              {page === "configuration" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  disabled={disabled || configuring}
                  onClick={() => setPage("models")}
                >
                  Choose another
                </Button>
              )}
            </div>
          </div>
        )}
        {catalogError && (
          <div role="alert" className="flex items-center gap-2 px-1 text-xs">
            <span className="min-w-0 flex-1 text-destructive">
              {catalogError}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0 rounded-full"
              disabled={blocked}
              onClick={() => setRequest({ refresh: false })}
            >
              Retry
            </Button>
          </div>
        )}
        {disabled && (
          <output className="block px-1 text-xs text-muted-foreground">
            Available once the conversation reconnects.
          </output>
        )}
        {error && (
          <p role="alert" className="break-words px-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
