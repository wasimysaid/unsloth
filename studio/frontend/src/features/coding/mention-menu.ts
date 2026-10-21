// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import {
  type CodingFile,
  type CodingSkill,
  type CodingSubagent,
  fileMentionToken,
  type MentionChoice,
} from "./input.ts";

/** The `@token` being typed at the caret. `@` must begin a token, so e-mail
 * addresses and words never open the menu; `(@x` and `[@x` still do. */
export function mentionQuery(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s([{>])(@[^\s@]*)$/.exec(before);
  if (!match) return null;
  const start = cursor - match[1].length;
  const rest = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? "";
  if (rest.includes("@")) return null;
  return { start, end: cursor + rest.length, query: match[1].slice(1) };
}

export interface MentionOption {
  id: string;
  choice: MentionChoice;
  label: string;
  description: string;
  /** Honest reason the native identity cannot be selected now. */
  disabled: string | null;
}
export interface MentionGroup {
  kind: MentionChoice["kind"];
  label: "Skills" | "Subagents" | "Files";
  options: MentionOption[];
  status: string | null;
}

function rank(name: string, description: string, query: string) {
  const q = query.toLocaleLowerCase();
  const n = name.toLocaleLowerCase();
  if (!q) return 0;
  if (n.startsWith(q)) return 0;
  if (n.split(/[:/_-]/).some((part) => part.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  return description.toLocaleLowerCase().includes(q) ? 3 : -1;
}
function filter<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
  description: (item: T) => string,
) {
  return items
    .map((item, index) => ({
      item,
      index,
      score: rank(name(item), description(item), query),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** Native identities grouped as Skills, Subagents and Files. Plan eligibility
 * is the native flag; ineligible or unquotable choices stay listed, disabled
 * with the reason. */
export function mentionGroups(
  catalog: {
    skills: readonly CodingSkill[];
    subagents: readonly CodingSubagent[];
    /** Host search results for this query, already ranked; never re-filtered. */
    files: readonly CodingFile[];
    skillStatus: string | null;
    subagentStatus: string | null;
    fileStatus: string | null;
  },
  query: string,
  mode: string | undefined,
): MentionGroup[] {
  return [
    {
      kind: "skill",
      label: "Skills",
      status: catalog.skillStatus,
      options: filter(
        catalog.skills,
        query,
        (skill) => skill.qualified_name,
        (skill) => skill.description,
      ).map((skill) => ({
        id: `skill:${skill.qualified_name}:${skill.path ?? ""}`,
        choice: { kind: "skill", skill },
        label: skill.qualified_name,
        description: skill.description,
        disabled: null,
      })),
    },
    {
      kind: "subagent",
      label: "Subagents",
      status: catalog.subagentStatus,
      options: filter(
        catalog.subagents,
        query,
        (agent) => agent.name,
        (agent) => agent.description,
      ).map((subagent) => ({
        id: `subagent:${subagent.name}`,
        choice: { kind: "subagent", subagent },
        label: subagent.name,
        description: subagent.description,
        disabled:
          mode === "plan" && !subagent.plan_eligible
            ? "Not available in Plan mode"
            : null,
      })),
    },
    {
      kind: "file",
      label: "Files",
      status: catalog.fileStatus,
      options: catalog.files.map((file) => ({
        id: `file:${file.path}`,
        choice: { kind: "file", file },
        label: file.path,
        description: file.kind === "directory" ? "Folder" : "",
        disabled: fileMentionToken(file)
          ? null
          : "This path cannot be written as an @ reference",
      })),
    },
  ];
}

/** Next selectable option in display order, wrapping and skipping disabled ones. */
export function stepMention(
  options: readonly MentionOption[],
  active: number | null,
  delta: 1 | -1,
): number | null {
  const count = options.length;
  if (!options.some((option) => !option.disabled)) return null;
  let index = active ?? (delta === 1 ? -1 : count);
  for (let step = 0; step < count; step++) {
    index = (index + delta + count) % count;
    if (!options[index].disabled) return index;
  }
  return null;
}
