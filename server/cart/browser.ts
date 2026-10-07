// One real browser window that Kaniti drives on the home computer to fill supermarket carts.
// Logins live only in this browser profile (cookies/localStorage managed by the browser itself) —
// Kaniti never sees or stores supermarket passwords or payment details.
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';

const PROFILE_DIR = path.resolve(process.env.KANITI_BROWSER_PROFILE ?? 'data/browser-profile');

let ctx: BrowserContext | null = null;
let launching: Promise<BrowserContext> | null = null;

export const headless = () => process.env.KANITI_BROWSER_HEADLESS === '1' || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);

/** Can a person interact with the window (log in, solve a CAPTCHA)? */
export const interactive = () => !headless();

async function launch(): Promise<BrowserContext> {
  const { chromium } = await import('playwright-core');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const base = { headless: headless(), viewport: null, locale: 'he-IL', args: ['--lang=he-IL'] };
  const attempts: (() => Promise<BrowserContext>)[] = [];
  if (process.env.KANITI_CHROME_PATH) attempts.push(() => chromium.launchPersistentContext(PROFILE_DIR, { ...base, executablePath: process.env.KANITI_CHROME_PATH }));
  attempts.push(() => chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel: 'chrome' }));
  attempts.push(() => chromium.launchPersistentContext(PROFILE_DIR, { ...base, channel: 'msedge' }));
  attempts.push(() => chromium.launchPersistentContext(PROFILE_DIR, { ...base })); // playwright's own chromium, if installed
  let last: unknown;
  for (const a of attempts) {
    try {
      const c = await a();
      c.on('close', () => { ctx = null; });
      return c;
    } catch (e) { last = e; }
  }
  throw new Error(`לא מצאתי דפדפן Chrome להפעלה. התקינו Google Chrome או הגדירו KANITI_CHROME_PATH. (${(last as Error)?.message?.split('\n')[0] ?? ''})`);
}

export async function context(): Promise<BrowserContext> {
  if (ctx) return ctx;
  launching ??= launch().then((c) => { ctx = c; return c; }).finally(() => { launching = null; });
  return launching;
}

/** A page on the given site, reusing an open tab when possible. */
export async function pageFor(url: string): Promise<Page> {
  const c = await context();
  const host = new URL(url).host;
  const existing = c.pages().find((p) => { try { return new URL(p.url()).host === host; } catch { return false; } });
  const page = existing ?? (c.pages().find((p) => p.url() === 'about:blank') ?? (await c.newPage()));
  if (!existing) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront().catch(() => {});
  return page;
}

export async function closeBrowser() {
  const c = ctx;
  ctx = null;
  await c?.close().catch(() => {});
}

/** Cloudflare / bot-check interstitials. We never try to get around them — the user completes them. */
export async function isBlockedByVerification(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => '')) || '';
  if (/just a moment|attention required|verify you are human|access denied/i.test(title)) return true;
  return page.evaluate(() => !!document.querySelector('#challenge-form, .cf-challenge, iframe[src*="challenges.cloudflare"], iframe[src*="captcha"]')).catch(() => false);
}
