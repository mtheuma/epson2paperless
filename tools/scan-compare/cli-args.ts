import { TONE_CURVES, type ToneCurveName } from "../../src/postprocess/tone-curves.js";

export interface CliArgs {
  files: string[];
  withDocument: boolean;
  toneCurve: ToneCurveName | undefined;
}

/**
 * Parse the scan-compare argv (after node + script). `--tone-curve <name>`
 * implies `--document` — the curve only exists on the `+ document` rows.
 * Unknown flags are an error rather than silently measured without effect
 * (issue #158: a missing curve made `+ document` rows misrepresent what the
 * pipeline delivers, so a typo'd flag must not do the same quietly).
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const validCurves = Object.keys(TONE_CURVES);
  const files: string[] = [];
  let withDocument = false;
  let toneCurve: ToneCurveName | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      // End-of-options: everything after is a file, however it is spelled.
      files.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--document") {
      withDocument = true;
    } else if (arg === "--tone-curve") {
      const name = argv[++i];
      if (name === undefined || name.startsWith("--")) {
        throw new Error(`--tone-curve requires a curve name (one of: ${validCurves.join(", ")})`);
      }
      if (!validCurves.includes(name)) {
        throw new Error(`unknown tone curve "${name}" (valid: ${validCurves.join(", ")})`);
      }
      toneCurve = name as ToneCurveName;
      withDocument = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      files.push(arg);
    }
  }

  return { files, withDocument, toneCurve };
}
