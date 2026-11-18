# Realorna: OpenAI, Real / Nah, accounts and transfers

The checker uses OpenAI web evidence to verify individual claims and returns Real / Nah with corrections. Existing username accounts, bank transfers, and admin-granted Regular/Advance attempts are retained.

The code has not been connected to your existing live Vercel database. Your database URL, bank details, OpenAI keys, and site URL are not available in the supplied ZIP. Configure them below before deploying.

## 1. Configure Vercel

Use your existing Vercel project. If importing the extracted project into a new repository, set the project root to the folder containing `package.json`.

1. Connect a Postgres database to the project. Vercel supports Postgres providers such as Neon through its Marketplace. If you already have a Postgres database, keep it.
2. In **Project → Settings → Environment Variables**, add the following variables to the deployment environment you intend to use.
3. Use **Container Runtime** for this media release, with the supplied `Dockerfile.vercel`. Follow **MEDIA-DEPLOY.md** for root directory, framework selection and the 300-second duration. The Docker build uses Node 24 and installs the real media tools. Database migration/admin seeding run at container startup with runtime credentials.
4. Deploy again after changing environment variables. Do not put private variables behind the `VITE_` prefix: that prefix exposes values to browsers.

| Variable | Value / purpose |
| --- | --- |
| `DATABASE_URL` | Your Postgres connection string. If the integration provided a differently named variable, add `DATABASE_URL` with the same appropriate Postgres connection string. |
| `BETTER_AUTH_URL` | Your site's exact HTTPS origin, for example `https://your-project.vercel.app`. Do not include `/login` or another path. Configure Preview separately if its origin differs. |
| `BETTER_AUTH_SECRET` | The generated value in the separate private `admin-credentials.txt` file, or your own random secret of at least 32 characters. Keep this stable across deployments. |
| `ADMIN_USERNAME` | `realorna_admin`, or your chosen unique bootstrap username. |
| `ADMIN_PASSWORD` | The generated value in the separate private credentials file, or your own 16–128 character password. |
| `ADMIN_EMAIL` | The credentials file supplies `admin@realorna.local`. You may use your own email before first deployment. No email delivery is configured. |
| `TRANSFER_BANK_NAME` | Your receiving bank's name. |
| `TRANSFER_ACCOUNT_NUMBER` | Your actual receiving account number, as text. |
| `TRANSFER_ACCOUNT_HOLDER` | The actual account holder name. |
| `TRANSFER_NOTE` | Optional additional instructions displayed to customers. |
| `OPENAI_TEXT_MODEL` | Article model for either plan. Default: `gpt-6-luna`. |
| `OPENAI_MEDIA_MODEL` | Image/video claim model. Default: `gpt-6.1-terra`. |
| `OPENAI_API_KEY` | Your server-side OpenAI key. For multiple authorized keys, see section 5. |

`VITE_AUTH_ENABLED` is already `true` in `.grok/app-env.json`. Do not override it with `false`.

`npm run build` builds the app, applies unapplied SQL migrations, then bootstraps the admin in the configured database. The database credentials therefore need permission to create the app's schema. The build refuses a Vercel deployment without `DATABASE_URL`; account endpoints also require `BETTER_AUTH_SECRET`.

Vercel Marketplace reference: https://vercel.com/docs/marketplace-storage

## 2. Sign in as admin

The generated initial login is in the separately supplied **admin-credentials.txt**. Set its variables before deployment, then visit **`/login`** and sign in with the username and password.

The bootstrap script stores a password hash, not a plaintext password. It runs safely again on later builds without overwriting an existing admin password. Changing `ADMIN_PASSWORD` after the account already exists does not reset that account's password. It refuses to promote a conflicting existing non-admin account.

Keep the private credentials file out of your repository. It is intentionally excluded from the source ZIP. Public signup reserves the bootstrap username, `realorna_admin`, `admin`, and `administrator`.

## 3. Send a Regular or Advance attempt

1. The recipient registers at `/login` using the **Register / Daftar** option.
2. Sign in as admin and open **Admin** in the header.
3. In **Send attempts / Kirim kesempatan**, enter the recipient's username.
4. Press **Send Regular** or **Send Advance**. Each press successfully completing adds one attempt.
5. The recipient sees the attempt in their account. The admin can also copy the generated attempt link and share it manually.

The link requires the recipient's login and cannot be redeemed by a different account. Registration treats `Alex`, `ALEX`, and `alex` as the same username; the database enforces this with a unique index, including racing registrations. Regular and Advance attempts are separate. One Regular attempt cannot buy an Advance check.

For your QRIS demo, show the payment QR from your banking or merchant app. Use that app's one-time QR feature if it supports one. After checking the actual incoming transaction there, send the appropriate attempt from the admin screen. Realorna does not generate or enforce the lifetime of that external QR.

Admin accounts can run either plan without buying or consuming attempts. This privilege is enforced on the server.

## 4. Bank transfer verification

1. A signed-in customer with no available attempt presses **Check** and creates an invoice.
2. Realorna displays your configured bank account, the exact amount, invoice ID, and a 24-hour expiry.
3. The customer transfers and submits a transfer reference or sender name. Their button requests verification; it does not confirm payment.
4. The admin opens **Admin → Transfer approvals** and checks the receiving account's actual transaction history.
5. Enter the amount actually received and the bank's transaction reference, confirm that you checked the transaction, then approve. Approval adds exactly one attempt.

Do not approve from a screenshot or a customer-supplied note alone. This integration has no bank API or automatic bank webhook. Payment authentication comes from the admin comparing the invoice with a real incoming bank transaction.

Prices and promo discounts are calculated on the server. Repeated approvals cannot add a second credit, and a bank transaction reference cannot be used on two invoices. Approval, credit creation, and the audit record are one atomic database statement. Expired invoices cannot be approved; reconcile any late payment manually before granting an attempt.

The old demo payment endpoint and Midtrans webhook return HTTP 410. They cannot mark a payment as paid. Old unowned Midtrans orders remain unowned and are not assigned to new users.

An AI check uses an attempt once. If analysis fails, the failure panel shows **Retry for free / Coba lagi gratis**. It reloads the saved check and retries its original order ID, URL and plan; editing the input field cannot change that retry into a different check. Saved failures also appear under **Payments & recent checks → Retry for free**, with a visible count of saved retries, including after page reload or signing in again. Repeating Check with unchanged input in the same browser session also reuses the saved check. The consumed attempt stays attached to its original URL and plan; failure does not mint a transferable attempt or require another customer payment. Cooldowns are respected, and successful reports are reused without another provider call.

## 5. OpenAI and content routing

Set `OPENAI_API_KEY`, `OPENAI_TEXT_MODEL=gpt-6-luna`, `OPENAI_MEDIA_MODEL=gpt-6.1-terra`, and `OPENAI_TRANSCRIBE_MODEL=gpt-transcribe`. Model values are optional defaults; actual project access remains to be verified in deployment. Article checks use LUNA regardless of purchased plan. Visual media requires Advance and uses Terra. Transcription uses GPT Transcribe separately. Remove obsolete `OPENAI_MODEL` and `OPENAI_ADVANCE_MODEL`; neither controls this release. The legacy `OPENAI_REGULAR_MODEL` is an article-only fallback when `OPENAI_TEXT_MODEL` is absent.

Keep keys server-side and redeploy after changing environment variables. `OPENAI_API_KEYS` optionally accepts an ordered comma/newline-separated list or JSON array of authorized keys; the single `OPENAI_API_KEY` is appended, duplicates removed, and at most twelve keys accepted. A 429 does not immediately hop keys. Gemini and xAI credentials are unused.

Every verification uses Responses with mandatory web search and strict structured output. The server requires a completed search and a usable completed model response. It accepts evidence URLs only from retrieved/cited sources, excluding the checked publisher's domain and generic home/search pages as sole comparison evidence. No search-free fallback is used. Retrieval provenance cannot itself prove that a source entails the model's interpretation.

The report derives Real/Nah from material claim statuses, shows concise corrections and evidence, preserves event-date context, and keeps link safety separate. Missing evidence is unverified, not a hoax. Partial input, unreadable visual text or omitted core claims cannot produce a fully verified result. There is no numeric trust score.

### Request pacing

The existing `0004_ai_throttle.sql` tables are reused under a new `openai` scope. No accounts, payments, or reports are deleted. Default behavior: one outbound request at a time, plus 12 seconds after a completed operation before the next begins. A request gate holds its lease until the provider body has been read. Transcription and checking share the gate across Vercel instances connected to the same database.

| Optional variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_MIN_INTERVAL_MS` | `12000` | Minimum spacing; increase for lower project limits. |
| `OPENAI_MAX_ATTEMPTS` | `3` | Total attempts per operation, including the first (1–5). |
| `OPENAI_MAX_QUEUE_WAIT_MS` | `30000` | Maximum in-request wait for a slot (0–60000 ms); occupied slots return `ai_busy` / HTTP 503 with a retry delay. |
| `OPENAI_RETRY_BASE_MS` | `2000` | Base for bounded exponential backoff with positive jitter. |

The code honors `Retry-After`, millisecond retry hints, and exhausted OpenAI request/token reset headers. Exhausted balance/spend quota errors stop automatic retries and return `ai_quota` / HTTP 503, without inventing a one-hour reset time. Any real provider retry hint remains honored. Busy slots are HTTP 503, temporary request/token limits HTTP 429, and timeouts HTTP 504. The saved check retains its attempt and any temporary retry time. The browser disables repeated requests during that cooldown, including after reloads, and follows updated server timestamps after an account refresh. Pacing does not increase token, spending, or account limits; other applications using your OpenAI project are outside this gate.

An article ordinarily uses one Responses request with up to six search calls. A media check may use up to three transcription calls followed by visual verification. Downloads, ASR, image inputs and web search affect latency/cost. Failed saved retries can repeat provider work even though they cost no extra customer attempt.

Article checks have a 120-second application deadline; media checks allow up to 270 seconds, including a maximum 100 seconds for download/preparation. Each provider request is limited to 90 seconds or the remaining overall budget. A timed-out POST is not automatically repeated because it may already have been processed. Deployment must allow a 300-second duration. Do not confuse this processing deadline with a customer cooldown.

Error responses include a support reference and safe diagnostic fields such as `error_origin`, provider HTTP status, provider error code and request ID when available. Match the reference to `[realorna] check_failed` in server logs. Keys, raw provider messages, article text and submitted URLs are not logged by this diagnostic path. See **RATE-LIMIT-FIX.md** for the error meanings and deployment steps. The pending screen shows elapsed time and the actual server stage from the owned order; it does not invent completed stages.

### Media and readability

Articles use bounded page retrieval with JSON-LD/article/main extraction. A blocked or unreadable article fails without a made-up verdict. Social media uses actual downloads, FFmpeg audio/frame preparation, GPT Transcribe and Terra. Instagram image collections preserve every slide and caption in order. Read **MEDIA-DEPLOY.md** for supported URL forms, limits, platform access restrictions and honest coverage notes.

## 6. Local use and verification

Use Node 24, Python 3.10+ and FFmpeg/ffprobe. Install JS dependencies with `npm ci`, create a Python virtual environment, and install `media/requirements.txt`. Set `MEDIA_PYTHON` to that environment's Python executable. `MEDIA_SCRIPT_PATH` is optional and defaults to `media/media_job.py` under the app root. No cookies or private credentials are bundled.

- `npm run dev`: the existing app preview, with isolated PGlite if DATABASE_URL is absent.
- `npm run typecheck`, `npm test`, `npm run test:factcheck`, `npm run test:ai-rate-limit`, `npm run test:payments`: application checks.
- `npm run test:media`: isolated media fixtures; defaults to `.media-venv/bin/python3`, or your `MEDIA_PYTHON`.
- `python -m unittest discover -s media -p 'test_*.py'`: Python media tests, including actual FFmpeg and offline yt-dlp download/merge.
- `npm run build`: legacy Nitro/Vercel output plus migration/seeding; use Container Runtime for production media.
- `npm run build:container`, then `npm run start:container`: production Node server build/start, with runtime database migration/seeding.
- `docker build -f Dockerfile.vercel .`: full production-image acceptance check when Docker is available.

Do not run fixture payment tests with a live DATABASE_URL or VERCEL environment; they refuse that configuration. See **VERIFICATION.md** for the latest actual results and limits.
