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
  ChevronDown,
  ChevronRight,
  Star,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { codingModelApi } from "./api";
import {
  filterCodingModels,
  findCodingModel,
  modelIdentity,
  readCodingFavorites,
} from "./model-selection";
import type {
  CodingConfiguration,
  CodingConfigurationChange,
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
  const [providerId, setProviderId] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState(initialFavorites);
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
    setProviderId(null);
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
          // A removed provider must not leave navigation stuck in an empty group.
          setProviderId((id) =>
            choices.some((item) => item.id === id) ? id : null,
          );
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setCatalogError(
            `${reason instanceof Error ? reason.message : "Mimir's catalog could not be read."} ${request.refresh ? "Refresh was not confirmed. Previous inventory is retained; read it again or explicitly retry refresh." : "Previous inventory and selection have not been replaced."}`,
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
  const visible = filterCodingModels(
    catalog,
    search,
    providerId,
    favorites,
    favoritesOnly,
  );
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
          title="Model and reasoning for the next native request to begin execution"
          data-testid="coding-model-trigger"
          className="min-w-0 max-w-[min(24rem,calc(100%-3.5rem))] gap-1.5 text-xs"
        >
          <span className="truncate">{modelLabel}</span>
          {unavailable && <span className="shrink-0">· Unavailable</span>}
          {configuration?.reasoning && (
            <span className="shrink-0 text-muted-foreground">
              · {configuration.reasoning}
            </span>
          )}
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={16}
        className="w-88 min-h-0 gap-3 border border-border shadow-lg"
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
        <p className="text-xs font-medium text-muted-foreground">
          Next-request selection
        </p>
        {page === "configuration" ? (
          <>
            <Button
              ref={heading}
              type="button"
              variant="ghost"
              aria-label="Choose coding model"
              className="h-auto min-h-10 w-full justify-between gap-2 px-2 text-left"
              onClick={() => setPage("models")}
            >
              <span className="min-w-0">
                <span className="block break-words font-medium">
                  {modelLabel}
                </span>
                <span className="block break-all text-xs font-normal text-muted-foreground">
                  {configuration?.provider &&
                    `${configuration.provider}/${configuration.model}`}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
            </Button>
            {selected && (
              <p className="break-all text-xs text-muted-foreground">
                API model: {selected.model.api_model}
              </p>
            )}
            {!configuration?.model && (
              <output className="block text-xs">
                Choose a model from Mimir's catalog.
              </output>
            )}
            {levels.length > 0 && (
              <div
                className="space-y-3 rounded-lg bg-muted/50 p-3"
                data-testid="coding-reasoning-control"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>Reasoning effort</span>
                  <output>
                    {levels[valueIndex] ?? effort ?? "Not offered"}
                  </output>
                </div>
                {effortIndex >= 0 ? (
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
                ) : (
                  <p className="text-xs">
                    The configured effort is not offered by this model. Switch
                    models to use a native default; no effort was substituted.
                  </p>
                )}
                <div
                  className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-[10px] text-muted-foreground"
                  aria-hidden="true"
                >
                  {levels.map((level) => (
                    <span key={level}>{level}</span>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Mimir default: {selected?.model.default_reasoning ?? "none"}
                </p>
              </div>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Applies when the next request begins, including queued input. Work
              already running keeps its model and effort.
            </p>
          </>
        ) : (
          <>
            <Button
              ref={back}
              type="button"
              variant="ghost"
              size="sm"
              className="justify-start px-1"
              onClick={() => setPage("configuration")}
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" /> Back to
              model configuration
            </Button>
            <Input
              ref={searchInput}
              aria-label="Search coding models"
              placeholder="Search models or providers…"
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
            <nav
              aria-label="Model providers"
              className="flex max-h-32 shrink-0 flex-wrap gap-1 overflow-y-auto"
            >
              <Button
                type="button"
                variant={providerId === null ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={providerId === null}
                onClick={() => setProviderId(null)}
              >
                All providers
              </Button>
              {catalog.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  variant={providerId === provider.id ? "secondary" : "ghost"}
                  size="sm"
                  className="h-auto min-h-8 max-w-full whitespace-normal break-words text-left"
                  aria-pressed={providerId === provider.id}
                  data-provider-nav={provider.id}
                  onClick={() => setProviderId(provider.id)}
                  title={provider.id}
                >
                  {provider.name}
                  <span className="text-[10px] text-muted-foreground">
                    {provider.id}
                  </span>
                </Button>
              ))}
            </nav>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={favoritesOnly}
              className="justify-start px-1"
              onClick={() => setFavoritesOnly(!favoritesOnly)}
            >
              <Star className="size-3.5" aria-hidden="true" /> Favorites
            </Button>
            <div
              className="max-h-64 min-h-0 overflow-y-auto overscroll-contain"
              data-testid="coding-model-list"
              aria-label="Coding models"
            >
              {visible.map((provider) => (
                <section
                  key={provider.id}
                  aria-label={`${provider.name} (${provider.id})`}
                  className="mb-3 space-y-1"
                >
                  <h3 className="break-words px-1 text-xs font-medium text-muted-foreground">
                    {provider.name} · {provider.id}
                  </h3>
                  {provider.models.map((model) => {
                    const key = modelIdentity(provider.id, model.id);
                    const isSelected = key === identity;
                    return (
                      <div
                        key={key}
                        className="flex min-w-0 items-center gap-1 rounded-lg hover:bg-muted/50"
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={blocked}
                          data-provider={provider.id}
                          data-model={model.id}
                          aria-pressed={isSelected}
                          className="h-auto min-h-12 min-w-0 flex-1 justify-start gap-2 px-2 text-left"
                          onClick={() =>
                            void apply(
                              { provider: provider.id, model: model.id },
                              true,
                            )
                          }
                        >
                          <Check
                            className={`size-3.5 shrink-0 ${isSelected ? "" : "invisible"}`}
                            aria-hidden="true"
                          />
                          <span className="min-w-0">
                            <span className="block break-words">
                              {model.name}
                              {isSelected && (
                                <span className="ml-1 text-[10px]">
                                  · Selected
                                </span>
                              )}
                            </span>
                            <span className="block break-all text-[10px] text-muted-foreground">
                              {provider.id}/{model.id}
                            </span>
                          </span>
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={`Favorite ${provider.id}/${model.id}`}
                          aria-pressed={favorites.has(key)}
                          onClick={() => toggleFavorite(provider.id, model.id)}
                        >
                          <Star
                            className={`size-3.5 ${favorites.has(key) ? "fill-current" : ""}`}
                            aria-hidden="true"
                          />
                        </Button>
                      </div>
                    );
                  })}
                </section>
              ))}
              {!loading && visible.length === 0 && (
                <p className="p-2 text-xs">
                  No matching models in Mimir's catalog.
                </p>
              )}
            </div>
          </>
        )}
        {(unavailable ||
          (catalogRead && !selected && configuration?.model)) && (
          <div
            className="space-y-2 rounded-lg border border-border p-2 text-xs"
            data-testid="coding-model-unavailable"
          >
            <p className="font-medium">Selected model unavailable</p>
            <p className="break-all">
              {configuration?.provider}/{configuration?.model}
            </p>
            <p>
              {unavailable ??
                "This identity is absent from the refreshed inventory. It has not been replaced."}
            </p>
            <p>
              History remains readable. No provider or model was substituted.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked}
                onClick={() => void apply({})}
              >
                Retry selected model
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || configuring}
                onClick={() => setPage("models")}
              >
                Choose replacement
              </Button>
            </div>
          </div>
        )}
        {page === "configuration" && selected && !unavailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={blocked}
            onClick={() => void apply({})}
          >
            Retry selected model
          </Button>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Inventory only, not a health, credentials or compatibility check.
          Provider setup and downloads stay in their existing workflows.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={() => setRequest({ refresh: true })}
        >
          Refresh model choices
        </Button>
        {loading && (
          <output className="block text-xs">
            {refreshing
              ? "Refreshing native model choices…"
              : "Reading Mimir catalog…"}
          </output>
        )}
        {catalogError && (
          <div className="space-y-2 text-xs">
            <p role="alert">{catalogError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() => setRequest({ refresh: false })}
            >
              Read current inventory
            </Button>
          </div>
        )}
        {configuring && (
          <output className="block text-xs">Configuring next request…</output>
        )}
        {disabled && (
          <output className="block text-xs">
            Reconnect and reconstruct native state before changing
            configuration.
          </output>
        )}
        {error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
