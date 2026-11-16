// SPDX-License-Identifier: AGPL-3.0-only
import {
  DOWNLOAD_KIND,
  downloadManager,
  useRepoDownload,
} from "@/features/hub";
import type { ModelSelectorChangeMeta } from "./components/model-selector/types";
import { type Dispatch, type SetStateAction, useEffect } from "react";

// An uncached Hub pick downloads first, so the resident model keeps serving the API meanwhile.
async function startStagedDownload(
  id: string,
  meta: ModelSelectorChangeMeta | undefined,
): Promise<string | null> {
  const outcome = await downloadManager.requestStart({
    kind: DOWNLOAD_KIND.MODEL,
    repoId: id,
    variant: meta?.ggufVariant ?? null,
    expectedBytes: meta?.expectedBytes ?? 0,
    presentation: meta?.downloadPresentation,
    callerToast: {
      title: "Downloading model",
      description: "It'll load once the download finishes.",
    },
  });
  if (outcome === "conflict") {
    return "Resume this download from the Model hub.";
  }
  if (outcome === "busy") {
    return "A download for this model is already in progress.";
  }
  if (outcome === "error") {
    return "Failed to start the download.";
  }
  return null;
}

export type PendingModelDownload = {
  id: string;
  meta: ModelSelectorChangeMeta;
  originModel: string | null;
  isCurrent?: () => boolean;
};

// Starts a staged pick's managed download and loads it on completion, as Chat does. The listener
// is bound before the start, and a newer pick cancels this one's start result.
export function useLoadAfterDownload(
  pending: PendingModelDownload | null,
  setPending: Dispatch<SetStateAction<PendingModelDownload | null>>,
  activeModel: string | null,
  load: (id: string, meta: ModelSelectorChangeMeta) => void,
  onStartError: (message: string) => void,
): void {
  const settle = (variant: string | null, loadIt: boolean) => {
    if (
      !pending ||
      pending.isCurrent?.() === false ||
      (pending.meta.ggufVariant ?? null) !== (variant ?? null)
    ) {
      return;
    }
    setPending(null);
    // An unload, reload or API switch since the pick means the user moved on.
    if (loadIt && pending.originModel === activeModel) {
      load(pending.id, { ...pending.meta, isDownloaded: true });
    }
  };
  useRepoDownload({
    kind: DOWNLOAD_KIND.MODEL,
    repoId: pending?.id ?? "__hub_autoload_idle__",
    activeVariant: pending?.meta.ggufVariant ?? null,
    onComplete: (variant) => settle(variant, true),
    onError: (variant) => settle(variant, false),
    onCancelled: (variant) => settle(variant, false),
  });
  useEffect(() => {
    if (!pending) {
      return;
    }
    let active = true;
    startStagedDownload(pending.id, pending.meta).then((error) => {
      if (active && pending.isCurrent?.() !== false && error) {
        onStartError(error);
        setPending(null);
      }
    });
    return () => {
      active = false;
    };
  }, [pending, setPending, onStartError]);
}
