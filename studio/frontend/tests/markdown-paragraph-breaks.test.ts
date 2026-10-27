// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import type { Element, Root } from "hast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { unified } from "unified";
import { withLiteralUnknownTags } from "../src/lib/markdown-data-images.ts";
import { rehypeParagraphBreaks } from "../src/lib/markdown-paragraph-breaks.ts";

const render = (text: string, breaks = true) =>
  renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "static",
        controls: false,
        rehypePlugins: [
          ...withLiteralUnknownTags(),
          ...(breaks ? [rehypeParagraphBreaks] : []),
        ],
      },
      text,
    ),
  );

const paragraph = (text: string): Element => ({
  type: "element",
  tagName: "p",
  properties: {},
  children: [{ type: "text", value: text }],
});
const transform = (node: Element) => {
  const tree: Root = { type: "root", children: [node] };
  unified().use(rehypeParagraphBreaks).runSync(tree);
  return node;
};

test("multi-megabyte Markdown remains one complete paragraph with break hints only after existing spaces", () => {
  const text =
    "EVAL_TRANSPORT_BEGIN " + "é中文😀z ".repeat(180000) + "EVAL_TRANSPORT_END";
  assert.equal(new TextEncoder().encode(text).length, 2520039);
  const markup = render(text);
  assert.equal((markup.match(/<p>/g) ?? []).length, 1);
  const contents = markup.match(/<p>([\s\S]*)<\/p>/)?.[1];
  assert.ok(contents);
  assert.ok((contents.match(/<wbr\/>/g) ?? []).length > 500);
  assert.equal(contents.replaceAll("<wbr/>", ""), text);
  assert.ok(
    contents
      .split("<wbr/>")
      .slice(0, -1)
      .every((run) => run.endsWith(" ")),
  );
});

test("formatted long paragraphs keep the exact Markdown markup apart from break hints", () => {
  const text = "é中文😀z ".repeat(1000);
  for (const markdown of [
    `**${text}**`,
    `*${text}*`,
    `~~${text}~~`,
    `[${text}](https://example.com)`,
    `> **${text}**`,
    `- ${text}\n\n  **${text}**`,
  ]) {
    const markup = render(markdown);
    assert.ok(markup.includes("<wbr/>"));
    assert.equal(markup.replaceAll("<wbr/>", ""), render(markdown, false));
  }
});

test("small prose, Markdown, raw tags, and inline code retain their original renderer behavior", () => {
  for (const text of [
    "a_b c_d",
    "漢_🙂_字",
    "  leading spaces",
    "a\nb",
    "**bold** _italic_",
    "<placeholder>",
    "[link](https://example.com)",
    "`inline code`",
  ]) {
    assert.equal(render(text), render(text, false), text);
  }
});

test("break hints do not split any grapheme attached to a space", () => {
  for (const extension of [
    "\u0301",
    "\u{1D185}",
    "\u200c",
    "\u200d",
    "\u{1f3fb}",
    "\u{e0061}",
    "\u093e",
    "\u0e33",
  ]) {
    const text = "x ".repeat(1023) + "x " + extension + "word tail";
    const node = transform(paragraph(text));
    const boundaries = new Set(
      Array.from(
        new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
          text,
        ),
        (part) => part.index,
      ),
    );
    let offset = 0;
    for (const child of node.children) {
      if (child.type === "text") offset += child.value.length;
      else {
        assert.equal(child.type, "element");
        assert.equal(child.tagName, "wbr");
        assert.ok(
          boundaries.has(offset),
          `${extension.codePointAt(0)?.toString(16)} at ${offset}`,
        );
        assert.equal(text[offset - 1], " ");
      }
    }
    assert.equal(offset, text.length);
  }
});

test("unbroken tokens, CJK, emoji sequences, and bidi controls are neither split nor rewritten", () => {
  for (const text of [
    "a".repeat(10000),
    "漢字".repeat(3000),
    "👩‍👩‍👧‍👦".repeat(1000),
    "\u2067مرحباשלום\u2069".repeat(1000),
  ]) {
    const node = transform(paragraph(text));
    assert.deepEqual(node.children, [{ type: "text", value: text }]);
  }
});

test("punctuation and Unicode no-break controls keep their spacing context", () => {
  for (const [left, right] of [
    ["(", "word"],
    ["word", "\u2060joined"],
    ["word", "\uFEFFjoined"],
    ["—", "—"],
  ]) {
    const text = "x".repeat(2047 - left.length) + left + " " + right + " tail";
    const node = transform(paragraph(text));
    assert.ok(
      node.children.some(
        (child) =>
          child.type === "text" && child.value.includes(left + " " + right),
      ),
    );
  }
});

test("code and plugin-generated spans are not rewritten as prose", () => {
  const text = "long text ".repeat(1000);
  for (const tagName of ["code", "span", "svg", "math"]) {
    const child: Element = {
      type: "element",
      tagName,
      properties: {},
      children: [{ type: "text", value: text }],
    };
    const node: Element = {
      type: "element",
      tagName: "p",
      properties: {},
      children: [child],
    };
    const before = structuredClone(node);
    assert.deepEqual(transform(node), before);
  }
  for (const markdown of [
    "`" + text + "`",
    "```text\n" + text + "\n```",
    "    " + text,
  ]) {
    assert.equal(render(markdown), render(markdown, false));
  }
});
