import "dotenv/config";
import { startBot } from "./bot.js";
import { closeBrowser } from "./tracker.js";

const required = ["TELEGRAM_BOT_TOKEN"];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and configure your bot token.");
  process.exit(1);
}

const bot = startBot();
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down DakSewa…`);
  try {
    await bot.stop();
    await closeBrowser();
  } catch (error) {
    console.error("Shutdown warning:", error?.message ?? error);
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
