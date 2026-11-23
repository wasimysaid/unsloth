// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { cn } from "@/lib/utils";
import { DashboardSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLayoutEffect, useRef } from "react";
import { isCustomProviderType } from "./external-providers";
import { providerLogoPath } from "./provider-logo-path";

export function apiProviderLogoSrc(
  providerType: string | undefined | null,
): string | undefined {
  const path = providerLogoPath(providerType);
  return path ? `${import.meta.env.BASE_URL}${path.slice(1)}` : undefined;
}

interface ApiProviderLogoProps {
  providerType: string | undefined | null;
  className?: string;
  title?: string;
  /** The connection's name: a type with no logo shows its first letter on a colour from it. */
  name?: string;
}

export function letterTileColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of name.toLowerCase()) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
  }
  // murmur3 finalizer, or names sharing "-GGUF" cluster on one hue.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  const h = hash >>> 0;
  const lightness = 0.52 + ((h >>> 20) % 4) * 0.04;
  return `oklch(${lightness.toFixed(2)} 0.15 ${h % 360})`;
}

const DARK_INVERT_LOGOS = new Set(["openai", "openai_codex", "ollama", "liquid", "typesafe", "vercel", "xai", "zai", "kimi", "opencode", "opencode_go"]);
// Pale brand marks get a hairline edge on light surfaces instead of inverting.
const LIGHT_OUTLINE_LOGOS = new Set(["openrouter"]);

type LetterPaint = { letter: string; color: string };
const pendingLetters = new Map<HTMLCanvasElement, LetterPaint>();

function paintLetters() {
  const measured = [...pendingLetters].flatMap(([canvas, paint]) => {
    if (!canvas.isConnected) return [];
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const size = canvas.offsetWidth;
    if (size <= 0) return [];
    const dpr = (window.devicePixelRatio || 1) * (canvas.getBoundingClientRect().width / size || 1);
    const fontFamily = getComputedStyle(canvas).fontFamily;
    return [{ canvas, ctx, size, dpr, fontFamily, ...paint }];
  });
  pendingLetters.clear();
  for (const { canvas, ctx, size, dpr, fontFamily, letter, color } of measured) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 ${size * 0.54}px ${fontFamily}`;
    const m = ctx.measureText(letter);
    ctx.fillStyle = "#fff";
    ctx.fillText(
      letter,
      size / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2,
      size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
    );
  }
}

function LetterTile({
  letter,
  name,
  title,
  className,
}: { letter: string; name: string; title?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const color = letterTileColor(name);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let live = true;
    const schedule = () => {
      if (!live) return;
      const scheduled = pendingLetters.size > 0;
      pendingLetters.set(canvas, { letter, color });
      if (!scheduled) queueMicrotask(paintLetters);
    };
    schedule();
    void document.fonts?.ready.then(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    return () => {
      live = false;
      observer.disconnect();
      pendingLetters.delete(canvas);
    };
  }, [letter, color]);
  return (
    <canvas
      ref={ref}
      title={title}
      aria-hidden
      className={cn("shrink-0 rounded-full", className)}
    />
  );
}

export function ApiProviderLogo({ providerType, className, title, name }: ApiProviderLogoProps) {
  const src = apiProviderLogoSrc(providerType);
  const letter = name?.trim().charAt(0).toUpperCase();
  if (!src && letter) {
    return (
      <LetterTile
        letter={letter}
        name={name ?? ""}
        title={title}
        className={className}
      />
    );
  }
  if (!src && isCustomProviderType(providerType)) {
    return (
      <span title={title} aria-hidden className="inline-flex shrink-0">
        <HugeiconsIcon icon={DashboardSquare01Icon} className={cn("shrink-0", className)} />
      </span>
    );
  }

  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      title={title}
      aria-hidden
      className={cn(
        "shrink-0 object-contain",
        providerType && DARK_INVERT_LOGOS.has(providerType) && "dark:invert",
        providerType &&
          LIGHT_OUTLINE_LOGOS.has(providerType) &&
          "drop-shadow-[0_0_0.5px_rgb(0_0_0/0.7)] dark:drop-shadow-none",
        className,
      )}
    />
  );
}
