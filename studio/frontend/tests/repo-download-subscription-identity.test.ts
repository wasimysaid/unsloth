// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import type * as Hook from "../src/features/hub/download-manager/use-repo-download.ts";
import type { JobListeners } from "../src/features/hub/download-manager/download-manager-types.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

function mount() {
  const refs: { current: unknown }[] = [];
  const effects: (() => void | (() => void))[] = [];
  const listeners: JobListeners[] = [];
  let cursor = 0;
  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useEffect(effect: () => void | (() => void)) { effects.push(effect); },
    useMemo(read: () => unknown) { return read(); },
    useCallback(callback: unknown) { return callback; },
  };
  const { useRepoDownload } = loadWithStubs<typeof Hook>(
    new URL("../src/features/hub/download-manager/use-repo-download.ts", import.meta.url),
    {
      react,
      "zustand/react/shallow": { useShallow: (selector: unknown) => selector },
      "./download-manager-controller": {
        downloadManager: { cancelConflict() {} },
        findActiveScopedJobForRepo: () => undefined,
        selectActiveJob: () => undefined,
        jobKeyOf: (...parts: unknown[]) => parts.join(":"),
        repoKeyOf: (...parts: unknown[]) => parts.join(":"),
        subscribeJobListeners(_kind: string, _repo: string, callbacks: JobListeners) {
          listeners.push(callbacks);
          return () => {};
        },
        useDownloadManagerStore: (selector: (state: { jobs: {}; conflicts: {} }) => unknown) =>
          selector({ jobs: {}, conflicts: {} }),
      },
    },
    { relativePassthrough: true },
  );
  return {
    render(config: Hook.RepoDownloadConfig) {
      cursor = 0;
      useRepoDownload(config);
    },
    commitEffects() { for (const effect of effects.splice(0)) effect(); },
    listeners,
  };
}

for (const replacement of [
  { kind: "model", repoId: "org/second" },
  { kind: "dataset", repoId: "org/first" },
] as const) {
  test(`retired repo listeners cannot deliver to ${replacement.kind} ${replacement.repoId}`, () => {
    const hook = mount();
    const received: string[] = [];
    hook.render({ kind: "model", repoId: "org/first" });
    hook.commitEffects();
    const old = hook.listeners[0];
    assert.ok(old);
    hook.render({
      ...replacement,
      onComplete: () => received.push("complete"),
      onCancelled: () => received.push("cancelled"),
      onError: () => received.push("error"),
    });
    old.onComplete?.("Q4_K_M", 42);
    old.onCancelled?.("Q4_K_M");
    old.onError?.("Q4_K_M");
    assert.deepEqual(received, []);
  });
}

test("a stable repo subscription calls the newest callbacks before effects commit", () => {
  const hook = mount();
  const received: string[] = [];
  hook.render({ kind: "model", repoId: "org/first", onComplete: () => received.push("old") });
  hook.commitEffects();
  const listener = hook.listeners[0];
  assert.ok(listener);
  hook.render({
    kind: "model", repoId: "org/first",
    onComplete: (variant, bytes) => received.push(`${variant}:${bytes}`),
    onCancelled: () => received.push("cancelled"),
    onError: () => received.push("error"),
  });
  listener.onComplete?.("Q4_K_M", 42);
  listener.onCancelled?.("Q4_K_M");
  listener.onError?.("Q4_K_M");
  assert.deepEqual(received, ["Q4_K_M:42", "cancelled", "error"]);
});
