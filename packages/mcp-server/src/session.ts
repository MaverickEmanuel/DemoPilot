import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
  resolveLocator,
  describeTarget,
  parseDemoScript,
  type Step,
  type DemoScript,
} from "@demopilot/core";
import { randomUUID } from "node:crypto";

export interface SnapshotResult {
  url: string;
  aria: string;
  screenshotBase64: string;
}

/**
 * A live, exploratory browser session used during demo *authoring*. The host
 * LLM drives it: snapshot to see the page, act to perform + record a step. It
 * executes actions quickly (no realistic pacing — that happens at render time).
 */
export class AuthoringSession {
  readonly id = randomUUID();
  readonly steps: Step[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    readonly baseUrl: string,
    private name: string,
    private readonly viewport: { width: number; height: number },
  ) {}

  static async open(opts: {
    url: string;
    name?: string;
    viewport?: { width: number; height: number };
    headless?: boolean;
  }): Promise<AuthoringSession> {
    const viewport = opts.viewport ?? { width: 1280, height: 800 };
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "load" });
    const origin = new URL(opts.url).origin;
    const session = new AuthoringSession(browser, context, page, origin, opts.name ?? "Untitled demo", viewport);
    // Record the opening navigation as the first step (relative to baseUrl).
    const path = new URL(opts.url).pathname + new URL(opts.url).search;
    session.steps.push({ goto: path || "/" });
    return session;
  }

  setName(name: string): void {
    this.name = name;
  }

  /** Executes a validated step against the live page and records it. */
  async applyStep(step: Step): Promise<void> {
    await this.executeLive(step);
    this.steps.push(step);
  }

  addNarration(text: string): void {
    this.steps.push({ narrate: text });
  }

  toScript(): DemoScript {
    return parseDemoScript({
      name: this.name,
      baseUrl: this.baseUrl,
      viewport: this.viewport,
      steps: this.steps,
    });
  }

  async snapshot(): Promise<SnapshotResult> {
    const tree = await this.page.accessibility.snapshot();
    const screenshot = await this.page.screenshot({ type: "png" });
    return {
      url: this.page.url(),
      aria: tree ? renderAria(tree) : "(no accessibility tree)",
      screenshotBase64: screenshot.toString("base64"),
    };
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  private async executeLive(step: Step): Promise<void> {
    const page = this.page;
    if ("goto" in step) {
      await page.goto(new URL(step.goto, this.baseUrl).toString(), { waitUntil: "load" });
    } else if ("click" in step) {
      await resolveLocator(page, step.click.target).click({
        button: step.click.button ?? "left",
        clickCount: step.click.clickCount ?? 1,
      });
    } else if ("type" in step) {
      const loc = resolveLocator(page, step.type.target);
      await loc.click();
      await loc.fill(step.type.text);
    } else if ("press" in step) {
      await page.keyboard.press(step.press.keys);
    } else if ("hover" in step) {
      await resolveLocator(page, step.hover.target).hover();
    } else if ("select" in step) {
      await resolveLocator(page, step.select.target).selectOption(
        step.select.label ? { label: step.select.label } : { value: step.select.value! },
      );
    } else if ("scroll" in step) {
      if (step.scroll.target) await resolveLocator(page, step.scroll.target).scrollIntoViewIfNeeded();
      else if (step.scroll.by) await page.mouse.wheel(0, step.scroll.by);
    } else if ("waitFor" in step) {
      if (step.waitFor.target) {
        await resolveLocator(page, step.waitFor.target).waitFor({ state: step.waitFor.state ?? "visible" });
      }
    }
    // pause / narrate / zoom are no-ops live (zoom is a post-production marker).
  }
}

interface AriaNode {
  role?: string;
  name?: string;
  children?: AriaNode[];
}

/** Compact, indented rendering of the accessibility tree for the LLM. */
function renderAria(node: AriaNode, depth = 0, lines: string[] = []): string {
  const role = node.role ?? "";
  if (role && role !== "WebArea" && (node.name || isInteractive(role))) {
    const name = node.name ? ` "${truncate(node.name, 60)}"` : "";
    lines.push(`${"  ".repeat(depth)}- ${role}${name}`);
  }
  const nextDepth = role && role !== "WebArea" ? depth + 1 : depth;
  for (const child of node.children ?? []) renderAria(child, nextDepth, lines);
  return lines.join("\n");
}

function isInteractive(role: string): boolean {
  return ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "tab", "switch"].includes(role);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export { describeTarget };
