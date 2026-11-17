// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EnterFullViewIcon, ExitFullViewIcon } from "@/lib/panel-icons";
import { cn } from "@/lib/utils";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from "react";

export const TOOLBAR_ICON_BUTTON =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_calc(6%*var(--contrast-wash-gain,1)),transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
export type PanelIconButtonProps = {
  label: string;
  shortcut?: string | null;
  icon?: IconSvgElement;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  tooltip?: boolean;
};

export function PanelIconButton({
  label,
  shortcut,
  icon,
  onClick,
  disabled,
  className,
  children,
  tooltip = true,
}: PanelIconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(TOOLBAR_ICON_BUTTON, className)}
    >
      {icon ? (
        <HugeiconsIcon icon={icon} strokeWidth={1.75} className="size-4.5" />
      ) : (
        children
      )}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild={true}>{button}</TooltipTrigger>
      <TooltipContent side="top" className="tooltip-compact">
        {shortcut ? (
          <span className="flex items-center gap-1.5">
            {label}
            <kbd className="rounded-full bg-[rgb(0_0_0_/_calc(0.1*var(--contrast-wash-gain,1)))] px-1 py-px text-ui-10 font-medium leading-none dark:bg-[rgb(255_255_255_/_calc(0.15*var(--contrast-wash-gain,1)))]">
              {shortcut}
            </kbd>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const TAB_DRAG_THRESHOLD_PX = 5;
const TAB_SHIFT_TRANSITION = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";

/** Which way a tab slides while another is dragged from slot over target; passed tabs shift one place. */
function tabShift(position: number, slot: number, target: number): -1 | 0 | 1 {
  if (slot < target && position > slot && position <= target) return -1;
  if (target < slot && position >= target && position < slot) return 1;
  return 0;
}

type TabDrag = {
  id: string;
  pointerId: number;
  startX: number;
  grabX: number;
  moved: boolean;
  elements: HTMLElement[];
  lefts: number[];
  widths: number[];
  slot: number;
  step: number;
  target: number;
};

/** Drag a tab to move it; the order changes once, on release: moving tabs mid-drag would move the dragged node and drop its pointer capture. */
function useTabDrag(
  listRef: RefObject<HTMLDivElement | null>,
  tabCount: number,
  activateTab: (id: string) => void,
  moveTab: (id: string, index: number) => void,
) {
  const drag = useRef<TabDrag | null>(null);
  // A drag ends in a click on the tab it started on; that click shouldn't count.
  const dragged = useRef(false);
  const reset = () => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved) return;
    for (const element of current.elements) {
      element.style.transition = "none";
      element.style.transform = "";
      element.style.zIndex = "";
    }
    requestAnimationFrame(() => {
      for (const element of current.elements) element.style.transition = "";
    });
  };
  // A tab opened or closed mid-drag makes the measured places wrong: drop the drag.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab count is the trigger
  useEffect(() => reset(), [tabCount]);
  const begin = (current: TabDrag, element: HTMLElement) => {
    const list = listRef.current;
    if (!list) return false;
    const elements = [...list.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const slot = elements.indexOf(element);
    if (slot < 0) return false;
    const rects = elements.map((tab) => tab.getBoundingClientRect());
    current.elements = elements;
    current.lefts = rects.map((rect) => rect.left);
    current.widths = rects.map((rect) => rect.width);
    current.slot = slot;
    current.target = slot;
    // Measured now, not on press: selecting the tab can scroll the strip under the pointer.
    current.grabX = current.startX - (rects[slot]?.left ?? 0);
    current.step =
      (rects[slot]?.width ?? 0) +
      (Number.parseFloat(getComputedStyle(list).columnGap) || 0);
    for (const [position, tab] of elements.entries()) {
      tab.style.transition = position === slot ? "none" : TAB_SHIFT_TRANSITION;
    }
    element.style.zIndex = "10";
    return true;
  };
  const follow = (current: TabDrag, clientX: number) => {
    const list = listRef.current;
    const element = current.elements[current.slot];
    if (!list || !element) return;
    const width = current.widths[current.slot] ?? 0;
    const natural = current.lefts[current.slot] ?? 0;
    const last = current.lefts.length - 1;
    const first = current.lefts[0] ?? natural;
    const end =
      (current.lefts[last] ?? natural) +
      (current.widths[last] ?? width) -
      width;
    const left = Math.min(Math.max(clientX - current.grabX, first), end);
    element.style.transform = `translateX(${left - natural}px)`;
    // The drop slot nearest where it's held: tabs share one width, so slots are a step apart.
    const target = Math.min(
      Math.max(
        current.slot + Math.round((left - natural) / (current.step || 1)),
        0,
      ),
      last,
    );
    if (target === current.target) return;
    current.target = target;
    for (const [position, tab] of current.elements.entries()) {
      if (position === current.slot) continue;
      const shift = tabShift(position, current.slot, target) * current.step;
      tab.style.transform = shift ? `translateX(${shift}px)` : "";
    }
  };
  return {
    consumeClick: () => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
    handlers: (tabId: string) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (
          event.button !== 0 ||
          (event.target instanceof Element && event.target.closest("button"))
        )
          return;
        dragged.current = false;
        drag.current = {
          id: tabId,
          pointerId: event.pointerId,
          startX: event.clientX,
          grabX: 0,
          moved: false,
          elements: [],
          lefts: [],
          widths: [],
          slot: -1,
          step: 0,
          target: -1,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        // Selected on press, as Firefox does, so the strip has settled before a drag measures it.
        activateTab(tabId);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!current.moved) {
          if (Math.abs(event.clientX - current.startX) < TAB_DRAG_THRESHOLD_PX)
            return;
          if (!begin(current, event.currentTarget)) return;
          current.moved = true;
          dragged.current = true;
        }
        follow(current, event.clientX);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (current?.moved && current.pointerId === event.pointerId) {
          follow(current, event.clientX);
          const { id, target, slot } = current;
          reset();
          if (target !== slot) moveTab(id, target);
        } else {
          reset();
        }
      },
      onPointerCancel: reset,
      onLostPointerCapture: reset,
    }),
  };
}

// The chat header's button size, so the two rows match.
export const PANEL_STRIP_BUTTON = "size-[calc(30px*var(--ui-space-scale,1))]";

export interface PanelTab {
  id: string;
  title: string;
  icon: ReactNode;
  label?: ReactNode;
  trailing?: ReactNode;
  wrap?: (element: ReactElement) => ReactElement;
}

export function PanelTabStrip({
  tabs,
  activeTabId,
  label,
  closeTabLabel,
  onActivate,
  onClose,
  onMove,
  actions,
}: {
  tabs: readonly PanelTab[];
  activeTabId: string | null;
  label: string;
  closeTabLabel: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, index: number) => void;
  actions: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const tabDrag = useTabDrag(listRef, tabs.length, onActivate, onMove);
  useEffect(() => {
    listRef.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);
  return (
    <div
      data-tauri-drag-region={true}
      className="browser-chrome relative z-40 flex h-[var(--studio-chat-header-height,48px)] min-w-0 shrink-0 items-center gap-1 pl-1.5 pr-[calc(0.5rem*var(--ui-space-scale,1)+var(--studio-chat-header-right-inset,var(--studio-window-control-inset,0px)))]"
    >
      <div
        ref={listRef}
        role="tablist"
        data-tauri-drag-region={true}
        aria-label={label}
        onWheel={(event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
            event.currentTarget.scrollLeft += event.deltaY;
        }}
        className="browser-tablist flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const element = (
            <div
              role="tab"
              aria-selected={active}
              tabIndex={0}
              title={tab.title}
              data-tab-id={tab.id}
              {...tabDrag.handlers(tab.id)}
              onClick={() => {
                if (!tabDrag.consumeClick()) onActivate(tab.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onActivate(tab.id);
                }
              }}
              className={cn(
                "group/tab relative flex h-[calc(32px*var(--ui-space-scale,1))] min-w-[calc(88px*var(--ui-space-scale,1))] max-w-60 flex-1 basis-0 cursor-pointer touch-none select-none items-center gap-1 rounded-[10px] pl-2 pr-1.5 text-ui-13 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active
                  ? "bg-card text-foreground dark:bg-accent"
                  : "text-muted-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_calc(6%*var(--contrast-wash-gain,1)),transparent)] hover:text-foreground",
              )}
            >
              {tab.icon}
              {tab.label ?? (
                <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%_-_0.625rem),transparent)]">
                  {tab.title}
                </span>
              )}
              {tab.trailing}
              <button
                type="button"
                aria-label={closeTabLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                className={cn(
                  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-muted-foreground hover:bg-[color-mix(in_oklab,var(--foreground)_calc(10%*var(--contrast-wash-gain,1)),transparent)] hover:text-foreground",
                  !active &&
                    "hidden group-hover/tab:flex group-focus-visible/tab:flex focus-visible:flex",
                )}
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  strokeWidth={2}
                  className="size-3.5"
                />
              </button>
            </div>
          );
          return (
            <Fragment key={tab.id}>
              {tab.wrap ? tab.wrap(element) : element}
            </Fragment>
          );
        })}
      </div>
      {actions}
    </div>
  );
}

export function PanelWindowControls({
  fullView,
  fullViewLabel,
  fullViewShortcut,
  onToggleFullView,
  closeLabel,
  onClose,
}: {
  fullView: boolean;
  fullViewLabel: string;
  fullViewShortcut?: string | null;
  onToggleFullView: () => void;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <>
      <span
        aria-hidden={true}
        data-slot="browser-tab-divider"
        className="mx-1 h-4 w-px shrink-0 bg-border"
      />
      <PanelIconButton
        label={fullViewLabel}
        shortcut={fullViewShortcut}
        onClick={onToggleFullView}
        className={PANEL_STRIP_BUTTON}
      >
        <HugeiconsIcon
          icon={fullView ? ExitFullViewIcon : EnterFullViewIcon}
          strokeWidth={1.75}
          className="size-[calc(var(--icon-size)*1.2)]"
        />
      </PanelIconButton>
      <PanelIconButton
        label={closeLabel}
        onClick={onClose}
        className={PANEL_STRIP_BUTTON}
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          strokeWidth={1.75}
          className="size-icon"
        />
      </PanelIconButton>
    </>
  );
}
