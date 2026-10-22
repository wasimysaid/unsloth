// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import {
  isLiteralParagraph,
  literalParagraphRuns,
} from "../src/features/coding/markdown-paragraph.ts";

test("literal paragraph classification agrees with the real Markdown renderer", () => {
  for (const text of [
    "ordinary text",
    "EVAL_TRANSPORT_BEGIN é中文😀z EVAL_TRANSPORT_END",
    "0000 0001 4999 EVAL_REPLAY_BEFORE",
    "漢字🙂",
    "accent e\u0301 text",
    "a_b c_d",
  ]) {
    assert.equal(isLiteralParagraph(text), true, text);
    const markup = renderToStaticMarkup(
      createElement(Streamdown, { mode: "static", controls: false }, text),
    );
    assert.ok(markup.includes(`<p>${text}</p>`), markup);
  }
});

test("formatting, links, escapes, HTML, code, indentation and paragraph boundaries keep Markdown semantics", () => {
  for (const text of [
    "**bold**",
    "_italic_",
    "foo__bar",
    "trailing_",
    "_leading",
    "a\nb",
    "a\r\nb",
    "a\tb",
    "    indented code",
    "# heading",
    "- list",
    "1. ordered",
    "[link](url)",
    "https://example.com",
    "www.example.com",
    "x@example.com",
    "<b>HTML</b>",
    "&amp;",
    "`code`",
    "$math$",
    "a\\_b",
    "漢_🙂_字",
    "---",
    "a | b",
  ]) {
    assert.equal(isLiteralParagraph(text), false, text);
  }
});

test("single Unicode paragraph retains all 2520039 UTF8 bytes without a content bound", () => {
  const text =
    "EVAL_TRANSPORT_BEGIN " + "é中文😀z ".repeat(180000) + "EVAL_TRANSPORT_END";
  assert.equal(new TextEncoder().encode(text).length, 2520039);
  assert.equal(isLiteralParagraph(text), true);
  const runs = literalParagraphRuns(text);
  assert.ok(runs.length > 500);
  assert.ok(runs.every((run) => run.length <= 2048));
  assert.equal(runs.join(""), text);
});

test("inline run boundaries preserve every space and never split a word or grapheme sequence", () => {
  for (const text of [
    "",
    "small",
    "  leading spaces",
    "a".repeat(3000),
    "漢🙂e\u0301".repeat(1000) + " tail",
    "left " + "word".repeat(1000) + " right",
    "x ".repeat(5000),
  ]) {
    const runs = literalParagraphRuns(text);
    assert.equal(runs.join(""), text);
    for (const run of runs.slice(0, -1)) assert.ok(run.endsWith(" "));
  }
});
