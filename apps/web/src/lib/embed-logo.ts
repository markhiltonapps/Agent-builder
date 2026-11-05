// Checks for a logo picture before it is stored. The file's own bytes decide what it is, not its name
// or what the browser says: only PNG, JPEG and WebP pass, so an image can never carry a script.

export const MAX_LOGO_BYTES = 512 * 1024;
export type LogoKind = { ext: "png" | "jpg" | "webp"; type: "image/png" | "image/jpeg" | "image/webp" };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

export function logoKind(bytes: Uint8Array): LogoKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", type: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: "jpg", type: "image/jpeg" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", type: "image/webp" };
  return null;
}

/** Why a file can't be used, in plain words, or null when it is fine. */
export function logoProblem(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return "That file is empty.";
  if (bytes.length > MAX_LOGO_BYTES) return "That picture is too big. Use one under 512 KB.";
  if (!logoKind(bytes)) return "Use a PNG, JPG or WebP picture.";
  return null;
}
