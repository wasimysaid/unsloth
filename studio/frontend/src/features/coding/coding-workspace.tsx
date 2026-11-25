// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  PanelTabStrip,
  PanelWindowControls,
  type PanelTab,
} from "@/components/panel-tabs";
import {
  WorkspacePane,
  useWorkspacePaneControls,
} from "@/components/workspace-pane";
import {
  Bot,
  FileDiff,
  FolderCode,
  LoaderCircle,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ChildInspector } from "./child-inspector";
import {
  childDescription,
  childKey,
  sameChild,
  terminalChild,
} from "./child-types";
import type { ChildView } from "./child-view";
import { CodingPanels } from "./coding-panels-context";
import {
  gitWorkspace,
  type GitComparison,
  type GitWorkspace,
} from "./git-workspace-api";
import { GitReviewPanel } from "./git-review-panel";
import { ProjectFileIcon } from "./project-file-icons";
import { createProjectFiles } from "./project-files";
import { projectFilesApi } from "./project-files-api";
import { ProjectFilesPanel } from "./project-files-panel";
import type { CodingConversation } from "./types";

function WindowControls() {
  const controls = useWorkspacePaneControls();
  return (
    <PanelWindowControls
      fullView={controls.fullView}
      fullViewLabel={controls.fullView ? "Exit full view" : "Enter full view"}
      onToggleFullView={controls.toggleFullView}
      closeLabel="Close workspace panel"
      onClose={controls.close}
    />
  );
}

type TabKind = "files" | "subagents" | "changes";
interface WorkspaceTab extends PanelTab {
  kind: TabKind;
  activate: () => void;
  close: () => void;
}

export function CodingWorkspace({
  view,
  project,
  conversation,
  children,
}: {
  view: ChildView | null;
  project: string | null;
  conversation: CodingConversation | null;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    view?.subscribe ?? (() => () => {}),
    view?.getSnapshot ?? (() => null),
  );
  const [files] = useState(() =>
    project ? createProjectFiles(project, projectFilesApi) : null,
  );
  const fileState = useSyncExternalStore(
    files?.subscribe ?? (() => () => {}),
    files?.getSnapshot ?? (() => null),
  );
  useEffect(() => () => files?.cancelRequests(), [files]);

  const git = useMemo(
    () =>
      conversation?.cwd && conversation.runtime_generation
        ? gitWorkspace(conversation)
        : null,
    [conversation],
  );
  const [workspace, setWorkspace] = useState<GitWorkspace | null>(null);
  const [changedFiles, setChangedFiles] = useState<number | null>(null);
  const taskBase = workspace?.base;
  const updateChangeCount = useCallback(
    (count: number, comparison: GitComparison) => {
      if (comparison === (taskBase ? "task" : "uncommitted"))
        setChangedFiles(count);
    },
    [taskBase],
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshGit = useCallback(() => setRefreshKey((key) => key + 1), []);
  useEffect(() => {
    if (!git) return;
    let current = true;
    async function inspect() {
      if (!git || !(await git.available()) || !current) return;
      const info = await git.inspect();
      if (!current) return;
      setWorkspace(info);
      const changes = await git.changes(info.base ? "task" : "uncommitted");
      if (current) setChangedFiles(changes.total);
    }
    void inspect().catch(() => {
      if (current) setChangedFiles(null);
    });
    return () => {
      current = false;
    };
  }, [git, refreshKey]);

  const [kind, setKind] = useState<TabKind>("files");
  const [visible, setVisible] = useState(false);
  const [filesOpened, setFilesOpened] = useState(false);
  const [changesOpened, setChangesOpened] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  function open(kind: TabKind) {
    if (kind === "files") setFilesOpened(true);
    if (kind === "changes") setChangesOpened(true);
    setKind(kind);
    setVisible(true);
  }
  const tabs: WorkspaceTab[] = [];
  if (filesOpened && files && fileState) {
    if (fileState.tabs.length === 0) {
      tabs.push({
        id: "files",
        kind: "files",
        title: "Files",
        icon: <FolderCode className="size-3.5 shrink-0" />,
        activate: () => open("files"),
        close: () => setFilesOpened(false),
      });
    }
    for (const tab of fileState.tabs) {
      tabs.push({
        id: `file:${tab.path}`,
        kind: "files",
        title: tab.path,
        label: (
          <span className="min-w-0 flex-1 truncate">
            {tab.path.split("/").at(-1)}
          </span>
        ),
        icon: <ProjectFileIcon path={tab.path} />,
        activate: () => {
          open("files");
          if (fileState.selected !== tab.path) void files.open(tab.path);
        },
        close: () => {
          if (fileState.tabs.length === 1) setFilesOpened(false);
          void files.close(tab.path);
        },
      });
    }
  }
  if (changesOpened && workspace) {
    tabs.push({
      id: "changes",
      kind: "changes",
      title: "Changes",
      icon: <FileDiff className="size-3.5 shrink-0" />,
      activate: () => open("changes"),
      close: () => setChangesOpened(false),
    });
  }
  if (view && state)
    for (const identity of state.tabs) {
      const child = state.attempts.find((item) => sameChild(item, identity));
      if (!child) continue;
      const duplicate = state.tabs.some(
        (other) =>
          other.handle === identity.handle &&
          other.attempt !== identity.attempt,
      );
      tabs.push({
        id: childKey(identity),
        kind: "subagents",
        title:
          childDescription(child) +
          (duplicate ? ` · Attempt ${child.attempt}` : ""),
        icon:
          !child.historical && !terminalChild(child) ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <Bot className="size-3.5 shrink-0" />
          ),
        activate: () => {
          open("subagents");
          if (!state.inspection || !sameChild(state.inspection, child))
            void view.open(identity);
        },
        close: () => void view.closeTab(identity),
      });
    }

  const position = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? Infinity : index;
  };
  tabs.sort((left, right) => position(left.id) - position(right.id));
  const active =
    kind === "changes"
      ? "changes"
      : kind === "files"
        ? fileState?.selected
          ? `file:${fileState.selected}`
          : "files"
        : state?.inspection
          ? childKey(state.inspection)
          : null;
  const selected = tabs.find((tab) => tab.id === active);
  const pane = tabs.length
    ? {
        id: "coding-tools",
        testId:
          kind === "files"
            ? "coding-files-panel"
            : kind === "changes"
              ? "coding-git-panel"
              : "coding-subagent-panel",
        label: "Workspace tools",
        focusKey: active,
        onClose: () => setVisible(false),
        content: (
          <>
            <PanelTabStrip
              tabs={tabs}
              activeTabId={active}
              label="Workspace tabs"
              closeTabLabel="Close tab"
              onActivate={(id) => tabs.find((tab) => tab.id === id)?.activate()}
              onClose={(id) => {
                const tab = tabs.find((item) => item.id === id);
                if (!tab) return;
                tab.close();
                if (id === active) {
                  const neighbor =
                    tabs[tabs.indexOf(tab) + 1] ?? tabs[tabs.indexOf(tab) - 1];
                  if (neighbor) neighbor.activate();
                  else setVisible(false);
                }
              }}
              onMove={(id, index) => {
                const next = tabs
                  .map((tab) => tab.id)
                  .filter((tab) => tab !== id);
                next.splice(index, 0, id);
                setOrder(next);
              }}
              actions={<WindowControls />}
            />
            {filesOpened && files && (
              <div
                className={
                  kind === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden"
                }
              >
                <ProjectFilesPanel files={files} />
              </div>
            )}
            {changesOpened && conversation && workspace && (
              <div
                className={
                  kind === "changes" ? "flex min-h-0 flex-1 flex-col" : "hidden"
                }
              >
                <GitReviewPanel
                  conversation={conversation}
                  workspace={workspace}
                  visible={visible && kind === "changes"}
                  refreshKey={refreshKey}
                  onChangeCount={updateChangeCount}
                />
              </div>
            )}
            {kind === "subagents" && view && <ChildInspector view={view} />}
          </>
        ),
      }
    : null;
  return (
    <CodingPanels.Provider
      value={{
        openFiles: () => open("files"),
        openSubagents: () => open("subagents"),
        openChanges: () => {
          if (visible && kind === "changes") setVisible(false);
          else open("changes");
        },
        refreshGit,
        hasProject: Boolean(files),
        filesOpen: visible && kind === "files",
        subagentsOpen: visible && kind === "subagents",
        changesOpen: visible && kind === "changes",
        branch:
          workspace?.branch ??
          workspace?.head?.slice(0, 8) ??
          (workspace ? "HEAD" : null),
        changedFiles,
      }}
    >
      <WorkspacePane
        pane={pane}
        visible={visible && Boolean(selected)}
        focusFallback={'[aria-label="Coding prompt"]'}
        testId="coding-workspace"
      >
        {children}
      </WorkspacePane>
    </CodingPanels.Provider>
  );
}
