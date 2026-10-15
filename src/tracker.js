import { chromium } from "playwright";

const TRACK_URL = process.env.INDIA_POST_TRACK_URL || "https://www.indiapost.gov.in/";
const TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 30000);
const MAX_CAPTCHA_ATTEMPTS = Number(process.env.MAX_CAPTCHA_ATTEMPTS || 5);
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
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 })) {
        await locator.click({ timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function findVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 })) return locator;
    } catch {}
  }
  return null;
}

async function locateTrackingForm(page) {
  await page.goto(TRACK_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: Math.min(TIMEOUT_MS, 10000) }).catch(() => {});

  await clickFirstVisible(page, [
    'a:has-text("Track \'N\' Trace View")',
    'button:has-text("Track \'N\' Trace")',
    'text=Track \'N\' Trace View',
    'a:has-text("Track and Trace")',
  ]);
  await clickFirstVisible(page, [
    '[role="tab"]:has-text("Consignment ID")',
    'text=Consignment ID',
  ]);
  await clickFirstVisible(page, [
    'label:has-text("Article Number")',
    'text=Article Number',
  ]);

  const input = await findVisible(page, [
    'input[placeholder*="CONSIGNMENT" i]',
    'input[aria-label*="Consignment" i]',
    'input[name*="consignment" i]',
    'input[id*="consignment" i]',
    'input[placeholder*="Article Number" i]',
  ]);
  if (!input) throw new Error("Could not find the consignment number field on India Post’s page.");
  return input;
}

async function findCaptchaImage(page) {
  // Prefer an actual loaded CAPTCHA asset. Broad selectors such as
  // "[id*=captcha] img" can match decorative/placeholder images on the page.
  const selectors = [
    'img[alt*="captcha" i]',
    'img[title*="captcha" i]',
    'img[src*="captcha" i]',
    'canvas[aria-label*="captcha" i]',
    'canvas[id*="captcha" i]',
    '[id*="captcha" i] img',
  ];

  const candidates = [];
  for (const selector of selectors) {
    try {
      const locators = page.locator(selector);
      const count = Math.min(await locators.count(), 10);
      for (let i = 0; i < count; i++) {
        const locator = locators.nth(i);
        if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const box = await locator.boundingBox().catch(() => null);
        if (!box || box.width < 70 || box.height < 18) continue;

        const info = await locator.evaluate((element) => {
          const style = getComputedStyle(element);
          const isImage = element instanceof HTMLImageElement;
          return {
            tag: element.tagName,
            alt: isImage ? element.alt : "",
            src: isImage ? element.currentSrc || element.src : "",
            complete: isImage ? element.complete : true,
            naturalWidth: isImage ? element.naturalWidth : 0,
            naturalHeight: isImage ? element.naturalHeight : 0,
            filter: style.filter,
            opacity: style.opacity,
            width: element.clientWidth,
            height: element.clientHeight,
          };
        }).catch(() => null);
        if (!info) continue;

        // A broken or not-yet-loaded img often screenshots as a grey box.
        if (info.tag === "IMG" && (!info.complete || info.naturalWidth < 40 || info.naturalHeight < 12)) continue;
        const text = `${selector} ${info.alt} ${info.src}`.toLowerCase();
        const explicitMatch = /captcha/.test(text) ? 100 : 0;
        const loadedImage = info.tag === "IMG" && info.naturalWidth > 0 ? 30 : 0;
        candidates.push({ locator, score: explicitMatch + loadedImage + Math.min(box.width, 300) / 100, info });
      }
    } catch {}
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) {
    const best = candidates[0];
    // Wait briefly for any final image decode/layout update before capturing it.
    if (best.info.tag === "IMG") {
      await best.locator.evaluate(async (img) => {
        if (img.decode) await img.decode().catch(() => {});
      }).catch(() => {});
    }
    return best.locator;
  }

  // Some versions of the portal render the challenge on a canvas or as a CSS
  // background rather than an <img>. Restrict fallback to a CAPTCHA-labelled
  // block and only accept a challenge-sized child element.
  for (const labelSelector of ['text=/captcha/i', 'label:has-text("CAPTCHA")']) {
    try {
      const label = page.locator(labelSelector).first();
      if (!(await label.isVisible({ timeout: 500 }))) continue;
      for (const selector of ["canvas", 'img[src^="data:image" i]', '[style*="background-image" i]']) {
        const locator = label.locator("xpath=..").locator(selector).first();
        if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const box = await locator.boundingBox().catch(() => null);
        if (box && box.width >= 70 && box.height >= 18) return locator;
      }
    } catch {}
  }
  return null;
}

async function screenshotCaptcha(page) {
  const locator = await findCaptchaImage(page);
  if (!locator) throw new Error("Could not find a loaded CAPTCHA image on India Post’s page. The website may have changed its layout.");

  // India Post currently embeds the CAPTCHA as a data URL. Prefer the original
  // image bytes over a browser screenshot: screenshots can capture CSS scaling,
  // overlays, or rendering artifacts and may make the challenge hard to read.
  const source = await locator.evaluate((element) => {
    if (element instanceof HTMLImageElement) {
      return {
        src: element.currentSrc || element.src,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
      };
    }
    return null;
  }).catch(() => null);

  if (source?.src?.startsWith("data:image/") && source.naturalWidth >= 70 && source.naturalHeight >= 18) {
    const match = source.src.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/=]+)$/);
    if (match) {
      const original = Buffer.from(match[1], "base64");
      if (original.length >= 500) return original;
    }
  }

  // Fallback for portals that do not expose the image as an inline data URL.
  const image = Buffer.from(await locator.screenshot({ type: "png", timeout: 5000 }));
  if (image.length < 500) throw new Error("India Post returned an empty or incomplete CAPTCHA image. Please try /refresh.");
  return image;
}

async function findCaptchaInput(page) {
  return findVisible(page, [
    'input[placeholder*="captcha" i]',
    'input[aria-label*="captcha" i]',
    'input[name*="captcha" i]',
    'input[id*="captcha" i]',
    'input[placeholder*="enter captcha" i]',
  ]);
}

async function readResponse(page) {
  const body = normalizeText(await page.locator("body").innerText().catch(() => ""));
  return {
    body,
    captchaWrong: /invalid\s*captcha|incorrect\s*captcha|captcha\s*(is\s*)?wrong|enter\s*valid\s*captcha|captcha\s*does\s*not\s*match/i.test(body),
    notFound: /consignment\s*(number\s*)?(not found|does not exist)|no records found|no data found/i.test(body),
    expired: /session expired|session timed out|page expired/i.test(body),
  };
}

function looksLikeTrackingResult(body) {
  const trackingFields = /booking date|delivery date|tracking details|tracking history|article number|consignment number/i.test(body);
  const hasTrackingStatus = /item delivered|out for delivery|item received|item dispatched|bag received|bag dispatched|return to sender|in transit|item booked/i.test(body);
  return trackingFields && hasTrackingStatus;
}

async function captureResult(page, consignmentNumber, body) {
  if (!looksLikeTrackingResult(body)) return null;
  let detail = "";
  for (const selector of ["table", '[role="table"]', ".table-responsive", '[class*="track" i]', '[id*="track" i]', '[class*="result" i]', '[id*="result" i]']) {
    try {
      const locators = page.locator(selector);
      const count = Math.min(await locators.count(), 8);
      const blocks = [];
      for (let i = 0; i < count; i++) {
        const node = locators.nth(i);
        if (await node.isVisible().catch(() => false)) {
          const text = normalizeText(await node.innerText().catch(() => ""));
          if (text.length > 25) blocks.push(text);
        }
      }
      if (blocks.length) {
        detail = [...new Set(blocks)].sort((a, b) => b.length - a.length)[0];
        if (detail.length > 120) break;
      }
    } catch {}
  }
  if (!detail) detail = body;
  const statusHints = ["Item Delivered", "Out for Delivery", "Item Received", "Item Dispatched", "Bag Received", "Bag Dispatched", "Return to Sender", "In Transit", "Item Booked"];
  const lower = body.toLowerCase();
  const matches = statusHints.filter((status) => lower.includes(status.toLowerCase()));
  return {
    kind: "complete",
    message: `<b>📦 DakSewa Tracking Update</b>\n\n<b>Consignment:</b> <code>${escapeHtml(consignmentNumber)}</code>\n<b>Detected status keywords:</b> ${escapeHtml(matches.join(" • "))}\n\n<b>Details from India Post:</b>\n<pre>${escapeHtml(detail.slice(0, 3500))}</pre>\n\n<a href="https://www.indiapost.gov.in/">Open India Post official website</a>\n\n<i>Details are copied from the page at the time of this check. Verify the latest status on the official site.</i>`,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
    const input = await locateTrackingForm(page);
    await input.fill(consignmentNumber);
    const captcha = await screenshotCaptcha(page);
    sessions.set(String(chatId), { context, page, consignmentNumber, attempts: 0, createdAt: Date.now() });
    return { image: captcha, attempt: 1 };
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
  const session = sessions.get(String(chatId));
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
  // India Post may render Search as a styled control rather than a native button.
  // Try semantic controls first, then exact visible text to avoid clicking a parent.
  const submitted = await clickFirstVisible(session.page, [
    'button:has-text("Search")',
    '[role="button"]:has-text("Search")',
    'input[type="submit"][value*="Search" i]',
    'input[type="button"][value*="Search" i]',
    'button[type="submit"]',
    'input[type="submit"]',
    'text=/^Search$/i',
  ]);
  if (!submitted) {
    await cancelTracking(chatId);
    throw new Error("Could not find the Search button on India Post’s tracking form.");
  }

  await session.page.waitForTimeout(1200);
  await session.page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  const response = await readResponse(session.page);
  if (response.expired) {
    await cancelTracking(chatId);
    return { kind: "expired" };
  }

  if (response.captchaWrong) {
    session.attempts += 1;
    if (session.attempts >= MAX_CAPTCHA_ATTEMPTS) {
      await cancelTracking(chatId);
      throw new Error(`India Post rejected ${MAX_CAPTCHA_ATTEMPTS} CAPTCHA attempts. Please restart with /track.`);
    }
    await refreshCaptchaInPage(session.page);
    session.createdAt = Date.now();
    const image = await screenshotCaptcha(session.page);
    await onCaptcha({ image, attempt: session.attempts + 1, note: "India Post did not accept the previous entry. Try this new CAPTCHA." });
    return { kind: "captcha" };
  }

  const result = await captureResult(session.page, session.consignmentNumber, response.body);
  if (result) {
    await cancelTracking(chatId);
    return result;
  }

  if (response.notFound) {
    const number = session.consignmentNumber;
    await cancelTracking(chatId);
    return {
      kind: "complete",
      message: `<b>📦 DakSewa Tracking Update</b>\n\n<b>Consignment:</b> <code>${escapeHtml(number)}</code>\n\nIndia Post reported that no matching record was found. Check the number on your receipt and try again. A recently booked item may take time to appear.\n\n<a href="https://www.indiapost.gov.in/">Open India Post official website</a>`,
    };
  }

  const captcha = await screenshotCaptcha(session.page).catch(() => null);
  if (!captcha) {
    await cancelTracking(chatId);
    throw new Error("India Post returned an unrecognized response. Please start again later.");
  }
  await onCaptcha({
    image: captcha,
    attempt: session.attempts + 1,
    note: "The page did not return a clear result. Try the CAPTCHA once more, or send /refresh for a new image.",
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
  await Promise.allSettled(all.map((session) => session.context.close()));
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close().catch(() => {});
    browserPromise = undefined;
  }
}
