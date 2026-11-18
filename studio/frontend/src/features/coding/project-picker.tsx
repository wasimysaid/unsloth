// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { ChevronDown, Folder } from "lucide-react";
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

/** Open the folder browser directly; recent projects live in the same dialog. */
export function ProjectPicker({
  triggerRef,
  project,
  disabled,
  onBrowse,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  project: string | null;
  disabled: boolean;
  onBrowse: (invoker: HTMLElement) => void;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      data-testid="coding-project-chooser"
      disabled={disabled}
      title={project ?? "Choose the folder Mimir works in"}
      aria-label={
        project ? `Project folder: ${project}` : "Choose project folder"
      }
      aria-haspopup="dialog"
      onClick={(event) => onBrowse(event.currentTarget)}
      className="flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      <Folder className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {project ? splitPath(project).name : "Choose folder"}
      </span>
      <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
    </button>
  );
}
