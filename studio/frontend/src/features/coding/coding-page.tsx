// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useAppShellReadySignal } from "@/components/app-readiness";
import { useSidebar } from "@/components/ui/sidebar";
import { isTauri } from "@/lib/api-base";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { readCodingCatalog } from "./api";
import { CodingSurface } from "./coding-surface";
import { CodingModelPicker } from "./model-configuration-popover";
import { ProjectFolderDialog } from "./project-folder-dialog";
import { projectName } from "./project-name";
import { ProjectPicker, recentProjects } from "./project-picker";
import { RuntimeNotice } from "./runtime-notice";
import {
  codingMaintenance as maintenance,
  codingSession as session,
  inspectFreshRuntime,
} from "./shared-session";

export function CodingPage() {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const runtime = useSyncExternalStore(
    maintenance.subscribe,
    maintenance.getSnapshot,
  );
  useEffect(() => {
    void maintenance.refresh();
    const timer = setInterval(() => void maintenance.refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  const { isMobile, pinned } = useSidebar();
  const [folderOpen, setFolderOpen] = useState(false);
  const folderInvoker = useRef<HTMLElement | null>(null);
  const projectTrigger = useRef<HTMLButtonElement | null>(null);
  const signalReady = useAppShellReadySignal();
  useLayoutEffect(() => {
    signalReady();
  }, [signalReady]);
  useEffect(() => {
    void session.refreshConversations();
    return () => session.cancelBrowse();
  }, []);
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-[var(--studio-content-top-inset,0px)]"
      data-testid="coding-shell"
    >
      <header
        className={cn(
          "flex h-12 shrink-0 items-center gap-1.5 pr-2 sm:pr-4",
          // Clear the shell's own sidebar controls, as the chat header does.
          isMobile
            ? "pl-12 pt-2"
            : pinned
              ? "pl-4"
              : isTauri
                ? "pl-[var(--studio-collapsed-chat-controls-inset,0.75rem)]"
                : "pl-[calc(1rem*var(--ui-space-scale,1)+max(0px,var(--studio-mac-traffic-light-inset,0px)-var(--sidebar-width-icon,3rem)))]",
        )}
      >
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
    </div>
  );
}
