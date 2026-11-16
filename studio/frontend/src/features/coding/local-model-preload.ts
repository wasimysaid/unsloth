// SPDX-License-Identifier: AGPL-3.0-only
export function createModelPreloader(
  load: (id: string, requestId: string) => Promise<void>,
  changed: (id: string, error: unknown | null, loading: boolean) => void,
) {
  let active: { id: string; requestId: string; dismissed: boolean } | null = null;
  let pending: string | null = null;
  let closed = false;
  async function drain() {
    if (active || closed) return;
    while (pending !== null && !closed) {
      const next = { id: pending, requestId: crypto.randomUUID(), dismissed: false };
      pending = null;
      active = next;
      changed(next.id, null, true);
      try {
        await load(next.id, next.requestId);
        if (!closed && !next.dismissed) changed(next.id, null, false);
      } catch (error) {
        if (!closed && !next.dismissed) changed(next.id, error, false);
      } finally {
        active = null;
      }
    }
  }
  return {
    select(id: string) {
      if (closed) return;
      pending = active?.id === id && !active.dismissed ? null : id;
      changed(id, null, true);
      void drain();
    },
    dismissCompletion(requestId: string) { if (active?.requestId === requestId) active.dismissed = true; },
    removePending(id: string) { if (pending === id) pending = null; },
    active: () => active,
    isLoading: (id: string | null) => id !== null && ((active?.id === id && !active.dismissed) || pending === id),
    close() { closed = true; pending = null; },
  };
}
