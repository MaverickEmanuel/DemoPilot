import { z } from "zod";

/**
 * A Target identifies an element. Accessibility (role + accessible name) is
 * preferred because it survives markup churn far better than CSS. CSS / test-id
 * are escape hatches.
 */
export const TargetSchema = z
  .object({
    role: z.string().optional().describe("ARIA role, e.g. button, textbox, link"),
    name: z.string().optional().describe("Accessible name (label/text) of the element"),
    text: z.string().optional().describe("Visible text content to match"),
    css: z.string().optional().describe("CSS selector escape hatch"),
    testId: z.string().optional().describe("data-testid value"),
    exact: z.boolean().optional().describe("Match name/text exactly rather than substring"),
    nth: z.number().int().nonnegative().optional().describe("Disambiguate when several match"),
  })
  .refine(
    (t) => Boolean(t.role || t.name || t.text || t.css || t.testId),
    "Target needs at least one of: role, name, text, css, testId",
  );
export type Target = z.infer<typeof TargetSchema>;

const TypeCadence = z.enum(["human", "fast", "instant"]);
export type TypeCadence = z.infer<typeof TypeCadence>;

const MousePace = z.enum(["natural", "fast", "instant"]);
export type MousePace = z.infer<typeof MousePace>;

/**
 * Steps use a one-key shorthand: the property name is the action. Exactly one
 * action key is present per step. This keeps authored YAML compact and readable.
 */
export const StepSchema = z.union([
  z.object({ goto: z.string().describe("Path (joined to baseUrl) or absolute URL") }).strict(),
  z
    .object({
      click: z
        .object({
          target: TargetSchema,
          button: z.enum(["left", "right", "middle"]).optional(),
          clickCount: z.number().int().positive().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z
        .object({ target: TargetSchema, text: z.string(), cadence: TypeCadence.optional() })
        .strict(),
    })
    .strict(),
  z.object({ press: z.object({ keys: z.string() }).strict() }).strict(),
  z.object({ hover: z.object({ target: TargetSchema }).strict() }).strict(),
  z
    .object({
      scroll: z
        .object({
          target: TargetSchema.optional(),
          to: z.enum(["top", "bottom"]).optional(),
          by: z.number().optional().describe("Pixels to scroll (positive = down)"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      waitFor: z
        .object({
          target: TargetSchema.optional(),
          ms: z.number().int().nonnegative().optional(),
          state: z.enum(["visible", "hidden", "attached", "detached"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      select: z
        .object({ target: TargetSchema, value: z.string().optional(), label: z.string().optional() })
        .strict()
        .refine((s) => Boolean(s.value || s.label), "select needs value or label"),
    })
    .strict(),
  z.object({ pause: z.number().int().nonnegative().describe("Milliseconds to pause") }).strict(),
  z.object({ narrate: z.string().describe("Caption / narration line for this moment") }).strict(),
  z
    .object({
      zoom: z
        .enum(["in", "out"])
        .describe("Authored zoom region: 'in' forces a sustained zoom that holds until 'out'"),
    })
    .strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export const DemoDefaultsSchema = z
  .object({
    typeCadence: TypeCadence.default("human"),
    mousePace: MousePace.default("natural"),
    /** Reading pause (ms) after each navigation — explicit `goto` *and* client-side
     * (form submit / SPA route change) — before the next step runs. */
    readPause: z.number().int().nonnegative().default(900),
    /** Pause (ms) after the cursor arrives on a target, before the click/type fires.
     * Reads as the cursor "taking aim", so actions don't feel instantaneous. */
    preActionDwell: z.number().int().nonnegative().default(450),
    /** Hold (ms) after a click or type completes so the result is readable before
     * the demo moves on. */
    postActionHold: z.number().int().nonnegative().default(650),
    /** Global pace multiplier (> 0). 1 = the calibrated default pace; values above 1
     * play faster (durations shrink), below 1 play slower (durations stretch). Scales
     * the dwell/hold/reading pauses, lead-in/tail, and mouse-travel & typing durations.
     * Author-controlled `pause` and `waitFor` steps are left literal (they may be
     * synchronized to app behavior). */
    speed: z.number().positive().default(1),
    /** Post-production zoom settings (applied by the compositor, not playback). */
    zoom: z
      .object({
        /** Max magnification for activity-driven zooms (1 = no zoom). The zoom
         * eases toward this level over a sustained group of actions. */
        level: z
          .number()
          .min(1)
          .max(2)
          .default(1.25)
          .describe("Zoom magnification for activity zooms (1 = none)"),
      })
      .strict()
      .default({}),
  })
  .strict();
export type DemoDefaults = z.infer<typeof DemoDefaultsSchema>;

export const DemoScriptSchema = z
  .object({
    name: z.string().describe("Human-readable demo name"),
    description: z.string().optional(),
    baseUrl: z.string().url().describe("Base URL the demo runs against"),
    viewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .default({ width: 1280, height: 800 }),
    storageStatePath: z
      .string()
      .optional()
      .describe("Path to a Playwright storageState JSON for pre-authenticated demos"),
    defaults: DemoDefaultsSchema.default({}),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type DemoScript = z.infer<typeof DemoScriptSchema>;

/** Parse + validate an untrusted object into a DemoScript (throws on error). */
export function parseDemoScript(input: unknown): DemoScript {
  return DemoScriptSchema.parse(input);
}
