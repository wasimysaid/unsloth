// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { ProgressiveRows } from "@/components/progressive-rows";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { PencilEdit02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSyncExternalStore } from "react";
import { projectName } from "./project-name";
import { codingSession } from "./shared-session";

const PAGE_SIZE = 50;

const useCodingSessionState = () =>
  useSyncExternalStore(
    codingSession.subscribe,
    codingSession.getSnapshot,
    codingSession.getSnapshot,
  );

/** The Recents header's buttons while Coding is open. */
export function CodingRecentsActions() {
  const state = useCodingSessionState();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <>
      <button
        type="button"
        aria-label="Refresh conversations"
        title="Refresh conversations"
        disabled={state.loadingConversations}
        onClick={() => void codingSession.refreshConversations()}
        className="sidebar-header-action"
      >
        <HugeiconsIcon
          icon={Refresh01Icon}
          strokeWidth={1.75}
          className={`size-icon ${state.loadingConversations ? "animate-spin" : ""}`}
        />
      </button>
      <button
        type="button"
        aria-label="New conversation"
        title="New conversation"
        // A pending create opens what it creates; it is never withdrawn.
        disabled={state.pending?.operation === "create"}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          codingSession.startNew();
        }}
        className="sidebar-header-action"
      >
        <HugeiconsIcon
          icon={PencilEdit02Icon}
          strokeWidth={1.75}
          className="size-icon"
        />
      </button>
    </>
  );
}

/** Saved coding conversations, drawn as the app sidebar draws chats. */
export function CodingRecents() {
  const state = useCodingSessionState();
  const { isMobile, setOpenMobile } = useSidebar();
  // A newer open supersedes a pending one; only a pending create or an
  // uninspected uncertain one blocks opening.
  const disabled =
    state.pending?.operation === "create" ||
    Boolean(state.openingUncertainty && !state.openingUncertainty.inspected);
  return (
    <>
      {state.historyError && (
        <p
          role="alert"
          className="break-words px-3 py-2 text-xs text-destructive"
        >
          {state.historyError}
        </p>
      )}
      {!state.loadingConversations &&
        !state.historyError &&
        state.conversations.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No conversations yet
          </p>
        )}
      <SidebarMenu aria-label="Saved coding conversations">
        <ProgressiveRows
          items={state.conversations}
          pageSize={PAGE_SIZE}
          renderItem={(conversation) => {
            const active = conversation.id === state.active?.id;
            const pending = conversation.id === state.pending?.id;
            return (
              <SidebarMenuItem
                key={conversation.id}
                className="group/recent-item relative"
              >
                <SidebarMenuButton
                  data-conversation-id={conversation.id}
                  isActive={active}
                  aria-current={active ? "true" : undefined}
                  aria-busy={pending}
                  disabled={disabled}
                  title={conversation.cwd}
                  className="sidebar-nav-btn h-[calc(30px*var(--ui-space-scale,1))] cursor-pointer rounded-full py-0 pl-3 pr-4 text-ui-14p5 leading-ui-19 tracking-nav font-medium"
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                    void codingSession.openConversation(conversation.id);
                  }}
                >
                  <span className="truncate">
                    {conversation.title || "Coding conversation"}
                  </span>
                  {pending ? (
                    <Spinner
                      label="Opening conversation"
                      className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <span className="ml-auto max-w-[40%] shrink-0 truncate pl-2 text-ui-10 font-normal text-muted-foreground">
                      {projectName(conversation.cwd)}
                    </span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          }}
        />
      </SidebarMenu>
    </>
  );
}
