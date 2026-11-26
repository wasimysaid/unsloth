// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useExternalProvidersStore } from "@/features/chat";
import { useEffect, useMemo, useState } from "react";
import { codingModelApi } from "./api";
import {
  type CodingConfiguration,
  type CodingProviderChoice,
  findCodingModel,
  studioConnectionBlockedReason,
} from "./model-selection";

/** A routed model another conversation can start on. */
export type CodingTarget = {
  provider: string;
  model: string;
  name: string;
  providerName: string;
};

export type Origin = Pick<CodingConfiguration, "provider" | "model"> | null;

export type CodingTargets = {
  /** Providers reachable now; a disabled Studio connection is not a target. */
  providers: CodingProviderChoice[];
  loaded: boolean;
  error: string | null;
  /** The origin's catalog name, or its raw ID while the catalog loads. */
  originName: string;
};

/** The conversation's own routed catalog, read once `enabled` turns true. */
export function useCodingTargets(
  conversationId: string | null,
  origin: Origin,
  enabled = true,
): CodingTargets {
  const [catalog, setCatalog] = useState<CodingProviderChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionsEnabled = useExternalProvidersStore(
    (s) => s.connectionsEnabled,
  );
  const wanted = enabled && Boolean(conversationId) && catalog === null;
  useEffect(() => {
    if (!wanted || !conversationId) return;
    const abort = new AbortController();
    codingModelApi
      .catalog(conversationId, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        setCatalog(next);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Models could not be loaded.",
          );
      });
    return () => abort.abort();
  }, [wanted, conversationId]);
  const providers = useMemo(
    () =>
      (catalog ?? []).filter(
        (provider) =>
          provider.models.length &&
          !studioConnectionBlockedReason(provider.id, connectionsEnabled),
      ),
    [catalog, connectionsEnabled],
  );
  return {
    providers,
    loaded: catalog !== null,
    error,
    originName:
      (catalog && findCodingModel(catalog, origin)?.model.name) ??
      origin?.model ??
      "Current model",
  };
}

export const sameTarget = (
  a: Origin | CodingTarget | undefined,
  b: Origin | CodingTarget | undefined,
) => Boolean(a && b && a.provider === b.provider && a.model === b.model);

/** A short display name: "Inkling-2-Mini-GGUF · UD-Q4_K_M" reads "Inkling-2-Mini".
 * The exact catalog name stays in the picker and tooltips. */
export function friendlyModelName(name: string): string {
  const base = (name.split(" · ")[0] ?? "").trim();
  return base.replace(/[-_ ]GGUF$/i, "") || name;
}

/** The exact identity shown on hover: catalog name and provider. */
export const exactTargetName = (target: CodingTarget) =>
  `${target.name} · ${target.providerName}`;
