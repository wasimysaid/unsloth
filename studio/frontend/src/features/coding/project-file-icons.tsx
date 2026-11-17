// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { Folder01Icon, Folder02Icon } from "@/lib/folder-icons";
import {
  CProgrammingIcon,
  Css3Icon,
  FileArchiveIcon,
  FileAudioIcon,
  FileBracesIcon,
  FileCodeIcon,
  FileCogIcon,
  FileEmpty02Icon,
  FileImageIcon,
  FileKeyIcon,
  FileSpreadsheetIcon,
  FileSymlinkIcon,
  FileTerminalIcon,
  FileTypeIcon,
  FileVideoIcon,
  Html5Icon,
  JavaIcon,
  JavaScriptIcon,
  PhpIcon,
  PythonIcon,
  ReactIcon,
  SqlIcon,
  TypescriptIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import type { ProjectEntry } from "./project-files";

type FileIcon = {
  extensions: readonly string[];
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  color: string;
};

const FILE_ICONS: readonly FileIcon[] = [
  {
    extensions: ["py", "pyi", "pyw", "ipynb"],
    icon: PythonIcon,
    color: "text-blue-500 dark:text-blue-400",
  },
  {
    extensions: ["js", "mjs", "cjs"],
    icon: JavaScriptIcon,
    color: "text-yellow-600 dark:text-yellow-400",
  },
  {
    extensions: ["ts", "mts", "cts"],
    icon: TypescriptIcon,
    color: "text-blue-500 dark:text-blue-400",
  },
  {
    extensions: ["jsx", "tsx"],
    icon: ReactIcon,
    color: "text-cyan-600 dark:text-cyan-400",
  },
  {
    extensions: ["html", "htm"],
    icon: Html5Icon,
    color: "text-orange-600 dark:text-orange-400",
  },
  {
    extensions: ["css", "scss", "sass", "less"],
    icon: Css3Icon,
    color: "text-blue-600 dark:text-blue-400",
  },
  {
    extensions: ["java", "jar"],
    icon: JavaIcon,
    color: "text-orange-600 dark:text-orange-400",
  },
  {
    extensions: ["php"],
    icon: PhpIcon,
    color: "text-violet-600 dark:text-violet-400",
  },
  {
    extensions: ["c", "h"],
    icon: CProgrammingIcon,
    color: "text-blue-500 dark:text-blue-400",
  },
  {
    extensions: ["sql", "db", "sqlite", "sqlite3"],
    icon: SqlIcon,
    color: "text-amber-600 dark:text-amber-400",
  },
  {
    extensions: ["md", "mdx", "markdown"],
    icon: FileTypeIcon,
    color: "text-blue-500 dark:text-blue-400",
  },
  {
    extensions: ["json", "jsonc", "jsonl"],
    icon: FileBracesIcon,
    color: "text-yellow-600 dark:text-yellow-400",
  },
  {
    extensions: ["toml", "yaml", "yml", "ini", "conf", "config", "env"],
    icon: FileCogIcon,
    color: "text-muted-foreground",
  },
  {
    extensions: ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
    icon: FileTerminalIcon,
    color: "text-green-600 dark:text-green-400",
  },
  {
    extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif"],
    icon: FileImageIcon,
    color: "text-violet-600 dark:text-violet-400",
  },
  {
    extensions: ["mp3", "wav", "flac", "ogg", "m4a"],
    icon: FileAudioIcon,
    color: "text-pink-600 dark:text-pink-400",
  },
  {
    extensions: ["mp4", "webm", "mov", "mkv"],
    icon: FileVideoIcon,
    color: "text-pink-600 dark:text-pink-400",
  },
  {
    extensions: ["zip", "gz", "tar", "bz2", "xz", "7z"],
    icon: FileArchiveIcon,
    color: "text-amber-600 dark:text-amber-400",
  },
  {
    extensions: ["csv", "tsv", "xlsx", "xls"],
    icon: FileSpreadsheetIcon,
    color: "text-green-600 dark:text-green-400",
  },
  {
    extensions: ["lock", "pem", "key"],
    icon: FileKeyIcon,
    color: "text-muted-foreground",
  },
  {
    extensions: [
      "rs",
      "go",
      "cpp",
      "cc",
      "cxx",
      "hpp",
      "kt",
      "kts",
      "rb",
      "swift",
      "cs",
      "vue",
      "svelte",
      "lua",
      "r",
    ],
    icon: FileCodeIcon,
    color: "text-muted-foreground",
  },
];

export function ProjectFileIcon({
  path,
  kind = "file",
  expanded = false,
}: {
  path: string;
  kind?: ProjectEntry["kind"];
  expanded?: boolean;
}) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1) : "";
  const match =
    kind === "file"
      ? FILE_ICONS.find((entry) => entry.extensions.includes(extension ?? ""))
      : undefined;
  const icon =
    kind === "directory"
      ? expanded
        ? Folder02Icon
        : Folder01Icon
      : kind === "symlink"
        ? FileSymlinkIcon
        : (match?.icon ?? FileEmpty02Icon);

  return (
    <HugeiconsIcon
      icon={icon}
      aria-hidden="true"
      className={`size-4 shrink-0 ${match?.color ?? "text-muted-foreground"}`}
      strokeWidth={1.75}
    />
  );
}
