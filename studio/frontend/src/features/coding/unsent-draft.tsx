// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Known-unsent text, selectable even while failed storage disables the composer. */
export function CodingUnsentDraft({ text }: { text: string }) {
  return (
    <section
      className="space-y-2 rounded-2xl border border-border/60 p-3 text-xs"
      aria-label="Unsent prompt recovery"
    >
      <p className="font-medium">Not sent · copy your message below.</p>
      <textarea
        aria-label="Unsent coding prompt"
        data-testid="coding-unsent-draft"
        className="max-h-40 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm"
        readOnly={true}
        rows={3}
        value={text}
      />
    </section>
  );
}
