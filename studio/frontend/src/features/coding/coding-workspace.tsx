// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { PanelTabStrip, PanelWindowControls } from "@/components/panel-tabs";
import { panelDefaultSize } from "@/components/panel-sizing";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSidebar } from "@/components/ui/sidebar";
import { Bot, LoaderCircle } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ChildInspector } from "./child-inspector";
import {
  childDescription,
  childKey,
  sameChild,
  terminalChild,
} from "./child-types";
import type { ChildView } from "./child-view";

export function CodingWorkspace({
  view,
  children,
}: { view: ChildView | null; children: ReactNode }) {
  const state = useSyncExternalStore(
    view?.subscribe ?? (() => () => {}),
    view?.getSnapshot ?? (() => null),
    view?.getSnapshot ?? (() => null),
  );
  const { isMobile } = useSidebar();
  const [fullView, setFullView] = useState(false);
  const panel = useRef<PanelImperativeHandle | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const priorOpen = useRef(false);
  const rememberedSize = useRef<string | null>(null);
  const appliedLayoutMode = useRef<
    "closed" | "full" | "vertical" | "horizontal" | null
  >(null);
  const invoker = useRef<HTMLElement | null>(null);
  const open = Boolean(state?.inspection && state.tabs.length);
  const activeTabId = state?.inspection ? childKey(state.inspection) : null;
  useEffect(() => {
    if (open && !priorOpen.current) {
      invoker.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    if (!open && priorOpen.current) {
      const target = invoker.current?.isConnected
        ? invoker.current
        : container.current?.querySelector<HTMLElement>(
            '[aria-label="Coding prompt"]',
          );
      target?.focus({ preventScroll: true });
    }
    priorOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (activeTabId)
      container.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
  }, [activeTabId]);
  const applyPanelLayout = () => {
    const mode = !open
      ? "closed"
      : fullView
        ? "full"
        : isMobile
          ? "vertical"
          : "horizontal";
    if (appliedLayoutMode.current === mode) return;
    appliedLayoutMode.current = mode;
    if (!open) return;
    const size =
      rememberedSize.current ??
      (isMobile
        ? "50%"
        : panelDefaultSize(
            container.current?.getBoundingClientRect().width ?? 0,
          ));
    panel.current?.resize(fullView ? "100%" : size);
  };
  const rememberSize = () => {
    const size = panel.current?.getSize().asPercentage;
    if (!fullView && size !== undefined) rememberedSize.current = `${size}%`;
  };
  const toggleFullView = () => {
    rememberSize();
    setFullView((value) => !value);
  };
  const closePanel = () => {
    rememberSize();
    setFullView(false);
    view?.close();
  };
  const tabs =
    state?.tabs.flatMap((identity) => {
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
    }) ?? [];
  const identityFor = (id: string) =>
    state?.tabs.find((tab) => childKey(tab) === id);
  return (
    <div
      ref={container}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="coding-workspace"
    >
      <ResizablePanelGroup
        onLayoutChanged={applyPanelLayout}
        orientation={isMobile ? "vertical" : "horizontal"}
        className="min-h-0 min-w-0"
      >
        <ResizablePanel
          id="coding-conversation"
          inert={fullView && open}
          aria-hidden={fullView && open}
          defaultSize="100%"
          minSize={fullView && open ? "0%" : "30%"}
          maxSize={fullView && open ? "0%" : "100%"}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          {children}
        </ResizablePanel>
        <ResizableHandle
          disableDoubleClick
          disabled={!open || fullView}
          className={!open || fullView ? "hidden" : "bg-border/70"}
        />
        <ResizablePanel
          panelRef={panel}
          id="coding-subagents"
          defaultSize="0%"
          minSize={!open ? "0%" : fullView ? "100%" : "30%"}
          maxSize={!open ? "0%" : fullView ? "100%" : "70%"}
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          {open && view && state ? (
            <section
              aria-label="Subagents"
              data-testid="coding-subagent-panel"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closePanel();
                }
              }}
              className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-muted pt-[var(--studio-content-top-inset,0px)]"
            >
              <PanelTabStrip
                tabs={tabs}
                activeTabId={activeTabId}
                label="Subagent tabs"
                closeTabLabel="Close subagent tab"
                onActivate={(id) => {
                  const identity = identityFor(id);
                  if (
                    identity &&
                    (!state.inspection ||
                      !sameChild(identity, state.inspection))
                  )
                    void view.open(identity);
                }}
                onClose={(id) => {
                  const identity = identityFor(id);
                  if (identity) {
                    if (state.tabs.length === 1) closePanel();
                    else void view.closeTab(identity);
                  }
                }}
                onMove={(id, index) => {
                  const identity = identityFor(id);
                  if (identity) view.moveTab(identity, index);
                }}
                actions={
                  <PanelWindowControls
                    fullView={fullView}
                    fullViewLabel={
                      fullView ? "Exit full view" : "Enter full view"
                    }
                    onToggleFullView={toggleFullView}
                    closeLabel="Close subagents"
                    onClose={closePanel}
                  />
                }
              />
              <ChildInspector view={view} />
            </section>
          ) : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
