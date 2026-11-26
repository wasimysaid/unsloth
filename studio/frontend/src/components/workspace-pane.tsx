// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { panelDefaultSize } from "@/components/panel-sizing";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useSidebar } from "@/components/ui/sidebar";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

export type WorkspacePaneControls = {
  fullView: boolean;
  toggleFullView: () => void;
  close: () => void;
};
const PaneControls = createContext<WorkspacePaneControls | null>(null);
export function useWorkspacePaneControls() {
  const controls = useContext(PaneControls);
  if (!controls) throw new Error("Pane controls require a WorkspacePane.");
  return controls;
}
export type WorkspacePaneContent = {
  id: string;
  testId: string;
  label: string;
  focusKey: string | null;
  onClose: () => void;
  content: ReactNode;
};
export function WorkspacePane({
  children,
  pane,
  focusFallback,
  testId,
  visible = true,
}: {
  children: ReactNode;
  pane: WorkspacePaneContent | null;
  visible?: boolean;
  focusFallback: string;
  testId: string;
}) {
  const { isMobile } = useSidebar();
  const [full, setFull] = useState<string | null>(null);
  const fullView = visible && pane !== null && full === pane.id;
  const panel = useRef<PanelImperativeHandle | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const priorOpen = useRef(false);
  const rememberedSize = useRef<string | null>(null);
  const appliedLayoutMode = useRef<
    "closed" | "full" | "vertical" | "horizontal" | null
  >(null);
  const invoker = useRef<HTMLElement | null>(null);
  const open = visible && pane !== null;
  useEffect(() => {
    if (open && !priorOpen.current)
      invoker.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    if (!open && priorOpen.current) {
      const target = invoker.current?.isConnected
        ? invoker.current
        : container.current?.querySelector<HTMLElement>(focusFallback);
      target?.focus({ preventScroll: true });
    }
    priorOpen.current = open;
  }, [open, focusFallback]);
  useEffect(() => {
    if (open && pane?.focusKey)
      container.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
  }, [open, pane?.focusKey]);
  const applyPanelLayout = () => {
    const mode = !open
      ? "closed"
      : fullView
        ? "full"
        : isMobile
          ? "vertical"
          : "horizontal";
    if (appliedLayoutMode.current === mode) {
      if (open && !fullView) {
        const size = panel.current?.getSize().asPercentage;
        if (size !== undefined) rememberedSize.current = `${size}%`;
      }
      return;
    }
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
  const close = () => {
    rememberSize();
    setFull(null);
    pane?.onClose();
  };
  const toggleFullView = () => {
    rememberSize();
    setFull(fullView ? null : (pane?.id ?? null));
  };
  return (
    <PaneControls.Provider value={{ fullView, toggleFullView, close }}>
      <div
        ref={container}
        className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
        data-testid={testId}
      >
        <ResizablePanelGroup
          onLayoutChanged={applyPanelLayout}
          orientation={isMobile ? "vertical" : "horizontal"}
          className="min-h-0 min-w-0"
        >
          <ResizablePanel
            id="workspace-main"
            inert={fullView}
            aria-hidden={fullView}
            defaultSize="100%"
            minSize={fullView ? "0%" : "30%"}
            maxSize={fullView ? "0%" : "100%"}
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
            id="workspace-pane"
            defaultSize="0%"
            minSize={!open ? "0%" : fullView ? "100%" : "30%"}
            maxSize={!open ? "0%" : fullView ? "100%" : "70%"}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            {pane && (
              <section
                data-slot="workspace-pane"
                aria-label={pane.label}
                data-testid={pane.testId}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && event.currentTarget.contains(event.target as Node)) {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  }
                }}
                className={
                  open
                    ? "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-muted pt-[var(--studio-content-top-inset,0px)]"
                    : "hidden"
                }
              >
                {pane.content}
              </section>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </PaneControls.Provider>
  );
}
