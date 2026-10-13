// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Button } from "@/components/ui/button";
import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { CodingRun, QuestionAnswerForm } from "./run-session";
import type { NativeAnswer } from "./run-types";

/** Expanded native controls; never use the ordinary prompt as a question reply. */
export function QuestionCard({
  form,
  run,
  live,
  focus,
  onReleaseFocus,
}: {
  form: QuestionAnswerForm;
  run: CodingRun;
  live: boolean;
  focus: boolean;
  onReleaseFocus: (questionId: string) => void;
}) {
  const prefix = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const initiallyFocus = useRef(focus);
  const section = useRef<HTMLElement>(null);
  const statusOutput = useRef<HTMLOutputElement>(null);
  const heldFocus = useRef(false);
  const releaseFocus = useRef(onReleaseFocus);
  releaseFocus.current = onReleaseFocus;
  const questionId = form.target.user_request_id;
  useEffect(() => {
    const outsideInteraction = (event: Event) => {
      if (
        event.target instanceof Node &&
        !(event.type === "focusin" && event.target === document.body) &&
        !section.current?.contains(event.target)
      )
        heldFocus.current = false;
    };
    const leaveWindow = () => {
      heldFocus.current = false;
    };
    // Clicking non-focusable transcript text can blur to body with no relatedTarget.
    // Such deliberate outside interaction is not focus lost to disabled controls.
    document.addEventListener("pointerdown", outsideInteraction, true);
    document.addEventListener("focusin", outsideInteraction, true);
    window.addEventListener("blur", leaveWindow);
    if (initiallyFocus.current) heading.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", outsideInteraction, true);
      document.removeEventListener("focusin", outsideInteraction, true);
      window.removeEventListener("blur", leaveWindow);
      // React has removed the controls by this point. Restore only focus that
      // belonged to this card; never steal it from another input or earlier row.
      if (heldFocus.current && document.activeElement === document.body)
        releaseFocus.current(questionId);
    };
  }, [questionId]);
  const editable = live && ["waiting", "error"].includes(form.status);
  useLayoutEffect(() => {
    if (
      !editable &&
      heldFocus.current &&
      (document.activeElement === document.body ||
        section.current?.contains(document.activeElement))
    )
      statusOutput.current?.focus();
  }, [editable]);
  const change = (answer: NativeAnswer) => {
    run.editAnswer(
      form.target,
      form.answers.map((item) =>
        item.question_id === answer.question_id ? answer : item,
      ),
    );
  };
  const status =
    form.status === "accepted"
      ? "Accepted · confirmed by Mimir"
      : form.status === "submitting"
        ? "Submitting… waiting for native acceptance"
        : form.status === "uncertain"
          ? "Answer delivery unconfirmed · reconciling native state"
          : form.status === "inactive"
            ? "Question no longer live · draft retained"
            : live
              ? form.status === "error"
                ? "Answer not accepted · review the error and draft"
                : "Waiting for your answer"
              : "Waiting · answer controls unavailable until native state is confirmed";
  return (
    <section
      ref={section}
      onFocusCapture={() => {
        heldFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          event.relatedTarget !== document.body &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          heldFocus.current = false;
      }}
      className="min-w-0 space-y-3 rounded-2xl border border-border bg-muted/30 p-4 text-sm"
      aria-labelledby={`${prefix}-heading`}
      data-testid="coding-question-card"
      data-question-id={form.target.user_request_id}
      data-request-id={form.target.request_id}
      data-subscription={form.target.subscription}
    >
      <h3
        ref={heading}
        id={`${prefix}-heading`}
        tabIndex={-1}
        className="rounded font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Mimir needs your input
      </h3>
      <output
        ref={statusOutput}
        tabIndex={-1}
        className="block rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-live="polite"
        data-testid="coding-answer-status"
      >
        {status}
      </output>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (editable) void run.answer(form.target);
        }}
      >
        {form.question.questions.map((question, index) => {
          const answer = form.answers.find(
            (item) => item.question_id === question.id,
          );
          if (!answer) return null;
          return (
            <fieldset
              key={question.id}
              disabled={!editable}
              className="min-w-0 space-y-2"
            >
              <legend className="mb-2 whitespace-pre-wrap break-words font-medium">
                {question.prompt}
              </legend>
              {question.options.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {question.allow_multiple
                    ? "Select any applicable options."
                    : "Select one option."}{" "}
                  You can also provide your own answer below.
                </p>
              )}
              {question.options.map((option, optionIndex) => (
                <label
                  key={option.label}
                  className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                >
                  <input
                    type={question.allow_multiple ? "checkbox" : "radio"}
                    name={`${prefix}-${index}`}
                    value={option.label}
                    aria-label={option.label}
                    aria-describedby={
                      option.description
                        ? `${prefix}-${index}-${optionIndex}-description`
                        : undefined
                    }
                    checked={answer.selected_options.includes(option.label)}
                    className="mt-1 shrink-0 accent-primary"
                    onChange={(event) =>
                      change({
                        ...answer,
                        selected_options: question.allow_multiple
                          ? event.target.checked
                            ? [...answer.selected_options, option.label]
                            : answer.selected_options.filter(
                                (label) => label !== option.label,
                              )
                          : [option.label],
                      })
                    }
                  />
                  <span className="min-w-0 break-words">
                    <span className="block font-medium">{option.label}</span>
                    {option.description && (
                      <span
                        id={`${prefix}-${index}-${optionIndex}-description`}
                        className="block whitespace-pre-wrap text-xs text-muted-foreground"
                      >
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <label className="block space-y-1">
                <span>
                  {question.options.length
                    ? "Additional or custom answer"
                    : "Your answer"}
                </span>
                <textarea
                  aria-label={`${question.prompt} — ${question.options.length ? "Additional or custom answer" : "Your answer"}`}
                  className="block min-h-20 w-full min-w-0 resize-y rounded-lg border border-input bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
                  value={answer.freeform_text ?? ""}
                  maxLength={16384}
                  onChange={(event) =>
                    change({
                      ...answer,
                      freeform_text: event.target.value || null,
                    })
                  }
                />
              </label>
            </fieldset>
          );
        })}
        {form.error && (
          <p role="alert" className="break-words text-destructive">
            {form.error}
          </p>
        )}
        {form.status !== "accepted" && (
          <Button
            type="submit"
            disabled={!editable}
            className="max-w-full whitespace-normal"
            data-testid="coding-submit-answer"
          >
            {form.status === "submitting"
              ? "Submitting answer…"
              : "Submit answer"}
          </Button>
        )}
      </form>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Question identity details
        </summary>
        <p className="mt-1 break-all font-mono text-[10px]">
          Request {form.target.request_id} · Question{" "}
          {form.target.user_request_id}
        </p>
      </details>
    </section>
  );
}
