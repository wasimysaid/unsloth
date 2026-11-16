// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import type * as DownloadSelection from "../src/features/model-picker/use-load-after-download.ts";
import { loadWithStubs } from "./helpers/module-stubs.ts";

type DownloadHandlers = {
  repoId: string;
  activeVariant: string | null;
  onComplete: (variant: string | null) => void;
  onError: (variant: string | null) => void;
  onCancelled: (variant: string | null) => void;
};

function mount() {
  let handlers!: DownloadHandlers;
  let effect!: () => (() => void) | undefined;
  let resolveStart!: (outcome: string) => void;
  const events: unknown[] = [];
  const { useLoadAfterDownload } = loadWithStubs<typeof DownloadSelection>(
    new URL(
      "../src/features/model-picker/use-load-after-download.ts",
      import.meta.url,
    ),
    {
      react: {
        useEffect: (callback: typeof effect) => {
          effect = callback;
        },
      },
      "@/features/hub": {
        DOWNLOAD_KIND: { MODEL: "model" },
        useRepoDownload: (value: DownloadHandlers) => {
          handlers = value;
          events.push("subscribed");
        },
        downloadManager: {
          requestStart: (request: unknown) => {
            events.push(request);
            return new Promise<string>((resolve) => {
              resolveStart = resolve;
            });
          },
        },
      },
    },
  );
  return {
    useLoadAfterDownload,
    events,
    handlers: () => handlers,
    start: () => effect(),
    resolveStart: (outcome: string) => resolveStart(outcome),
  };
}

function pending(
  isCurrent = () => true,
): DownloadSelection.PendingModelDownload {
  return {
    id: "org/model",
    meta: {
      source: "hub",
      isLora: false,
      isGguf: true,
      ggufVariant: "Q4",
      expectedBytes: 100,
    },
    originModel: "original",
    isCurrent,
  };
}

test("shared managed download binds before starting and loads only its exact completed quant", () => {
  const view = mount();
  const changes: unknown[] = [];
  view.useLoadAfterDownload(
    pending(),
    (value) => changes.push(value),
    "original",
    (id, meta) => changes.push({ id, meta }),
    () => {},
  );
  const cleanup = view.start();
  assert.equal(view.events[0], "subscribed");
  assert.deepEqual(view.events[1], {
    kind: "model",
    repoId: "org/model",
    variant: "Q4",
    expectedBytes: 100,
    presentation: undefined,
    callerToast: {
      title: "Downloading model",
      description: "It'll load once the download finishes.",
    },
  });
  view.handlers().onComplete("Q8");
  assert.deepEqual(changes, []);
  view.handlers().onComplete("Q4");
  assert.deepEqual(changes, [
    null,
    { id: "org/model", meta: { ...pending().meta, isDownloaded: true } },
  ]);
  cleanup?.();
});

test("cancelled or failed downloads never load and a stale completion cannot clear the newer pick", () => {
  for (const event of ["onCancelled", "onError"] as const) {
    const view = mount();
    const changes: unknown[] = [];
    view.useLoadAfterDownload(
      pending(),
      (value) => changes.push(value),
      "original",
      () => assert.fail("must not load"),
      () => {},
    );
    view.handlers()[event]("Q4");
    assert.deepEqual(changes, [null]);
  }
  let current = true;
  const view = mount();
  view.useLoadAfterDownload(
    pending(() => current),
    () => assert.fail("must not clear new pick"),
    "original",
    () => assert.fail("must not load"),
    () => {},
  );
  current = false;
  view.handlers().onComplete("Q4");
});

test("a delayed start failure cannot overwrite a newer choice or report after unmount", async () => {
  for (const unmount of [false, true]) {
    let current = true;
    const view = mount();
    view.useLoadAfterDownload(
      pending(() => current),
      () => assert.fail("must not clear new pick"),
      "original",
      () => assert.fail("must not load"),
      () => assert.fail("must not report stale error"),
    );
    const cleanup = view.start();
    if (unmount) cleanup?.();
    else current = false;
    view.resolveStart("error");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});
