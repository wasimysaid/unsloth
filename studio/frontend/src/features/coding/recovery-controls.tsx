// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { codingCanContinue, codingInterruptedRequest } from "./run-session";
import type { CodingRun, CodingRunState } from "./run-session";

/** An interrupted request is continued only by an explicit new prompt. */
export function CodingRecoveryControls({
  state,
  run,
}: { state: CodingRunState; run: CodingRun | null }) {
  const interrupted = codingInterruptedRequest(state);
  // A running request already answers "what is happening now".
  if (state.native?.active_request) return null;
  if (!interrupted && !state.continuationRequested) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="coding-interrupted-recovery"
    >
      <p role="status" className="min-w-0 flex-1 break-words">
        {interrupted
          ? "Interrupted · the last request didn't finish."
          : "Continuing the interrupted work."}
      </p>
      {interrupted && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-testid="coding-continue-interrupted"
          title="Sends a new prompt asking Mimir to review history and the project first"
          aria-disabled={!codingCanContinue(state)}
          onClick={() => {
            if (codingCanContinue(state)) void run?.continueInterruptedWork();
          }}
        >
          Continue
        </Button>
      )}
    </div>
  );
}
