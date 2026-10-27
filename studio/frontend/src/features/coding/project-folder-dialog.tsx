// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useState } from "react";
import { ArrowUp, ChevronRight, Folder, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CodingSession, CodingSessionState } from "./session";

/** Host folder browser. Choosing only selects where the next conversation runs. */
export function ProjectFolderDialog({
  open,
  onOpenChange,
  onRestoreFocus,
  onSelect,
  session,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestoreFocus: () => void;
  onSelect: (path: string) => void;
  session: CodingSession;
  state: CodingSessionState;
}) {
  const [path, setPath] = useState("");
  useEffect(() => {
    if (state.directory) setPath(state.directory.path);
  }, [state.directory]);

  const close = (next: boolean) => {
    if (!next) session.cancelBrowse();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          // This controlled dialog has multiple invokers and no DialogTrigger.
          // Restore the actual invoker instead of Radix's absent-trigger fallback.
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Mimir works directly in this folder on the Studio host. It isn't a
            sandbox: the folder's project settings and extensions are trusted
            for that conversation only.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void session.browse(path);
          }}
        >
          <label htmlFor="coding-host-path" className="text-sm font-medium">
            Host folder path
          </label>
          <div className="flex gap-2">
            <Input
              id="coding-host-path"
              value={path}
              onChange={(event) => {
                // A late directory response must never replace a newer typed
                // choice or enable opening the folder the user just edited away.
                session.cancelBrowse();
                setPath(event.target.value);
              }}
              placeholder="Enter a host folder path"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" variant="outline" disabled={state.browsing}>
              Browse
            </Button>
          </div>
        </form>
        <div className="min-h-32 space-y-2" aria-busy={state.browsing}>
          {state.browsing && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />{" "}
              Loading host folders…
            </p>
          )}
          {state.browseError && (
            <p role="alert" className="break-words text-sm text-destructive">
              {state.browseError}
            </p>
          )}
          {state.directory && (
            <>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Go to parent folder"
                  disabled={state.directory.parent === null}
                  onClick={() => {
                    if (state.directory?.parent)
                      void session.browse(state.directory.parent);
                  }}
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </Button>
                <p
                  className="min-w-0 break-all font-mono text-xs"
                  data-testid="coding-browsed-path"
                >
                  {state.directory.path}
                </p>
              </div>
              <ul
                className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-border p-2"
                aria-label="Host folders"
              >
                {state.directory.entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() => void session.browse(entry.path)}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <Folder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 break-all">
                        {entry.name}
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
                {state.directory.entries.length === 0 && (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    No subfolders
                  </li>
                )}
              </ul>
              {state.directory.truncated && (
                <p className="text-xs text-muted-foreground">
                  Only the first folders are shown. Enter a path to go further.
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              !state.directory ||
              path !== state.directory.path ||
              state.browsing
            }
            onClick={() => {
              if (!state.directory || path !== state.directory.path) return;
              onSelect(state.directory.path);
              session.cancelBrowse();
              onOpenChange(false);
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
