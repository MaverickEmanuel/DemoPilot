/**
 * The timeline is the sidecar artifact emitted alongside the clean (cursor-less)
 * screen recording. The compositor reads it to redraw the cursor, click ripples,
 * zoom, and captions in sync with the video, using `t` (ms from recording start).
 */

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

/** Axis-aligned bounding box of an acted-on element, in video pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TimelineEvent =
  | { kind: "navigate"; t: number; url: string }
  | {
      kind: "click";
      t: number;
      x: number;
      y: number;
      button: "left" | "right" | "middle";
      /** Bounding box of the clicked element (for adaptive zoom / grouping). */
      bbox?: Box;
      /** Stable signature of the nearest container (form/dialog/section/…). */
      container?: string;
    }
  | {
      kind: "type";
      t: number;
      tStart: number;
      text: string;
      /** Center of the typed-into field (so the compositor needn't infer it). */
      x?: number;
      y?: number;
      bbox?: Box;
      container?: string;
    }
  | { kind: "scroll"; t: number; x: number; y: number }
  | { kind: "narrate"; t: number; text: string }
  | { kind: "zoom"; t: number; action: "in" | "out" }
  /** Author-placed boundary that forces a named action group (overrides the
   * automatic grouping heuristic). "start" opens a group, "end" closes it. */
  | { kind: "group"; t: number; action: "start" | "end"; name?: string };

/** Geometry of an acted-on element, recorded alongside click/type events. */
export interface TargetGeometry {
  x?: number;
  y?: number;
  bbox?: Box;
  container?: string;
}

/** Post-production camera/zoom settings carried alongside the capture. The
 * field is named `zoom` for back-compat; it now drives the spring camera too. */
export interface ZoomConfig {
  /** Legacy/fallback magnification (1 = no zoom). Used when min/max are unset. */
  level: number;
  /** Deprecated: per-click punch is gone (clicks stay anchored to their group). */
  clickBoost?: number;
  /** Shallowest magnification the adaptive camera will choose. */
  minZoom?: number;
  /** Deepest magnification the adaptive camera will choose (small targets). */
  maxZoom?: number;
  /** Fraction of the frame an action group's box should fill (drives depth). */
  fill?: number;
  /** Magnification held during a "zoom-out" handoff between far-apart groups. */
  establishLevel?: number;
  /** Pan vs. zoom-out threshold, as a fraction of the viewport diagonal. */
  panThreshold?: number;
  /** Spring angular frequency (rad/s); higher = snappier camera. */
  stiffness?: number;
  /** Spring damping ratio (1 = critical; <1 adds a subtle settle). */
  damping?: number;
  /** Max edge-to-edge gap (ms) for two actions to merge into one group. */
  groupGapMs?: number;
  /** Cursor magnification for visibility (1 = native size). */
  cursorScale?: number;
}

export interface Timeline {
  version: 1;
  width: number;
  height: number;
  durationMs: number;
  cursor: CursorSample[];
  events: TimelineEvent[];
  /** Optional zoom configuration resolved from the script's defaults. */
  zoom?: ZoomConfig;
}

/**
 * Accumulates cursor samples and discrete events against a monotonic clock.
 * `now()` is injectable for deterministic tests.
 */
export class TimelineRecorder {
  private readonly start: number;
  private readonly cursor: CursorSample[] = [];
  private readonly events: TimelineEvent[] = [];
  private last = { x: 0, y: 0 };

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.start = this.now();
  }

  /** The clock value (e.g. Date.now()) at which this recorder's t=0 was set.
   * Screencast capture uses it to align frame timestamps to the timeline. */
  get startedAt(): number {
    return this.start;
  }

  private t(): number {
    return Math.max(0, this.now() - this.start);
  }

  /** The current timeline time in ms. Used to capture an action's start before
   * a long operation (e.g. typing) whose event is only recorded on completion. */
  nowMs(): number {
    return this.t();
  }

  sampleCursor(x: number, y: number): void {
    this.last = { x, y };
    const t = this.t();
    // Avoid duplicate stationary samples at the same timestamp.
    const prev = this.cursor[this.cursor.length - 1];
    if (prev && prev.t === t && prev.x === x && prev.y === y) return;
    this.cursor.push({ t, x, y });
  }

  navigate(url: string): void {
    // The player records explicit `goto` steps and also auto-records client-side
    // navigations (form submits, SPA transitions) via a framenavigated listener.
    // Ignore the blank startup page and collapse duplicate reports of the same
    // URL that arrive close together (e.g. commit + load for one navigation).
    if (!url || url === "about:blank") return;
    const t = this.t();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind !== "navigate") continue;
      if (e.url === url && t - e.t < 1200) return;
      break;
    }
    this.events.push({ kind: "navigate", t, url });
  }

  click(
    x: number,
    y: number,
    button: "left" | "right" | "middle" = "left",
    geom?: TargetGeometry,
  ): void {
    this.sampleCursor(x, y);
    this.events.push({ kind: "click", t: this.t(), x, y, button, bbox: geom?.bbox, container: geom?.container });
  }

  /** Records a `type` event spanning [tStart, now]. When `tStart` is omitted it
   * collapses to a point at the current time (keeps the event well-formed).
   * `geom` carries the field's center/box so the compositor can anchor on it. */
  type(text: string, tStart?: number, geom?: TargetGeometry): void {
    const t = this.t();
    this.events.push({
      kind: "type",
      t,
      tStart: tStart ?? t,
      text,
      x: geom?.x,
      y: geom?.y,
      bbox: geom?.bbox,
      container: geom?.container,
    });
  }

  /** An author-placed action-group boundary ("start"/"end"), with optional name. */
  group(action: "start" | "end", name?: string): void {
    this.events.push({ kind: "group", t: this.t(), action, name });
  }

  scroll(): void {
    this.events.push({ kind: "scroll", t: this.t(), x: this.last.x, y: this.last.y });
  }

  narrate(text: string): void {
    this.events.push({ kind: "narrate", t: this.t(), text });
  }

  /** An authored zoom-region marker ("in" opens a region, "out" closes it). */
  zoom(action: "in" | "out"): void {
    this.events.push({ kind: "zoom", t: this.t(), action });
  }

  finish(): Timeline {
    return {
      version: 1,
      width: this.width,
      height: this.height,
      durationMs: this.t(),
      cursor: this.cursor,
      events: this.events,
    };
  }
}
