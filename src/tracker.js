import { chromium } from "playwright";

const TRACK_URL = process.env.INDIA_POST_TRACK_URL || "https://www.indiapost.gov.in/";
const TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 30000);
const MAX_CAPTCHA_ATTEMPTS = Number(process.env.MAX_CAPTCHA_ATTEMPTS || 5);

// One isolated browser context per Telegram chat prevents cookie/session mixing.
const sessions = new Map();
let browserPromise;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }).catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

function normalizeText(value = "") {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 700 })) {
        await locator.click({ timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 700 })) {
        await locator.fill(value, { timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function locateTrackingForm(page) {
  // India Post has periodically changed its landing page layout. Prefer visible labels
  // and accessible names; retain conservative fallbacks and fail rather than guessing.
  await page.goto(TRACK_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: Math.min(TIMEOUT_MS, 12000) }).catch(() => {});
  const trackLabels = [
    page.getByText(/Track and Trace Services/i).first(),
    page.getByText(/Track.*Trace/i).first(),
  ];
  for (const label of trackLabels) {
    try {
      if (await label.isVisible({ timeout: 800 })) {
        await label.scrollIntoViewIfNeeded();
        break;
      }
    } catch {}
  }

  await clickFirstVisible(page, [
    'a:has-text("Track 'N' Trace View")',
    'button:has-text("Track 'N' Trace")',
    'text=Track 'N' Trace View',
    'a:has-text("Track and Trace")',
  ]);

  // The screenshot supplied by the project owner shows the tracking form using
  // tabs: Consignment ID -> Article Number / Reference Number.
  await clickFirstVisible(page, [
    '[role="tab"]:has-text("Consignment ID")',
    'text=Consignment ID',
  ]);
  await clickFirstVisible(page, [
    'label:has-text("Article Number")',
    'text=Article Number',
  ]);

  const entered = await fillFirstVisible(page, [
    'input[placeholder*="CONSIGNMENT" i]',
    'input[aria-label*="Consignment" i]',
    'input[name*="consignment" i]',
    'input[id*="consignment" i]',
    'input[placeholder*="Article Number" i]',
  ], ""); // establish a form/input without submitting a real number
  return entered;
}

async function findConsignmentInput(page) {
  const selectors = [
    'input[placeholder*="CONSIGNMENT" i]',
    'input[aria-label*="Consignment" i]',
    'input[name*="consignment" i]',
    'input[id*="consignment" i]',
    'input[placeholder*="Article Number" i]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 500 })) return locator;
    } catch {}
  }
  return null;
}

async function findCaptchaImage(page) {
  // Capture only the CAPTCHA element, never the full page.
  const candidates = [
    'img[alt*="captcha" i]',
    'img[src*="captcha" i]',
    'canvas[aria-label*="captcha" i]',
    '[id*="captcha" i] img',
    'img[title*="captcha" i]',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 700 })) {
        const box = await locator.boundingBox();
        if (box && box.width >= 40 && box.height >= 12) {
          return { locator, selector };
        }
      }
    } catch {}
  }

  // Fallback: small image-like elements close to "Play Audio CAPTCHA" or an
  // explicit CAPTCHA label. This intentionally avoids screenshotting the page.
  for (const labelSelector of ['text=/captcha/i', 'label:has-text("CAPTCHA")']) {
    const label = page.locator(labelSelector).first();
    try {
      if (await label.isVisible({ timeout: 500 })) {
        const parent = label.locator("xpath=..");
        const images = parent.locator("img, canvas");
        if (await images.count()) {
          const locator = images.first();
          if (await locator.isVisible()) return { locator, selector: labelSelector };
        }
      }
    } catch {}
  }
  return null;
}

async function screenshotCaptcha(page) {
  const found = await findCaptchaImage(page);
  if (!found) {
    throw new Error("India Post’s CAPTCHA image could not be located. The website may have changed its layout.");
  }
  const image = await found.locator.screenshot({ type: "png", timeout: 5000 });
  return Buffer.from(image);
}

async function findCaptchaInput(page) {
  const selectors = [
    'input[placeholder*="captcha" i]',
    'input[aria-label*="captcha" i]',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[placeholder*="enter captcha" i]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 500 })) return locator;
    } catch {}
  }
  return null;
}

async function getFormError(page) {
  const text = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const captchaWrong = /invalid\s*captcha|incorrect\s*captcha|captcha\s*(is\s*)?wrong|enter\s*valid\s*captcha|captcha\s*does\s*not\s*match/i.test(text);
  const notFound = /consignment\s*(number\s*)?(not found|does not exist)|no records found|no data found/i.test(text);
  const expiry = /session expired|session timed out|page expired/i.test(text);
  return { text, captchaWrong, notFound, expiry };
}

async function captureResult(page, consignmentNumber) {
  const body = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const statusHints = [
    "Item Delivered", "Delivered", "Out for Delivery", "Item Received",
    "Item Dispatched", "Bag Received", "Bag Dispatched", "Return to Sender",
    "In Transit", "Item Booked", "No Records Found",
  ];
  const lower = body.toLowerCase();
  const matches = statusHints.filter((s) => lower.includes(s.toLowerCase()));
  const bodyLooksLikeResults = /consignment|article number|booking date|delivery date|tracking details|item delivered|item dispatched|item received|out for delivery/i.test(body);

  if (!bodyLooksLikeResults || (!matches.length && body.length < 180)) {
    return null;
  }

  // Collect visible result tables/summary panels first to reduce irrelevant page text.
  let detail = "";
  for (const selector of [
    "table",
    '[role="table"]',
    ".table-responsive",
    '[class*="track" i]',
    '[id*="track" i]',
    '[class*="result" i]',
    '[id*="result" i]',
  ]) {
    try {
      const blocks = page.locator(selector);
      const count = Math.min(await blocks.count(), 8);
      const parts = [];
      for (let i = 0; i < count; i++) {
        const item = blocks.nth(i);
        if (await item.isVisible().catch(() => false)) {
          const value = normalizeText(await item.innerText().catch(() => ""));
          if (value.length > 25) parts.push(value);
        }
      }
      if (parts.length) {
        detail = [...new Set(parts)].sort((a, b) => b.length - a.length)[0];
        if (detail.length > 120) break;
      }
    } catch {}
  }
  if (!detail) detail = body;
  const escaped = escapeHtml(detail.slice(0, 5000));
  const statusLine = matches.length ? matches.join(" • ") : "Tracking details received";
  return {
    kind: "complete",
    message:
      `<b>📦 DakSewa Tracking Update</b>\n\n<b>Consignment:</b> <code>${escapeHtml(consignmentNumber)}</code>\n<b>Detected status keywords:</b> ${escapeHtml(statusLine)}\n\n<b>Details from India Post:</b>\n<pre>${escaped}</pre>\n\n<a href="https://www.indiapost.gov.in/">Open India Post official website</a>\n\n<i>This information is copied from the page response at the time of this check. For the authoritative latest status, use India Post’s official tracking service.</i>`,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function buildSession(chatId, consignmentNumber) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(TIMEOUT_MS);
  page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));

  try {
    await locateTrackingForm(page);
    const input = await findConsignmentInput(page);
    if (!input) throw new Error("Could not find the consignment number field on India Post’s page.");
    await input.fill(consignmentNumber);

    const captcha = await screenshotCaptcha(page);
    const active = { context, page, consignmentNumber, attempts: 0, createdAt: Date.now() };
    sessions.set(String(chatId), active);
    return { kind: "captcha", image: captcha, attempt: 1 };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function beginTracking({ chatId, consignmentNumber, onCaptcha }) {
  await cancelTracking(chatId);
  const result = await buildSession(chatId, consignmentNumber);
  await onCaptcha({ image: result.image, attempt: result.attempt });
  return { kind: "captcha" };
}

export async function submitCaptcha(chatId, captchaText, { onCaptcha }) {
  const key = String(chatId);
  const session = sessions.get(key);
  if (!session) return { kind: "expired" };
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    await cancelTracking(chatId);
    return { kind: "expired" };
  }

  const input = await findCaptchaInput(session.page);
  if (!input) {
    await cancelTracking(chatId);
    return { kind: "expired" };
  }
  await input.fill(captchaText);
  const submitted = await clickFirstVisible(session.page, [
    'button:has-text("Search")',
    'input[type="submit"][value*="Search" i]',
    'button[type="submit"]',
    'input[type="submit"]',
  ]);
  if (!submitted) {
    await cancelTracking(chatId);
    throw new Error("Could not find the Search button on India Post’s tracking form.");
  }

  await session.page.waitForTimeout(1200);
  await session.page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  const error = await getFormError(session.page);

  if (error.expiry) {
    await cancelTracking(chatId);
    return { kind: "expired" };
  }

  const result = await captureResult(session.page, session.consignmentNumber);
  if (result) {
    await cancelTracking(chatId);
    return result;
  }

  if (error.captchaWrong) {
    session.attempts += 1;
    if (session.attempts >= MAX_CAPTCHA_ATTEMPTS) {
      await cancelTracking(chatId);
      throw new Error(`India Post rejected ${MAX_CAPTCHA_ATTEMPTS} CAPTCHA attempts. Please restart with /track to avoid repeated submissions.`);
    }
    // Many versions of the page refresh CAPTCHA on failed submit; if not, click its
    // refresh affordance before taking a new, element-only screenshot.
    await refreshCaptchaInPage(session.page);
    session.createdAt = Date.now();
    const image = await screenshotCaptcha(session.page);
    await onCaptcha({
      image,
      attempt: session.attempts + 1,
      note: "India Post did not accept the previous entry. Try the characters in this new image.",
    });
    return { kind: "captcha" };
  }

  if (error.notFound) {
    await cancelTracking(chatId);
    return {
      kind: "complete",
      message: `<b>📦 DakSewa Tracking Update</b>\n\n<b>Consignment:</b> <code>${escapeHtml(session.consignmentNumber)}</code>\n\nIndia Post reported that no matching record was found. Please check the number on your receipt and try again. A recently booked item may take time to appear.\n\n<a href="https://www.indiapost.gov.in/">Open India Post official website</a>`,
    };
  }

  // If no explicit error or complete results were detected, do not falsely label the
  // CAPTCHA as wrong; retain the page and ask for an explicit refresh / retry.
  const captcha = await screenshotCaptcha(session.page).catch(() => null);
  if (!captcha) {
    await cancelTracking(chatId);
    throw new Error("India Post returned an unrecognized response. Please start again later.");
  }
  await onCaptcha({
    image: captcha,
    attempt: session.attempts + 1,
    note: "The page did not return a clear result. Please carefully re-enter the CAPTCHA shown here.",
  });
  return { kind: "captcha" };
}

async function refreshCaptchaInPage(page) {
  await clickFirstVisible(page, [
    'button[aria-label*="refresh" i]',
    'button[title*="refresh" i]',
    'a[title*="refresh" i]',
    '[class*="captcha" i] button',
    'button:has-text("Refresh")',
  ]);
}

export async function refreshCaptcha(chatId, onCaptcha) {
  const session = sessions.get(String(chatId));
  if (!session) throw new Error("No active tracking session. Send /track to start again.");
  await refreshCaptchaInPage(session.page);
  const image = await screenshotCaptcha(session.page);
  session.createdAt = Date.now();
  await onCaptcha({ image, attempt: session.attempts + 1, note: "Use this new CAPTCHA image." });
}

export async function cancelTracking(chatId) {
  const key = String(chatId);
  const session = sessions.get(key);
  sessions.delete(key);
  if (session) await session.context.close().catch(() => {});
}

export function getActiveTrackingCount() {
  return sessions.size;
}

export async function closeBrowser() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(all.map((item) => item.context.close()));
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
    browserPromise = undefined;
  }
}
