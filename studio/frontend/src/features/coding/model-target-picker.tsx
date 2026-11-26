// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ReactNode } from "react";
import { modelIdentity } from "./model-selection";
import {
  type CodingTarget,
  type CodingTargets,
  type Origin,
  sameTarget,
} from "./model-targets";

/**
 * Searchable list of routed targets in a popover. Choosing only selects;
 * the caller decides when anything runs.
 */
export function ModelTargetPicker({
  targets,
  origin,
  value,
  onChange,
  open,
  onOpenChange,
  includeOrigin,
  label,
  align = "start",
  children,
}: {
  targets: CodingTargets;
  origin: Origin;
  /** `null` is the origin itself when `includeOrigin` is set. */
  value: CodingTarget | null;
  onChange: (target: CodingTarget | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** List the origin first as the default "Current model" choice. */
  includeOrigin: boolean;
  label: string;
  align?: "start" | "end";
  /** The trigger, rendered as the popover anchor. */
  children: ReactNode;
}) {
  const others = targets.providers
    .map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) =>
          !sameTarget(origin, { provider: provider.id, model: model.id }),
      ),
    }))
    .filter((provider) => provider.models.length);
  const nameCounts = new Map<string, number>();
  for (const provider of others)
    for (const model of provider.models)
      nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  const choose = (target: CodingTarget | null) => {
    onChange(target);
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild={true}>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={4}
        className="w-[min(20rem,calc(100vw-32px))] gap-0 overflow-hidden p-1"
        data-testid="coding-model-targets"
      >
        <Command className="bg-transparent p-0" label={label}>
          <CommandInput placeholder="Search models…" aria-label={label} />
          <CommandList className="max-h-64">
            <CommandEmpty className="py-5 text-xs text-muted-foreground">
              {targets.error ??
                (targets.loaded ? "No matching models." : "Loading models…")}
            </CommandEmpty>
            {includeOrigin && (
              <CommandGroup heading="This conversation">
                <CommandItem
                  value="current"
                  keywords={[targets.originName, "current"]}
                  data-checked={value === null}
                  onSelect={() => choose(null)}
                >
                  <span className="min-w-0 truncate">Current model</span>
                  <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                    {targets.originName}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {others.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.name}>
                {provider.models.map((model) => {
                  const target: CodingTarget = {
                    provider: provider.id,
                    model: model.id,
                    name: model.name,
                    providerName: provider.name,
                  };
                  return (
                    <CommandItem
                      key={model.id}
                      value={modelIdentity(provider.id, model.id)}
                      keywords={[model.name, provider.name, model.api_model]}
                      data-checked={sameTarget(value, target)}
                      onSelect={() => choose(target)}
                    >
                      <span className="min-w-0 truncate">{model.name}</span>
                      {(nameCounts.get(model.name) ?? 0) > 1 && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {provider.name}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
