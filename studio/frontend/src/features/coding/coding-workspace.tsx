// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { PanelTabStrip, PanelWindowControls } from "@/components/panel-tabs";
import {
  WorkspacePane,
  type WorkspacePaneContent,
  useWorkspacePaneControls,
} from "@/components/workspace-pane";
import { Bot, LoaderCircle } from "lucide-react";
import {
  type ReactNode,
  useEffect,
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
import { createProjectFiles } from "./project-files";
import { projectFilesApi } from "./project-files-api";
import { ProjectFilesPanel } from "./project-files-panel";

function SubagentPanel({ view }: { view: ChildView }) {
  const controls = useWorkspacePaneControls();
  const state = useSyncExternalStore(view.subscribe, view.getSnapshot);
  const tabs = state.tabs.flatMap((identity) => {
    const child = state.attempts.find((item) => sameChild(item, identity));
    if (!child) return [];
    const sameHandle =
      state.tabs.filter((tab) => tab.handle === child.handle).length > 1;
    return [
      {
        id: childKey(child),
        title: `${childDescription(child)}${sameHandle ? ` · Attempt ${child.attempt}` : ""}`,
        icon:
          !child.historical && !terminalChild(child) ? (
            <LoaderCircle
              className="mx-px size-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : (
            <Bot className="mx-px size-3.5 shrink-0" aria-hidden="true" />
          ),
      },
    ];
  });
  const identityFor = (id: string) =>
    state.tabs.find((tab) => childKey(tab) === id);
  return (
    <>
      <PanelTabStrip
        tabs={tabs}
        activeTabId={state.inspection ? childKey(state.inspection) : null}
        label="Subagent tabs"
        closeTabLabel="Close subagent tab"
        onActivate={(id) => {
          const identity = identityFor(id);
          if (
            identity &&
            (!state.inspection || !sameChild(identity, state.inspection))
          )
            void view.open(identity);
        }}
        onClose={(id) => {
          const identity = identityFor(id);
          if (identity) {
            if (state.tabs.length === 1) controls.close();
            else void view.closeTab(identity);
          }
        }}
        onMove={(id, index) => {
          const identity = identityFor(id);
          if (identity) view.moveTab(identity, index);
        }}
        actions={
          <PanelWindowControls
            fullView={controls.fullView}
            fullViewLabel={
              controls.fullView ? "Exit full view" : "Enter full view"
            }
            onToggleFullView={controls.toggleFullView}
            closeLabel="Close subagents"
            onClose={controls.close}
          />
        }
      />
      <ChildInspector view={view} />
    </>
  );
}

export function CodingWorkspace({
  view,
  project,
  conversationKey,
  children,
}: {
  view: ChildView | null;
  project: string | null;
  conversationKey: string;
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
  const [selection, setSelection] = useState<
    "files" | { child: string } | null
  >(null);
  useEffect(() => () => files?.cancelRequests(), [files]);
  let pane: WorkspacePaneContent | null = null;
  if (selection === "files" && files) {
    pane = {
      id: `files:${project}`,
      testId: "coding-files-panel",
      label: "Files",
      focusKey: fileState?.selected ?? null,
      onClose: () => setSelection(null),
      content: <ProjectFilesPanel files={files} />,
    };
  } else if (
    selection &&
    selection !== "files" &&
    selection.child === conversationKey &&
    view &&
    state?.inspection &&
    state.tabs.length
  ) {
    pane = {
      id: `subagents:${conversationKey}`,
      testId: "coding-subagent-panel",
      label: "Subagents",
      focusKey: childKey(state.inspection),
      onClose: () => {
        setSelection(null);
        view.close();
      },
      content: <SubagentPanel view={view} />,
    };
  }
  return (
    <CodingPanels.Provider
      value={{
        openFiles: () => setSelection("files"),
        openSubagents: () => setSelection({ child: conversationKey }),
        hasProject: files !== null,
        filesOpen: selection === "files",
      }}
    >
      <WorkspacePane
        pane={pane}
        focusFallback={'[aria-label="Coding prompt"]'}
        testId="coding-workspace"
      >
        {children}
      </WorkspacePane>
    </CodingPanels.Provider>
  );
}
