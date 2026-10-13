// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export interface CodingSkill {
  name: string;
  qualified_name: string;
  description: string;
  path?: string | null;
  bundled?: boolean;
}
export interface SkillMention {
  name: string;
  path?: string | null;
  start: number;
  end: number;
}
export interface CodingImage {
  mime_type: string;
  data: string;
}
export interface CodingInputExtras {
  skill_mentions?: SkillMention[];
  images?: CodingImage[];
}
export interface CodingInput extends CodingInputExtras {
  text: string;
}
export interface DraftMention extends SkillMention {
  token: string;
}
export interface DraftImage extends CodingImage {
  id: string;
  filename: string;
  bytes: number;
}
export interface InputDraft {
  text: string;
  mentions: DraftMention[];
  images: DraftImage[];
}

/** Preserve selections only when their exact text survives an edit. JS offsets
 * are kept locally; serialize into native UTF-8 byte ranges at submission. */
export function editMentions(
  before: string,
  after: string,
  mentions: DraftMention[],
  edit?: { start: number; end: number } | null,
): DraftMention[] {
  if (before === after && edit === undefined) return mentions;
  // Unknown history/composition edits must not guess which occurrence was selected.
  if (edit === null) return [];
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

export function mentionInput(
  text: string,
  mentions: DraftMention[],
): SkillMention[] {
  const encoder = new TextEncoder();
  return mentions.map((mention) => {
    if (text.slice(mention.start, mention.end) !== mention.token)
      throw new Error(
        "A selected skill mention changed. Select it again before Send.",
      );
    return {
      name: mention.name,
      ...(mention.path !== undefined ? { path: mention.path } : {}),
      start: encoder.encode(text.slice(0, mention.start)).length,
      end: encoder.encode(text.slice(0, mention.end)).length,
    };
  });
}

/** Tracks input associations only; assistant-ui retains ownership of the text field. */
export function createInputDraft() {
  let state: InputDraft = { text: "", mentions: [], images: [] };
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
    syncText(text: string, edit?: { start: number; end: number } | null) {
      publish({
        ...state,
        text,
        mentions: editMentions(state.text, text, state.mentions, edit),
      });
    },
    selectSkill(skill: CodingSkill, start: number, end: number) {
      const token = `@${skill.qualified_name}`;
      const text = `${state.text.slice(0, start)}${token} ${state.text.slice(end)}`;
      // A selected insertion supplies the actual replacement range. Inferring
      // edits from equal tokens can misidentify prepend as append and duplicate
      // ranges; shift untouched associations using the explicit edit instead.
      const delta = token.length + 1 - (end - start);
      const mentions = state.mentions.flatMap((mention) => {
        if (mention.start >= end)
          return [
            {
              ...mention,
              start: mention.start + delta,
              end: mention.end + delta,
            },
          ];
        if (mention.end <= start) return [mention];
        return [];
      });
      publish({
        ...state,
        text,
        mentions: [
          ...mentions,
          {
            name: skill.qualified_name,
            ...(skill.path !== undefined ? { path: skill.path } : {}),
            token,
            start,
            end: start + token.length,
          },
        ].sort((a, b) => a.start - b.start),
      });
      return { text, cursor: start + token.length + 1 };
    },
    addImages(images: DraftImage[]) {
      const all = [...state.images, ...images];
      if (all.length > MAX_IMAGES)
        throw new Error(`Attach at most ${MAX_IMAGES} images.`);
      if (
        all.reduce((total, image) => total + image.bytes, 0) > MAX_IMAGE_BYTES
      )
        throw new Error(
          "Images must total at most 512 KiB per coding submission.",
        );
      publish({ ...state, images: all });
    },
    removeImage(id: string) {
      publish({
        ...state,
        images: state.images.filter((image) => image.id !== id),
      });
    },
    input(text: string): CodingInputExtras {
      const mentions = editMentions(state.text, text, state.mentions);
      const skillMentions = mentionInput(text, mentions);
      return {
        ...(skillMentions.length ? { skill_mentions: skillMentions } : {}),
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
    clear() {
      publish({ text: "", mentions: [], images: [] });
    },
    restore(input: CodingInput) {
      const decoder = new TextDecoder();
      const bytes = new TextEncoder().encode(input.text);
      publish({
        text: input.text,
        mentions: (input.skill_mentions ?? []).map((mention) => ({
          ...mention,
          start: decoder.decode(bytes.slice(0, mention.start)).length,
          end: decoder.decode(bytes.slice(0, mention.end)).length,
          token: decoder.decode(bytes.slice(mention.start, mention.end)),
        })),
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

export async function readCodingImage(file: File): Promise<DraftImage> {
  if (!IMAGE_TYPES.includes(file.type))
    throw new Error(
      `${file.name}: supported images are PNG, JPEG, WebP and GIF.`,
    );
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error(
      `${file.name}: image must be nonempty and at most 512 KiB.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (imageSignature(bytes) !== file.type)
    throw new Error(
      `${file.name}: image bytes do not match its declared type.`,
    );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const data = btoa(binary);
  // Browser decode is a usability check. The authenticated host/native boundary
  // independently validates bytes; client validation is never authority.
  const image = new Image();
  image.src = `data:${file.type};base64,${data}`;
  try {
    await image.decode();
  } catch {
    throw new Error(`${file.name}: image cannot be decoded.`);
  }
  if (image.naturalWidth > 4096 || image.naturalHeight > 4096)
    throw new Error(
      `${file.name}: image dimensions must be at most 4096 × 4096.`,
    );
  return {
    id: crypto.randomUUID(),
    filename: file.name,
    mime_type: file.type,
    data,
    bytes: bytes.length,
  };
}
