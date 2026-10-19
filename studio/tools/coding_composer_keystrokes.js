// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
// Run against an authenticated /coding page with a deliberately opened idle
// conversation (Chromium is required to reproduce the original ordering bug):
// playwright-cli -s=<session> run-code --filename=studio/tools/coding_composer_keystrokes.js
// No prompts are submitted. This clears only this browser tab's composer draft.
async page => {
  const input = page.getByLabel('Coding prompt', {exact: true});
  await page.waitForFunction(() => {
    const node = document.querySelector('textarea[aria-label="Coding prompt"]');
    return node && !node.disabled;
  });
  const equal = async (expected, label) => {
    const actual = await input.inputValue();
    if (actual !== expected) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  await input.fill('');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  await input.pressSequentially(alphabet, {delay: 80});
  await equal(alphabet, 'Ordinary typing');
  await input.press('Backspace');
  await equal(alphabet.slice(0, -1), 'Backspace');
  await input.press('Home');
  await input.pressSequentially('prefix ', {delay: 10});
  await equal('prefix ' + alphabet.slice(0, -1), 'Insertion at cursor');
  await input.press('Delete');
  await equal('prefix ' + alphabet.slice(1, -1), 'Forward deletion');
  await input.fill('');
  const rapid = 'Fast typing with spaces, punctuation, and 1234567890.';
  await input.pressSequentially(rapid);
  await equal(rapid, 'Rapid typing');
  await input.fill('');
  await input.pressSequentially('@nonexistent-skill', {delay: 10});
  await equal('@nonexistent-skill', 'Skill suggestions');
  await input.press('Escape');
  await input.fill('');
  // Use Chromium's real composition pipeline; dispatchEvent cannot emulate the
  // browser's in-progress IME selection/controlled-input behavior.
  const cdp = await page.context().newCDPSession(page);
  await input.focus();
  await cdp.send('Input.imeSetComposition', {
    text: '日本語', selectionStart: 3, selectionEnd: 3,
  });
  await cdp.send('Input.insertText', {text: '日本語'});
  await cdp.detach();
  await equal('日本語', 'Composition completion');
  await input.pressSequentially(' text');
  await equal('日本語 text', 'Typing after composition');
  await input.fill('');
  return 'PASS: ordinary/rapid typing, cursor insertion, backward/forward deletion, skill suggestions, Chromium IME composition; no prompt submitted.';
}
