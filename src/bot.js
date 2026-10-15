import { Bot, InlineKeyboard, session } from "grammy";
import {
  beginTracking,
  submitCaptcha,
  refreshCaptcha,
  cancelTracking,
  getActiveTrackingCount,
} from "./tracker.js";

const HELP_TEXT = [
  "📮 *DakSewa — India Post Tracking Assistant*",
  "",
  "I’ll help you track a consignment using India Post’s official tracking page.",
  "",
  "*How it works*",
  "1. Send your consignment/article number.",
  "2. I open the official India Post tracking page and send you the CAPTCHA image.",
  "3. Read the image and reply with the CAPTCHA text.",
  "4. I submit it and share the tracking details shown by India Post.",
  "",
  "Commands: /track to start, /refresh for a new CAPTCHA, /cancel to stop, /help for help.",
  "",
  "🔐 CAPTCHA is intentionally completed by you. DakSewa does not solve or bypass it.",
].join("\n");

function mainKeyboard() {
  return new InlineKeyboard()
    .text("📦 Track a consignment", "track:start")
    .text("❓ Help", "help:show");
}

export function startBot() {
  const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
  bot.use(session({
    initial: () => ({ state: "idle", consignmentNumber: null, createdAt: null, lastStatus: null }),
  }));

  bot.command("start", async (ctx) => {
    ctx.session.state = "idle";
    await cancelTracking(ctx.chat.id);
    await ctx.reply(
      "Welcome to *DakSewa*! 📮\n\nTrack your India Post parcel in a few guided steps.\n\nChoose an option below to begin.",
      { parse_mode: "Markdown", reply_markup: mainKeyboard() },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
  });

  bot.command("track", async (ctx) => {
    await cancelTracking(ctx.chat.id);
    ctx.session.state = "awaiting_consignment";
    ctx.session.consignmentNumber = null;
    await ctx.reply(
      "📦 *Let’s track your parcel*\n\nSend your India Post consignment/article number as a text message.\n\nYou can cancel at any time with /cancel.",
      { parse_mode: "Markdown" },
    );
  });

  bot.command("cancel", async (ctx) => {
    await cancelTracking(ctx.chat.id);
    ctx.session.state = "idle";
    ctx.session.consignmentNumber = null;
    await ctx.reply("✅ Tracking session cancelled. Send /track whenever you’re ready.");
  });

  bot.callbackQuery("track:start", async (ctx) => {
    await ctx.answerCallbackQuery();
    await cancelTracking(ctx.chat.id);
    ctx.session.state = "awaiting_consignment";
    ctx.session.consignmentNumber = null;
    await ctx.reply("📦 Please send your India Post consignment/article number.\n\nFor your privacy, send it only in this chat.");
  });

  bot.callbackQuery("help:show", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(HELP_TEXT, { parse_mode: "Markdown", reply_markup: mainKeyboard() });
  });

  bot.command("refresh", async (ctx) => {
    if (ctx.session.state !== "awaiting_captcha") {
      await ctx.reply("There’s no active CAPTCHA to refresh. Send /track to start a new tracking request.");
      return;
    }
    try {
      ctx.session.state = "loading_tracking";
      await refreshCaptcha(ctx.chat.id, async ({ image, note }) => {
        ctx.session.state = "awaiting_captcha";
        await ctx.replyWithPhoto(new Blob([image], { type: "image/png" }), {
          caption: `🧩 *Fresh CAPTCHA*\n\n${note ?? "Please enter the characters shown."}\n\nReply with the CAPTCHA text.`,
          parse_mode: "Markdown",
        });
      });
    } catch (error) {
      ctx.session.state = "awaiting_consignment";
      ctx.session.consignmentNumber = null;
      await ctx.reply(`Couldn’t refresh the CAPTCHA: ${safeError(error)}. Please use /track to restart.`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (ctx.session.state === "awaiting_consignment") {
      const consignment = text.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9]{8,20}$/.test(consignment)) {
        await ctx.reply("⚠️ That number doesn’t look right. Please send the consignment/article number (8–20 letters or digits), without spaces.");
        return;
      }

      ctx.session.consignmentNumber = consignment;
      ctx.session.state = "loading_tracking";
      await ctx.reply("🔎 Opening India Post’s official tracking page…\n\nThis may take a few seconds.");
      try {
        const result = await beginTracking({
          chatId: ctx.chat.id,
          consignmentNumber: consignment,
          onCaptcha: async ({ image, attempt, note }) => {
            ctx.session.state = "awaiting_captcha";
            await ctx.replyWithPhoto(new Blob([image], { type: "image/png" }), {
              caption: [
                attempt > 1 ? "🔁 *New CAPTCHA*" : "🧩 *Please enter the CAPTCHA*",
                note ?? "",
                "Read the characters in this image and reply with them in this chat.",
                "If the image is unclear, send /refresh. Send /cancel to stop.",
                "_I won’t guess or automatically solve the CAPTCHA._",
              ].filter(Boolean).join("\n\n"),
              parse_mode: "Markdown",
            });
          },
        });
        if (result.kind === "complete") {
          ctx.session.state = "idle";
          ctx.session.consignmentNumber = null;
          await ctx.reply(result.message, { parse_mode: "HTML", reply_markup: mainKeyboard() });
        } else if (result.kind === "captcha") {
          ctx.session.state = "awaiting_captcha";
        }
      } catch (error) {
        await cancelTracking(ctx.chat.id);
        ctx.session.state = "idle";
        ctx.session.consignmentNumber = null;
        await ctx.reply(
          `❌ I couldn’t open or read the India Post tracking page right now.\n\nDetails: ${safeError(error)}\n\nPlease try again later with /track. No tracking status has been assumed.`,
          { reply_markup: mainKeyboard() },
        );
      }
      return;
    }

    if (ctx.session.state === "awaiting_captcha") {
      if (text.length < 3 || text.length > 12 || !/^[A-Za-z0-9]+$/.test(text)) {
        await ctx.reply("Please enter only the characters shown in the CAPTCHA image (letters and numbers), or send /refresh for a new image.");
        return;
      }
      ctx.session.state = "checking_captcha";
      await ctx.reply("⏳ Submitting your CAPTCHA to India Post…");
      try {
        const result = await submitCaptcha(ctx.chat.id, text, {
          onCaptcha: async ({ image, attempt, note }) => {
            ctx.session.state = "awaiting_captcha";
            await ctx.replyWithPhoto(new Blob([image], { type: "image/png" }), {
              caption: [
                attempt > 1 ? "❌ *CAPTCHA not accepted — try again*" : "🧩 *Please enter the CAPTCHA*",
                note ?? "Please read the new image carefully and try again.",
                "Reply with the characters in this image, or send /refresh.",
              ].join("\n\n"),
              parse_mode: "Markdown",
            });
          },
        });
        if (result.kind === "complete") {
          ctx.session.state = "idle";
          ctx.session.consignmentNumber = null;
          await ctx.reply(result.message, { parse_mode: "HTML", reply_markup: mainKeyboard() });
        } else if (result.kind === "captcha") {
          ctx.session.state = "awaiting_captcha";
        } else if (result.kind === "expired") {
          ctx.session.state = "awaiting_consignment";
          ctx.session.consignmentNumber = null;
          await ctx.reply("⌛ The India Post page/session expired. Please send your consignment number again to restart.");
        }
      } catch (error) {
        await cancelTracking(ctx.chat.id);
        ctx.session.state = "idle";
        ctx.session.consignmentNumber = null;
        await ctx.reply(
          `❌ I couldn’t complete the tracking request. ${safeError(error)}\n\nPlease start again with /track.`,
          { reply_markup: mainKeyboard() },
        );
      }
      return;
    }

    if (ctx.session.state === "loading_tracking" || ctx.session.state === "checking_captcha") {
      await ctx.reply("⏳ I’m still working on your current request. Please wait for the next message, or use /cancel.");
      return;
    }

    await ctx.reply("Ready when you are. Send /track to check a parcel, or /help to see the steps.", {
      reply_markup: mainKeyboard(),
    });
  });

  bot.catch((error) => {
    console.error("Telegram update error:", error.error?.stack ?? error.error);
  });

  const polling = bot.start({ onStart: (info) => console.log(`DakSewa is running as @${info.username}`) });
  polling.catch((error) => console.error("Bot polling stopped:", error));
  console.log(`Active tracking sessions: ${getActiveTrackingCount()} at startup`);
  return bot;
}

function safeError(error) {
  const message = String(error?.message ?? error ?? "Unexpected error");
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}
