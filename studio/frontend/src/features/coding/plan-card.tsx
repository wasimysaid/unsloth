// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { MarkdownPreview } from "@/components/markdown/markdown-preview";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { Check, ChevronDown, ClipboardList, Copy } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { planOverflows, planPreviewLimit } from "./plan-preview";
import type { NativePlan } from "./plan-types";
import { replyProse } from "./reply-prose";
import { useDisclosure } from "./tool-report";

const planLabels: Record<NativePlan["status"], string> = {
  review_pending: "Ready for review",
  saved_stopped: "Saved",
  accepted: "Accepted",
  implementing: "Implementing",
  completed: "Implemented",
  abandoned: "Abandoned",
};

/**
 * The current plan reads like a reply: a quiet label over its rendered Markdown
 * in reply typography, unboxed, previewed to a bounded height with a "Show full
 * plan" toggle when long. Earlier plans are a one-line record that opens to the
 * full plan. `actions` are the turn's reply actions, beside Copy.
 */
export function PlanCard({
  plan,
  current = false,
  actions,
}: { plan: NativePlan; current?: boolean; actions?: ReactNode }) {
  // A new plan or revision starts over: its own fold, measurement and copy state.
  return current ? (
    <CurrentPlan
      key={`${plan.id}:${plan.revision}`}
      plan={plan}
      actions={actions}
    />
  ) : (
    <HistoricalPlan
      key={`${plan.id}:${plan.revision}:${plan.status}`}
      plan={plan}
      actions={actions}
    />
  );
}

// Folded text fades into whatever is behind the transcript.
const fadeMask =
  "linear-gradient(to bottom, #000 calc(100% - 4.5rem), transparent)";

function CurrentPlan({
  plan,
  actions,
}: { plan: NativePlan; actions?: ReactNode }) {
  const id = useId();
  const [expanded, toggle] = useDisclosure(
    `plan:${plan.id}:${plan.revision}`,
    false,
  );
  const content = useRef<HTMLDivElement>(null);
  // null: the whole plan fits; otherwise the preview height in pixels.
  const [limit, setLimit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const next = planPreviewLimit(window.innerHeight);
      setLimit(planOverflows(element.scrollHeight, next) ? next : null);
    };
    measure();
    // Markdown can settle after mount (highlighting, fonts, images).
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const folded = limit !== null && !expanded;
  return (
    <section
      aria-labelledby={`${id}-title ${id}-status`}
      className="min-w-0 pt-2"
      data-testid="coding-current-plan"
      data-plan-id={plan.id}
      data-plan-status={plan.status}
      data-plan-view={folded ? "preview" : "full"}
    >
      <div className="mb-1 flex h-6.5 min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        <ClipboardList aria-hidden="true" className="size-3.5 shrink-0" />
        <span
          id={`${id}-title`}
          className="min-w-0 truncate font-medium"
          title={plan.path || undefined}
        >
          Plan
          {/* The Markdown carries its own title; the label names it only when it can't. */}
          {plan.markdown ? (
            <span className="sr-only">: {plan.name}</span>
          ) : (
            <span className="ml-1.5 font-normal text-foreground/85">
              {plan.name}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="text-muted-foreground/50">
          ·
        </span>
        <PlanStatus plan={plan} id={id} />
      </div>
      <div
        id={`${id}-content`}
        className="min-w-0 overflow-hidden"
        style={
          folded
            ? {
                maxHeight: limit,
                maskImage: fadeMask,
                WebkitMaskImage: fadeMask,
              }
            : undefined
        }
        data-testid="coding-plan-content"
        // Keyboard focus reaching a folded link or code block reveals the rest.
        onFocus={folded ? toggle : undefined}
      >
        <div ref={content} className="min-w-0">
          <PlanBody plan={plan} />
        </div>
      </div>
      {(limit !== null || plan.markdown || actions) && (
        <div className="flex min-w-0 flex-wrap items-center gap-0.5 pt-1">
          {limit !== null && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`${id}-content`}
              data-reading-control={`plan:${plan.id}`}
              data-testid="coding-plan-toggle"
              onClick={toggle}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
            >
              {expanded ? "Show less" : "Show full plan"}
              <ChevronDown
                aria-hidden="true"
                className={`size-3.5 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
          {plan.markdown && <CopyPlan markdown={plan.markdown} />}
          {actions}
        </div>
      )}
    </section>
  );
}

function HistoricalPlan({
  plan,
  actions,
}: { plan: NativePlan; actions?: ReactNode }) {
  const id = useId();
  const [open, toggle] = useDisclosure(
    `plan:${plan.id}:${plan.revision}:${plan.status}`,
    false,
  );
  return (
    <>
      <section
        aria-labelledby={`${id}-title ${id}-status`}
        className={`min-w-0 rounded-xl border border-border/70 ${open ? "bg-background dark:bg-card" : ""}`}
        data-testid="coding-historical-plan"
        data-plan-id={plan.id}
        data-plan-status={plan.status}
        data-plan-view={open ? "full" : "collapsed"}
      >
        <div className="flex min-w-0 items-center gap-1 pr-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${id}-content`}
            data-reading-control={`plan:${plan.id}:${plan.status}`}
            data-testid="coding-plan-toggle"
            onClick={toggle}
            title={plan.path || undefined}
            className="group/plan flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pr-2 pl-3 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            <ClipboardList
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span id={`${id}-title`} className="min-w-0 flex-1 truncate">
              <span className="font-medium text-muted-foreground">Plan</span>
              <span className="sr-only">: </span>
              <span className="ml-2 text-foreground/85 group-hover/plan:text-foreground">
                {plan.name}
              </span>
            </span>
            <PlanStatus plan={plan} id={id} />
            <ChevronDown
              aria-hidden="true"
              className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            />
          </button>
          {open && plan.markdown && <CopyPlan markdown={plan.markdown} />}
        </div>
        {open && (
          <div
            id={`${id}-content`}
            className="min-w-0 px-4 pt-1 pb-3 sm:px-5.5"
            data-testid="coding-plan-content"
          >
            <PlanBody plan={plan} />
          </div>
        )}
      </section>
      {actions && <div className="flex items-center gap-0.5">{actions}</div>}
    </>
  );
}

function PlanStatus({ plan, id }: { plan: NativePlan; id: string }) {
  return (
    <>
      <span className="sr-only">, </span>
      <span
        id={`${id}-status`}
        className="shrink-0 text-[12px] text-muted-foreground"
        data-testid="coding-plan-status"
      >
        {planLabels[plan.status]}
      </span>
    </>
  );
}

function PlanBody({ plan }: { plan: NativePlan }) {
  return (
    <>
      {plan.markdown ? (
        <MarkdownPreview markdown={plan.markdown} className={replyProse} />
      ) : (
        <p className="text-xs text-muted-foreground">
          This entry didn't record the plan text.
        </p>
      )}
      {plan.clipped && (
        <p className="mt-2 text-xs text-muted-foreground">Plan clipped</p>
      )}
    </>
  );
}

function CopyPlan({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied plan" : "Copy plan"}
      title="Copy plan as Markdown"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
      onClick={() =>
        void copyToClipboard(markdown).then((done) => done && setCopied(true))
      }
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}
