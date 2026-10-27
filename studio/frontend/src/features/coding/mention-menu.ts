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
  options: readonly { disabled: string | null }[],
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

/** One flat menu: prefix-matching skills and agents, then files, then the rest. */
export function mentionItems(
  groups: readonly MentionGroup[],
  query: string,
): MentionOption[] {
  const named = groups
    .filter((group) => group.kind !== "file")
    .flatMap((group) => group.options);
  const files = groups.find((group) => group.kind === "file")?.options ?? [];
  if (!query) return [...files, ...named];
  const q = query.toLocaleLowerCase();
  const prefix = named.filter((option) =>
    option.label.toLocaleLowerCase().startsWith(q),
  );
  return [
    ...prefix,
    ...files,
    ...named.filter((option) => !prefix.includes(option)),
  ];
}

/** The one line shown when nothing matches: a retryable failure first. */
export function mentionStatus(
  groups: readonly MentionGroup[],
  query: string,
): string {
  const statuses = groups
    .map((group) => group.status)
    .filter((status): status is string => Boolean(status));
  return (
    statuses.find((status) => status.endsWith("Retry.")) ??
    groups.find((group) => group.kind === "file")?.status ??
    (query ? `No matches for “${query}”` : "No files")
  );
}

/** The `/command` being typed: the prompt's first token, caret inside it. */
export function commandQuery(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const match = /^(\s*)\/([^\s]*)$/.exec(text.slice(0, cursor));
  if (!match) return null;
  const rest = /^[^\s]*/.exec(text.slice(cursor))?.[0] ?? "";
  return {
    start: match[1].length,
    end: cursor + rest.length,
    query: match[2] + rest,
  };
}

export interface CommandOption {
  id: string;
  name: string;
  label: string;
  description: string;
  disabled: string | null;
}

/** Effective native commands matching a typed prefix, aliases included. */
export function commandItems(
  commands: readonly {
    name: string;
    aliases: readonly string[];
    description: string;
    argument: string | null;
    availability: string;
  }[],
  query: string,
  busy: boolean,
): CommandOption[] {
  const q = query.toLocaleLowerCase();
  const score = (names: string[], description: string) => {
    if (!q) return 0;
    if (names.some((name) => name.toLocaleLowerCase().startsWith(q))) return 0;
    if (names.some((name) => name.toLocaleLowerCase().includes(q))) return 1;
    return description.toLocaleLowerCase().includes(q) ? 2 : -1;
  };
  return commands
    .map((command, index) => ({
      command,
      index,
      score: score([command.name, ...command.aliases], command.description),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ command }) => ({
      id: `command:${command.name}`,
      name: command.name,
      label: `/${command.name}`,
      description: command.argument
        ? `${command.description} · <${command.argument}>`
        : command.description,
      disabled:
        busy && command.availability === "idle-only"
          ? "Available when idle"
          : null,
    }));
}
