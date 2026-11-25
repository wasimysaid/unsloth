// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { useFullAccessAllowed } from "@/features/auth";
import { FullAccessConfirmContent, PermissionComposerMenu, type PermissionMode } from "@/features/chat";
import { codingModeControlReason, type CodingRun, type CodingRunState } from "./run-session";

export function TerminalPermissionMenu({
  mode, disabled, onChange, onOpen, confirmRequested, onCloseRequest,
}: {
  mode: PermissionMode;
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
  onOpen?: () => void;
  confirmRequested?: boolean;
  onCloseRequest?: () => void;
}) {
  const fullAccessAllowed = useFullAccessAllowed();
  const [confirm, setConfirm] = useState(false);
  const close = () => {
    setConfirm(false);
    onCloseRequest?.();
  };
  if (disabled && confirm) setConfirm(false);
  useEffect(() => {
    if (disabled && confirmRequested) onCloseRequest?.();
  }, [disabled, confirmRequested, onCloseRequest]);

  return (
    <>
      <PermissionComposerMenu
        mode={mode}
        terminal
        disabled={disabled}
        fullAccessAllowed={fullAccessAllowed}
        onOpenChange={(open) => { if (open) onOpen?.(); }}
        onChoose={(choice) => {
          // Let the menu restore focus before the confirmation takes it.
          if (choice === "full") setTimeout(() => setConfirm(true), 0);
          else onChange(choice);
        }}
      />
      <AlertDialog
        open={Boolean((confirm || confirmRequested) && fullAccessAllowed && !disabled)}
        onOpenChange={(open) => { if (!open) close(); }}
      >
        <FullAccessConfirmContent
          terminal
          onConfirm={() => {
            close();
            if (!disabled && fullAccessAllowed) onChange("full");
          }}
          onClose={close}
        />
      </AlertDialog>
    </>
  );
}

export function TerminalPermissionPill({ run, state, conversationId }: {
  run: CodingRun;
  state: CodingRunState;
  conversationId: string;
}) {
  const channel = useRef<BroadcastChannel | null>(null);
  const connected = state.connection === "connected";
  const refresh = run.refreshTerminalPermissions;
  useEffect(() => {
    if (!connected) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const updates = typeof BroadcastChannel === "function"
      ? new BroadcastChannel(`studio-terminal-permissions:${conversationId}`)
      : null;
    if (updates) updates.onmessage = onFocus;
    channel.current = updates;
    return () => {
      window.removeEventListener("focus", onFocus);
      updates?.close();
      channel.current = null;
    };
  }, [connected, conversationId, refresh]);
  const control = state.terminalPermissions;
  if (!connected || !control || control.kind === "unavailable") return null;
  if (control.kind === "unknown")
    return <button type="button" className="composer-pill-btn" onClick={() => void refresh()}>Check terminal permissions</button>;
  return (
    <TerminalPermissionMenu
      mode={control.kind === "changing" ? control.previous : control.mode}
      disabled={control.kind === "changing" || Boolean(state.native?.active_request || codingModeControlReason(state))}
      onOpen={() => void refresh()}
      onChange={async (mode) => {
        await run.chooseTerminalMode(mode);
        channel.current?.postMessage(null);
      }}
      confirmRequested={state.confirmFullTerminalAccess}
      onCloseRequest={run.closeFullTerminalAccess}
    />
  );
}
