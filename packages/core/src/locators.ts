import type { Locator, Page } from "playwright";
import type { Target } from "./schema.js";
import type { Point } from "./engines/mouse.js";

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

export function describeTarget(target: Target): string {
  if (target.role) return `${target.role}${target.name ? ` "${target.name}"` : ""}`;
  if (target.testId) return `testId=${target.testId}`;
  if (target.text) return `text "${target.text}"`;
  if (target.css) return `css ${target.css}`;
  return "<target>";
}
