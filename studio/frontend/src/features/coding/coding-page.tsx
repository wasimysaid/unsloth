// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "@tanstack/react-router";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  ArrowLeft,
  ArrowUp,
  Code2,
  Folder,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
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
import { codingApi, watchCodingConversation } from "./api";
import {
  CODING_SEND_UNAVAILABLE,
  codingOpeningAdapter,
} from "./opening-runtime";
import { ProjectFolderDialog } from "./project-folder-dialog";
import { restoreProjectPickerFocus } from "./project-picker-focus";
import { MimirSettings } from "./mimir-settings";
import { createMcpSettings } from "./mcp-settings";
import { mcpSettingsApi } from "./api";
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
              disabled={state.opening}
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
              <p
                role="status"
                className="px-2 py-3 text-xs text-muted-foreground"
              >
                Loading saved conversations…
              </p>
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
                    disabled={state.opening}
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
        <Button asChild variant="ghost" className="justify-start">
          <Link to="/chat">
            <ArrowLeft className="size-4" aria-hidden="true" /> Back to Studio
          </Link>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}

function NativeEventStatus({ conversationId }: { conversationId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "error"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setConnection("connecting");
    setError(null);
    void watchCodingConversation(conversationId, abort.signal, () => {
      if (!abort.signal.aborted) setConnection("connected");
    }).catch((reason: unknown) => {
      if (abort.signal.aborted) return;
      setConnection("error");
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not connect to native events.",
      );
    });
    return () => abort.abort();
  }, [conversationId, attempt]);
  return (
    <div
      className="space-y-2 text-xs text-muted-foreground"
      data-testid="coding-event-status"
    >
      <p role="status">
        {connection === "connected"
          ? "Native event stream connected"
          : connection === "connecting"
            ? "Connecting to native events…"
            : "Native event stream unavailable"}
      </p>
      {error && (
        <>
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reconnect native events
          </Button>
        </>
      )}
    </div>
  );
}

function OpeningComposer() {
  const runtime = useExternalStoreRuntime(codingOpeningAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ComposerPrimitive.Root
        className="aui-composer-root relative w-full"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Coding composer"
      >
        <div className="unsloth-composer-surface">
          <div className="flex min-w-0 items-end gap-2">
            <ComposerPrimitive.Input
              className="unsloth-composer-input disabled:cursor-not-allowed"
              aria-label="Coding prompt"
              aria-describedby="coding-send-explanation"
              placeholder="What would you like to build?"
              submitMode="none"
              disabled
              minRows={2}
              maxRows={5}
              addAttachmentOnPaste={false}
              unstable_focusOnThreadSwitched={false}
              unstable_focusOnRunStart={false}
              unstable_focusOnScrollToBottom={false}
            />
            <Button
              type="button"
              size="icon"
              disabled
              aria-label="Send"
              aria-describedby="coding-send-explanation"
              className="mb-1 rounded-full"
            >
              <ArrowUp className="size-5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
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
    folderInvoker.current = invoker;
    session.clearOpeningError();
    setFolderOpen(true);
    void session.browse(state.active?.cwd ?? "");
  };

  return (
    <SidebarProvider
      defaultOpen
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
          className={`min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-8 ${tab === "conversation" ? "flex" : "hidden"}`}
          aria-busy={state.opening}
          hidden={tab !== "conversation"}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-7">
            <section
              className="space-y-3 text-center"
              aria-label="Coding conversation"
            >
              <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
                <Code2 className="size-6" aria-hidden="true" />
              </div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
                {state.active
                  ? "Your coding conversation is open"
                  : "Build with Mimir"}
              </h1>
              <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
                {state.active
                  ? "Mimir opened this conversation on the Studio host. Prompt execution is coming in a later slice."
                  : "Choose a project folder to open a native coding conversation, or explicitly reopen one from the sidebar."}
              </p>
              {state.active && (
                <div
                  className="space-y-2 rounded-2xl border border-border/70 p-4 text-left"
                  data-testid="coding-opened-conversation"
                >
                  <p className="font-medium">
                    {state.active.title || "Coding conversation"}
                  </p>
                  <p
                    className="break-all font-mono text-xs"
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
                  <NativeEventStatus
                    key={`${state.active.id}:${state.openingGeneration}`}
                    conversationId={state.active.id}
                  />
                </div>
              )}
              {state.opening && (
                <p
                  role="status"
                  className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
                >
                  <LoaderCircle
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />{" "}
                  Opening native conversation…
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
            <section className="space-y-3" aria-label="Open a coding project">
              <OpeningComposer key={state.active?.id ?? "unopened"} />
              {/* The host project chooser intentionally sits beneath the composer, not in its toolbar. */}
              <div
                className="flex min-w-0 flex-wrap items-center justify-between gap-2"
                data-testid="coding-project-chooser"
              >
                <Button
                  ref={projectChooser}
                  type="button"
                  variant="outline"
                  disabled={state.opening}
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
              <p
                id="coding-send-explanation"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {CODING_SEND_UNAVAILABLE}
              </p>
            </section>
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
