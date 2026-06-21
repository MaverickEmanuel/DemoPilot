// ----------------------------------------------------------------------------
// Action grouping
//
// The camera frames *actions*, not raw events. A run of related clicks and
// keystrokes — typing an email, then a password, then pressing "Log in" — is one
// "action group": the camera holds a single anchor across the whole thing and
// never punches per click. Groups are inferred heuristically (same container, or
// close together in time) and can be forced by the author with `group` markers,
// which always win over the heuristic. Navigations always end a group: the page
// context changed, so the camera resets rather than dragging across the cut.
// ----------------------------------------------------------------------------

import type { Timeline, Box } from "./types";
import { cursorAt } from "./interp";

export interface Vec {
  x: number;
  y: number;
}

/** One acted-on element with its time span and geometry (in video pixels). */
export interface ActionItem {
  kind: "click" | "type";
  start: number;
  end: number;
  /** Focus point (element center). */
  point: Vec;
  /** Element box; falls back to a point-sized box when geometry is missing. */
  box: Box;
  container?: string;
}

/** A coherent run of actions the camera treats as a single shot. */
export interface ActionGroup {
  name?: string;
  /** Span start (lead-in is added later by the camera). */
  tStart: number;
  /** Span end (tail is added later by the camera). */
  tEnd: number;
  items: ActionItem[];
  /** Union of the member boxes — drives the anchor and the adaptive depth. */
  bbox: Box;
}

/** A default box around a bare point, for events with no recorded geometry. */
const FALLBACK_W = 240;
const FALLBACK_H = 72;

function boxOf(item: { x: number; y: number; bbox?: Box }): Box {
  if (item.bbox && item.bbox.width > 0 && item.bbox.height > 0) return item.bbox;
  return { x: item.x - FALLBACK_W / 2, y: item.y - FALLBACK_H / 2, width: FALLBACK_W, height: FALLBACK_H };
}

function unionBox(boxes: Box[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Clicks (instant) and typing ([tStart, t] spans), each with a focus point. */
export function actionItems(timeline: Timeline): ActionItem[] {
  const out: ActionItem[] = [];
  for (const e of timeline.events) {
    if (e.kind === "click") {
      out.push({
        kind: "click",
        start: e.t,
        end: e.t,
        point: { x: e.x, y: e.y },
        box: boxOf(e),
        container: e.container,
      });
    } else if (e.kind === "type") {
      // Prefer the recorded field center; older timelines fall back to the
      // cursor position at the moment typing began (the player parks there).
      const p =
        typeof e.x === "number" && typeof e.y === "number"
          ? { x: e.x, y: e.y }
          : cursorAt(timeline.cursor, e.tStart);
      out.push({
        kind: "type",
        start: e.tStart,
        end: e.t,
        point: p,
        box: boxOf({ x: p.x, y: p.y, bbox: e.bbox }),
        container: e.container,
      });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** True if a navigation falls strictly between times a and b. */
function navBetween(timeline: Timeline, a: number, b: number): boolean {
  return timeline.events.some((e) => e.kind === "navigate" && e.t > a && e.t < b);
}

/** The author's explicit group windows, in order. Both the `group` start/end
 * markers and the legacy `zoom: in`/`zoom: out` region markers open/close one. */
interface Marker {
  start: number;
  end: number;
  name?: string;
}
function explicitWindows(timeline: Timeline): Marker[] {
  const out: Marker[] = [];
  let open: { t: number; name?: string } | null = null;
  for (const e of timeline.events) {
    const opens = (e.kind === "group" && e.action === "start") || (e.kind === "zoom" && e.action === "in");
    const closes = (e.kind === "group" && e.action === "end") || (e.kind === "zoom" && e.action === "out");
    if (opens) {
      if (open) out.push({ start: open.t, end: e.t, name: open.name });
      open = { t: e.t, name: e.kind === "group" ? e.name : undefined };
    } else if (closes && open) {
      out.push({ start: open.t, end: e.t, name: open.name });
      open = null;
    }
  }
  if (open) out.push({ start: open.t, end: timeline.durationMs, name: open.name });
  return out;
}

function finalize(items: ActionItem[], name?: string): ActionGroup {
  return {
    name,
    tStart: items[0].start,
    tEnd: items.reduce((m, a) => Math.max(m, a.end), items[0].end),
    items,
    bbox: unionBox(items.map((a) => a.box)),
  };
}

/**
 * Segments the timeline's actions into groups. An explicit author window claims
 * all the actions whose start falls inside it; everything else is grouped by the
 * heuristic: consecutive actions merge when they share a container, or when the
 * edge-to-edge gap between them is under `groupGapMs` — provided no navigation
 * intervenes.
 */
export function buildActionGroups(timeline: Timeline, groupGapMs: number): ActionGroup[] {
  const items = actionItems(timeline);
  if (items.length === 0) return [];

  const windows = explicitWindows(timeline);
  const windowOf = (t: number): Marker | undefined =>
    windows.find((w) => t >= w.start && t <= w.end);

  const groups: ActionGroup[] = [];
  let cur: ActionItem[] = [items[0]];
  let curWindow = windowOf(items[0].start);

  const flush = () => {
    if (cur.length) groups.push(finalize(cur, curWindow?.name));
  };

  for (let i = 1; i < items.length; i++) {
    const prev = cur[cur.length - 1];
    const item = items[i];
    const win = windowOf(item.start);

    // An explicit window is authoritative: stay together iff in the same window.
    if (curWindow || win) {
      if (win && curWindow && win.start === curWindow.start) {
        cur.push(item);
        continue;
      }
      flush();
      cur = [item];
      curWindow = win;
      continue;
    }

    // Heuristic: merge on shared container or temporal proximity, never across a nav.
    const sameContainer = Boolean(prev.container && item.container && prev.container === item.container);
    const close = item.start - prev.end < groupGapMs;
    if ((sameContainer || close) && !navBetween(timeline, prev.end, item.start)) {
      cur.push(item);
    } else {
      flush();
      cur = [item];
      curWindow = undefined;
    }
  }
  flush();
  return groups;
}
