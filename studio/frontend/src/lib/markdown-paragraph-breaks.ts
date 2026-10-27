// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import type { Element, ElementContent, Root } from "hast";
import type { Plugin } from "unified";

const phrasing = new Set(["a", "em", "strong", "del"]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordStart = /^[\p{L}\p{N}]/u;

function textRuns(text: string): ElementContent[] {
  const nodes: ElementContent[] = [];
  const segments = graphemes.segment(text);
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 2048);
    if (end < text.length) {
      const before = text.lastIndexOf(" ", end - 1);
      if (before >= offset) end = before + 1;
      else {
        const after = text.indexOf(" ", end);
        end = after < 0 ? text.length : after + 1;
      }
    }
    while (end < text.length) {
      const left = segments.containing(end - 2);
      const right = segments.containing(end);
      if (
        left &&
        right?.index === end &&
        wordStart.test(left.segment) &&
        wordStart.test(right.segment)
      )
        break;
      const after = text.indexOf(" ", end);
      end = after < 0 ? text.length : after + 1;
    }
    nodes.push({ type: "text", value: text.slice(offset, end) });
    if (end < text.length)
      nodes.push({
        type: "element",
        tagName: "wbr",
        properties: {},
        children: [],
      });
    offset = end;
  }
  return nodes;
}

function breakParagraph(node: Element): void {
  node.children = node.children.flatMap((child): ElementContent[] => {
    if (child.type === "element" && phrasing.has(child.tagName))
      breakParagraph(child);
    return child.type === "text" && child.value.length > 2048
      ? textRuns(child.value)
      : [child];
  });
}

// Inline spans still share a shaping run. Ordinary word spaces allow shaping
// boundaries without splitting graphemes or overriding punctuation and no-break controls.
export const rehypeParagraphBreaks: Plugin<[], Root> = () => (tree) => {
  function walk(node: Root | Element): void {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "p") breakParagraph(child);
      else walk(child);
    }
  }
  walk(tree);
};
