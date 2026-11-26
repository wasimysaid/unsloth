// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

export function ComposerDecision({
  icon: Icon,
  question,
  testId,
  children,
}: {
  icon: LucideIcon;
  question: string;
  testId: string;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-testid={testId}
      className="mx-1 mb-2 min-w-0 space-y-2 px-2 pt-1 text-sm"
    >
      <h3 id={heading} className="flex items-center gap-2 font-medium">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        {question}
      </h3>
      {children}
    </section>
  );
}
