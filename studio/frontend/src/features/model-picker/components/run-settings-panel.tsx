// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent } from "@/components/ui/tooltip";
import { PanelResizeHandle } from "@/components/ui/panel-resize-handle";
import { useScrollFades } from "@/hooks/use-scroll-fades";
import { useUiSpaceScale } from "@/hooks/use-ui-space-scale";
import {
  CHAT_SETTINGS_WIDTH_MIN,
  clampChatSettingsWidth,
  useChatSettingsWidth,
} from "@/hooks/use-chat-settings-width";
import { useIsCompact } from "@/hooks/use-mobile";
import { useT } from "@/i18n";
import { cornerInsets, watchChatSettingsInset } from "@/lib/toast-offset";
import { ChevronDownStandardIcon } from "@/lib/chevron-icons";
import { cn } from "@/lib/utils";
import {
  PanelRightIcon,
  LayoutAlignRightIcon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

const CHAT_SETTINGS_TOP =
  "var(--chat-settings-top, var(--studio-custom-titlebar-height, 0px))";
const CHAT_SETTINGS_DOCKED_WIDTH_VAR = "--studio-chat-settings-docked-width";

export function RunSettingsToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipPrimitive.Trigger asChild={true}>
        <button
          type="button"
          onClick={onOpen}
          className="flex size-[calc(30px*var(--ui-space-scale,1))] cursor-pointer items-center justify-center rounded-[10px] text-nav-fg transition-colors hover:bg-nav-surface-hover hover:text-black dark:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Open run settings"
        >
          <HugeiconsIcon
            icon={LayoutAlignRightIcon}
            strokeWidth={1.75}
            className="size-icon"
          />
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipContent side="bottom" sideOffset={6} className="tooltip-compact">
        Open run settings
      </TooltipContent>
    </Tooltip>
  );
}

export function RunSettingsPanel({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const t = useT();
  const isCompact = useIsCompact();
  const uiSpaceScale = useUiSpaceScale();
  const {
    width: settingsWidth,
    max: settingsMax,
    scale: settingsScale,
    stored: settingsStored,
    setWidth: setSettingsWidth,
    resetWidth: resetSettingsWidth,
  } = useChatSettingsWidth();
  useEffect(() => {
    if (!open || isCompact) return;
    return watchChatSettingsInset(
      cornerInsets,
      asideRef.current,
      settingsWidth * settingsScale,
      uiSpaceScale,
    );
  }, [open, isCompact, settingsWidth, settingsScale, uiSpaceScale]);
  useEffect(() => {
    const panel = asideRef.current;
    if (!open || isCompact || !panel) return;
    // On the strip, not <html>: an inherited root var restyles the thread every drag frame.
    let frame: HTMLElement | null = null;
    const apply = () => {
      const next = document.querySelector<HTMLElement>(
        '[data-slot="sidebar-container"][data-windows-glass-frame]',
      );
      if (frame && frame !== next) {
        frame.style.removeProperty(CHAT_SETTINGS_DOCKED_WIDTH_VAR);
      }
      frame = next;
      // Unrounded: offsetWidth leaves a sub-pixel seam.
      frame?.style.setProperty(
        CHAT_SETTINGS_DOCKED_WIDTH_VAR,
        `${panel.getBoundingClientRect().width}px`,
      );
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(panel);
    const pinObserver = new MutationObserver(apply);
    pinObserver.observe(document.documentElement, {
      attributeFilter: ["data-sidebar-glass-frame"],
    });
    return () => {
      observer.disconnect();
      pinObserver.disconnect();
      frame?.style.removeProperty(CHAT_SETTINGS_DOCKED_WIDTH_VAR);
    };
  }, [open, isCompact]);
  const {
    attach: attachSettingsScroll,
    onScroll: onSettingsScroll,
    className: settingsFadeClass,
  } = useScrollFades();
  const settingsContent = (
    <div className="hint-on-hover flex h-full min-h-0 flex-col">
      {/* Header outside the scroll area so the scrollbar never shifts the close button. */}
      <div className="flex h-[var(--studio-chat-header-height,48px)] shrink-0 items-start gap-2 bg-panel-surface pl-[calc(18px*var(--ui-space-scale,1))] pr-[calc(18px*var(--ui-space-scale,1))] pt-[var(--studio-chat-header-padding-top,11px)]">
        {isCompact ? (
          <span className="flex h-[var(--studio-chat-control-height,34px)] flex-1 items-center text-ui-16 font-semibold tracking-[0em] dark:tracking-[0.015em] text-nav-fg">
            Run settings
          </span>
        ) : (
          <>
            <span className="flex h-[var(--studio-chat-control-height,34px)] flex-1 items-center text-ui-16 font-semibold tracking-[0em] dark:tracking-[0.015em] text-nav-fg">
              Run settings
            </span>
            <Tooltip key={open ? "open" : "closed"}>
              <TooltipPrimitive.Trigger asChild={true}>
                <button
                  type="button"
                  onClick={() => onOpenChange?.(false)}
                  className="mt-[calc((var(--studio-chat-control-height,33px)-30px*var(--ui-space-scale,1))/2)] flex size-[calc(30px*var(--ui-space-scale,1))] cursor-pointer items-center justify-center rounded-[10px] text-nav-icon-idle dark:text-nav-fg-muted transition-colors hover:bg-nav-surface-hover hover:text-black dark:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label="Close run settings"
                >
                  <HugeiconsIcon
                    icon={PanelRightIcon}
                    strokeWidth={1.75}
                    className="size-icon"
                  />
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipContent
                side="bottom"
                sideOffset={6}
                className="tooltip-compact"
              >
                Close run settings
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      <div
        ref={attachSettingsScroll}
        onScroll={onSettingsScroll}
        className={cn(
          "run-settings-scroll panel-scroll-fade relative min-h-0 flex-1 overflow-y-auto",
          settingsFadeClass,
        )}
      >
        {children}
      </div>
    </div>
  );

  if (isCompact) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          data-chat-settings-sheet=""
          className="w-[min(calc(18rem*var(--ui-space-scale,1)),100vw)] p-0 font-heading"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Run settings</SheetTitle>
            <SheetDescription>Model and inference settings</SheetDescription>
          </SheetHeader>
          <div data-tour="chat-settings" data-slot="chat-settings-panel" className="relative flex h-full flex-col">
            {settingsContent}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      ref={asideRef}
      data-tour="chat-settings"
      data-slot="chat-settings-panel"
      inert={!open}
      className={cn(
        "relative z-50 shrink-0 bg-panel-surface text-panel-surface-fg font-heading",
        open ? "w-(--chat-settings-width)" : "w-0 overflow-hidden",
      )}
      style={
        {
          "--chat-settings-width": `${settingsWidth * settingsScale}px`,
          height: `calc(100% - ${CHAT_SETTINGS_TOP})`,
          marginTop: CHAT_SETTINGS_TOP,
        } as CSSProperties
      }
    >
      {open ? (
        <PanelResizeHandle
          edge="left"
          open={open}
          width={settingsWidth}
          stored={settingsStored}
          min={CHAT_SETTINGS_WIDTH_MIN}
          max={settingsMax}
          scale={settingsScale}
          clamp={clampChatSettingsWidth}
          setWidth={setSettingsWidth}
          resetWidth={resetSettingsWidth}
          onToggle={() => onOpenChange?.(!open)}
          target={() => asideRef.current}
          cssVar="--chat-settings-width"
          measure={() =>
            (asideRef.current?.getBoundingClientRect().width ?? 0) /
            settingsScale
          }
          label={t("shell.aria.resizeRunSettings")}
          toggleLabel={t("shell.aria.openRunSettings")}
          collapseHint={t("shell.resize.collapse")}
          expandHint={t("shell.resize.expand")}
          dragHint={t("shell.resize.drag")}
          dataSlot="chat-settings-resize-handle"
        />
      ) : null}
      <div
        data-chat-settings-content=""
        className={cn(
          "h-full w-full overflow-hidden",
          open && "border-l border-panel-edge",
        )}
      >
        {settingsContent}
      </div>
    </aside>
  );
}

const COLLAPSIBLE_STATE_KEY = "unsloth_chat_collapsible_state";

function loadCollapsibleState(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(COLLAPSIBLE_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch (error) {
    console.warn("Failed to load collapsible state from localStorage:", error);
    return {};
  }
}

function saveCollapsibleOpen(label: string, open: boolean) {
  if (typeof window === "undefined") return;
  try {
    const state = loadCollapsibleState();
    state[label] = open;
    localStorage.setItem(COLLAPSIBLE_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function RunSettingsBody({
  model,
  children,
}: {
  model?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-[calc(18px*var(--ui-space-scale,1))] pt-3">
      {model && (
        <RunSettingsSection label="Model" defaultOpen={true} first={true}>
          <div className="flex flex-col gap-5">{model}</div>
        </RunSettingsSection>
      )}
      {children}
    </div>
  );
}

export function RunSettingsSection({
  label,
  labelHref,
  headerAction,
  onLabelClick,
  children,
  defaultOpen = false,
  first = false,
}: {
  label: string;
  /** Makes the label an external link; link and chevron are siblings, not <a> in <button>. */
  labelHref?: string;
  headerAction?: ReactNode;
  onLabelClick?: () => void;
  children?: ReactNode;
  defaultOpen?: boolean;
  first?: boolean;
}) {
  const [open, setOpen] = useState(() => {
    const saved = loadCollapsibleState();
    return Object.hasOwn(saved, label) ? saved[label] : defaultOpen;
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    saveCollapsibleOpen(label, next);
  };

  const headerClasses = cn(
    "flex w-full items-center justify-between text-ui-12 font-medium normal-case tracking-[0.04em] text-nav-fg-muted transition-colors focus-visible:outline-none focus-visible:ring-0",
    // pt-2 centers the first label on the sidebar's New chat row.
    first ? "pt-2 pb-5" : "py-5",
  );

  return (
    <div
      className={cn(
        !first &&
          "border-t border-[rgb(0_0_0_/_calc(0.13*var(--contrast-edge-gain,1)))] dark:border-[rgb(255_255_255_/_calc(0.09*var(--contrast-edge-gain,1)))]",
      )}
    >
      {labelHref ? (
        <div className={headerClasses}>
          <a
            href={labelHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex cursor-pointer items-center gap-1 leading-none transition-colors hover:text-nav-fg"
          >
            <span>{label}</span>
            <HugeiconsIcon icon={LinkSquare02Icon} className="size-3" />
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
            className="flex shrink-0 cursor-pointer items-center leading-none transition-colors hover:text-nav-fg"
          >
            <HugeiconsIcon
              icon={ChevronDownStandardIcon}
              className={cn("size-3.5", open ? "rotate-0" : "-rotate-90")}
            />
          </button>
        </div>
      ) : headerAction ? (
        <div className={headerClasses}>
          <button
            type="button"
            onClick={onLabelClick ?? toggle}
            className="flex min-w-0 flex-1 cursor-pointer items-center text-left leading-none transition-colors hover:text-nav-fg"
          >
            <span className="leading-none">{label}</span>
          </button>
          <span className="flex shrink-0 items-center gap-1">
            {headerAction}
            <button
              type="button"
              onClick={toggle}
              aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
              className="flex shrink-0 cursor-pointer items-center leading-none transition-colors hover:text-nav-fg"
            >
              <HugeiconsIcon
                icon={ChevronDownStandardIcon}
                className={cn("size-3.5", open ? "rotate-0" : "-rotate-90")}
              />
            </button>
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={toggle}
          className={cn("cursor-pointer hover:text-nav-fg", headerClasses)}
        >
          <span className="leading-none">{label}</span>
          <span className="flex shrink-0 items-center leading-none">
            <HugeiconsIcon
              icon={ChevronDownStandardIcon}
              className={cn("size-3.5", open ? "rotate-0" : "-rotate-90")}
            />
          </span>
        </button>
      )}
      {open && <div className="pb-5">{children}</div>}
    </div>
  );
}
