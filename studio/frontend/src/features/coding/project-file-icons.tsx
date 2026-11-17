// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { Folder01Icon, Folder02Icon } from "@/lib/folder-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  File,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey2,
  FileTerminal,
  FileType2,
  Link2,
} from "lucide-react";
import type { ProjectEntry } from "./project-files";
export function ProjectFileIcon({
  path,
  kind = "file",
  expanded = false,
}: { path: string; kind?: ProjectEntry["kind"]; expanded?: boolean }) {
  if (kind === "directory")
    return (
      <HugeiconsIcon
        icon={expanded ? Folder02Icon : Folder01Icon}
        className="size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.75}
      />
    );
  if (kind === "symlink")
    return <Link2 className="size-4 shrink-0 text-muted-foreground" />;
  const extension = path.split(".").at(-1)?.toLowerCase();
  const icon =
    extension === "md" || extension === "mdx"
      ? FileType2
      : extension === "json"
        ? FileJson2
        : extension === "lock"
          ? FileKey2
          : ["toml", "yaml", "yml", "ini", "conf"].includes(extension ?? "")
            ? FileCog
            : ["sh", "bash", "zsh", "ps1"].includes(extension ?? "")
              ? FileTerminal
              : ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(
                    extension ?? "",
                  )
                ? FileImage
                : [
                      "rs",
                      "py",
                      "ts",
                      "tsx",
                      "js",
                      "jsx",
                      "css",
                      "html",
                      "c",
                      "cpp",
                      "h",
                      "go",
                      "java",
                      "kt",
                      "rb",
                      "swift",
                    ].includes(extension ?? "")
                  ? FileCode2
                  : File;
  const Icon = icon;
  return (
    <Icon
      className={`size-4 shrink-0 ${["md", "mdx", "ts", "tsx"].includes(extension ?? "") ? "text-blue-500 dark:text-blue-400" : "text-muted-foreground"}`}
      strokeWidth={1.75}
    />
  );
}
