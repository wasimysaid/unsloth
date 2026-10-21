// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Browser feedback bounds. Studio and the plugin validate independently. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_DIMENSION = 4096;
/** Native admission accepts at most 64 selected mentions of every kind combined. */
export const MAX_MENTIONS = 64;
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const IMAGE_LIMITS =
  "PNG, JPEG, WebP or GIF · up to 4 images, 10 MiB each, 20 MiB total";

export interface CodingSkill {
  name: string;
  qualified_name: string;
  description: string;
  path?: string | null;
  bundled?: boolean;
}
/** Native effective subagent identity; selecting one never launches it. */
export interface CodingSubagent {
  name: string;
  description: string;
  plan_eligible: boolean;
}
export interface SkillMention {
  name: string;
  path?: string | null;
  start: number;
  end: number;
}
export interface SubagentMention {
  name: string;
  start: number;
  end: number;
}
/** A host catalog entry: exact project path identity, never file contents. */
export interface CodingFile {
  path: string;
  kind: "file" | "directory";
}
export interface FileMention extends CodingFile {
  start: number;
  end: number;
}
/** The visible native reference for a catalog path: `@path`, or
 * `@"path with spaces"`; directories end in `/`. There are no escapes, so a
 * path the grammar cannot carry (a quote with whitespace, a `#` line suffix,
 * control characters) has no token and cannot be selected. */
export function fileMentionToken(file: CodingFile): string | null {
  const visible =
    file.kind === "directory" ? `${file.path.replace(/\/+$/, "")}/` : file.path;
  if (!file.path || visible.includes("#") || /\p{Cc}/u.test(visible))
    return null;
  if (!/\s/u.test(visible)) return `@${visible}`;
  return visible.includes('"') ? null : `@"${visible}"`;
}
export interface CodingImage {
  mime_type: string;
  data: string;
}
export interface CodingInputExtras {
  skill_mentions?: SkillMention[];
  subagent_mentions?: SubagentMention[];
  file_mentions?: FileMention[];
  images?: CodingImage[];
}
export interface CodingInput extends CodingInputExtras {
  text: string;
}
export type MentionChoice =
  | { kind: "skill"; skill: CodingSkill }
  | { kind: "subagent"; subagent: CodingSubagent }
  | { kind: "file"; file: CodingFile };
/** A selected native identity. The token text alone never authorizes one. */
export type DraftMention =
  | {
      kind: "skill";
      name: string;
      path?: string | null;
      token: string;
      start: number;
      end: number;
    }
  | {
      kind: "subagent";
      name: string;
      token: string;
      start: number;
      end: number;
    }
  | {
      kind: "file";
      path: string;
      fileKind: CodingFile["kind"];
      token: string;
      start: number;
      end: number;
    };
export interface DraftImage extends CodingImage {
  id: string;
  filename: string;
  bytes: number;
}
/** An attached image whose bytes are still being read and checked. */
export interface ReadingImage {
  id: string;
  filename: string;
  bytes: number;
}
export interface InputDraft {
  text: string;
  mentions: DraftMention[];
  images: DraftImage[];
  /** Attachments still being read; Send waits until every one settles. */
  reading: ReadingImage[];
  /** Why the latest attachments were refused or failed to read. */
  attachmentErrors: string[];
}
type Ranged = { token: string; start: number; end: number };

export const mentionName = (choice: MentionChoice) =>
  choice.kind === "skill"
    ? choice.skill.qualified_name
    : choice.kind === "subagent"
      ? choice.subagent.name
      : choice.file.path;
const mentionToken = (choice: MentionChoice) =>
  choice.kind === "file"
    ? fileMentionToken(choice.file)
    : `@${mentionName(choice)}`;

/** Preserve selections only when their exact text survives an edit. JS offsets
 * are kept locally; serialize into native UTF-8 byte ranges at submission.
 * `edit` is the browser-reported replacement; without it (undo, unknown input
 * types) the edit is inferred from the common prefix/suffix, and any token that
 * occurs more than once is dropped rather than guessed. */
export function editMentions<M extends Ranged>(
  before: string,
  after: string,
  mentions: M[],
  edit?: { start: number; end: number },
): M[] {
  if (before === after && edit === undefined) return mentions;
  let start = edit?.start ?? 0;
  let oldEnd = edit?.end ?? before.length;
  let newEnd = oldEnd + after.length - before.length;
  if (edit) {
    if (
      start < 0 ||
      oldEnd < start ||
      oldEnd > before.length ||
      newEnd < start ||
      before.slice(0, start) !== after.slice(0, start) ||
      before.slice(oldEnd) !== after.slice(newEnd)
    )
      return [];
  } else {
    while (
      start < before.length &&
      start < after.length &&
      before[start] === after[start]
    )
      start++;
    newEnd = after.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      before[oldEnd - 1] === after[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
  }
  const delta = newEnd - oldEnd;
  return mentions.flatMap((mention) => {
    if (
      !edit &&
      [before, after].some((text) => {
        const first = text.indexOf(mention.token);
        return first >= 0 && text.indexOf(mention.token, first + 1) >= 0;
      })
    )
      return [];
    // Inserting strictly inside a mention invalidates it, as does any replacement
    // touching its range. Adjacent insertion only shifts an intact mention.
    if (
      (start < mention.end && oldEnd > mention.start) ||
      (oldEnd === start && start > mention.start && start < mention.end)
    )
      return [];
    const next =
      mention.start >= oldEnd
        ? { ...mention, start: mention.start + delta, end: mention.end + delta }
        : mention;
    const suffix = after[next.end];
    return after.slice(next.start, next.end) === next.token &&
      (!suffix || /[\s.,!?;()[\]{}]/.test(suffix))
      ? [next]
      : [];
  });
}

/** Native extras for exactly the selected identities, as UTF-8 byte ranges. */
export function mentionExtras(
  text: string,
  mentions: DraftMention[],
): Pick<
  CodingInputExtras,
  "skill_mentions" | "subagent_mentions" | "file_mentions"
> {
  const encoder = new TextEncoder();
  const skills: SkillMention[] = [];
  const subagents: SubagentMention[] = [];
  const files: FileMention[] = [];
  for (const mention of mentions) {
    if (text.slice(mention.start, mention.end) !== mention.token)
      throw new Error(
        "A selected mention changed. Select it again before Send.",
      );
    const range = {
      start: encoder.encode(text.slice(0, mention.start)).length,
      end: encoder.encode(text.slice(0, mention.end)).length,
    };
    if (mention.kind === "skill")
      skills.push({
        name: mention.name,
        ...(mention.path !== undefined ? { path: mention.path } : {}),
        ...range,
      });
    else if (mention.kind === "subagent")
      subagents.push({ name: mention.name, ...range });
    else files.push({ path: mention.path, kind: mention.fileKind, ...range });
  }
  return {
    ...(skills.length ? { skill_mentions: skills } : {}),
    ...(subagents.length ? { subagent_mentions: subagents } : {}),
    ...(files.length ? { file_mentions: files } : {}),
  };
}

const imageBytes = (images: readonly { bytes: number }[]) =>
  images.reduce((total, image) => total + image.bytes, 0);
function boundedImages(images: DraftImage[]) {
  if (images.length > MAX_IMAGES)
    throw new Error(`Attach at most ${MAX_IMAGES} images.`);
  if (imageBytes(images) > MAX_TOTAL_IMAGE_BYTES)
    throw new Error("Images must total at most 20 MiB per coding submission.");
  return images;
}

/** Tracks input associations only; assistant-ui retains ownership of the text
 * field. Image reads belong to the draft that started them: a draft taken over
 * by a created conversation brings them along, an abandoned one keeps them. */
export function createInputDraft() {
  let state: InputDraft = {
    text: "",
    mentions: [],
    images: [],
    reading: [],
    attachmentErrors: [],
  };
  const listeners = new Set<() => void>();
  const publish = (next: InputDraft) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncText(text: string, edit?: { start: number; end: number }) {
      publish({
        ...state,
        text,
        mentions: editMentions(state.text, text, state.mentions, edit),
      });
    },
    selectMention(choice: MentionChoice, start: number, end: number) {
      const name = mentionName(choice);
      const token = mentionToken(choice);
      if (!token)
        throw new Error("This path cannot be written as an @ reference.");
      const kept = state.mentions.filter(
        (mention) => mention.end <= start || mention.start >= end,
      );
      if (kept.length >= MAX_MENTIONS)
        throw new Error(`Select at most ${MAX_MENTIONS} mentions per prompt.`);
      const text = `${state.text.slice(0, start)}${token} ${state.text.slice(end)}`;
      // A selected insertion supplies the actual replacement range. Inferring
      // edits from equal tokens can misidentify prepend as append and duplicate
      // ranges; shift untouched associations using the explicit edit instead.
      const delta = token.length + 1 - (end - start);
      const mentions = kept.map((mention) =>
        mention.start >= end
          ? {
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            }
          : mention,
      );
      const selected: DraftMention =
        choice.kind === "skill"
          ? {
              kind: "skill",
              name,
              ...(choice.skill.path !== undefined
                ? { path: choice.skill.path }
                : {}),
              token,
              start,
              end: start + token.length,
            }
          : choice.kind === "subagent"
            ? {
                kind: "subagent",
                name,
                token,
                start,
                end: start + token.length,
              }
            : {
                kind: "file",
                path: choice.file.path,
                fileKind: choice.file.kind,
                token,
                start,
                end: start + token.length,
              };
      publish({
        ...state,
        text,
        mentions: [...mentions, selected].sort((a, b) => a.start - b.start),
      });
      return { text, cursor: start + token.length + 1 };
    },
    /** Remove one selected identity together with its exact token text. */
    removeMention(mention: DraftMention) {
      const index = state.mentions.indexOf(mention);
      if (index < 0) return null;
      const spaced = state.text[mention.end] === " " ? 1 : 0;
      const end = mention.end + spaced;
      const text = `${state.text.slice(0, mention.start)}${state.text.slice(end)}`;
      const delta = end - mention.start;
      publish({
        ...state,
        text,
        mentions: state.mentions.flatMap((item, at) =>
          at === index
            ? []
            : item.start >= end
              ? [{ ...item, start: item.start - delta, end: item.end - delta }]
              : [item],
        ),
      });
      return { text, cursor: mention.start };
    },
    addImages(images: DraftImage[]) {
      publish({
        ...state,
        images: boundedImages([...state.images, ...images]),
      });
    },
    /** Read and attach images. Count/size feedback comes before any read;
     * each accepted file is read on its own while typing continues. */
    async attach(
      files: File[],
      read: (file: File) => Promise<DraftImage> = readCodingImage,
    ) {
      const plan = planImageAttachments(state.images, state.reading, files);
      const entries = plan.accepted.map((file) => ({
        file,
        reading: {
          id: crypto.randomUUID(),
          filename: file.name,
          bytes: file.size,
        },
      }));
      publish({
        ...state,
        reading: [...state.reading, ...entries.map((entry) => entry.reading)],
        attachmentErrors: plan.errors,
      });
      await Promise.all(
        entries.map(async ({ file, reading }) => {
          let error: string | null = null;
          let images = state.images;
          try {
            const image = await read(file);
            images = boundedImages([...state.images, image]);
          } catch (reason) {
            error =
              reason instanceof Error
                ? reason.message
                : `${reading.filename}: image attachment failed.`;
          }
          publish({
            ...state,
            images: error ? state.images : images,
            reading: state.reading.filter((item) => item.id !== reading.id),
            attachmentErrors: error
              ? [...state.attachmentErrors, error]
              : state.attachmentErrors,
          });
        }),
      );
    },
    dismissAttachmentErrors() {
      publish({ ...state, attachmentErrors: [] });
    },
    removeImage(id: string) {
      publish({
        ...state,
        images: state.images.filter((image) => image.id !== id),
      });
    },
    input(text: string): CodingInputExtras {
      const mentions = editMentions(state.text, text, state.mentions);
      return {
        ...mentionExtras(text, mentions),
        ...(state.images.length
          ? {
              images: state.images.map(({ mime_type, data }) => ({
                mime_type,
                data,
              })),
            }
          : {}),
      };
    },
    /** Text, mentions and images were consumed; reads still in flight stay. */
    clear() {
      publish({ ...state, text: "", mentions: [], images: [] });
    },
    restore(input: CodingInput) {
      const decoder = new TextDecoder();
      const bytes = new TextEncoder().encode(input.text);
      const offsets = (mention: { start: number; end: number }) => ({
        start: decoder.decode(bytes.slice(0, mention.start)).length,
        end: decoder.decode(bytes.slice(0, mention.end)).length,
        token: decoder.decode(bytes.slice(mention.start, mention.end)),
      });
      publish({
        ...state,
        text: input.text,
        mentions: [
          ...(input.skill_mentions ?? []).map(
            (mention): DraftMention => ({
              kind: "skill",
              ...mention,
              ...offsets(mention),
            }),
          ),
          ...(input.subagent_mentions ?? []).map(
            (mention): DraftMention => ({
              kind: "subagent",
              ...mention,
              ...offsets(mention),
            }),
          ),
          ...(input.file_mentions ?? []).map(
            (mention): DraftMention => ({
              kind: "file",
              path: mention.path,
              fileKind: mention.kind,
              ...offsets(mention),
            }),
          ),
        ].sort((a, b) => a.start - b.start),
        images: (input.images ?? []).map((image, index) => ({
          ...image,
          id: crypto.randomUUID(),
          filename: `Restored image ${index + 1}`,
          bytes: Math.floor((image.data.length * 3) / 4),
        })),
      });
    },
  };
}
export type CodingInputDraft = ReturnType<typeof createInputDraft>;

export function imageSignature(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6)))
    return "image/gif";
  return null;
}

/** Chunked so multi-megabyte images neither overflow argument limits nor build
 * one rope string per byte. */
export function base64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The browser's native encoder where present; exact chunked bytes otherwise. */
async function encodeBase64(file: Blob): Promise<string> {
  if (typeof FileReader === "undefined")
    return base64Bytes(new Uint8Array(await file.arrayBuffer()));
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return url.slice(url.indexOf(",") + 1);
}

type FileLike = Pick<File, "name" | "size" | "type">;
/** Count/size feedback before any bytes are read. Rejected files are named. */
export function planImageAttachments<F extends FileLike>(
  current: readonly { bytes: number }[],
  pending: readonly { bytes: number }[],
  files: readonly F[],
): { accepted: F[]; errors: string[] } {
  const accepted: F[] = [];
  const errors: string[] = [];
  let count = current.length + pending.length;
  let total = imageBytes(current) + imageBytes(pending);
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type))
      errors.push(`${file.name}: attach PNG, JPEG, WebP or GIF images only.`);
    else if (!file.size || file.size > MAX_IMAGE_BYTES)
      errors.push(`${file.name}: image must be nonempty and at most 10 MiB.`);
    else if (count >= MAX_IMAGES)
      errors.push(`${file.name}: attach at most ${MAX_IMAGES} images.`);
    else if (total + file.size > MAX_TOTAL_IMAGE_BYTES)
      errors.push(`${file.name}: images must total at most 20 MiB.`);
    else {
      accepted.push(file);
      count++;
      total += file.size;
    }
  }
  return { accepted, errors };
}

export type ImageDecoder = (
  file: Blob,
  mime: string,
  data: string,
) => Promise<{ width: number; height: number }>;
const decodeInBrowser: ImageDecoder = async (file, mime, data) => {
  const image = new Image();
  const url =
    typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : `data:${mime};base64,${data}`;
  image.src = url;
  try {
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
};

export async function readCodingImage(
  file: File,
  decode: ImageDecoder = decodeInBrowser,
): Promise<DraftImage> {
  if (!IMAGE_TYPES.includes(file.type))
    throw new Error(
      `${file.name}: supported images are PNG, JPEG, WebP and GIF.`,
    );
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error(`${file.name}: image must be nonempty and at most 10 MiB.`);
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (imageSignature(header) !== file.type)
    throw new Error(
      `${file.name}: image bytes do not match its declared type.`,
    );
  const data = await encodeBase64(file);
  // Browser decode is a usability check. The authenticated host/native boundary
  // independently validates bytes; client validation is never authority.
  let size: { width: number; height: number };
  try {
    size = await decode(file, file.type, data);
  } catch {
    throw new Error(`${file.name}: image cannot be decoded.`);
  }
  if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION)
    throw new Error(
      `${file.name}: image dimensions must be at most 4096 × 4096.`,
    );
  return {
    id: crypto.randomUUID(),
    filename: file.name,
    mime_type: file.type,
    data,
    bytes: file.size,
  };
}
