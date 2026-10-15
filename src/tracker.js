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
  // The tracking widget may be rendered inside an iframe. Read all frame
  // bodies so we do not classify only the outer SPA shell or homepage.
  const frameBodies = [];
  for (const frame of page.frames()) {
    const frameBody = normalizeText(await frame.locator("body").innerText().catch(() => ""));
    if (frameBody) frameBodies.push(frameBody);
  }
  const body = normalizeText([...new Set(frameBodies)].join("\n"));
  return {
    body,
    captchaWrong: /invalid\s*captcha|incorrect\s*captcha|captcha\s*(is\s*)?wrong|enter\s*valid\s*captcha|captcha\s*does\s*not\s*match/i.test(body),
    notFound: /consignment\s*(number\s*)?(not found|does not exist)|no records found|no data found/i.test(body),
    expired: /session expired|session timed out|page expired/i.test(body),
  };
}

function looksLikeTrackingResult(body, consignmentNumber, url = "") {
  const text = normalizeText(body);
  const number = String(consignmentNumber || "").trim();
  if (!number || !text.toLowerCase().includes(number.toLowerCase())) return false;

  // India Post's current SPA exposes result pages under this route. Do not
  // accept homepage announcements or generic words such as "Delivered".
  const resultRoute = /\/track-result\/article-tracking\//i.test(url);
  const hasResultFields =
    /article number|consignment (?:no\.?|number)|booked at|booked on|booking date|destination pincode|origin pincode/i.test(text);
  const hasStatusField =
    /(?:current status|article status|tracking status|status)\s*[:\-]?\s*(?:delivered|out for delivery|in transit|dispatched|booked|received|returned|return to sender)/i.test(text);
  // The portal's timeline sometimes renders the status and its date/office on
  // separate lines, so don't require them to be on the same line.
  const hasStatusTerm =
    /\b(?:delivered|out for delivery|in transit|item dispatched|article dispatched|bag dispatched|item booked|article booked|item received|article received|bag received|return to sender)\b/i.test(text);
  return resultRoute && hasResultFields && (hasStatusField || hasStatusTerm);
}

function extractField(text, labels) {
  const lines = normalizeText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const label of labels) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp("^" + escapedLabel + "\\s*[:：]?\\s*(.*)$", "i");
      const match = line.match(pattern);
      if (match && match[1].trim()) return match[1].trim();
      if (match && lines[i + 1] && !/^(article|consignment|booked|booking|origin|destination|delivery|status|print report)/i.test(lines[i + 1])) {
        return lines[i + 1];
      }
    }
  }
  return null;
}
function extractTrackingDetails(detail, body, consignmentNumber) {
  const source = normalizeText(detail);
  const full = normalizeText(body);
  const statusLabels = [
    ["Delivered", /\bdelivered\b/i],
    ["Out for Delivery", /\bout for delivery\b/i],
    ["In Transit", /\bin transit\b/i],
    ["Dispatched", /\b(?:item|article|bag) dispatched\b/i],
    ["Booked", /\b(?:item|article) booked\b/i],
    ["Returned to Sender", /\breturn(?:ed)? to sender\b/i],
    ["Received", /\b(?:item|article|bag) received\b/i],
  ];
  // Status must come from the result detail, not the site's shared header,
  // homepage carousel, or announcements.
  let currentStatus = extractField(source, ["Current Status", "Article Status", "Tracking Status", "Status"]);
  if (!currentStatus) {
    const eventLines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const event = eventLines.find((line) =>
      /\b(?:delivered|out for delivery|in transit|item dispatched|article dispatched|bag dispatched|item booked|article booked|item received|article received|bag received|return to sender)\b/i.test(line)
    );
    if (event) {
      const match = statusLabels.find(([, regex]) => regex.test(event));
      if (match) currentStatus = match[0];
    }
  }
  const deliveryDate = extractField(source, ["Delivered On", "Delivery Date", "Delivery Date/Time", "Delivery Date & Time"]);
  return {
    consignmentNumber: extractField(source, ["Article Number", "Consignment Number", "Consignment No"]) || (source.toLowerCase().includes(consignmentNumber.toLowerCase()) ? consignmentNumber : null),
    bookingOffice: extractField(source, ["Booked At", "Booking Office", "Booked From", "Origin Office"]),
    bookingDate: extractField(source, ["Booked On", "Booking Date", "Booking Date/Time"]),
    destination: extractField(source, ["Destination"]),
    destinationPincode: extractField(source, ["Destination Pincode", "Destination PIN Code"]),
    currentStatus,
    deliveryDate,
  };
}

async function waitForTrackingResult(page, consignmentNumber, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let latest = { body: "", captchaWrong: false, notFound: false, expired: false };
  while (Date.now() < deadline) {
    latest = await readResponse(page);
    if (latest.captchaWrong || latest.notFound || latest.expired) return latest;
    if (looksLikeTrackingResult(latest.body, consignmentNumber, page.url())) return latest;
    await page.waitForTimeout(350);
  }
  return latest;
}

async function captureResult(page, consignmentNumber, body) {
  if (!looksLikeTrackingResult(body, consignmentNumber, page.url())) return null;

  // Prefer the smallest visible result container that contains the submitted
  // consignment number; never derive status from the whole page shell.
  let detail = "";
  const selectors = [
    '[class*="track-result" i]', '[id*="track-result" i]',
    '[class*="tracking-result" i]', '[id*="tracking-result" i]',
    '[class*="result" i]', '[id*="result" i]',
    "table", '[role="table"]', ".table-responsive",
  ];
  const candidates = [];
  // Search every frame, matching the same frame-aware behavior used when
  // locating the CAPTCHA and Search control.
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const locators = frame.locator(selector);
        const count = Math.min(await locators.count(), 12);
        for (let i = 0; i < count; i++) {
          const node = locators.nth(i);
          if (!(await node.isVisible().catch(() => false))) continue;
          const text = normalizeText(await node.innerText().catch(() => ""));
          if (text.length > 30 && text.toLowerCase().includes(consignmentNumber.toLowerCase())) {
            candidates.push(text);
          }
        }
      } catch {}
    }
  }
  // Prefer the smallest matching block that contains both result fields and
  // a status term. A tiny block containing only the consignment number is not
  // enough evidence to classify the parcel.
  const verifiedCandidates = candidates.filter((candidate) =>
    /article number|consignment (?:no\.?|number)|booked at|booked on|booking date|destination pincode|origin pincode/i.test(candidate) &&
    /\b(?:delivered|out for delivery|in transit|item dispatched|article dispatched|bag dispatched|item booked|article booked|item received|article received|bag received|return to sender)\b/i.test(candidate)
  );
  if (verifiedCandidates.length) detail = verifiedCandidates.sort((a, b) => a.length - b.length)[0];
  else detail = body;
  const fields = extractTrackingDetails(detail, body, consignmentNumber);
  if (!fields.consignmentNumber || fields.consignmentNumber.toLowerCase() !== consignmentNumber.toLowerCase() || !fields.currentStatus) {
    console.warn("India Post result failed field verification:", {
      url: page.url(),
      expectedConsignment: consignmentNumber,
      extractedConsignment: fields.consignmentNumber,
      extractedStatus: fields.currentStatus,
      detail: detail.slice(0, 1000),
    });
    return null;
  }

  let screenshot = null;
  try {
    // Capture the actual rendered India Post result page after verification.
    // The user requested a screenshot only; do not generate a PDF.
    screenshot = Buffer.from(await page.screenshot({ type: "png", fullPage: true, animations: "disabled" }));
  } catch (error) {
    console.warn("Could not capture India Post result screenshot:", error.message);
  }

  const rows = [
    ["Consignment Number", fields.consignmentNumber],
    ["Current Status", fields.currentStatus],
    ["Booking Office", fields.bookingOffice],
    ["Booking Date", fields.bookingDate],
    ["Destination", fields.destination],
    ["Destination PIN Code", fields.destinationPincode],
    ["Delivery Date", fields.deliveryDate],
  ].filter(([, value]) => value);
  const summary = rows.map(([label, value]) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`).join("\n");
  return {
    kind: "complete",
    screenshot,
    message: `<b>📦 DakSewa Tracking Update</b>\n\n${summary}\n\n<i>Details are taken from the verified India Post result page. Fields not shown by the portal are omitted.</i>\n\n<a href="https://www.indiapost.gov.in/">Open India Post official website</a>\n\n<i>The screenshot reflects the official result page at the time of this check. Verify the official site for the latest status.</i>`,
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
  const searchSelectors = [
    'button:has-text("Search")',
    '[role="button"]:has-text("Search")',
    'input[type="submit"][value*="Search" i]',
    'input[type="button"][value*="Search" i]',
    'button[type="submit"]',
    'input[type="submit"]',
    'text=/^Search$/i',
  ];

  // Check the main document and any embedded frames; the portal's tracking
  // widget may be rendered separately from the page shell.
  let submitted = false;
  for (const frame of session.page.frames()) {
    submitted = await clickFirstVisible(frame, searchSelectors);
    if (submitted) break;
  }

  // Fallback for custom controls without button semantics. Only click a visible
  // element whose own normalized text is exactly "Search".
  if (!submitted) {
    for (const frame of session.page.frames()) {
      try {
        submitted = await frame.evaluate(() => {
          const visible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 &&
              style.visibility !== "hidden" && style.display !== "none" &&
              Number(style.opacity) !== 0;
          };
          const candidates = [...document.querySelectorAll("button, input, a, [role='button'], div, span")]
            .filter((el) => visible(el))
            .filter((el) => {
              const text = el instanceof HTMLInputElement ? el.value : el.innerText;
              return (text || "").replace(/\\s+/g, " ").trim().toLowerCase() === "search";
            })
            .sort((a, b) => {
              const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
              return (ar.width * ar.height) - (br.width * br.height);
            });
          if (!candidates.length) return false;
          candidates[0].click();
          return true;
        });
      } catch {}
      if (submitted) break;
    }
  }

  if (!submitted) {
    const diagnostics = [];
    for (const [index, frame] of session.page.frames().entries()) {
      try {
        diagnostics.push(await frame.evaluate((frameIndex) => ({
          frameIndex,
          url: location.href,
          title: document.title,
          visibleControls: [...document.querySelectorAll("button, input, [role='button'], a")]
            .filter((el) => {
              const r = el.getBoundingClientRect(), s = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
            })
            .slice(0, 40)
            .map((el) => ({
              tag: el.tagName,
              type: el.getAttribute("type"),
              text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80),
              id: el.id || "",
              className: typeof el.className === "string" ? el.className.slice(0, 100) : "",
            })),
        }), index));
      } catch {}
    }
    console.error("India Post Search control diagnostics:", JSON.stringify(diagnostics));
    await cancelTracking(chatId);
    throw new Error("Could not find the Search control. Diagnostic details were written to the bot terminal.");
  }

  // India Post is a client-rendered SPA; wait for the result route and
  // matching consignment details instead of assuming 1.2 seconds is enough.
  await session.page.waitForLoadState("domcontentloaded", { timeout: 4000 }).catch(() => {});
  const response = await waitForTrackingResult(session.page, session.consignmentNumber, Math.min(TIMEOUT_MS, 20000));
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

  // A stale CAPTCHA image can remain visible after a failed SPA navigation.
  // Do not send it automatically again: only an explicit CAPTCHA rejection
  // above should trigger a new challenge.
  console.warn("Unclassified India Post response after CAPTCHA submission:", {
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
    body: response.body.slice(0, 700),
  });
  await cancelTracking(chatId);
  throw new Error("India Post did not return a verifiable tracking result after CAPTCHA submission. I stopped this attempt to avoid repeating the same CAPTCHA. Please try /track again later; no parcel status has been assumed.");
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
