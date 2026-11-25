// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { ShieldQuestion } from "lucide-react";
import { useId } from "react";
import type { CodingRun, CodingRunState } from "./run-session";

function presentInput(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    "command" in input &&
    typeof input.command === "string" &&
    Object.keys(input).length === 1
  ) {
    // Make invisible control and bidi characters visible in the command a person approves.
    return input.command.replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  }
  return JSON.stringify(input, null, 2);
}

export function PendingApproval({
  state,
  run,
}: { state: CodingRunState; run: CodingRun }) {
  const heading = useId();
  const pending = state.native?.user_request;
  const details = pending?.approval;
  if (!details) return null;
  const form = state.answerForms.find(
    (item) =>
      item.target.user_request_id === pending?.id &&
      item.target.request_id === state.native?.active_request,
  );
  if (
    !form ||
    form.status === "accepted" ||
    form.status === "inactive"
  )
    return null;
  const choice = form.question.questions[0];
  if (!choice) return null;
  const live =
    state.connection === "connected" &&
    !state.stopping &&
    state.answerTarget?.subscription === form.target.subscription &&
    state.answerTarget?.request_id === form.target.request_id &&
    state.answerTarget?.user_request_id === form.target.user_request_id &&
    (form.status === "waiting" || form.status === "error");
  function respond(label: string) {
    if (!form || !live) return;
    run.editAnswer(form.target, [
      {
        question_id: choice.id,
        selected_options: [label],
        freeform_text: null,
      },
    ]);
    void run.answer(form.target);
  }
  return (
    <section
      aria-labelledby={heading}
      data-testid="coding-tool-approval"
      className="mx-1 mb-2 min-w-0 space-y-2 px-2 pt-1 text-sm"
    >
      <h3 id={heading} className="flex items-center gap-2 font-medium">
        <ShieldQuestion
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        {details.tool === "shell"
          ? "Run this command?"
          : `Allow ${details.tool}?`}
      </h3>
      {details.input === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          This input is too large to display in full.
        </p>
      ) : (
        <pre
          aria-label="Proposed action"
          dir="ltr"
          className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 px-2.5 py-2 font-mono text-xs"
          tabIndex={0}
        >
          {presentInput(details.input)}
        </pre>
      )}
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {details.reason && <p className="break-words">{details.reason}</p>}
        <p dir="auto" className="truncate font-mono" title={details.cwd}>
          {details.cwd}
        </p>
      </div>
      {form.error && (
        <p role="alert" className="text-xs text-destructive">
          {form.error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        {choice.options
          .map((option) => (
            <Button
              key={option.label}
              type="button"
              size="sm"
              variant={option.label === "Approve" ? "primary" : "ghost"}
              disabled={
                !live || (details.input === null && option.label !== "Deny")
              }
              title={option.description}
              onClick={() => respond(option.label)}
            >
              {option.label === "Approve" ? "Allow once" : option.label}
            </Button>
          ))
          .reverse()}
      </div>
    </section>
  );
}
