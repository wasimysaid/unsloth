// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { codingCanContinue, codingInterruptedRequest } from "./run-session";
import type { CodingRun, CodingRunState } from "./run-session";

export function CodingRecoveryControls({
  state,
  run,
}: { state: CodingRunState; run: CodingRun | null }) {
  const interrupted = codingInterruptedRequest(state);
  if (!interrupted && !state.continuationRequested) return null;
  return (
    <div className="space-y-2" data-testid="coding-interrupted-recovery">
      <p role="status" className="break-words">
        {interrupted
          ? "Interrupted · native work did not finish. Saved history and configured provider/model are retained; no accepted prompt, answer or command is replayed."
          : "Continuation requested as a new native admission; inspect native request status above."}
      </p>
      <p id="coding-continuation-explanation" className="text-muted-foreground">
        Continue sends a new keyed prompt asking Mimir to review saved history
        and current project state first. This is not Retry same submission,
        which only reconciles uncertain delivery.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-auto whitespace-normal text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        data-testid="coding-continue-interrupted"
        aria-describedby="coding-continuation-explanation"
        aria-disabled={!codingCanContinue(state)}
        onClick={() => {
          if (codingCanContinue(state)) void run?.continueInterruptedWork();
        }}
      >
        Continue interrupted work
      </Button>
      {state.continuationRequested && (
        <p role="status">
          Continuation requested explicitly. No second continuation is sent
          automatically.
        </p>
      )}
    </div>
  );
}
