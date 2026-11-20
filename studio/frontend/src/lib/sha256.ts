// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Hash UTF-8 text on secure origins and plain HTTP Studio hosts. */
export async function sha256Hex(text: string): Promise<string> {
  let hex: string | null = null;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      hex = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    } catch {
      // Some embedded browsers expose crypto.subtle but reject it outside a secure context.
    }
  }
  if (hex === null) {
    const { default: forge } = await import("node-forge");
    const digest = forge.md.sha256.create();
    digest.update(text, "utf8");
    hex = digest.digest().toHex();
  }
  return hex;
}
