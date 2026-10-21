// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useAppShellReadySignal } from "@/components/app-readiness";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { SettingsDialog } from "@/features/settings/settings-dialog";
import { useSettingsDialogStore } from "@/features/settings/stores/settings-dialog-store";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Code2,
  FolderOpen,
  Info,
  LoaderCircle,
  Plus,
  RefreshCw,
  Settings2,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { codingApi, codingRuntimeApi, mcpSettingsApi } from "./api";
import { createRuntimeMaintenance } from "./runtime-maintenance";
import { CodingRuntimeControls } from "./runtime-controls";
import { CodingSurface } from "./coding-surface";
import { ConversationList, projectName } from "./conversation-list";
import { createMcpSettings } from "./mcp-settings";
import { MimirSettings } from "./mimir-settings";
import { ProjectChooser, recentProjects } from "./project-chooser";
import { ProjectFolderDialog } from "./project-folder-dialog";
import { restoreProjectPickerFocus } from "./project-picker-focus";
import { createCodingSession } from "./session";
import type { CodingSession, CodingSessionState } from "./session";

function CodingSidebar({
  session,
  state,
  onNew,
  onOpen,
  focusFallback,
}: {
  session: CodingSession;
  state: CodingSessionState;
  onNew: () => void;
  onOpen: (id: string) => void;
  focusFallback: RefObject<HTMLButtonElement | null>;
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
              <Plus className="size-4" aria-hidden="true" />
              <span>New coding conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent ref={setScrollElement}>
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center justify-between">
            <span>Coding conversations</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh coding conversations"
              disabled={state.loadingConversations}
              onClick={() => void session.refreshConversations()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
            </Button>
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {state.loadingConversations && (
              <output className="block px-2 py-3 text-xs text-muted-foreground">
                Loading saved conversations…
              </output>
            )}
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
                  No coding conversations yet.
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
      <SidebarFooter className="gap-3 p-4">
        <Button
          variant="ghost"
          className="justify-start"
          onClick={(event) => {
            if (isMobile) setOpenMobile(false);
            useSettingsDialogStore.setState({
              mimirConversationRequested: state.active?.id ?? null,
            });
            useSettingsDialogStore.getState().openDialog("mimir", {
              opener: event.currentTarget,
              focusFallback: focusFallback.current,
            });
          }}
        >
          Mimir Settings
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Conversations and project folders are owned by Mimir on this host.
        </p>
        <Button asChild={true} variant="ghost" className="justify-start">
          <Link to="/chat">
            <ArrowLeft className="size-4" aria-hidden="true" /> Back to Studio
          </Link>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

const runtimeHealthy = (status: string | undefined) =>
  !status || ["running", "not_started"].includes(status);

function SessionDetails({
  session,
  state,
  maintenance,
  runtime,
  onSettings,
}: {
  session: CodingSession;
  state: CodingSessionState;
  maintenance: ReturnType<typeof createRuntimeMaintenance>;
  runtime: ReturnType<
    ReturnType<typeof createRuntimeMaintenance>["getSnapshot"]
  >;
  onSettings: () => void;
}) {
  const active = state.active;
  const attention =
    !runtimeHealthy(runtime.status?.state) ||
    Boolean(runtime.error || runtime.statusError);
  return (
    <Popover>
      <PopoverTrigger asChild={true}>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
          aria-label={
            attention
              ? "Session details · runtime needs attention"
              : "Session details"
          }
          data-testid="coding-session-details"
        >
          {attention ? (
            <TriangleAlert
              className="size-4 text-destructive"
              aria-hidden="true"
            />
          ) : (
            <Info className="size-4" aria-hidden="true" />
          )}
          <span className="max-sm:hidden">
            {attention
              ? `Runtime ${runtime.restarting ? "restarting" : (runtime.status?.state ?? "unavailable")}`
              : "Session"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(36rem,80dvh)] w-[min(26rem,calc(100vw-1.5rem))] gap-4 overflow-y-auto rounded-[21px] border border-border/60 p-4 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.16)] dark:bg-card"
      >
        {active ? (
          <section
            className="min-w-0 space-y-1.5 text-xs"
            aria-label="Open coding conversation"
          >
            <h3 className="text-sm font-medium">
              {active.title || "Coding conversation"}
            </h3>
            <p className="break-all font-mono">{active.cwd}</p>
            <p
              className="break-all font-mono text-muted-foreground"
              data-testid="coding-conversation-id"
            >
              {active.id}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto whitespace-normal rounded-full text-left"
              data-testid="coding-reopen-saved"
              aria-disabled={
                state.pending?.operation === "create" ||
                Boolean(
                  state.openingUncertainty &&
                    !state.openingUncertainty.inspected,
                )
              }
              aria-describedby="coding-project-disclosure"
              onClick={() => void session.openConversation(active.id)}
            >
              Reopen saved conversation
            </Button>
          </section>
        ) : (
          <p className="text-xs text-muted-foreground">
            No coding conversation is open.
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {PROJECT_DISCLOSURE}
        </p>
        <CodingRuntimeControls maintenance={maintenance} state={runtime} />
        <Button
          variant="ghost"
          size="sm"
          className="justify-start rounded-full"
          onClick={onSettings}
        >
          <Settings2 className="size-4" aria-hidden="true" /> Mimir Settings
        </Button>
      </PopoverContent>
    </Popover>
  );
}

const PROJECT_DISCLOSURE =
  "Mimir uses the host folder as its working directory, not an upload or sandbox. Opening or reopening trusts project configuration and extensions for this native controller only; no shared trust decision is saved.";

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
  const [settings] = useState(() => createMcpSettings(mcpSettingsApi));
  const [tab, setTab] = useState<"conversation" | "settings">("conversation");
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
  const projectChooser = useRef<HTMLButtonElement | null>(null);
  const sidebarToggle = useRef<HTMLButtonElement | null>(null);
  const signalReady = useAppShellReadySignal();
  useLayoutEffect(() => {
    document.title = "Coding - Unsloth";
    signalReady();
  }, [signalReady]);
  useEffect(() => {
    void session.refreshConversations();
    return () => session.cancelBrowse();
  }, [session]);
  const choosing =
    state.pending?.operation === "create" || Boolean(state.openingUncertainty);
  const chooseFolder = (invoker: HTMLElement) => {
    if (choosing) return;
    folderInvoker.current = invoker;
    session.clearOpeningError();
    setFolderOpen(true);
    void session.browse(state.active?.cwd ?? "");
  };

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
        focusFallback={sidebarToggle}
      />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-1.5 px-2 sm:px-4">
          <SidebarTrigger
            ref={sidebarToggle}
            aria-label="Toggle coding sidebar"
          />
          {state.active ? (
            <Button
              ref={projectChooser}
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 min-w-0 max-w-[min(32rem,60vw)] justify-start gap-2 rounded-full px-2.5"
              disabled={choosing}
              aria-label={`Choose another project · current ${state.active.cwd}`}
              aria-describedby="coding-project-disclosure"
              title="Every folder selection opens a new conversation"
              data-testid="coding-opened-conversation"
              onClick={(event) => chooseFolder(event.currentTarget)}
            >
              <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate font-heading text-sm font-medium">
                {state.active.title || projectName(state.active.cwd)}
              </span>
              <span
                className="truncate font-mono text-[11px] font-normal text-muted-foreground max-md:hidden"
                data-testid="coding-canonical-cwd"
              >
                {state.active.cwd}
              </span>
            </Button>
          ) : (
            <span className="flex items-center gap-2 px-1.5 font-heading text-sm font-medium">
              <Code2
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              Coding
            </span>
          )}
          {state.pending && (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-muted-foreground"
              aria-label={
                state.pending.operation === "create"
                  ? "Creating conversation"
                  : "Opening conversation"
              }
            />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <SessionDetails
              session={session}
              state={state}
              maintenance={maintenance}
              runtime={runtime}
              onSettings={() => setTab("settings")}
            />
            <Button
              size="sm"
              variant={tab === "settings" ? "secondary" : "ghost"}
              className="h-8 gap-1.5 rounded-full px-2.5 text-xs"
              aria-pressed={tab === "settings"}
              onClick={() =>
                setTab(tab === "settings" ? "conversation" : "settings")
              }
            >
              <Settings2 className="size-4" aria-hidden="true" />
              <span className="max-sm:sr-only">Mimir Settings</span>
            </Button>
          </div>
        </header>
        <p id="coding-project-disclosure" className="sr-only">
          {PROJECT_DISCLOSURE}
        </p>
        {tab === "settings" && (
          <MimirSettings settings={settings} conversation={state.active} />
        )}
        <main
          className={`min-h-0 min-w-0 flex-1 flex-col ${tab === "conversation" ? "flex" : "hidden"}`}
          aria-busy={Boolean(state.pending)}
          aria-label="Coding conversation"
          hidden={tab !== "conversation"}
        >
          {(state.reopened ||
            state.pending ||
            state.openingUncertainty ||
            (!folderOpen && state.openingError)) && (
            <div className="mx-auto w-full max-w-3xl shrink-0 space-y-1 px-3 pt-1 text-xs sm:px-6">
              {state.reopened && (
                <output
                  data-testid="coding-reopened"
                  className="block text-muted-foreground"
                >
                  Reopened saved conversation · no work automatically resumed.
                </output>
              )}
              {state.pending && (
                <output className="block text-muted-foreground">
                  {state.pending.operation === "create"
                    ? "Creating conversation…"
                    : "Opening conversation…"}
                </output>
              )}
              {state.openingUncertainty && (
                <output
                  data-testid="coding-opening-reconciliation"
                  className="block rounded-2xl border border-border/60 bg-muted/40 px-3.5 py-2.5"
                >
                  {state.openingUncertainty.inspected
                    ? "Shared native history inspected. Opening remains unconfirmed; deliberately reopen a saved identity from the sidebar. No create/open command was replayed."
                    : "Opening is unconfirmed. Inspecting shared native history before offering another action; refresh history if inspection failed."}
                </output>
              )}
              {!folderOpen && state.openingError && (
                <p
                  role="alert"
                  data-testid="coding-opening-error"
                  className="break-words rounded-2xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-destructive"
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
            runtimeStatus={runtime.status}
            onRuntimeLost={inspectFreshRuntime}
            draft={state.draft}
            projectChooser={
              state.active ? null : (
                <ProjectChooser
                  triggerRef={projectChooser}
                  projects={recentProjects(state.conversations)}
                  disabled={choosing}
                  onChoose={(cwd) => void session.createConversation(cwd)}
                  onBrowse={chooseFolder}
                />
              )
            }
            empty={
              <div className="m-auto flex max-w-md flex-col items-center gap-2 px-4 text-center">
                <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                  What should we build?
                </h1>
                <p className="text-sm text-muted-foreground">
                  Pick a project below, then describe the task.
                </p>
              </div>
            }
          />
        </main>
      </SidebarInset>
      <ProjectFolderDialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        onRestoreFocus={() =>
          restoreProjectPickerFocus(
            folderInvoker.current,
            projectChooser.current,
          )
        }
        session={session}
        state={state}
      />
      {/* The ordinary Studio shell is parked/unmounted on this route. Mount only
          its shared settings presentation, not FloatingMonitor or chat owners. */}
      <SettingsDialog />
    </SidebarProvider>
  );
}
