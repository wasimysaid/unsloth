// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** The rail's rows: a tab, or an expandable category holding the tabs that name it. */
export type NavItem<Tab extends { id: string; category?: Category }, Category extends string> =
  | { kind: "tab"; tab: Tab }
  | { kind: "category"; id: Category; tabs: Tab[] };

/** A category sits where its first tab would; its other tabs join it, wherever they are listed. */
export function navItems<Tab extends { id: string; category?: Category }, Category extends string>(
  tabs: readonly Tab[],
): NavItem<Tab, Category>[] {
  const items: NavItem<Tab, Category>[] = [];
  const categories = new Map<Category, Tab[]>();
  for (const tab of tabs) {
    if (tab.category === undefined) {
      items.push({ kind: "tab", tab });
      continue;
    }
    const members = categories.get(tab.category);
    if (members) {
      members.push(tab);
      continue;
    }
    const created = [tab];
    categories.set(tab.category, created);
    items.push({ kind: "category", id: tab.category, tabs: created });
  }
  return items;
}

const EXPANDED_KEY = "unsloth_settings_nav_expanded";

export function loadExpandedCategories(storage: Pick<Storage, "getItem"> | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(EXPANDED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveExpandedCategories(
  storage: Pick<Storage, "setItem"> | null,
  ids: Iterable<string>,
): void {
  try {
    storage?.setItem(EXPANDED_KEY, JSON.stringify([...ids].sort()));
  } catch {
    // A full or blocked storage only forgets the rail's shape.
  }
}
