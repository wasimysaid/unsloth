// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelSelectorChangeMeta } from "@/features/model-picker";
import { loadedConfigSignature } from "../model-picker/model-config/config-signature.ts";

export type LocalModelLoadOptions = Pick<
  ModelSelectorChangeMeta,
  "config" | "forceReload"
>;

type LoadIntent = {
  id: string;
  options: LocalModelLoadOptions;
  signature: string;
};

export function createModelPreloader(
  load: (
    id: string,
    requestId: string,
    options: LocalModelLoadOptions,
  ) => Promise<void>,
  changed: (id: string, error: unknown | null, loading: boolean) => void,
) {
  let active: (LoadIntent & { requestId: string; dismissed: boolean }) | null =
    null;
  let pending: LoadIntent | null = null;
  let closed = false;
  async function drain() {
    if (active || closed) return;
    while (pending !== null && !closed) {
      const next = {
        ...pending,
        requestId: crypto.randomUUID(),
        dismissed: false,
      };
      pending = null;
      active = next;
      changed(next.id, null, true);
      try {
        await load(next.id, next.requestId, next.options);
        if (!closed && !next.dismissed) changed(next.id, null, false);
      } catch (error) {
        if (!closed && !next.dismissed) changed(next.id, error, false);
      } finally {
        active = null;
      }
    }
  }
  return {
    select(id: string, options: LocalModelLoadOptions = {}) {
      if (closed) return;
      const signature = JSON.stringify([
        id,
        loadedConfigSignature(options.config),
        options.forceReload === true,
      ]);
      pending =
        active?.signature === signature && !active.dismissed
          ? null
          : { id, options, signature };
      changed(id, null, true);
      void drain();
    },
    dismissCompletion(requestId: string) {
      if (active?.requestId === requestId) active.dismissed = true;
    },
    removePending(id: string) {
      if (pending?.id === id) pending = null;
    },
    active: () => active,
    isLoading: (id: string | null) =>
      id !== null &&
      ((active?.id === id && !active.dismissed) || pending?.id === id),
    close() {
      closed = true;
      pending = null;
    },
  };
}
