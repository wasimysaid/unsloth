// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { NonModalDropdownMenu } from "@/components/ui/non-modal-dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderSearch,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { useRef, type RefObject } from "react";
import type { CodingConversation } from "./types";
import { projectName } from "./project-name";

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
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push({ cwd, ...splitPath(cwd) });
    if (projects.length === limit) break;
  }
  return projects;
}

const RECENT_LIMIT = 3;

function ModeRow({
  icon: Icon,
  label,
  detail,
  active,
  title,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  active: boolean;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      title={title}
      aria-current={active ? "true" : undefined}
      className={cn("items-start gap-2.5 py-2", active && "font-medium")}
    >
      <Icon
        aria-hidden="true"
        className="mt-[calc(0.14rem*var(--ui-font-scale,1))] size-4 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-13 leading-tight">{label}</span>
        <span className="truncate text-xs font-normal leading-snug text-muted-foreground">
          {detail}
        </span>
      </span>
      {active ? (
        <Check aria-hidden="true" className="size-4 self-center" />
      ) : null}
    </DropdownMenuItem>
  );
}

export function ProjectPicker({
  triggerRef,
  project,
  projects,
  onSelect,
  onBrowse,
  disabled,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  project: string | null;
  projects: readonly RecentProject[];
  onSelect: (cwd: string | null) => void;
  onBrowse: (invoker: HTMLElement) => void;
  disabled: boolean;
}) {
  // Set when a row opens the folder browser, so closing the menu leaves focus with that dialog.
  const browsing = useRef(false);
  const browse = () => {
    browsing.current = true;
    if (triggerRef.current) onBrowse(triggerRef.current);
  };
  const name = project ? projectName(project) : null;
  // The open project already heads the menu; recents offer somewhere else to go.
  const recents = projects
    .filter((item) => item.cwd !== project)
    .slice(0, RECENT_LIMIT);

  return (
    <NonModalDropdownMenu
      side="top"
      align="end"
      sideOffset={6}
      aria-label="Project mode"
      className="unsloth-plus-menu w-[calc(17rem*var(--ui-space-scale,1))]"
      onCloseAutoFocus={(event) => {
        if (!browsing.current) return;
        browsing.current = false;
        event.preventDefault();
      }}
      trigger={(ref) => (
        <button
          ref={(element) => {
            ref.current = element;
            triggerRef.current = element;
          }}
          type="button"
          data-testid="coding-project-chooser"
          disabled={disabled}
          title={project ?? "No project selected"}
          aria-label={
            project
              ? `Project: ${project}. Change project mode`
              : "No project. Change project mode"
          }
          className="flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          {project ? (
            <Folder className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{name ?? "No project"}</span>
          <ChevronDown
            className="size-3 shrink-0 opacity-60"
            aria-hidden="true"
          />
        </button>
      )}
    >
      <ModeRow
        icon={FolderOpen}
        label={name ? `Project · ${name}` : "Work in a project"}
        detail={project ?? "Read and edit files in a folder"}
        title={project ?? undefined}
        active={project !== null}
        // Already in one: keep it. Otherwise a folder has to be picked first.
        onSelect={() => {
          if (!project) browse();
        }}
      />
      <ModeRow
        icon={MessageSquare}
        label="No project"
        detail="Chat without choosing a folder"
        active={project === null}
        onSelect={() => {
          if (project) onSelect(null);
        }}
      />
      <DropdownMenuGroup className="mt-2">
        {recents.length > 0 ? (
          <DropdownMenuLabel className="pb-1 pt-1.5">Recent</DropdownMenuLabel>
        ) : null}
        {recents.map((item) => (
          <DropdownMenuItem
            key={item.cwd}
            title={item.cwd}
            onSelect={() => onSelect(item.cwd)}
            className="gap-2.5 py-1.5"
          >
            <Folder
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            <span className="min-w-0 truncate text-ui-13">{item.name}</span>
            {item.parent ? (
              <span className="ml-auto min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground">
                {projectName(item.parent)}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={browse} className="gap-2.5 py-1.5">
          <FolderSearch
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
          <span className="text-ui-13">Open folder…</span>
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </NonModalDropdownMenu>
  );
}
