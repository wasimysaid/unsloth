// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import type { RefObject } from "react";
import type { CodingConversation } from "./types";

export interface RecentProject {
  cwd: string;
  name: string;
  parent: string;
}

/** Distinct native canonical folders of saved conversations, newest first. */
export function recentProjects(
  conversations: readonly CodingConversation[],
  limit = 8,
): RecentProject[] {
  const seen = new Set<string>();
  const projects: RecentProject[] = [];
  for (const { cwd } of conversations) {
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    const trimmed = cwd.replace(/[\\/]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    projects.push({
      cwd,
      name: trimmed.slice(cut + 1) || cwd,
      parent: cut > 0 ? trimmed.slice(0, cut) : "",
    });
    if (projects.length === limit) break;
  }
  return projects;
}

/** Project selection in the landing composer. Choosing creates a native
 * conversation there and carries the typed text into it. */
export function ProjectChooser({
  triggerRef,
  projects,
  disabled,
  onChoose,
  onBrowse,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  projects: RecentProject[];
  disabled: boolean;
  onChoose: (cwd: string) => void;
  onBrowse: (invoker: HTMLElement) => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild={true}>
        <button
          ref={triggerRef}
          type="button"
          data-testid="coding-project-chooser"
          disabled={disabled}
          aria-describedby="coding-project-disclosure"
          className="flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-full bg-muted px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-accent dark:bg-accent"
        >
          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">Choose project</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="unsloth-plus-menu w-[calc(288px*var(--ui-space-scale,1))]"
      >
        {projects.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
              Recent projects
            </DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.cwd}
                title={project.cwd}
                onSelect={() => onChoose(project.cwd)}
              >
                <FolderOpen aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate">{project.name}</span>
                  {project.parent && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.parent}
                    </span>
                  )}
                </span>
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
          <Folder aria-hidden="true" />
          Choose project folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
