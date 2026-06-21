import type { Locator, Page } from "playwright";
import type { Target } from "./schema.js";
import type { Point } from "./engines/mouse.js";
import type { Box, TargetGeometry } from "./timeline.js";

/**
 * Resolves a Target to a Playwright Locator, preferring accessibility queries
 * (role + name) and falling back to text / test-id / CSS.
 */
export function resolveLocator(page: Page, target: Target): Locator {
  let locator: Locator;
  if (target.role) {
    // Cast: the schema keeps role as an open string for authoring ergonomics.
    locator = page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
      name: target.name,
      exact: target.exact,
    });
  } else if (target.testId) {
    locator = page.getByTestId(target.testId);
  } else if (target.text) {
    locator = page.getByText(target.text, { exact: target.exact });
  } else if (target.css) {
    locator = page.locator(target.css);
  } else {
    throw new Error("Target had no usable selector");
  }
  if (typeof target.nth === "number") locator = locator.nth(target.nth);
  return locator;
}

/** Center point of a locator's bounding box (viewport coordinates). */
export async function centerOf(locator: Locator): Promise<Point> {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not visible / has no layout box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Resolves the geometry the compositor needs to frame an action: the element's
 * center, its bounding box (for adaptive zoom depth) and a stable signature of
 * the nearest container (for grouping fields that belong to the same form).
 */
export async function geometryOf(
  locator: Locator,
): Promise<{ point: Point; bbox: Box; container?: string }> {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not visible / has no layout box");
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const container = await locator
    .evaluate((el) => {
      const host = (el as Element).closest(
        'form,dialog,[role="dialog"],[role="form"],[role="group"],section,main,nav,header,aside',
      );
      if (!host) return undefined;
      const tag = host.tagName.toLowerCase();
      const id = host.id ? `#${host.id}` : "";
      const role = host.getAttribute("role");
      const aria = host.getAttribute("aria-label");
      return `${tag}${id}${role ? `[role=${role}]` : ""}${aria ? `[aria=${aria}]` : ""}`;
    })
    .catch(() => undefined);
  return { point, bbox: box, container: container ?? undefined };
}

/** Packs resolved geometry into the TargetGeometry recorded on the timeline. */
export function toGeometry(g: { point: Point; bbox: Box; container?: string }): TargetGeometry {
  return { x: g.point.x, y: g.point.y, bbox: g.bbox, container: g.container };
}

export function describeTarget(target: Target): string {
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  if (target.testId) return `testId=${target.testId}`;
  if (target.text) return `text "${target.text}"`;
  if (target.css) return `css ${target.css}`;
  return "<target>";
}
