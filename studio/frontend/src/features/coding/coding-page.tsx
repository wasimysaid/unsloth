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
import {
  ArrowLeft,
  Code2,
  Folder,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { codingApi, mcpSettingsApi } from "./api";
import { CodingSurface } from "./coding-surface";
import { ProjectFolderDialog } from "./project-folder-dialog";
import { restoreProjectPickerFocus } from "./project-picker-focus";
import { MimirSettings } from "./mimir-settings";
import { createMcpSettings } from "./mcp-settings";
import { createCodingSession } from "./session";
import type { CodingSession, CodingSessionState } from "./session";

function CodingSidebar({
  session,
  state,
  onNew,
}: {
  session: CodingSession;
  state: CodingSessionState;
  onNew: (invoker: HTMLElement) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
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
              disabled={state.opening || Boolean(state.openingUncertainty)}
              onClick={(event) => {
                if (isMobile) setOpenMobile(false);
                onNew(event.currentTarget);
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span>New coding conversation</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
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
            <SidebarMenu aria-label="Saved coding conversations">
              {state.conversations.map((conversation) => (
                <SidebarMenuItem key={conversation.id}>
                  <SidebarMenuButton
                    className="h-auto min-h-12 items-start py-2"
                    isActive={state.active?.id === conversation.id}
                    aria-current={
                      state.active?.id === conversation.id ? "true" : undefined
                    }
                    disabled={
                      state.opening ||
                      Boolean(
                        state.openingUncertainty &&
                          !state.openingUncertainty.inspected,
                      )
                    }
                    onClick={async () => {
                      if (await session.openConversation(conversation.id)) {
                        if (isMobile) setOpenMobile(false);
                      }
                    }}
                    title={`Reopen ${conversation.cwd}`}
                    aria-describedby="coding-project-disclosure"
                  >
                    <Code2
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate">
                        {conversation.title || "Coding conversation"}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {conversation.cwd}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {conversation.id}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3 p-4">
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

export function CodingPage() {
  const [session] = useState(() => createCodingSession(codingApi));
  const [settings] = useState(() => createMcpSettings(mcpSettingsApi));
  const [tab, setTab] = useState<"conversation" | "settings">("conversation");
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [folderOpen, setFolderOpen] = useState(false);
  const folderInvoker = useRef<HTMLElement | null>(null);
  const projectChooser = useRef<HTMLButtonElement | null>(null);
  const signalReady = useAppShellReadySignal();
  useLayoutEffect(() => {
    document.title = "Coding - Unsloth";
    signalReady();
  }, [signalReady]);
  useEffect(() => {
    void session.refreshConversations();
    return () => session.cancelBrowse();
  }, [session]);
  const chooseFolder = (invoker: HTMLElement) => {
    if (state.opening || state.openingUncertainty) return;
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
      <CodingSidebar session={session} state={state} onNew={chooseFolder} />
      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-3 sm:px-5">
          <SidebarTrigger aria-label="Toggle coding sidebar" />
          <Code2 className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="font-heading text-sm font-medium">Coding</span>
          <nav
            className="ml-auto flex flex-wrap gap-1"
            aria-label="Coding views"
          >
            <Button
              size="sm"
              variant={tab === "conversation" ? "secondary" : "ghost"}
              aria-pressed={tab === "conversation"}
              onClick={() => setTab("conversation")}
            >
              Conversation
            </Button>
            <Button
              size="sm"
              variant={tab === "settings" ? "secondary" : "ghost"}
              aria-pressed={tab === "settings"}
              onClick={() => setTab("settings")}
            >
              Mimir Settings
            </Button>
          </nav>
        </header>
        {tab === "settings" && (
          <MimirSettings settings={settings} conversation={state.active} />
        )}
        <main
          className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-8 ${tab === "conversation" ? "flex" : "hidden"}`}
          aria-busy={state.opening}
          hidden={tab !== "conversation"}
        >
          <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col gap-4">
            <section
              className="shrink-0 space-y-2 text-center"
              aria-label="Coding conversation"
            >
              {!state.active && (
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
                  <Code2 className="size-6" aria-hidden="true" />
                </div>
              )}
              <h1
                className={`font-heading font-semibold tracking-tight ${state.active ? "text-base sm:text-lg" : "text-2xl sm:text-3xl"}`}
              >
                {state.active
                  ? "Your coding conversation is open"
                  : "Build with Mimir"}
              </h1>
              {!state.active && (
                <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
                  Choose a project folder to open a native coding conversation,
                  or explicitly reopen one from the sidebar.
                </p>
              )}
              {state.active && (
                <div
                  className="space-y-1 rounded-xl border border-border/70 px-3 py-2 text-left"
                  data-testid="coding-opened-conversation"
                >
                  {state.active.title && (
                    <p
                      className="truncate text-sm font-medium"
                      title={state.active.title}
                    >
                      {state.active.title}
                    </p>
                  )}
                  <p
                    className="truncate font-mono text-xs"
                    title={state.active.cwd}
                    data-testid="coding-canonical-cwd"
                  >
                    {state.active.cwd}
                  </p>
                  <p
                    className="break-all font-mono text-xs text-muted-foreground"
                    data-testid="coding-conversation-id"
                  >
                    {state.active.id}
                  </p>
                </div>
              )}
              {state.opening && (
                <output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />{" "}
                  Opening native conversation…
                </output>
              )}
              {state.openingUncertainty && (
                <p
                  role="status"
                  data-testid="coding-opening-reconciliation"
                  className="text-sm text-muted-foreground"
                >
                  {state.openingUncertainty.inspected
                    ? "Shared native history inspected. Opening remains unconfirmed; deliberately reopen a saved identity from the sidebar. No create/open command was replayed."
                    : "Opening is unconfirmed. Inspecting shared native history before offering another action; refresh history if inspection failed."}
                </p>
              )}
              {!folderOpen && state.openingError && (
                <p
                  role="alert"
                  className="break-words text-sm text-destructive"
                >
                  {state.openingError}
                </p>
              )}
            </section>
            <CodingSurface
              key={`${state.active?.id ?? "unopened"}:${state.openingGeneration}`}
              conversationId={state.active?.id ?? null}
            >
              {/* The host project chooser intentionally sits beneath the composer, not in its toolbar. */}
              <div
                className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                data-testid="coding-project-chooser"
              >
                <Button
                  ref={projectChooser}
                  type="button"
                  variant="outline"
                  disabled={state.opening || Boolean(state.openingUncertainty)}
                  aria-describedby="coding-project-disclosure"
                  onClick={(event) => chooseFolder(event.currentTarget)}
                >
                  <Folder className="size-4" aria-hidden="true" />
                  {state.active
                    ? "Choose another project"
                    : "Choose project folder"}
                </Button>
                <p className="min-w-0 break-all text-xs text-muted-foreground">
                  {state.active
                    ? "Every folder selection opens a new conversation"
                    : "Working directory · not an upload or sandbox"}
                </p>
              </div>
              <p
                id="coding-project-disclosure"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Mimir uses the host folder as its working directory, not an
                upload or sandbox. Opening or reopening trusts project
                configuration and extensions for this native controller only; no
                shared trust decision is saved.
              </p>
            </CodingSurface>
          </div>
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
    </SidebarProvider>
  );
}
