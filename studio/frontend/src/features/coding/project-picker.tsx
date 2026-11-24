// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { NonModalDropdownMenu } from "@/components/ui/non-modal-dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Search,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { codingRequest } from "./api";
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

interface LocalCheckout {
  cwd: string;
  branch: string | null;
  head: string;
  current: boolean;
}

function BranchSearch({
  project,
  checkouts,
  onSelect,
  onClose,
  triggerRef,
}: {
  project: string;
  checkouts: LocalCheckout[];
  onSelect: (cwd: string) => void;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const result = await codingRequest(
        `/projects/branches?${new URLSearchParams({ path: project })}`,
        { signal: controller.signal },
      );
      const names: string[] = await result.json();
      if (!controller.signal.aborted) {
        setBranches(names);
        setStatus("ready");
      }
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setStatus("failed");
    });
    return () => controller.abort();
  }, [project]);
  const rows = useMemo(() => {
    const checked = new Set(checkouts.map((item) => item.branch));
    return [
      ...checkouts.map((item) => ({
        name: item.branch ?? `Detached · ${item.head}`,
        checkout: item,
      })),
      ...branches
        .filter((name) => !checked.has(name))
        .map((name) => ({ name, checkout: null })),
    ];
  }, [branches, checkouts]);
  const needle = query.trim().toLowerCase();
  const matches = rows.filter((row) => row.name.toLowerCase().includes(needle));
  const limit = 50;
  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Search branches"
      description="Choose a local checkout for this project."
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        triggerRef.current?.focus();
      }}
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search branches…"
          aria-label="Search branches"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandGroup heading="Local branches">
            {matches.slice(0, limit).map(({ name, checkout }) => (
              <CommandItem
                key={checkout?.cwd ?? name}
                value={checkout?.cwd ?? name}
                disabled={!checkout}
                data-checked={checkout?.current}
                onSelect={() => {
                  if (checkout) {
                    onClose();
                    if (!checkout.current) onSelect(checkout.cwd);
                  }
                }}
              >
                <GitBranch />
                <span className="min-w-0 truncate">{name}</span>
                {!checkout && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    No checkout
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
        {(status !== "ready" || !matches.length || matches.length > limit) && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            {status === "failed"
              ? "Couldn’t read other local branches."
              : status === "loading"
                ? "Reading branches…"
                : !matches.length
                  ? "No matching branches"
                  : `Showing ${limit} of ${matches.length}. Type to narrow the list.`}
          </p>
        )}
      </Command>
    </CommandDialog>
  );
}

function LocalCheckouts({
  project,
  onSelect,
  onSearch,
}: {
  project: string;
  onSelect: (cwd: string) => void;
  onSearch: (items: LocalCheckout[]) => void;
}) {
  const [checkouts, setCheckouts] = useState<LocalCheckout[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const result = await codingRequest(
        `/projects/checkouts?${new URLSearchParams({ path: project })}`,
        { signal: controller.signal },
      );
      const rows: LocalCheckout[] = await result.json();
      if (!controller.signal.aborted) setCheckouts(rows);
    }
    void load().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [project]);
  if (failed)
    return <DropdownMenuLabel>Couldn’t read local checkouts</DropdownMenuLabel>;
  if (!checkouts.length) return null;
  return (
    <DropdownMenuGroup className="mt-1">
      <DropdownMenuLabel>Local checkouts</DropdownMenuLabel>
      <div className="max-h-44 overflow-y-auto">
        {checkouts.slice(0, 3).map((item) => (
          <DropdownMenuItem
            key={item.cwd}
            title={item.cwd}
            aria-current={item.current || undefined}
            textValue={item.branch ?? item.head}
            onSelect={() => {
              if (!item.current) onSelect(item.cwd);
            }}
          >
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {item.branch ?? `Detached · ${item.head}`}
            </span>
            {item.current && (
              <Check
                aria-label="Current checkout"
                className="ml-auto size-3.5 shrink-0"
              />
            )}
          </DropdownMenuItem>
        ))}
      </div>
      <DropdownMenuItem onSelect={() => onSearch(checkouts)}>
        <Search className="size-4 text-muted-foreground" /> Search branches…
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

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
  onSelect,
  onBrowse,
  disabled,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  project: string | null;
  onSelect: (cwd: string | null) => void;
  onBrowse: (invoker: HTMLElement) => void;
  disabled: boolean;
}) {
  // Set when a row opens the folder browser, so closing the menu leaves focus with that dialog.
  const browsing = useRef(false);
  const [search, setSearch] = useState<LocalCheckout[] | null>(null);
  const browse = () => {
    browsing.current = true;
    if (triggerRef.current) onBrowse(triggerRef.current);
  };
  const name = project ? projectName(project) : null;
  return (
    <>
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
        {project && (
          <LocalCheckouts
            key={project}
            project={project}
            onSelect={onSelect}
            onSearch={(items) => {
              browsing.current = true;
              setSearch(items);
            }}
          />
        )}
        <DropdownMenuGroup className="mt-1">
          <DropdownMenuItem onSelect={browse} className="gap-2.5 py-1.5">
            <FolderSearch
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            <span className="text-ui-13">Open folder…</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </NonModalDropdownMenu>
      {search && project && (
        <BranchSearch
          project={project}
          checkouts={search}
          triggerRef={triggerRef}
          onSelect={onSelect}
          onClose={() => setSearch(null)}
        />
      )}
    </>
  );
}
