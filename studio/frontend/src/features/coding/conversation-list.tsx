// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useUiSpaceScale } from "@/hooks/use-ui-space-scale";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import { Code2, LoaderCircle } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CONVERSATION_OVERSCAN,
  conversationKeyTarget,
  windowWithPinned,
} from "./conversation-window";
import type { CodingConversation } from "./types";

/** An h-13 row plus the 1px gap SidebarMenu leaves between items. */
const ROW_SLOT_PX = 53;
/** Rows laid out before the sidebar's scroll container has been measured. */
const INITIAL_ROWS = 16;

export const projectName = (cwd: string) =>
  cwd
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || cwd;

/**
 * Saved conversations, windowed inside the sidebar's own scroll container:
 * only the rows near the viewport are mounted, while the list keeps the full
 * height and every row stays reachable by scrolling and by keyboard.
 */
export function ConversationList({
  conversations,
  scrollElement,
  activeId,
  pendingId,
  disabled,
  onOpen,
}: {
  conversations: readonly CodingConversation[];
  scrollElement: HTMLDivElement | null;
  activeId: string | undefined;
  pendingId: string | null | undefined;
  disabled: boolean;
  onOpen: (id: string) => void;
}) {
  // Rows scale with the UI font size, so their slots do too.
  const slot = Math.round(ROW_SLOT_PX * useUiSpaceScale());
  const [list, setList] = useState<HTMLUListElement | null>(null);
  // Null until measured, so the active row is not revealed against offset 0.
  const [scrollMargin, setScrollMargin] = useState<number | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const revealed = useRef<string | null>(null);
  const indexById = useMemo(
    () => new Map(conversations.map((row, index) => [row.id, index])),
    [conversations],
  );
  const focusedIndex =
    focusedId === null ? undefined : indexById.get(focusedId);
  const activeIndex =
    activeId === undefined ? undefined : indexById.get(activeId);
  const getItemKey = useCallback(
    (index: number) => conversations[index]?.id ?? index,
    [conversations],
  );
  const rangeExtractor = useCallback(
    (range: Range) => windowWithPinned(range, focusedIndex),
    [focusedIndex],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => slot,
    overscan: CONVERSATION_OVERSCAN,
    scrollMargin: scrollMargin ?? 0,
    initialRect: { width: 0, height: slot * INITIAL_ROWS },
    getItemKey,
    rangeExtractor,
  });

  // Sizes are cached from estimateSize, so a new scale has to invalidate them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: slot is the trigger
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, slot]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scale moves the list
  useLayoutEffect(() => {
    if (!list || !scrollElement) return;
    const measure = () => {
      const margin = Math.max(
        0,
        Math.round(
          list.getBoundingClientRect().top -
            scrollElement.getBoundingClientRect().top +
            scrollElement.scrollTop,
        ),
      );
      setScrollMargin((current) => (current === margin ? current : margin));
    };
    measure();
    // Loading, error and empty lines above the list move it down.
    const observer = new ResizeObserver(measure);
    observer.observe(list.parentElement ?? scrollElement);
    return () => observer.disconnect();
  }, [list, scrollElement, slot]);

  // Reveal each newly active conversation once, not on every list refresh.
  useLayoutEffect(() => {
    if (activeId === undefined) revealed.current = null;
    if (!scrollElement || scrollMargin === null) return;
    if (activeId === undefined || activeIndex === undefined) return;
    if (revealed.current === activeId) return;
    revealed.current = activeId;
    virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [scrollElement, scrollMargin, activeId, activeIndex, virtualizer]);

  // A keyboard move focuses its row only once that row is mounted.
  useLayoutEffect(() => {
    const id = focusRequest.current;
    if (id === null || !list) return;
    const row = list.querySelector<HTMLButtonElement>(
      `[data-conversation-id="${CSS.escape(id)}"]`,
    );
    if (!row) return;
    focusRequest.current = null;
    if (!row.disabled) row.focus({ preventScroll: true });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const id = (event.target as HTMLElement).dataset.conversationId;
    const index = id === undefined ? undefined : indexById.get(id);
    if (index === undefined) return;
    const page = Math.floor((scrollElement?.clientHeight ?? 0) / slot);
    const target = conversationKeyTarget(
      event.key,
      index,
      conversations.length,
      page,
    );
    if (target === null) return;
    event.preventDefault();
    if (target === index) return;
    const targetId = conversations[target].id;
    focusRequest.current = targetId;
    setFocusedId(targetId);
    virtualizer.scrollToIndex(target, { align: "auto" });
  };

  return (
    <SidebarMenu
      ref={setList}
      aria-label="Saved coding conversations"
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
        overflowAnchor: "none",
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const id = (event.target as HTMLElement).dataset.conversationId;
        if (id !== undefined) setFocusedId(id);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusedId(null);
        }
      }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const conversation = conversations[item.index];
        const active = conversation.id === activeId;
        const pending = conversation.id === pendingId;
        return (
          <SidebarMenuItem
            key={item.key}
            data-index={item.index}
            aria-posinset={item.index + 1}
            aria-setsize={conversations.length}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: `${slot}px`,
              transform: `translateY(${item.start - (scrollMargin ?? 0)}px)`,
              contain: "layout",
            }}
          >
            <SidebarMenuButton
              className="h-13 items-start py-2"
              isActive={active}
              aria-current={active ? "true" : undefined}
              data-conversation-id={conversation.id}
              aria-busy={pending}
              disabled={disabled}
              onClick={() => onOpen(conversation.id)}
              title={conversation.cwd}
              aria-describedby="coding-project-disclosure"
            >
              {pending ? (
                <LoaderCircle
                  className="mt-0.5 size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <Code2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">
                  {conversation.title || "Coding conversation"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {projectName(conversation.cwd)}
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
