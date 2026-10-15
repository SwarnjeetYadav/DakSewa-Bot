# DakSewa 📮

A Telegram bot that guides users through India Post consignment tracking. It takes a consignment number in chat, opens India Post’s official website, sends only the CAPTCHA image to the user, accepts their typed CAPTCHA, submits it, and returns the details visible on the result page.

> **Important:** The user reads and enters the CAPTCHA. DakSewa does not use OCR, an external solving service, or any automatic CAPTCHA bypass. India Post may change the page or use CAPTCHA/session mechanisms that require a manual fallback.

## Features

- Telegram chat flow: `/start`, `/track`, `/refresh`, `/cancel`, `/help`.
- Input validation for article/consignment numbers.
- Playwright browser automation against India Post’s official website.
- Element-only CAPTCHA screenshot sent to the user (not a full-page or browser screenshot).
- User replies with CAPTCHA; the bot submits the value to the site’s search form.
- Wrong CAPTCHA handling: detects explicit page errors, sends a new CAPTCHA, and caps retries.
- Session isolation by Telegram chat, 10-minute session expiry, cancel/cleanup, clear error messages.
- No fabricated tracking updates; details are passed through from India Post’s page where detectable.
- Docker deployment and health-oriented operational notes.

## Architecture

```
Telegram user
  -> /track + consignment number
  -> Bot creates isolated Playwright browser context
  -> India Post official tracking form
  -> CAPTCHA element screenshot only
  -> Telegram photo
  -> User enters CAPTCHA text
  -> Bot fills CAPTCHA + clicks Search
  -> Inspect actual page response
       -> details found: send status/details
       -> explicit wrong CAPTCHA: refresh/new image
       -> no record: explain and provide official link
       -> unknown response/site changed: fail safely
```

## Requirements

- Node.js 20.11 or newer
- Telegram bot token from Telegram’s official `@BotFather`
- Internet access to Telegram and India Post
- Playwright Chromium browser dependencies (installed by the setup below)

## Local setup

1. Clone the repository and enter the project directory:

   ```bash
   git clone https://github.com/SwarnjeetYadav/DakSewa-Bot.git
   cd DakSewa-Bot
   ```

2. Install dependencies and the Playwright browser:

   ```bash
   npm install
   npx playwright install chromium
   ```

   On Linux servers, use `npx playwright install --with-deps chromium` if the OS packages are missing.

3. Create environment file:

   ```bash
   cp .env.example .env
   ```

   Set `TELEGRAM_BOT_TOKEN` in `.env`. Never commit the real token.

4. Start:

   ```bash
   npm run check
   npm start
   ```

5. Open the bot in Telegram and send `/start`.

## Environment variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Token from BotFather |
| `INDIA_POST_TRACK_URL` | No | `https://www.indiapost.gov.in/` | Official India Post landing page |
| `PAGE_TIMEOUT_MS` | No | `30000` | Playwright navigation timeout |
| `MAX_CAPTCHA_ATTEMPTS` | No | `5` | Maximum rejected CAPTCHA attempts before restart |

## Telegram commands

- `/start` — show welcome menu
- `/track` — start a tracking request
- `/refresh` — request a fresh CAPTCHA when one is active
- `/cancel` — close the browser context and cancel current tracking
- `/help` — instructions

## Deployment with Docker

Build and run:

```bash
docker build -t dak-sewa-bot .
docker run -d --name dak-sewa-bot --restart unless-stopped \
  --env-file .env dak-sewa-bot
```

Logs:

```bash
docker logs -f dak-sewa-bot
```

The bot uses Telegram long polling, so it does not need a public webhook URL. Keep `.env` out of the image and source repository.

## Important limitations and responsible operation

1. **Third-party website changes:** India Post can update its markup, labels, CAPTCHA type, or tracking workflow. The automation uses accessible labels and conservative selector fallbacks. If the form no longer matches, it fails with an error rather than inventing a status. Update `src/tracker.js` after checking the current official page.
2. **CAPTCHA handling:** A human must read and enter the CAPTCHA. Do not add CAPTCHA-solving services or code that tries to bypass access controls.
3. **Rate limiting:** Do not run parallel repeated lookups against India Post. Ask users to retry later if the website is unavailable or imposes a challenge.
4. **Accuracy:** Tracking detail parsing is best-effort because official page structure can change. The bot includes the actual text it can read and links the user to the official site for verification.
5. **Privacy:** The consignment number is kept in in-memory per-chat session state while the request is active. It is not written to a database or application logs by this code. Do not share private tracking identifiers publicly. For a public production deployment, add a privacy notice and retention policy.
6. **Group chats:** For privacy, use this bot in a direct Telegram chat rather than a group.

## Troubleshooting

- **Bot does not respond:** Verify `TELEGRAM_BOT_TOKEN`, network access, and that another process is not polling with the same bot token.
- **Chromium launch errors:** Run `npx playwright install --with-deps chromium` on a supported Linux host.
- **CAPTCHA cannot be found:** The India Post page markup may have changed; inspect its current official form and adjust only the CAPTCHA-specific selector in `findCaptchaImage()`.
- **Bot says it cannot find the input/Search button:** Inspect the current official tracking page and update the selector lists in `src/tracker.js`.
- **No status displayed:** The official site may return a new result layout. The bot should not infer a status in that case; use the India Post link and update the result parser after verifying page markup.

## Project status

This is an initial implementation with robust conversation/session structure. Since India Post can change its live form and CAPTCHA, do a real end-to-end test with a valid consignment on the current website before announcing the bot as production-ready.
