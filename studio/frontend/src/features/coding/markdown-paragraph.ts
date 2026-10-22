// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** A conservative subset whose Markdown result is exactly one literal paragraph. */
export function isLiteralParagraph(text: string): boolean {
  return (
    !text.startsWith("    ") &&
    !/[^\p{L}\p{N}\p{M}\p{So}_ ]/u.test(text) &&
    !/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u.test(text)
  );
}

/** Inline runs avoid shaping one huge text node without changing paragraph flow. */
export function literalParagraphRuns(text: string): string[] {
  const runs: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 2048);
    if (end < text.length) {
      const before = text.lastIndexOf(" ", end - 1);
      if (before >= offset) end = before + 1;
      else {
        // Keep an unbroken word or grapheme sequence whole, never clip it.
        const after = text.indexOf(" ", end);
        end = after < 0 ? text.length : after + 1;
      }
    }
    runs.push(text.slice(offset, end));
    offset = end;
  }
  return runs;
}
