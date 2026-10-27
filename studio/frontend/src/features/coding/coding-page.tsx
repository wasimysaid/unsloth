// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useAppShellReadySignal } from "@/components/app-readiness";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, LoaderCircle, RefreshCw, SquarePen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { codingApi, codingRuntimeApi, readCodingCatalog } from "./api";
import { CodingSurface } from "./coding-surface";
import { ConversationList, projectName } from "./conversation-list";
import { CodingModelPicker } from "./model-configuration-popover";
import { ProjectFolderDialog } from "./project-folder-dialog";
import { ProjectPicker, recentProjects } from "./project-picker";
import { createRuntimeMaintenance } from "./runtime-maintenance";
import { RuntimeNotice } from "./runtime-notice";
import { createCodingSession } from "./session";
import type { CodingSession, CodingSessionState } from "./session";

function CodingSidebar({
  session,
  state,
  onNew,
  onOpen,
}: {
  session: CodingSession;
  state: CodingSessionState;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <Sidebar collapsible="offcanvas" className="font-heading">
      <SidebarHeader className="gap-4 p-4">
        <Link
          to="/chat"
          className="flex items-center gap-2 rounded-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src="/circle-logo-small.png"
            alt=""
            className="size-7 rounded-full"
          />
          <span>unsloth</span>
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              // A pending create opens what it creates; it is never withdrawn.
              disabled={state.pending?.operation === "create"}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                onNew();
              }}
            >
              <SquarePen className="size-4" aria-hidden="true" />
              <span>New conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={setScrollElement}>
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between">
            <span>Conversations</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh conversations"
              disabled={state.loadingConversations}
              onClick={() => void session.refreshConversations()}
            >
              <RefreshCw
                className={`size-3.5 ${state.loadingConversations ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </Button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {state.historyError && (
              <p
                role="alert"
                className="break-words px-2 py-3 text-xs text-destructive"
              >
                {state.historyError}
              </p>
            )}
            {!state.loadingConversations &&
              !state.historyError &&
              state.conversations.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">
                  No conversations yet
                </p>
              )}
            <ConversationList
              conversations={state.conversations}
              scrollElement={scrollElement}
              activeId={state.active?.id}
              pendingId={state.pending?.id}
              // A newer open supersedes a pending one; only a pending
              // create or an uninspected uncertain one blocks opening.
              disabled={
                state.pending?.operation === "create" ||
                Boolean(
                  state.openingUncertainty &&
                    !state.openingUncertainty.inspected,
                )
              }
              onOpen={(id) => {
                if (isMobile) setOpenMobile(false);
                onOpen(id);
              }}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <Button asChild={true} variant="ghost" className="justify-start">
          <Link to="/chat">
            <ArrowLeft className="size-4" aria-hidden="true" /> Back to Studio
          </Link>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

export function CodingPage() {
  const [maintenance] = useState(() =>
    createRuntimeMaintenance(codingRuntimeApi),
  );
  const inspectFreshRuntime = useCallback(() => {
    maintenance.invalidate();
    void maintenance.refresh();
  }, [maintenance]);
  const [session] = useState(() =>
    createCodingSession(codingApi, { onOpened: inspectFreshRuntime }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const runtime = useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
  );
  useEffect(() => {
    void maintenance.refresh();
    const timer = setInterval(() => void maintenance.refresh(), 3000);
    return () => clearInterval(timer);
  }, [maintenance]);
  const [folderOpen, setFolderOpen] = useState(false);
  const folderInvoker = useRef<HTMLElement | null>(null);
  const projectTrigger = useRef<HTMLButtonElement | null>(null);
  const signalReady = useAppShellReadySignal();
  useLayoutEffect(() => {
    document.title = "Coding - Unsloth";
    signalReady();
  }, [signalReady]);
  useEffect(() => {
    void session.refreshConversations();
    return () => session.cancelBrowse();
  }, [session]);
  const creating = state.pending?.operation === "create";
  const chooseFolder = (invoker: HTMLElement) => {
    folderInvoker.current = invoker;
    setFolderOpen(true);
    void session.browse(state.project ?? "");
  };
  const project = state.project;
  const landingBlocked = !project
    ? "Choose a project folder first."
    : state.openingUncertainty
      ? "Check the sidebar: the last conversation may already have been created."
      : null;

  return (
    <SidebarProvider
      defaultOpen={true}
      className="!min-h-0 h-[calc(100dvh-var(--studio-titlebar-height,0px))] overflow-hidden"
      data-testid="coding-shell"
    >
      <CodingSidebar
        session={session}
        state={state}
        onNew={() => session.startNew()}
        onOpen={(id) => void session.openConversation(id)}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-2 sm:px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h2
            className="min-w-0 truncate font-heading text-sm font-medium"
            data-testid="coding-opened-conversation"
            title={state.active?.cwd}
          >
            {state.active
              ? state.active.title || projectName(state.active.cwd)
              : "New conversation"}
          </h2>
          {state.pending && (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-muted-foreground"
              aria-label={creating ? "Starting conversation" : "Opening conversation"}
            />
          )}
        </header>
        <RuntimeNotice maintenance={maintenance} runtime={runtime} />
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          aria-busy={Boolean(state.pending)}
          aria-label="Coding conversation"
        >
          {(state.openingUncertainty || state.openingError) && (
            <div className="mx-auto w-full max-w-3xl shrink-0 space-y-1 px-3 pt-1 text-xs sm:px-6">
              {state.openingUncertainty && (
                <output
                  data-testid="coding-opening-reconciliation"
                  className="block rounded-xl border border-border/60 bg-muted/40 px-3 py-2"
                >
                  {state.openingUncertainty.inspected
                    ? "The conversation may have been created. Open it from the sidebar if it's there."
                    : "Checking whether the conversation was created…"}
                </output>
              )}
              {state.openingError && (
                <p
                  role="alert"
                  data-testid="coding-opening-error"
                  className="break-words rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive"
                >
                  {state.openingError}
                </p>
              )}
            </div>
          )}
          <CodingSurface
            key={`${state.active?.id ?? "unopened"}:${state.openingGeneration}`}
            conversationId={state.active?.id ?? null}
            conversationGeneration={state.active?.runtime_generation}
            cwd={state.active?.cwd ?? null}
            runtimeStatus={runtime.status}
            onRuntimeLost={inspectFreshRuntime}
            draft={state.draft}
            autoSend={state.autoSend}
            onAutoSent={session.clearAutoSend}
            onConfigured={(configuration) =>
              session.selectModel({
                provider: configuration.provider ?? undefined,
                model: configuration.model ?? undefined,
                reasoning: configuration.reasoning ?? undefined,
              })
            }
            landing={
              state.active
                ? null
                : {
                    project: (
                      <ProjectPicker
                        triggerRef={projectTrigger}
                        project={project}
                        projects={recentProjects(state.conversations, project)}
                        disabled={creating}
                        onSelect={session.selectProject}
                        onBrowse={chooseFolder}
                      />
                    ),
                    modelPicker: (
                      <CodingModelPicker
                        key={`folder:${project ?? ""}`}
                        readCatalog={(_, signal) =>
                          readCodingCatalog(project, signal)
                        }
                        configuration={
                          state.selection
                            ? {
                                provider: state.selection.provider ?? null,
                                model: state.selection.model ?? null,
                                reasoning: state.selection.reasoning ?? null,
                              }
                            : null
                        }
                        disabled={creating}
                        configuring={false}
                        configure={async (change) =>
                          session.selectModel(change)
                        }
                      />
                    ),
                    onStart: () => void session.startConversation(),
                    starting: creating,
                    blocked: landingBlocked,
                  }
            }
          />
        </main>
      </SidebarInset>
      <ProjectFolderDialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        onRestoreFocus={() =>
          (folderInvoker.current?.isConnected
            ? folderInvoker.current
            : projectTrigger.current
          )?.focus()
        }
        onSelect={session.selectProject}
        session={session}
        state={state}
      />
    </SidebarProvider>
  );
}
