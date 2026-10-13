// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Known-unsent text, selectable even while failed storage disables the composer. */
export function CodingUnsentDraft({ text }: { text: string }) {
  return (
    <section
      className="space-y-2 rounded-xl border border-border/60 p-3 text-xs"
      aria-label="Unsent prompt recovery"
    >
      <p className="font-medium">
        No prompt was sent. Your unsent draft is retained below.
      </p>
      <textarea
        aria-label="Unsent coding prompt"
        data-testid="coding-unsent-draft"
        className="max-h-40 w-full resize-y rounded-lg border border-border bg-background p-2 text-sm"
        readOnly
        rows={3}
        value={text}
      />
      <p className="text-muted-foreground">
        Copy this draft before reopening or leaving this view. It is only
        retained in memory because browser storage failed; restore storage
        before sending. Nothing will be sent automatically.
      </p>
    </section>
  );
}
