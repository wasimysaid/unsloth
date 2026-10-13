// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ProjectOverlap } from "./run-types";

/** A per-submission warning, not an ownership or filesystem control. */
export function ProjectOverlapDialog({
  overlap,
  disabled,
  onContinue,
  onCancel,
  onCloseFocus,
}: {
  overlap: ProjectOverlap | null;
  disabled: boolean;
  onContinue: () => void;
  onCancel: () => void;
  onCloseFocus: () => void;
}) {
  return (
    <AlertDialog
      open={Boolean(overlap)}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Other work is active in this project
          </AlertDialogTitle>
          <AlertDialogDescription>
            Another coding conversation is working in the same canonical project
            folder. Your prompt has not been admitted. Continue only if you
            intend to overlap this work.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-w-0 space-y-3 text-sm">
          <p
            className="break-all rounded-lg bg-muted p-3 font-mono text-xs"
            data-testid="coding-overlap-cwd"
          >
            {overlap?.cwd}
          </p>
          <details className="min-w-0 rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {overlap?.conversations.length ?? 0} other active coding
              conversation(s)
            </summary>
            <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto break-all font-mono text-xs">
              {overlap?.conversations.map(({ id }) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </details>
          <p className="text-muted-foreground">
            This warning is not a filesystem lock, sandbox, or comprehensive
            nested-workspace detector. It does not grant authority over another
            owner or guarantee absence of file conflicts. Native capacity limits
            and conversation execution leases still apply.
          </p>
          {disabled && (
            <output className="block">
              Wait for the connected native view before continuing. You can
              cancel this prompt now.
            </output>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            Cancel prompt
          </AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={onContinue}>
            Continue anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
