// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranchPlus,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ProjectFileIcon } from "./project-file-icons";
import { GitReviewDiff } from "./git-review-diff";
import type { LineSelection } from "./git-review-lines";
import {
  addReviewToComposer,
  gitWorkspace,
  openGitWorkspace,
  type GitChanges,
  type GitComment,
  type GitComparison,
  type GitFile,
  type GitPatch,
  type GitWorkspace,
} from "./git-workspace-api";
import type { CodingConversation } from "./types";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn’t read Git changes.";
const fileKey = (file: GitFile) =>
  JSON.stringify([file.status, file.path, file.old_path]);
const statusLabel: Record<string, string> = {
  added: "A",
  untracked: "U",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  conflicted: "!",
  type_changed: "T",
};

interface ReviewNote {
  comparison: GitComparison;
  anchor: GitComment;
  location: string;
}

function NewWorktree({
  conversation,
  workspace,
}: { conversation: CodingConversation; workspace: GitWorkspace }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          title="New worktree"
          aria-label="New worktree"
          disabled={!workspace.head}
        >
          <GitBranchPlus />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={7}
        className="unsloth-plus-menu gap-3"
      >
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await openGitWorkspace(conversation, id);
              setOpen(false);
            } catch (reason) {
              setError(message(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h3 className="text-sm font-medium">New worktree</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Start a conversation from{" "}
            <strong className="font-medium text-foreground">
              {workspace.branch || workspace.head?.slice(0, 7)}
            </strong>
            . Local edits stay in this checkout.
          </p>
          <label htmlFor={inputId} className="grid gap-1.5 text-xs font-medium">
            Worktree name
            <Input
              id={inputId}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="fix-parser"
              pattern="[a-z0-9][a-z0-9\-]{0,63}"
              maxLength={64}
              required
              title="Lowercase letters, numbers and hyphens"
              disabled={busy}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button
            type="submit"
            size="sm"
            variant="dark"
            disabled={busy || !id.trim()}
          >
            {busy && <LoaderCircle className="animate-spin" />} Open worktree
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function GitReviewPanel({
  conversation,
  workspace,
  visible,
  onChangeCount,
  refreshKey = 0,
}: {
  conversation: CodingConversation;
  workspace: GitWorkspace;
  visible: boolean;
  onChangeCount?: (count: number, comparison: GitComparison) => void;
  refreshKey?: number;
}) {
  const api = useMemo(() => gitWorkspace(conversation), [conversation]);
  const [comparison, setComparison] = useState<GitComparison>(
    workspace.base ? "task" : "uncommitted",
  );
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [selected, setSelected] = useState<string | null | undefined>(
    undefined,
  );
  const [patch, setPatch] = useState<GitPatch | null>(null);
  const [patchError, setPatchError] = useState("");
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState("");
  const [paging, setPaging] = useState(false);
  const [notes, setNotes] = useState<(ReviewNote & { id: number })[]>([]);
  const nextNoteId = useRef(0);
  const [editing, setEditing] = useState<
    (ReviewNote & { selection: LineSelection }) | null
  >(null);
  const [showNotes, setShowNotes] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState("");
  const listVersion = useRef(0);
  const firstFile = changes?.files[0];
  const key =
    selected === undefined && firstFile ? fileKey(firstFile) : selected;
  const file = changes?.files.find((item) => fileKey(item) === key);
  const refreshList = useCallback(() => {
    const version = ++listVersion.current;
    setPaging(false);
    setListError("");
    api
      .changes(comparison)
      .then((result) => {
        if (version === listVersion.current) {
          setChanges(result);
          onChangeCount?.(result.total, comparison);
        }
      })
      .catch((error) => {
        if (version === listVersion.current) setListError(message(error));
      });
  }, [api, comparison, onChangeCount]);
  // An admitted turn settling can change files without any browser interaction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey represents a newly settled turn.
  useEffect(() => {
    if (visible) refreshList();
    return () => {
      listVersion.current++;
    };
  }, [visible, refreshList, refreshKey]);

  useEffect(() => {
    if (!file) return;
    let current = true;
    setPatch(null);
    setPatchError("");
    api
      .patch(comparison, file)
      .then((result) => {
        if (current) setPatch(result);
      })
      .catch((error) => {
        if (current) setPatchError(message(error));
      });
    return () => {
      current = false;
    };
  }, [api, comparison, file]);

  async function loadMore() {
    const offset = changes?.next_offset;
    if (offset == null || paging) return;
    const version = listVersion.current;
    setPaging(true);
    try {
      const next = await api.changes(comparison, offset);
      if (version === listVersion.current)
        setChanges(
          (prior) =>
            prior && {
              ...next,
              files: [
                ...new Map(
                  [...prior.files, ...next.files].map((f) => [fileKey(f), f]),
                ).values(),
              ],
            },
        );
    } catch (error) {
      if (version === listVersion.current) setActionError(message(error));
    } finally {
      if (version === listVersion.current) setPaging(false);
    }
  }
  async function addToChat() {
    setPreparing(true);
    setActionError("");
    setNotice("");
    try {
      const groups = (["task", "uncommitted"] as const)
        .map((scope) => ({
          scope,
          comments: notes
            .filter((n) => n.comparison === scope)
            .map((n) => n.anchor),
        }))
        .filter((group) => group.comments.length);
      const drafts = await Promise.all(
        groups.map((g) => api.feedback(g.scope, g.comments)),
      );
      addReviewToComposer(conversation, drafts.map((d) => d.text).join("\n\n"));
      setNotes([]);
      setShowNotes(false);
      setNotice(
        drafts.some((d) => d.stale_count)
          ? "Added to chat with earlier line excerpts."
          : "Added to chat.",
      );
    } catch (error) {
      setActionError(message(error));
    } finally {
      setPreparing(false);
    }
  }
  const editingInline =
    editing &&
    file &&
    patch?.kind === "text" &&
    editing.comparison === comparison &&
    editing.anchor.path === file.path &&
    editing.anchor.revision === patch.revision &&
    !listError &&
    !patchError;
  function finishComment(from: HTMLElement) {
    const line = editing?.anchor.start_line;
    if (line)
      from
        .closest("[data-git-patch]")
        ?.querySelector<HTMLButtonElement>(`[data-patch-line="${line - 1}"]`)
        ?.focus({ preventScroll: true });
    setEditing(null);
  }
  const commentForm = editing && (
    <form
      aria-label="Line comment"
      className="flex items-start gap-2 px-3 py-2 font-sans text-sm text-foreground"
      onSubmit={(e) => {
        e.preventDefault();
        if (!editing.anchor.comment.trim() || notes.length >= 12 || preparing)
          return;
        const id = nextNoteId.current++;
        setNotes((previous) => [
          ...previous,
          {
            id,
            comparison: editing.comparison,
            location: editing.location,
            anchor: editing.anchor,
          },
        ]);
        finishComment(e.currentTarget);
        setNotice("");
      }}
    >
      <MessageSquare
        className="mt-1 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {!editingInline && (
          <div className="truncate text-xs text-muted-foreground">
            {editing.anchor.path}:{editing.location}
          </div>
        )}
        <textarea
          aria-label="Review comment"
          placeholder="Comment on this line…"
          rows={1}
          dir="auto"
          className="block field-sizing-content max-h-36 min-h-7 w-full resize-none bg-transparent py-0.5 leading-5 outline-none placeholder:text-muted-foreground"
          value={editing.anchor.comment}
          onChange={(event) =>
            setEditing({
              ...editing,
              anchor: { ...editing.anchor, comment: event.target.value },
            })
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          required
        />
        <div className="flex items-center gap-1">
          <Button
            type="submit"
            variant="secondary"
            size="xs"
            disabled={
              !editing.anchor.comment.trim() || preparing || notes.length >= 12
            }
          >
            Add comment
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={(event) => finishComment(event.currentTarget)}
          >
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col text-foreground"
      data-testid="git-review-panel"
    >
      <div className="flex min-w-0 items-center gap-1 px-3 pt-3 pb-2">
        {workspace.base ? (
          <Select
            value={comparison}
            onValueChange={(value) => {
              setComparison(value as GitComparison);
              setChanges(null);
              setPatch(null);
              setSelected(undefined);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Compare changes"
              className="h-7 gap-2 border-0 bg-muted/55 px-2.5 text-xs"
            >
              <GitCompareArrows />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="task">Since task started</SelectItem>
              <SelectItem value="uncommitted">Working tree</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="flex items-center gap-2 px-1 text-xs font-medium">
            <GitCompareArrows className="size-4 text-muted-foreground" />
            Working tree
          </span>
        )}
        <div className="ml-auto flex items-center gap-1 text-muted-foreground">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh changes"
            title="Refresh changes"
            onClick={refreshList}
          >
            <RefreshCw />
          </Button>
          <NewWorktree conversation={conversation} workspace={workspace} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {listError ? (
          <div role="alert" className="p-4 text-xs text-destructive">
            {listError}
          </div>
        ) : !changes ? (
          <output className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            Reading changes…
          </output>
        ) : changes.total === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 pb-6 text-center">
            <Check className="size-5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {comparison === "task"
                ? "No changes since this task started"
                : "Working tree is clean"}
            </p>
          </div>
        ) : (
          <>
            <div className="px-4 pt-1 pb-2 text-[11px] font-medium text-muted-foreground">
              {changes.total} changed {changes.total === 1 ? "file" : "files"}
            </div>
            {changes.files.map((item) => {
              const id = fileKey(item);
              const expanded = id === key;
              const slash = item.path.lastIndexOf("/");
              const current = editing?.anchor;
              const marking =
                current &&
                editing.comparison === comparison &&
                patch?.kind === "text" &&
                current.revision === patch.revision &&
                current.path === item.path
                  ? editing.selection
                  : undefined;
              return (
                <div key={id} className="min-w-0">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    title={
                      item.old_path
                        ? `${item.old_path} → ${item.path}`
                        : item.path
                    }
                    onClick={() => {
                      setSelected(expanded ? null : id);
                      setPatch(null);
                      setPatchError("");
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 px-4 py-2 text-left text-xs transition-colors hover:bg-accent/60 focus-visible:outline-offset-[-2px]",
                      expanded && "coding-wash-faint",
                    )}
                  >
                    {expanded ? (
                      <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <ProjectFileIcon path={item.path} />
                    <span className="truncate font-medium">
                      {item.path.slice(slash + 1)}
                    </span>
                    {slash >= 0 && (
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {item.path.slice(0, slash)}
                      </span>
                    )}
                    <span
                      aria-label={item.status}
                      title={item.status}
                      className={cn(
                        "ml-auto shrink-0 pl-1 font-mono text-[10px] text-muted-foreground",
                        ["untracked", "added"].includes(item.status) &&
                          "text-emerald-600 dark:text-emerald-400",
                        item.status === "deleted" &&
                          "text-red-600 dark:text-red-400",
                        item.status === "modified" &&
                          "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {statusLabel[item.status] || item.status}
                    </span>
                  </button>
                  {expanded &&
                    (patchError ? (
                      <p
                        role="alert"
                        className="px-4 py-2 text-xs text-destructive"
                      >
                        {patchError}
                      </p>
                    ) : !patch ? (
                      <output className="px-4 py-2 text-xs text-muted-foreground">
                        Loading diff…
                      </output>
                    ) : patch.kind === "text" ? (
                      <GitReviewDiff
                        key={patch.revision}
                        path={item.path}
                        text={patch.text}
                        selection={marking}
                        editor={marking ? commentForm : null}
                        comments={notes
                          .filter(
                            (n) =>
                              n.comparison === comparison &&
                              n.anchor.path === item.path &&
                              n.anchor.revision === patch.revision,
                          )
                          .map((n) => n.anchor)}
                        onSelect={(selection) => {
                          if (
                            editing?.anchor.comment.trim() &&
                            (!marking || current?.revision !== patch.revision)
                          ) {
                            setActionError(
                              "Add or cancel your current comment first.",
                            );
                            return;
                          }
                          if (notes.length >= 12) {
                            setActionError(
                              "Add these comments to chat before starting another.",
                            );
                            return;
                          }
                          setNotice("");
                          setActionError("");
                          setEditing({
                            comparison,
                            location: selection.location,
                            selection,
                            anchor: {
                              path: item.path,
                              old_path: item.old_path,
                              untracked: item.status === "untracked",
                              revision: patch.revision,
                              start_line: selection.start_line,
                              end_line: selection.end_line,
                              excerpt: selection.excerpt,
                              comment: editing?.anchor.comment ?? "",
                            },
                          });
                        }}
                      />
                    ) : (
                      <p className="px-4 py-3 text-xs text-muted-foreground">
                        {
                          {
                            refresh_required:
                              "This file changed. Refresh to see its current diff.",
                            binary: "Binary file",
                            too_large: "This patch is too large to display.",
                            unchanged: "This file has no changes.",
                          }[patch.kind]
                        }
                        {patch.kind === "refresh_required" && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="ml-1"
                            onClick={refreshList}
                          >
                            Refresh
                          </Button>
                        )}
                      </p>
                    ))}
                </div>
              );
            })}
            {changes.next_offset != null && (
              <Button
                className="m-2"
                size="xs"
                variant="ghost"
                onClick={loadMore}
                disabled={paging}
              >
                Show more files
              </Button>
            )}
          </>
        )}
      </div>
      {editing && !editingInline && commentForm}
      {notes.length > 0 && (
        <div className="shrink-0 px-3 pb-2">
          {showNotes && (
            <ul className="max-h-36 space-y-1 overflow-auto py-1">
              {notes.map((n, i) => (
                <li
                  key={n.id}
                  className="flex items-start gap-2 rounded-md bg-muted/45 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[10px] text-muted-foreground">
                      {n.anchor.path}:{n.location}
                    </div>
                    <p className="break-words">{n.anchor.comment}</p>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove comment on ${n.anchor.path}`}
                    disabled={preparing}
                    onClick={() =>
                      setNotes((prior) =>
                        prior.filter((_, index) => index !== i),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2 pt-2">
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={showNotes}
              onClick={() => setShowNotes(!showNotes)}
            >
              <MessageSquare />
              {notes.length} {notes.length === 1 ? "comment" : "comments"}
              <ChevronDown />
            </Button>
            <Button
              size="xs"
              variant="secondary"
              disabled={preparing}
              onClick={addToChat}
            >
              {preparing ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowUpRight />
              )}{" "}
              Add to chat
            </Button>
          </div>
        </div>
      )}
      {(actionError || notice) && (
        <output
          className={cn(
            "px-4 pb-2 text-xs text-muted-foreground",
            actionError && "text-destructive",
          )}
        >
          {actionError || notice}
        </output>
      )}
    </div>
  );
}
