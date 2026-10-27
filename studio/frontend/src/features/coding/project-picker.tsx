// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { NonModalDropdownMenu } from "@/components/ui/non-modal-dropdown-menu";
import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderSearch,
} from "lucide-react";
import type { RefObject } from "react";
import type { CodingConversation } from "./types";

export interface RecentProject {
  cwd: string;
  name: string;
  parent: string;
}

const splitPath = (cwd: string) => {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return {
    name: trimmed.slice(cut + 1) || cwd,
    parent: cut > 0 ? trimmed.slice(0, cut) : "",
  };
};

/** The chosen folder first, then distinct folders of saved conversations, newest first. */
export function recentProjects(
  conversations: readonly CodingConversation[],
  chosen: string | null = null,
  limit = 8,
): RecentProject[] {
  const seen = new Set<string>();
  const projects: RecentProject[] = [];
  for (const cwd of [
    ...(chosen ? [chosen] : []),
    ...conversations.map((item) => item.cwd),
  ]) {
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push({ cwd, ...splitPath(cwd) });
    if (projects.length === limit) break;
  }
  return projects;
}

/** The new conversation's folder: a remembered choice, not an opened conversation. */
export function ProjectPicker({
  triggerRef,
  project,
  projects,
  disabled,
  onSelect,
  onBrowse,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  project: string | null;
  projects: RecentProject[];
  disabled: boolean;
  onSelect: (cwd: string) => void;
  onBrowse: (invoker: HTMLElement) => void;
}) {
  return (
    <NonModalDropdownMenu
      side="top"
      align="end"
      className="w-[min(18rem,calc(100vw-2rem))]"
      trigger={(menuRef) => (
        <button
          ref={(node) => {
            menuRef.current = node;
            triggerRef.current = node;
          }}
          type="button"
          data-testid="coding-project-chooser"
          disabled={disabled}
          title={project ?? "Choose the folder Mimir works in"}
          aria-label={
            project ? `Project folder: ${project}` : "Choose project folder"
          }
          className={`flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-accent ${project ? "text-muted-foreground" : "text-foreground"}`}
        >
          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {project ? splitPath(project).name : "Choose folder"}
          </span>
          <ChevronDown
            className="size-3 shrink-0 opacity-60"
            aria-hidden="true"
          />
        </button>
      )}
    >
      {projects.length > 0 && (
        <>
          <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Projects
          </DropdownMenuLabel>
          {projects.map((item) => (
            <DropdownMenuItem
              key={item.cwd}
              title={item.cwd}
              onSelect={() => onSelect(item.cwd)}
            >
              <FolderOpen aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name}</span>
                {item.parent && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.parent}
                  </span>
                )}
              </span>
              {item.cwd === project && (
                <Check className="ml-auto" aria-label="Selected" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem
        onSelect={() => {
          if (triggerRef.current) onBrowse(triggerRef.current);
        }}
      >
        <FolderSearch aria-hidden="true" />
        Choose folder…
      </DropdownMenuItem>
    </NonModalDropdownMenu>
  );
}
