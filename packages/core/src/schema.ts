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
  z
    .object({
      group: z
        .union([
          z.object({ name: z.string() }).strict().describe("Open a named action group"),
          z.literal("end").describe("Close the current action group"),
        ])
        .describe(
          "Authored action group: '{ name: … }' opens a group the camera holds one anchor across; 'end' closes it",
        ),
    })
    .strict(),
]);
export type Step = z.infer<typeof StepSchema>;

export const DemoDefaultsSchema = z
  .object({
    typeCadence: TypeCadence.default("human"),
    mousePace: MousePace.default("natural"),
    /** Reading pause (ms) after each navigation — explicit `goto` *and* client-side
     * (form submit / SPA route change) — before the next step runs. Tuned to keep
     * page-load beats from turning into dead air while the camera is mid-transition. */
    readPause: z.number().int().nonnegative().default(850),
    /** Pause (ms) after the cursor arrives on a target, before the click/type fires.
     * Reads as the cursor "taking aim", so actions don't feel instantaneous. */
    preActionDwell: z.number().int().nonnegative().default(450),
    /** Hold (ms) after a click or type completes so the result is readable before
     * the demo moves on. Tuned a touch longer than instantaneous so each action
     * group gets a beat to settle before the camera moves on (cinematic pacing). */
    postActionHold: z.number().int().nonnegative().default(700),
    /** Global pace multiplier (> 0). 1 = the calibrated default pace; values above 1
     * play faster (durations shrink), below 1 play slower (durations stretch). Scales
     * the dwell/hold/reading pauses, lead-in/tail, and mouse-travel & typing durations.
     * Author-controlled `pause` and `waitFor` steps are left literal (they may be
     * synchronized to app behavior). */
    speed: z.number().positive().default(1),
    /** Post-production camera settings (applied by the compositor, not playback).
     * The camera understands "action groups" (e.g. a whole sign-in) and holds one
     * anchor across each group, then springs/pans to the next — depth chosen
     * automatically from the acted-on element's size. Named `zoom` for back-compat. */
    zoom: z
      .object({
        /** Legacy/fallback magnification (1 = no zoom). Used when min/max are unset. */
        level: z
          .number()
          .min(1)
          .max(2)
          .default(1.25)
          .describe("Fallback zoom magnification (1 = none); superseded by min/maxZoom"),
        /** Deprecated: clicks no longer punch in; they stay anchored to their group. */
        clickBoost: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Deprecated — per-click punch removed; clicks stay anchored to their group"),
        /** Shallowest magnification the adaptive camera will choose (large regions). */
        minZoom: z.number().min(1).max(3).default(1.15).describe("Shallowest adaptive zoom"),
        /** Deepest magnification the adaptive camera will choose (small targets). */
        maxZoom: z.number().min(1).max(3).default(1.55).describe("Deepest adaptive zoom"),
        /** Fraction of the frame an action group's box should fill (drives depth). */
        fill: z.number().min(0.2).max(1).default(0.62).describe("Target frame fill for a group"),
        /** Magnification held during a zoom-out handoff between far-apart groups. */
        establishLevel: z
          .number()
          .min(1)
          .max(2)
          .default(1.06)
          .describe("Magnification during a far-jump establishing handoff"),
        /** Pan vs. zoom-out threshold, as a fraction of the viewport diagonal. */
        panThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.42)
          .describe("Anchor distance (fraction of diagonal) above which a jump zooms out"),
        /** Spring angular frequency (rad/s); higher = snappier camera. */
        stiffness: z.number().min(1).max(40).default(8).describe("Camera spring frequency (rad/s)"),
        /** Spring damping ratio (1 = critical; <1 adds a subtle settle). */
        damping: z.number().min(0.4).max(2).default(0.92).describe("Camera spring damping ratio"),
        /** Max edge-to-edge gap (ms) for two actions to merge into one group. */
        groupGapMs: z
          .number()
          .int()
          .nonnegative()
          .default(1800)
          .describe("Max gap (ms) for adjacent actions to merge into one group"),
        /** Cursor magnification for visibility (1 = native size). */
        cursorScale: z.number().min(1).max(3).default(1.5).describe("Cursor magnification"),
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
