// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import {
  type CodingCommand,
  type DiagnosticKind,
  commandOutcomeLabel,
  contextUsageLabel,
} from "./command-types";
import type { CodingRun, CodingRunState } from "./run-session";

export function CodingCommandControls({
  run,
  state,
}: { run: CodingRun; state: CodingRunState }) {
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CodingCommand | null>(null);
  const [tail, setTail] = useState("");
  const connected = state.connection === "connected" && !state.recovering;
  const changing =
    state.commandBusy ||
    state.submitting ||
    state.configuring ||
    state.configurationUncertain ||
    Boolean(
      state.stopping ||
        state.reconcilingAction ||
        state.uncertainSubmission ||
        state.uncertainCommand ||
        state.storageError,
    );
  const busy = Boolean(
    state.native?.active_request ||
      state.native?.requests.some((r) => r.status === "queued"),
  );
  const effectiveSelected = state.commands?.find(
    (c) => c.name === selected?.name,
  );
  const unavailable = effectiveSelected?.availability === "idle-only" && busy;
  const commands = state.commands?.filter((command) =>
    [command.name, command.description, ...command.aliases]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const compression = state.native?.compression;
  return (
    <div
      className="min-w-0 space-y-2 text-xs"
      data-testid="coding-command-controls"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Dialog
          open={diagnosticsOpen}
          onOpenChange={(open) => {
            setDiagnosticsOpen(open);
            if (!open) run.clearDiagnostic();
          }}
        >
          <DialogTrigger asChild={true}>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 whitespace-normal text-left"
              disabled={!connected}
              aria-label="Inspect current-session context and usage"
            >
              {contextUsageLabel(state.native?.usage)}
            </Button>
          </DialogTrigger>
          <DialogContent className="min-w-0 content-start sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Current-session diagnostics</DialogTitle>
              <DialogDescription>
                Inspect supported, bounded native data on demand. Model context
                is separate from the public transcript; private content and
                credentials are not shown. These are current-session
                observations, not a historical usage dashboard.
              </DialogDescription>
            </DialogHeader>
            <div
              className="flex flex-wrap gap-2"
              aria-label="Diagnostic categories"
            >
              {(
                ["context", "tokens", "retry", "execution"] as DiagnosticKind[]
              ).map((kind) => (
                <Button
                  key={kind}
                  variant="outline"
                  size="sm"
                  disabled={!connected || Boolean(state.inspectingDiagnostic)}
                  onClick={() => void run.inspectDiagnostic(kind)}
                >
                  {kind[0].toUpperCase() + kind.slice(1)} diagnostics
                </Button>
              ))}
            </div>
            {state.inspectingDiagnostic && (
              <output className="block">
                Reading bounded {state.inspectingDiagnostic} diagnostics…
              </output>
            )}
            {state.commandError && (
              <p role="alert" className="break-words text-destructive">
                {state.commandError}
              </p>
            )}
            {state.diagnostic ? (
              <section
                aria-label={`${state.diagnostic.kind} diagnostics result`}
                className="min-w-0 space-y-2"
              >
                <p className="font-medium">
                  {state.diagnostic.kind} · native bounded snapshot{" "}
                  {state.diagnostic.clipped && "· truncated"}
                </p>
                <pre
                  className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-3 text-xs"
                  data-testid="coding-diagnostic-result"
                >
                  {JSON.stringify(state.diagnostic.data, null, 2)}
                </pre>
              </section>
            ) : (
              !state.inspectingDiagnostic && (
                <p>Select a category to request its supported data.</p>
              )
            )}
          </DialogContent>
        </Dialog>
        <Dialog
          open={commandsOpen}
          onOpenChange={(open) => {
            setCommandsOpen(open);
            if (open) void run.discoverCommands();
          }}
        >
          <DialogTrigger asChild={true}>
            <Button variant="outline" size="sm" disabled={!connected}>
              Commands
            </Button>
          </DialogTrigger>
          <DialogContent className="min-w-0 content-start sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Native commands</DialogTitle>
              <DialogDescription>
                Effective commands for this live conversation, including project
                contributions. Terminal-only commands are not supported here.
                Commands never fall through into model prompts.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input
                aria-label="Search native commands"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!connected || state.discoveringCommands}
                onClick={() => void run.discoverCommands()}
              >
                Refresh
              </Button>
            </div>
            {state.discoveringCommands && (
              <output className="block">Discovering effective commands…</output>
            )}
            <ul
              aria-label="Effective native commands"
              className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-border p-2"
            >
              {commands?.map((command) => (
                <li key={command.name}>
                  <button
                    type="button"
                    aria-label={`Select /${command.name}`}
                    aria-pressed={selected?.name === command.name}
                    className="w-full min-w-0 space-y-1 rounded-lg p-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setSelected(command);
                      setTail("");
                    }}
                  >
                    <p className="break-all font-medium">
                      /{command.name}
                      {command.argument ? ` [${command.argument}]` : ""}
                      {selected?.name === command.name && " · selected"}
                    </p>
                    <p className="break-words text-muted-foreground">
                      {command.description}
                    </p>
                    <p className="break-all text-xs">
                      {command.aliases.length > 0 &&
                        `Aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")} · `}
                      {command.availability === "idle-only"
                        ? "Native idle-only admission"
                        : "Native busy-state admission supported"}
                    </p>
                  </button>
                </li>
              ))}
              {commands?.length === 0 && (
                <li>No matching supported commands.</li>
              )}
            </ul>
            {state.commandsClipped && (
              <p className="text-muted-foreground">
                Command descriptions or argument labels were clipped to the
                presentation bound. Executable names and aliases are retained.
              </p>
            )}
            <form
              className="min-w-0 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (effectiveSelected && !changing && !unavailable && connected)
                  void run.executeCommand(effectiveSelected.name, tail);
              }}
            >
              <p className="break-all font-medium">
                {effectiveSelected
                  ? `/${effectiveSelected.name}`
                  : "Choose an effective command"}
              </p>
              {effectiveSelected?.argument && (
                <label
                  htmlFor="coding-native-command-arguments"
                  className="block space-y-1"
                >
                  Optional {effectiveSelected.argument}
                  <Input
                    id="coding-native-command-arguments"
                    aria-label="Native command arguments"
                    value={tail}
                    onChange={(event) => setTail(event.target.value)}
                    disabled={changing}
                    maxLength={16384}
                  />
                </label>
              )}
              {unavailable && (
                <output className="block">
                  This command requires the native session to be idle. Stop and
                  wait for confirmed terminal cleanup first.
                </output>
              )}
              <Button
                type="submit"
                disabled={
                  !effectiveSelected || !connected || changing || unavailable
                }
              >
                {state.commandBusy
                  ? "Awaiting native command…"
                  : "Execute native command"}
              </Button>
            </form>
            {state.commandError && (
              <p role="alert" className="break-words text-destructive">
                {state.commandError}
              </p>
            )}
            {state.commandOutcome && (
              <div className="min-w-0 space-y-2">
                <output className="block break-words">
                  {commandOutcomeLabel(state.commandOutcome)}
                </output>
                {state.commandOutcome.outcome === "display" && (
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-2 text-xs">
                    {state.commandOutcome.text}
                    {state.commandOutcome.clipped &&
                      "\n· Output truncated to the presentation bound"}
                  </pre>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
      {state.commandBusy && (
        <output className="block">
          Awaiting native command outcome · acceptance is not completion
        </output>
      )}
      {state.commandError && (
        <p
          role="alert"
          className="break-words text-destructive"
          data-testid="coding-command-error"
        >
          {state.commandError}
        </p>
      )}
      {state.uncertainCommand && (
        <output
          className="block break-words"
          data-testid="coding-command-uncertainty"
        >
          /{state.uncertainCommand.name} ·{" "}
          {state.uncertainCommand.reconciled
            ? "Fresh native view inspected; the command outcome remains unknown. No retry is permitted until its effect is confirmed."
            : "Reconstructing native state before another action. No command was replayed."}
        </output>
      )}
      {state.uncertainCommand?.reconciled && (
        <Button
          variant="outline"
          size="sm"
          disabled={!connected || state.reconcilingCommand || state.commandBusy}
          onClick={() => void run.reconcileCommand()}
        >
          {state.reconcilingCommand
            ? "Inspecting native command outcome…"
            : "Inspect command outcome"}
        </Button>
      )}
      {state.native?.usage?.request_usage && (
        <p className="text-muted-foreground">
          Latest native turn usage:{" "}
          {state.native.usage.request_usage.input_tokens.toLocaleString()} input
          · {state.native.usage.request_usage.output_tokens.toLocaleString()}{" "}
          output tokens{state.native.usage.stale && " · stale observation"}
        </p>
      )}
      {state.commandOutcome && (
        <div className="min-w-0 space-y-1" data-testid="coding-command-outcome">
          <output className="block break-words">
            {commandOutcomeLabel(state.commandOutcome)}
          </output>
          {state.commandOutcome.outcome === "display" && (
            <details>
              <summary className="cursor-pointer rounded px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Inspect transient command output
                {state.commandOutcome.clipped && " · truncated"}
              </summary>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted p-2">
                {state.commandOutcome.text}
              </pre>
            </details>
          )}
        </div>
      )}
      {compression && (
        <output className="block" data-testid="coding-compression-status">
          Model-context compression: {compression.status}
          {compression.phase && ` · ${compression.phase}`}
          {compression.before_tokens !== undefined &&
            compression.after_tokens !== undefined &&
            ` · ${compression.before_tokens} → ${compression.after_tokens} tokens`}
          {compression.error && ` · ${compression.error}`} · public conversation
          history is retained
        </output>
      )}
    </div>
  );
}
