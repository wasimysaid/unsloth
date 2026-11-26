// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { createNavigationNonce } from "../../lib/navigation-nonce.ts";
import type { RunApi } from "./run-types.ts";

export interface GitWorkspace {
  checkout: string;
  branch: string | null;
  head: string | null;
  base: string | null;
  id: string | null;
}

export type GitComparison = "uncommitted" | "task";
export interface GitFile {
  path: string;
  old_path?: string;
  status:
    | "renamed"
    | "copied"
    | "added"
    | "deleted"
    | "conflicted"
    | "modified"
    | "type_changed"
    | "untracked";
}

export interface GitChanges {
  files: GitFile[];
  total: number;
  next_offset: number | null;
  base: string;
}

export type GitPatch = { path: string; base: string } & (
  | { kind: "text"; text: string; revision: string }
  | { kind: "binary" | "too_large" | "unchanged" | "refresh_required" }
);

export interface GitComment {
  path: string;
  old_path?: string;
  untracked?: boolean;
  revision: string;
  start_line: number;
  end_line: number;
  excerpt: string;
  comment: string;
}

const COMMAND = "git-workspace";
function checkedWorkspace(workspace: GitWorkspace): GitWorkspace {
  if (
    !workspace ||
    typeof workspace.checkout !== "string" ||
    !workspace.checkout ||
    [workspace.branch, workspace.head, workspace.base, workspace.id].some(
      (value) => value !== null && typeof value !== "string",
    )
  ) {
    throw new Error("Mimir returned an invalid Git checkout.");
  }
  return workspace;
}

export function createGitWorkspaceClient(
  id: string,
  api: Pick<RunApi, "command" | "commands">,
) {
  async function dispatch<T>(tail: string): Promise<T> {
    if (new TextEncoder().encode(tail).byteLength > 16 * 1024) {
      throw new Error(
        "Review feedback is too long. Add fewer comments or select shorter lines.",
      );
    }
    const key = createNavigationNonce();
    const reply = await api.command!(id, COMMAND, tail, key);
    if (
      reply.conversation_id !== id ||
      reply.operation_id !== key ||
      reply.outcome !== "display" ||
      reply.clipped
    ) {
      throw new Error("Mimir returned an incomplete Git workspace result.");
    }
    try {
      return JSON.parse(reply.text) as T;
    } catch {
      throw new Error("Mimir returned an unreadable Git workspace result.");
    }
  }

  // The branch chip and panel may ask for the same comparison in one render.
  // Share the pending read only. An explicit refresh must reach Git again.
  const reads = new Map<string, Promise<unknown>>();
  function read<T>(request: object): Promise<T> {
    const tail = JSON.stringify(request);
    let result = reads.get(tail);
    if (!result) {
      result = dispatch<T>(tail).finally(() => reads.delete(tail));
      reads.set(tail, result);
    }
    return result as Promise<T>;
  }

  return {
    async available() {
      const result = await api.commands!(id);
      return (
        result.conversation_id === id &&
        result.commands.some((item) => item.name === COMMAND)
      );
    },
    inspect: async () =>
      checkedWorkspace(await read<GitWorkspace>({ op: "inspect" })),
    create: async (id: string) => {
      const workspace = checkedWorkspace(
        await dispatch<GitWorkspace>(JSON.stringify({ op: "create", id })),
      );
      if (workspace.id !== id || !workspace.base)
        throw new Error("Mimir did not confirm the requested worktree.");
      return workspace;
    },
    changes: (comparison: GitComparison, offset = 0) =>
      read<GitChanges>({ op: "changes", comparison, offset }),
    patch: (comparison: GitComparison, file: GitFile) =>
      read<GitPatch>({
        op: "patch",
        comparison,
        path: file.path,
        old_path: file.old_path,
        untracked: file.status === "untracked",
      }),
    feedback: (comparison: GitComparison, comments: GitComment[]) =>
      read<{ text: string; stale_count: number }>({
        op: "feedback",
        comparison,
        comments,
      }),
  };
}
