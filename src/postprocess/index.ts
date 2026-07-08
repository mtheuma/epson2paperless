export type PostProcessProfile = "none" | "document";

export interface PostProcessOptions {
  /** JPEG quality for the re-encode (document profile). */
  jpegQuality: number;
}

/**
 * Apply the named post-process profile to a single JPEG page. `none` returns
 * the input untouched (no decode). Transform errors are the caller's to handle
 * (see finalizeSession fallback).
 */
export async function applyPostProcess(
  profile: PostProcessProfile,
  jpeg: Buffer,
  opts: PostProcessOptions,
): Promise<Buffer> {
  switch (profile) {
    case "none":
      return jpeg;
    case "document":
      // Implemented in Task 4.
      throw new Error("document profile not yet implemented");
  }
}
