// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import {
  PanelIconButton,
  PANEL_STRIP_BUTTON,
} from "@/components/panel-tabs";
import { useWorkspacePaneControls } from "@/components/workspace-pane";
import { attachmentTextLanguage } from "@/features/chat";
import { languageDisplayName } from "@/components/assistant-ui/code-plugin";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  CodeXml,
  Eye,
  EyeOff,
  FolderCode,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { CodingPanels } from "./coding-panels-context";
import type { ProjectEntry, ProjectFiles } from "./project-files";
import { ProjectFileIcon } from "./project-file-icons";
import { ProjectSource } from "./project-source";
import { projectName } from "./project-name";

export function ProjectFilesButton() {
  const panels = useContext(CodingPanels);
  const controls = useWorkspacePaneControls();
  return (
    <PanelIconButton
      label={
        panels.hasProject
          ? "Open project files"
          : "Choose a project folder to browse files"
      }
      disabled={!panels.hasProject}
      className={cn(
        PANEL_STRIP_BUTTON,
        panels.filesOpen && "bg-chat-icon-bg-hover",
      )}
      onClick={panels.filesOpen ? controls.close : panels.openFiles}
    >
      <FolderCode className="size-icon" strokeWidth={1.75} />
    </PanelIconButton>
  );
}
const sizeText = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const MAX_MARKDOWN_PREVIEW = 64 * 1024;

type TreeRow = { entry: ProjectEntry; depth: number };
function ProjectTree({
  files,
  filter,
  query,
  onQuery,
}: {
  files: ProjectFiles;
  filter: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
}) {
  const state = useSyncExternalStore(files.subscribe, files.getSnapshot);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const rows = useMemo(() => {
    if (state.query)
      return state.search?.phase === "ready"
        ? state.search.value.entries.map((entry) => ({ entry, depth: 0 }))
        : [];
    const rows: TreeRow[] = [];
    const visit = (path: string, depth: number) => {
      const page = state.directories.get(path);
      if (page?.phase !== "ready") return;
      for (const entry of page.value.entries) {
        rows.push({ entry, depth });
        if (entry.kind === "directory" && state.expanded.has(entry.path))
          visit(entry.path, depth + 1);
      }
    };
    visit("", 0);
    return rows;
  }, [state.directories, state.expanded, state.query, state.search]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 30,
    overscan: 8,
  });
  const openDirectory = (path: string) => {
    if (state.query) {
      onQuery("");
      void files.search("");
      void files.reveal(path, "directory");
    } else void files.toggleDirectory(path);
  };
  const root = state.directories.get("");
  const result = state.query ? state.search : root;
  const failed = [...state.directories.values()].find(
    (page) => page.phase === "failed",
  );
  const busy = [...state.directories.values()].some(
    (page) => page.phase === "loading",
  );
  const truncated = state.query
    ? state.search?.phase === "ready" && state.search.value.truncated
    : [...state.directories.values()].some(
        (page) => page.phase === "ready" && page.value.truncated,
      );
  return (
    <aside
      className="flex min-h-0 w-[38%] min-w-[150px] max-w-[280px] shrink-0 flex-col border-l border-border/60 bg-muted/30"
      aria-label="Project files"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={filter}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Filter files"
            aria-label="Filter files"
            className="h-7 w-full min-w-0 rounded-md bg-foreground/5 pl-7 pr-4 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {!query && (
            <kbd className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
              /
            </kbd>
          )}
        </div>
        <PanelIconButton
          label={state.hidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => void files.toggleHidden()}
          className="size-6"
        >
          {state.hidden ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
        </PanelIconButton>
        <PanelIconButton
          label="Refresh file tree"
          onClick={() => void files.refreshTree()}
          className="size-6"
        >
          <RefreshCw className="size-3.5" />
        </PanelIconButton>
        <PanelIconButton
          label="Collapse folders"
          onClick={() => files.collapse()}
          className="size-6"
        >
          <ChevronsDownUp className="size-3.5" />
        </PanelIconButton>
      </div>
      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-auto py-2"
        role="tree"
        aria-label="Project file tree"
        aria-busy={result?.phase === "loading" || busy}
      >
        {result?.phase === "loading" && !rows.length && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" />
            Loading files…
          </div>
        )}
        {result?.phase === "failed" && (
          <div className="px-3 py-2 text-xs text-destructive" role="alert">
            {result.message}
            <button
              className="mt-2 block underline"
              onClick={() =>
                void (state.query
                  ? files.search(state.query)
                  : files.directory("", true))
              }
            >
              Retry
            </button>
          </div>
        )}
        {result?.phase === "ready" && rows.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {state.query ? "No matching files" : "This folder is empty"}
          </p>
        )}
        <div className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((item) => {
            const { entry, depth } = rows[item.index];
            const expanded = state.expanded.has(entry.path);
            const loading =
              state.directories.get(entry.path)?.phase === "loading";
            const directory = entry.kind === "directory";
            return (
              <button
                key={entry.path}
                ref={(node) => {
                  if (node && pendingFocus.current === item.index) {
                    pendingFocus.current = null;
                    node.focus({ preventScroll: true });
                  }
                }}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={directory ? expanded : undefined}
                aria-selected={state.selected === entry.path}
                title={
                  entry.kind === "symlink"
                    ? `${entry.path} · symbolic links are not followed`
                    : entry.path
                }
                disabled={entry.kind !== "file" && !directory}
                onClick={() => {
                  if (directory) openDirectory(entry.path);
                  else void files.open(entry.path);
                }}
                onKeyDown={(event) => {
                  if (
                    directory &&
                    ((event.key === "ArrowRight" &&
                      (state.query || !expanded)) ||
                      (event.key === "ArrowLeft" && expanded))
                  ) {
                    event.preventDefault();
                    openDirectory(entry.path);
                  }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    let index = Math.max(
                      0,
                      Math.min(
                        rows.length - 1,
                        (pendingFocus.current ?? item.index) +
                          (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    while (
                      index >= 0 &&
                      index < rows.length &&
                      rows[index].entry.kind !== "file" &&
                      rows[index].entry.kind !== "directory"
                    )
                      index += step;
                    if (index < 0 || index >= rows.length) return;
                    pendingFocus.current = index;
                    virtual.scrollToIndex(index);
                    const target = viewport.current?.querySelector<HTMLElement>(
                      `[data-tree-index="${index}"]`,
                    );
                    if (target) {
                      pendingFocus.current = null;
                      target.focus({ preventScroll: true });
                    }
                  }
                }}
                data-tree-index={item.index}
                className={cn(
                  "absolute left-0 flex h-[30px] w-full min-w-0 items-center gap-1.5 pr-2 text-left text-xs outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50",
                  state.selected === entry.path && "bg-foreground/8",
                )}
                style={{ top: item.start, paddingLeft: 8 + depth * 14 }}
              >
                <span className="flex size-3 shrink-0 items-center">
                  {loading ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : directory ? (
                    expanded ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )
                  ) : null}
                </span>
                <ProjectFileIcon
                  path={entry.path}
                  kind={entry.kind}
                  expanded={expanded}
                />
                <span className="min-w-0 truncate">
                  {state.query ? entry.path : entry.name}
                </span>
              </button>
            );
          })}
        </div>
        {failed?.phase === "failed" && result?.phase !== "failed" && (
          <p className="px-3 py-2 text-xs text-destructive">{failed.message}</p>
        )}
        {truncated && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            More files are available. Refine the filter to find them.
          </p>
        )}
      </div>
    </aside>
  );
}

export function ProjectFilesPanel({ files }: { files: ProjectFiles }) {
  const state = useSyncExternalStore(files.subscribe, files.getSnapshot);
  const [query, setQuery] = useState(state.query);
  const [treeVisible, setTreeVisible] = useState(true);
  const filter = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void files.directory("");
  }, [files]);
  useEffect(() => {
    const timer = setTimeout(() => void files.search(query), 150);
    return () => clearTimeout(timer);
  }, [files, query]);
  const selected = files.activeTab();
  const read = files.activeDocument();
  const document = read?.phase === "ready" ? read.value : null;
  const language = selected
    ? attachmentTextLanguage(selected.path, null)
    : null;
  const markdown = /\.(md|mdx|markdown)$/i.test(selected?.path ?? "");
  const canPreview =
    markdown &&
    document?.kind === "text" &&
    document.offset === 0 &&
    document.next_offset === null &&
    document.text.length <= MAX_MARKDOWN_PREVIEW;
  const preview = canPreview && selected?.mode !== "source";
  const focusFilter = () => {
    setTreeVisible(true);
    requestAnimationFrame(() => filter.current?.focus());
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          !(
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement
          )
        ) {
          event.preventDefault();
          focusFilter();
        }
      }}
    >
      <div className="panel-document-surface flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            {selected && <ProjectFileIcon path={selected.path} />}
            <button
              title={
                selected
                  ? `Reveal ${selected.path} in the file tree`
                  : files.root
              }
              onClick={() => {
                if (selected) {
                  setTreeVisible(true);
                  setQuery("");
                  void files.reveal(selected.path);
                }
              }}
              className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
            >
              {projectName(files.root)}
              {selected && (
                <>
                  {" "}
                  / <span className="text-foreground">{selected.path}</span>
                </>
              )}
            </button>
            <PanelIconButton label="Find a file" onClick={focusFilter} className="size-6">
              <Search className="size-3.5" />
            </PanelIconButton>
            {markdown && (
              <PanelIconButton
                label={preview ? "Show Markdown source" : "Preview Markdown"}
                disabled={!canPreview}
                onClick={() => files.setMode(preview ? "source" : "preview")}
                className="size-6"
              >
                {preview ? (
                  <CodeXml className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </PanelIconButton>
            )}
            <PanelIconButton
              label="Reload file"
              onClick={() => void files.refresh()}
              className="size-6"
            >
              <RefreshCw className="size-3.5" />
            </PanelIconButton>
            <PanelIconButton
              label={treeVisible ? "Hide file tree" : "Show file tree"}
              onClick={() => setTreeVisible((visible) => !visible)}
              className="size-6"
            >
              {treeVisible ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRightOpen className="size-4" />
              )}
            </PanelIconButton>
          </div>
          {!selected && (
            <div className="m-auto px-6 text-center text-sm text-muted-foreground">
              Select a file to preview it.
            </div>
          )}
          {read?.phase === "loading" && (
            <div className="m-auto flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Opening file…
            </div>
          )}
          {read?.phase === "failed" && (
            <div
              className="m-auto max-w-sm space-y-3 p-5 text-center text-sm"
              role="alert"
            >
              <p>{read.message}</p>
              <button
                className="text-muted-foreground underline"
                onClick={() => void files.refresh()}
              >
                Reload file
              </button>
            </div>
          )}
          {document && document.kind !== "text" && (
            <p className="m-auto max-w-sm px-6 text-center text-sm text-muted-foreground">
              {document.kind === "binary"
                ? "This binary file has no text preview."
                : "This file encoding is not supported."}
            </p>
          )}
          {document?.kind === "text" &&
            selected &&
            (preview ? (
              <div className="min-h-0 flex-1 overflow-auto px-7 py-6">
                <MarkdownPreview
                  markdown={document.text}
                  defer
                  className="max-h-none overflow-visible rounded-none border-0 bg-transparent p-0 text-sm leading-relaxed"
                />
              </div>
            ) : (
              <ProjectSource
                key={`${selected.path}:${document.offset}`}
                text={document.text}
                language={language}
                firstLine={selected.position.firstLine}
              />
            ))}
          {document && selected && (
            <footer className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-2 border-t border-border/50 px-3 py-1 text-[11px] text-muted-foreground">
              <span>
                {language
                  ? languageDisplayName(language)
                  : document.kind === "text"
                    ? "Text"
                    : "File"}
              </span>
              <span>·</span>
              {document.kind === "text" && (
                <>
                  <span>
                    {document.offset > 0 || document.next_offset !== null
                      ? `${document.text.split("\n").length.toLocaleString()} displayed lines`
                      : `${document.text.split("\n").length.toLocaleString()} lines`}
                  </span>
                  <span>·</span>
                </>
              )}
              <span>{sizeText(document.size)}</span>
              {(document.offset > 0 || document.next_offset !== null) && (
                <>
                  <span className="ml-auto">
                    {sizeText(document.offset)}–
                    {sizeText(document.next_offset ?? document.size)}
                  </span>
                  <PanelIconButton
                    label="Previous file section"
                    className="size-5"
                    disabled={!selected.previous.length}
                    onClick={() => void files.previous()}
                  >
                    <ChevronLeft className="size-3.5" />
                  </PanelIconButton>
                  <PanelIconButton
                    label="Next file section"
                    className="size-5"
                    disabled={document.next_offset === null}
                    onClick={() => void files.next()}
                  >
                    <ChevronRight className="size-3.5" />
                  </PanelIconButton>
                </>
              )}
            </footer>
          )}
        </div>
        {treeVisible && (
          <ProjectTree
            files={files}
            filter={filter}
            query={query}
            onQuery={setQuery}
          />
        )}
      </div>
    </div>
  );
}
