// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  GitBranch,
  Home,
  LoaderCircle,
  Monitor,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { codingApi } from "./api";
import {
  createProjectFolderBrowser,
  displayedDirectory,
} from "./project-folder-browser";
import { projectName } from "./project-name";
import type { RecentProject } from "./project-picker";

const folderRowClass =
  "flex h-10 min-w-0 items-center gap-2.5 rounded-full px-3 text-sm font-normal";

export function ProjectFolderDialog({
  open,
  onOpenChange,
  onRestoreFocus,
  onSelect,
  project,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestoreFocus: () => void;
  onSelect: (path: string) => void;
  project: string | null;
  projects: RecentProject[];
}) {
  const [browser] = useState(() =>
    createProjectFolderBrowser(codingApi.browseProjects),
  );
  const state = useSyncExternalStore(browser.subscribe, browser.getSnapshot);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) browser.browse(project ?? "~");
    return () => browser.close();
  }, [browser, open, project]);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const directory = displayedDirectory(state);
  const ready = state.status === "ready";
  const selected = ready && !state.directory.filter ? state.directory : null;
  const entries = directory?.entries ?? [];
  const highlighted = ready ? entries[active] : undefined;
  const SelectionIcon = selected?.is_git ? GitBranch : Folder;
  const parent = directory?.filter ? directory.path : directory?.parent;
  const navigate = (path: string) => {
    setActive(-1);
    browser.browse(path);
    input.current?.focus();
  };
  const close = (next: boolean) => {
    if (!next) {
      browser.close();
      setActive(-1);
    }
    onOpenChange(next);
  };
  const choose = () => {
    // Read the current owner as well as the rendered selection: an edit may be batched.
    const current = browser.getSnapshot();
    if (current.status !== "ready" || current.directory.filter) return;
    onSelect(current.directory.path);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex flex-col gap-5 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader className="gap-1.5 pr-7">
          <DialogTitle>Choose a project folder</DialogTitle>
          <DialogDescription>Folders on your Studio host</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Go to parent folder"
            disabled={!ready || !parent}
            onClick={() => {
              if (parent) navigate(parent);
            }}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <div className="relative min-w-0 flex-1">
            <Folder
              className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={input}
              id="coding-host-path"
              value={state.query}
              aria-label="Folder path"
              role="combobox"
              aria-controls="coding-host-folders"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                highlighted ? `coding-host-folder-${active}` : undefined
              }
              aria-describedby="coding-folder-status"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Type or paste a folder path…"
              className="h-10 rounded-xl border-0 bg-muted/60 pr-10 pl-10 focus-visible:ring-2 focus-visible:ring-ring/20"
              onChange={(event) => {
                setActive(-1);
                browser.browse(event.target.value, { debounce: true });
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (
                  event.altKey &&
                  event.key === "ArrowUp" &&
                  ready &&
                  parent
                ) {
                  event.preventDefault();
                  navigate(parent);
                  return;
                }
                if (
                  (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                  ready &&
                  entries.length
                ) {
                  event.preventDefault();
                  setActive((index) =>
                    event.key === "ArrowDown"
                      ? (index + 1) % entries.length
                      : index <= 0
                        ? entries.length - 1
                        : index - 1,
                  );
                } else if (event.key === "Tab" && !event.shiftKey && ready) {
                  const completion =
                    highlighted ??
                    (directory?.filter && entries.length === 1
                      ? entries[0]
                      : undefined);
                  if (completion) {
                    event.preventDefault();
                    navigate(completion.path);
                  }
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.ctrlKey || event.metaKey) choose();
                  else if (highlighted) navigate(highlighted.path);
                  else if (selected) choose();
                  else if (ready && entries.length === 1)
                    navigate(entries[0].path);
                }
              }}
            />
            {state.status === "loading" && (
              <LoaderCircle
                className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[8rem_minmax(0,1fr)] gap-2 rounded-2xl bg-muted/35 p-2 sm:h-88 sm:flex-none sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
          <nav
            className="flex min-h-0 min-w-0 flex-col"
            aria-label="Folder shortcuts"
          >
            <p className="flex h-8 shrink-0 items-center px-3 text-xs text-muted-foreground">
              Places
            </p>
            <Button
              variant="ghost"
              className={cn(folderRowClass, "w-full shrink-0 justify-start")}
              aria-label="Go to home folder"
              onClick={() => navigate("~")}
            >
              <Home
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              Home
            </Button>
            <p className="mt-2 flex h-8 shrink-0 items-center px-3 text-xs text-muted-foreground">
              Recent projects
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {projects.map((item) => {
                const current = selected?.path === item.cwd;
                const git =
                  (directory?.path === item.cwd && directory.is_git) ||
                  entries.some(
                    (entry) => entry.path === item.cwd && entry.is_git,
                  );
                const Icon = git ? GitBranch : Folder;
                return (
                  <Button
                    key={item.cwd}
                    variant="ghost"
                    className={cn(
                      folderRowClass,
                      "w-full justify-start",
                      current && "bg-accent",
                    )}
                    title={item.cwd}
                    onClick={() => navigate(item.cwd)}
                  >
                    <Icon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{item.name}</span>
                  </Button>
                );
              })}
              {!projects.length && (
                <p className="px-3 text-xs leading-relaxed text-muted-foreground">
                  Your project folders will appear here.
                </p>
              )}
            </div>
            <p className="mt-2 flex h-8 shrink-0 items-center px-3 text-xs text-muted-foreground">
              Devices
            </p>
            <div
              className={cn(folderRowClass, "shrink-0")}
              aria-label="Current device: Studio host"
              title="The machine running Studio"
            >
              <Monitor
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">Studio host</span>
            </div>
          </nav>
          <section
            className="flex min-h-0 min-w-0 flex-col"
            aria-label="Host folder browser"
          >
            <div className="flex h-8 shrink-0 items-center justify-between px-3 text-xs text-muted-foreground">
              <span>{directory?.filter ? "Matching folders" : "Folders"}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={
                  state.hidden ? "Hide hidden folders" : "Show hidden folders"
                }
                aria-pressed={state.hidden}
                title={
                  state.hidden ? "Hide hidden folders" : "Show hidden folders"
                }
                onClick={() => {
                  setActive(-1);
                  browser.browse(state.query, { hidden: !state.hidden });
                }}
              >
                {state.hidden ? (
                  <Eye aria-hidden="true" />
                ) : (
                  <EyeOff aria-hidden="true" />
                )}
              </Button>
            </div>
            <div
              ref={list}
              id="coding-host-folders"
              role="listbox"
              aria-label="Host folders"
              aria-busy={state.status === "loading"}
              className={cn(
                "min-h-0 flex-1 overflow-y-auto",
                state.status === "loading" && "opacity-50",
              )}
            >
              {state.status === "error" ? (
                <p
                  role="alert"
                  className="px-3 py-8 text-sm leading-relaxed text-muted-foreground"
                >
                  {state.message}
                </p>
              ) : (
                entries.map((entry, index) => {
                  const Icon = entry.is_git ? GitBranch : Folder;
                  return (
                    <div
                      key={entry.path}
                      id={`coding-host-folder-${index}`}
                      role="option"
                      aria-selected={ready && active === index}
                      aria-disabled={!ready}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (ready) navigate(entry.path);
                      }}
                      title={entry.path}
                      className={cn(
                        folderRowClass,
                        ready
                          ? "cursor-pointer hover:bg-accent"
                          : "pointer-events-none",
                        ready && active === index && "bg-accent",
                      )}
                    >
                      <Icon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {entry.name}
                      </span>
                      {entry.is_git && (
                        <span className="hidden text-[10px] text-muted-foreground sm:inline">
                          Git
                        </span>
                      )}
                      <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                  );
                })
              )}
              {ready && !entries.length && (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  <Folder
                    className="mx-auto mb-3 size-5 opacity-60"
                    aria-hidden="true"
                  />
                  <p>
                    {directory?.filter
                      ? "No matching folders"
                      : "No subfolders"}
                  </p>
                  <p className="mt-1 text-xs">
                    {directory?.filter
                      ? "Try another name or go to the parent folder."
                      : "You can still use this folder."}
                  </p>
                </div>
              )}
            </div>
            <p
              id="coding-folder-status"
              role="status"
              className="min-h-5 shrink-0 px-3 pt-1 text-[11px] leading-4 text-muted-foreground"
            >
              {state.status === "loading"
                ? "Finding folders…"
                : ready
                  ? directory?.truncated
                    ? "More folders available. Type a name to narrow the list."
                    : `${entries.length} ${entries.length === 1 ? "folder" : "folders"}`
                  : ""}
            </p>
          </section>
        </div>
        <DialogFooter className="shrink-0 flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          <div className="flex min-h-10 min-w-0 flex-1 items-center gap-3 px-1">
            <SelectionIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {selected ? projectName(selected.path) : "Choose a folder"}
              </p>
              <p
                data-testid="coding-browsed-path"
                title={selected?.path}
                className="truncate text-xs text-muted-foreground"
              >
                {selected?.path ??
                  (directory?.filter
                    ? `Matching in ${directory.path}`
                    : "Type a path or open a folder above")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button disabled={!selected} onClick={choose}>
              Use this folder{" "}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
