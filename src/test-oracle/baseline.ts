import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const BaselineSchema = z.object({
  approvedAt: z.string(),
  note: z.string().optional(),
  replay: z.object({
    fixturePath: z.string(),
    source: z.enum(["flatbed", "adf-simplex", "adf-duplex"]),
    duplex: z.boolean(),
    trimStatCycles: z.number().int().nonnegative(),
    printerIp: z.string(),
    destId: z.number().int(),
  }),
  page: z.object({ width: z.number().int(), height: z.number().int() }),
  crosshairResidualPx: z.number(),
  swatches: z.array(
    z.object({ label: z.string(), rgb: z.tuple([z.number(), z.number(), z.number()]) }),
  ),
  greySpreads: z.array(z.object({ label: z.string(), spread: z.number() })),
  stripeVarianceMax: z.number(),
  /** Total pages the fixture is expected to produce — pins dropped/extra-page regressions. */
  expectedPageCount: z.number().int().positive(),
  expectedBackPages: z.array(z.number().int()),
  tolerances: z.object({
    swatchDeltaE: z.number(),
    crosshairPx: z.number(),
    greySpread: z.number(),
    stripeVariance: z.number(),
  }),
});

export type Baseline = z.infer<typeof BaselineSchema>;

export function loadBaseline(filePath: string): Baseline {
  return BaselineSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

export function saveBaseline(filePath: string, baseline: Baseline): void {
  writeFileSync(filePath, JSON.stringify(BaselineSchema.parse(baseline), null, 2) + "\n");
}
