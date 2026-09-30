# Early-warning and verified-record demo for cage fish farmers

A web demo for cage fish farmers in the Mwanza Gulf. It gives the farmer early warnings (low oxygen, water turnover risk, temperature, pH, wind and rain) and builds a **verified record** that a lender can review. Three roles, no sign-in: **Farmer**, **Lender officer**, **Extension officer**.

"Kipimo" is a **placeholder name**. It lives in one file, `src/brand.ts` (see "Renaming").

**Everything you see is demo data unless a screen says Live, and nothing was ever called live.** The loan and tranche are simulated ("Simulated. Not a real lender."). Nothing in the app is called AI: alerts and the record score are transparent rules.

## Run it

Needs **Node 22** (tested on 22.22.2 and 22.23.2). `.nvmrc` pins it, so `nvm use` picks the right one.
Node 20 also passes every check today, but it is outside `engines` and npm warns on install: treat it as unsupported.

```bash
npm i
npm run dev        # web on http://localhost:5173, API on http://localhost:8787
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server plus the Express API (proxied at `/api`) |
| `npm run build` | Typecheck, then build the PWA into `dist/` |
| `npm start` | Serves `dist/` and the API from one process on `PORT` (default 8787). Run `npm run build` first |
| `npm test` | Unit and integration tests (vitest) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run shots` | Playwright screenshots into `../deliverables/shots/` (needs a build and a Chromium; see below) |
| `npm run e2e` | Playwright flows: offline outbox, SMS dry run, validation (needs a build and a Chromium) |
| `npm run db:up` / `db:down` / `db:reset` / `db:psql` | The local Postgres in Docker |
| `npm run test:pg` | The whole suite again, against Postgres |

Useful URL switches (for demos and screenshots): `?now=2026-09-29T06:10:00Z` fixes the clock, `?dev=1` shows the "Simulate offline" button, `?offline=1` starts simulated offline. Screens are at `#/farmer/home`, `#/lender/portfolio`, `#/extension/farms`, and so on.

The Playwright scripts use a browser already on the machine. They look for `CHROMIUM_PATH` first, then the usual
locations (`/opt/pw-browsers/chromium`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`,
`/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, and the macOS Chrome app), and fail with the list if none
is present. No browser is downloaded by this project.

## Environment variables

All are optional. Copy `.env.example` to `.env` to set them. `.env` is gitignored and **must never be committed**. Only the server reads them; the browser never sees a secret.

| Variable | Used for | Default |
| --- | --- | --- |
| `PORT` | API and production web port | `8787` |
| `DATA_DIR` | Where the JSON store is kept | `server/data` (gitignored) |
| `CORS_ORIGINS` | Extra origins allowed to call the API (for example a Capacitor app). Same-origin needs nothing | empty |
| `BEEM_API_KEY` | Beem SMS API key | empty, so SMS run in **dry run** |
| `BEEM_SECRET_KEY` | Beem secret (`BEEM_API_SECRET` is accepted as an alias) | empty |
| `BEEM_SENDER_ID` | Your approved Beem sender ID. There is **no default**, on purpose | empty |
| `SMS_MAX_PER_HOUR` | Cap on live SMS per hour (the demo has no sign-in, so the server limits itself) | `5` |
| `BEEM_DLR_TOKEN` | Optional shared secret for the delivery-report callback. When set, `POST /api/sms/dlr` requires `?token=` | empty (endpoint open) |
| `BOX_BASE_URL` | KijaniSpace Space-IoT Box base URL | `https://api.kijanispace.eu` |
| `BOX_API_KEY` | Box API key | empty, so the Box stays in **demo** mode |
| `BOX_BEARER_TOKEN` | Box bearer token (WaziCloud) | empty |
| `VITE_API_BASE` | Build-time API origin, for example when the app is wrapped by Capacitor | empty (same origin) |
| `VITE_DEV_API` | Dev proxy target | `http://127.0.0.1:8787` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Local Docker Postgres. Local development values, not secrets | `ziwadata` / `ziwadata` / `localdev` |
| `POSTGRES_PORT` | Host port for the Docker Postgres (5433 and 6379 are taken by other projects here) | `5434` |
| `DATABASE_URL` | What the server connects with. Unset means the JSON file. Point it at Supabase to move | empty (JSON file) |
| `AUTH_REQUIRED` | Enforce sign-in and roles. Off means the open demo | empty (off) |
| `AUTH_SECRET` | Hashes one-time codes and session tokens. Unset means a random one per boot, so restarts sign everyone out | empty |
| `AUTH_ROLES` | `phone:role` pairs assigning a role at first sign-in. Everyone else is a farmer | empty |
| `AUTH_MAX_CODES_PER_HOUR` | Ceiling on sign-in code SMS per hour across the server | `50` |

## Database (Postgres in Docker)

The server runs on **either** store. `DATABASE_URL` set means Postgres; unset means the JSON file, so the demo
still runs with nothing installed. Nothing outside `server/store/` knows which one it got.

```bash
npm run db:up        # Postgres 17 on 127.0.0.1:5434
npm test             # JSON store; the Postgres cases are skipped and say so
npm run test:pg      # the same suite again, against Postgres
npm run db:psql      # a psql shell in the container
npm run db:reset     # wipe and re-apply the schema
```

`server/db/migrations/*.sql` are applied in order on boot, each recorded in `schema_migrations` so it runs exactly
once, and serialised by an advisory lock so two processes booting together cannot both apply them. The tests run the
same migrations. Tables:
`readings`, `checkpoints`, `settings`, `sms_log`, `inbox`, `unmatched_dlr`.

**Why Postgres:** Supabase *is* Postgres, so the same schema file runs there unchanged. Nothing in it is
Supabase-specific; moving means changing `DATABASE_URL` and nothing else. Ports 5433 and 6379 are already used
by other projects on this machine, so this defaults to **5434**, bound to `127.0.0.1` only.

### The one rule that shapes the schema

A reading's hash is `SHA-256(prevHash + canonicalJson(body))`. If the bytes fed back into that function differ by
one character, every later hash in the farm's chain fails and the lender screen reports a break that never happened.

So a record body is stored as **`text` holding the exact canonical JSON the client hashed**, never as `jsonb`.
Checked against the running database:

| Stored as | Result |
| --- | --- |
| `text` (what we do) | `{"cageId":"farm-demo-c1","value":5.0}` — byte-identical to what was hashed |
| `jsonb` | `{"value": 5.0, "cageId": "farm-demo-c1"}` — keys reordered, spaces added, **different hash** |

The typed columns beside `body_json` are derived copies, for querying and indexing only. `body_json` is the truth.

Constraints verified against the running database: a second phone cannot claim a chain position another already
holds (`readings_farm_seq_unique`, which is the "two phones for one farm" rule); a reading cannot carry both a
number and an incident string; a delivery state cannot exist without its timestamp; `settings` cannot get a second row.

### One interface, two stores

`server/store/types.ts` defines `AppStore`. `JsonStore` and `PgStore` implement it; routes only ever see the
interface, and `createApp` takes a store, so a test can pass a fake.

`tests/store-contract.test.ts` runs **one** set of assertions against **both** stores, so the JSON store stays a
faithful fake for the Postgres one rather than drifting from it. `tests/server-pg.test.ts` then drives the real
routes over HTTP against a real Postgres. Both skip, loudly, when `TEST_DATABASE_URL` is unset.

Two things the port had to get right:

- **Sync is serialised per farm** with `pg_advisory_xact_lock(hashtext(farmId))` inside the transaction. Without it,
  two phones syncing at once could both pass the "is this seq free?" check and one would lose its record.
- **Express 4 does not forward a rejected promise** out of an async handler: the request hangs until the client
  gives up. Now that every route awaits the store, one dropped connection would have hung them all. `createApp`
  wraps route handlers so a rejection becomes a clean 500. Express 5 does this itself; the wrapper goes when we upgrade.

## Sign-in and roles

Off by default: with `AUTH_REQUIRED` unset the app is the open demo it has always been, and the
"Demo: no sign-in" notice is honest. Set `AUTH_REQUIRED=1` and the server enforces sign-in and roles.

**How it works.** A farmer types their number, the server sends a 6-digit code by SMS through Beem, and a
correct code starts a session in an httpOnly cookie. No passwords.

**What is stored, and what is not:**

| Thing | Stored as |
| --- | --- |
| The one-time code | `SHA-256(AUTH_SECRET + phone + code)`. The code itself is never written down |
| The session token | `SHA-256(AUTH_SECRET + token)`. The token exists only in the user's cookie |
| The phone number | In plain text, because it IS the identity. Never returned to a browser except masked |

Checked against the running database: after a real sign-in, the code that was issued appears in **no** row,
and the raw cookie token appears in **no** row. A dump of this database does not let anyone sign in as
somebody else. The SMS log keeps the state only: no number, no code.

**Limits, because an SMS costs money and a code protects a farmer's record:** one code per minute per number,
5 per hour per number, 5 wrong guesses before the code dies, codes expire in 10 minutes and are single-use,
and `AUTH_MAX_CODES_PER_HOUR` caps sign-in SMS across the whole server. Sign-in codes are counted
**separately** from alerts, so a farmer who mistypes their number five times does not lose their low-oxygen
alerts for the next hour.

`/api/auth/request-code` answers identically whether or not a number is known, so it cannot be used to find
out who has an account.

**Roles the server enforces.** The role lives on the user row. The browser never sends a role and cannot
change its own, so no request can promote itself (there is a test for exactly that).

| | farmer | lender | extension |
| --- | --- | --- | --- |
| Write to the record chain (`/api/sync`) | yes | **no** | yes (attestations) |
| Send an SMS | yes | no | no |
| Read checkpoints, Box and SMS status | yes | yes | yes |

Roles are assigned by `AUTH_ROLES` at first sign-in and changed afterwards with SQL (`npm run db:psql`).
There is no admin screen, on purpose: an unprotected one would be a way to grant yourself a lender's view.

**The delivery-report callback stays unauthenticated**, deliberately: Beem calls it and has no session. Its
guard is `BEEM_DLR_TOKEN`, and all it can ever do is set the delivery state of a message this server already sent.

**With no Beem credentials** a code cannot reach a phone, so the server prints it to its own console and never
over HTTP. That keeps a local demo usable and cannot happen once credentials are set.

**Not done yet:** the sign-in screen itself. The API is complete and tested; the browser still has no way to
use it, so the "Demo: no sign-in" notice stays until that lands.

## Design system mix (decision)

- **Bwawa is the base.** Tokens come from `design/bwawa-tokens.json` and are turned into `src/styles/tokens.css` by `scripts/build-tokens.mjs` (light, Night and Sun themes, 36 colours each). The component classes (`bw-*`) are the copied Bwawa bundle in `src/styles/bwawa.css`. Reason: farmers use this on a phone in bright sun, so big touch targets (48 and 56 px), Atkinson Hyperlegible Next, borders instead of shadows, a high-contrast Sun theme, and a state that is always **icon plus word plus colour**.
- **SamakiCash desktop patterns are borrowed, not the tokens.** The lender and extension officer work at a desk, so the shell uses a 256 px sidebar at 1024 px and up, an icon rail from 640 to 1023 px, and a bottom tab bar on phones. Tables become cards on phones. Stat cards and a printable evidence pack follow the same idea. The SamakiCash CSS was used as a **reference**: the `sc-*` class names in `src/styles/app.css` are rewritten here on Bwawa tokens, not copied.
- Swahili is the default language, English is one tap away. **The Swahili text needs native review before real use** (the app says so in Settings).

## Renaming

Change `BRAND.name` (and `tagline`, `shortName`) in `src/brand.ts`, then run `npm run build`. The browser title, the wordmark, the PWA manifest (`vite.config.ts`), `capacitor.config.ts` and the SMS test message all read from it. The SMS **sender ID** is not in the code: it is `BEEM_SENDER_ID` on the server. There is no logo. The wordmark is plain text, and the PWA icons are plain solid squares (`scripts/make-icons.mjs`).

## Beem SMS setup

The server sends SMS through Beem (`server/sms/beem.ts`, ported from the owner's existing client with dependency injection so it can be tested). **It was never called live.** All Beem tests use a fake `fetch`.

1. Get an API key and secret from Beem and an approved sender ID.
2. Put them in `.env` as `BEEM_API_KEY`, `BEEM_SECRET_KEY`, `BEEM_SENDER_ID`.
3. Restart. The Data sources page shows the mode. **Live is shown only after a real send or balance check has succeeded in that session**; until then it says credentials are set, not verified.

Without credentials the server runs in **dry run**: an SMS request is recorded and shown as "Not sent (dry run)". Nothing leaves the machine.

Safety choices, because the demo has no sign-in: the server sends **only from fixed templates** (never free text from the browser), **only to the one number saved in Settings**, and stops after `SMS_MAX_PER_HOUR`. All templates are GSM-7 and at most 160 characters, and are unit-tested. Numbers and message bodies are not logged. Retries: 3 tries with backoff, and no retry for errors that cannot succeed.

### Checked against Beem's documentation (2026-09-30)

`server/sms/beem.ts` was read against the current docs at `docs.beem.africa`. **Confirmed unchanged:** the send endpoint
`POST https://apisms.beem.africa/v1/send` with HTTP Basic, the body fields (`source_addr`, `message`, `encoding`,
`recipients[{recipient_id, dest_addr}]`, `schedule_time`), and the balance endpoint
`GET https://apisms.beem.africa/public/v1/vendors/balance` returning `data.credit_balance`.

**Three things were wrong and are now fixed:**

- **The no-retry list was a guess and was incomplete.** It came from the reference client as `101, 102, 105, 111, 120`.
  Code `105` is not in Beem's published table at all, and codes `104` and `109`–`123` are permanent failures that the
  old code retried three times each, burning the hourly cap for nothing. The rule is now the documented one: **`103` is
  the only Beem code worth retrying**; every other code in `101`–`123` stops immediately. See `isPermanentFailure`.
- **Beem's free-text `message` was being written into the SMS log.** The log now records the documented code name
  (`invalid_sender_id`, `insufficient_balance`, …) so it stays a fixed vocabulary.
- **Nothing checked the sender ID.** Beem requires alphanumeric, at most 11 characters; a longer one fails with 111/121
  at send time. `senderIdIssue` now reports `missing`, `too_long` or `not_alphanumeric` **without ever echoing the value**.

One documented difference is left alone on purpose: the docs type `recipient_id` as an integer and this client sends a
string, exactly as the owner's production client does. That client works, so Beem accepts a string.

### `GET /api/sms/health`

Runs the documented balance check and reports three separate facts, never the credentials:

| Field | Meaning |
| --- | --- |
| `configured` | Key and secret are present on the server |
| `senderIdSet`, `senderIdIssue` | Whether a sender ID is set, and why Beem would reject it (never the value itself) |
| `reachable` | Beem answered at all. `null` means nothing was called because there are no credentials |
| `balance` | The SMS credit Beem reported, or `null` |
| `live` | A real call has succeeded **in this server session** |

With no credentials it answers `configured: false`, `reachable: null`, `error: "not_configured"` and **calls nothing**.
It is wired to a **"Check Beem health" button** on the Data sources page, not to page load: opening a page never calls Beem.
The health check only reads the balance. **It never sends an SMS.**

### Delivery reports

Beem offers two ways to learn whether a message arrived, and this build implements both.

- **Callback (webhook):** `POST /api/sms/dlr`. Beem POSTs inbound messages and delivery reports to a callback URL you
  register with them. The documented DLR shape is `application/x-www-form-urlencoded` with uppercase fields; a report is
  the one carrying `DLRID` and `STATUS` (1–11). Set `BEEM_DLR_TOKEN` and give Beem the URL with `?token=…`.
- **Polling:** `POST /api/sms/dlr/poll` calls the documented
  `GET https://dlrapi.beem.africa/public/v1/delivery-reports?dest_addr=&request_id=`, which returns `DELIVERED`,
  `PENDING` or `UNDELIVERED`. Beem asks callers to wait **at least 5 minutes** after sending, so anything younger than
  that is left alone and reported as `tooRecent`.

The Alerts screen shows the result as a second chip next to the SMS chip, and the SMS page shows it in the log.
**"Sent" and "Delivered" are kept apart on purpose:** Sent means Beem accepted the message, Delivered means it reached
the handset. A message with no report shows **"No report yet"**, never Delivered.

Beem's statuses 9 "Orphaned" and 11 "Unknown" are shown as **"Beem did not confirm"**, not as a failure: Beem does not
say the message failed, only that it cannot report on it. An unrecognised status is shown the same way. The endpoint can
only ever change the delivery state of a message this server already sent: it cannot create a record, send anything, or
touch a reading. A report it cannot match to a sent message is kept in `unmatchedDlr` so the gap stays visible.

**Still not verified:** no callback has ever reached this build, and Beem's own docs describe two different callback
shapes (the uppercase form-encoded one above, and a lowercase JSON one for Two-Way SMS inbound). The parser reads both
and reports anything else as unparsed rather than guessing. Ask Beem which shape their DLR callback actually sends.

**Inbound SMS is simulated.** Real inbound needs Beem inbound to be set up, which is a question to ask Beem. In the demo, the Settings screen sends a message such as `RIPOTI K3 OKS 5.2 JOTO 27.5` (or `REPORT C3 DO 5.2 T 27.5`) to the server's parser. It becomes a Manual reading marked "via SMS" and joins the farm's record on the next sync.

## Box setup (KijaniSpace Space-IoT Box)

Adapter: `server/box/adapter.ts`. The routes are in one table (`BOX_ROUTES`), shown on the Data sources page. **The two functions `mapWeatherPayload` and `mapDevicePayload` are the single places to edit** once real responses are known.

To try it: set `BOX_BASE_URL` and either `BOX_API_KEY` (weather routes) or `BOX_BEARER_TOKEN` (devices routes need a WaziCloud bearer token; an API key does not open them), restart, open Data sources, and press "Test connection". Raw response samples are written to `server/data/box-samples.json` so you can see the true shape.

**What is unverified, honestly:**
- No call to the Box was ever made from this build. The route list and auth rules come from the brief.
- The response fields are not documented. The "water" route looks like **weather, not lake water quality**. The mapping is a guess and is flagged "unverified" in the UI, and wind is only used when the payload states its unit.
- The device list shown in demo mode uses an **assumed shape**. There is no device-to-cage mapping yet, so device readings are never added to a record.
- There is no satellite water-quality data. The Satellite source tag exists but nothing writes it.
- We cannot issue our own Box key: KijaniSpace has to.

## Capacitor wrap (UNTESTED)

`capacitor.config.ts` is included, and the scripts exist. **No Android or iOS build was made or tested.** Suggested steps:

```bash
npm run build
npm run cap:add:android      # installs @capacitor/android, builds, runs "cap add android"
npm run cap:sync
npx cap open android
```

Before you do: set `appId` in `capacitor.config.ts` (it is a neutral placeholder `org.example.fishwatch`), build with `VITE_API_BASE=https://your-server` and put that origin into the server's `CORS_ORIGINS`, and check that IndexedDB, the service worker and the `capacitor://`/`https://localhost` origin behave. Expect to fix things: none of this was run.

## Feature-phone plan

Many farmers have a basic phone. **Now:** SMS alerts in Swahili or English, and SMS reporting of readings (simulated inbound, above). **Later:** a USSD menu. USSD needs a **shortcode** from an operator or aggregator, so it is not built. The Data sources and SMS pages say so.

## Real, demo, and not built

**Real (works in this build):**
- Offline-first storage in IndexedDB, an outbox, and idempotent sync by record id. A service worker serves the app with no network (tested with the network cut).
- The tamper-evident record: a SHA-256 hash chain per farm, verified in the browser, plus server checkpoints of the chain head. Editing an old reading breaks the chain and the lender screen shows where.
- The rules engine, alert history, feeding guidance and the record score (pure functions, unit-tested, all thresholds in one object, `RULES` in `src/core/config.ts`, labelled "Demo default, confirm with fisheries experts").
- The SMS templates, parser, dry-run path and the server code for Beem and for the Box adapter (tested with fakes).
- The Beem client checked line by line against the current published documentation, with the retry rules corrected to
  Beem's own code table, and delivery reports (callback and polling) implemented and unit-tested against fakes.

**Demo (invented for this demonstration):**
- All farms, readings, borrowers, alerts and the weather forecast. The seed is deterministic (5 farms, about 3,600 readings). Borrowers: Baraka (about 98), Neema (about 75), Juma (about 58, tranche held) and Salma (chain deliberately edited after hashing, breaks at entry 57), plus the demo farm (about 87).
- The loan and tranches ("Simulated. Not a real lender."), the lender hold and release, and the extension officer attestations.
- Sensors: none of them exist in this build.

**Not built:**
- Sign-in, roles enforced on the server, multi-farm accounts, consent screen (a stub), photo upload (only the file name is kept), real payments or lender integration.
- The sign-in screen. The server side is built and tested; nothing in the browser calls it yet.
- A consent screen. The database records consent (`users.consent_at`, `consent_version`) but nothing asks for it.
- Live Beem, live Box, USSD, satellite data, Android and iOS builds, a native Swahili review.
- A real delivery report: the callback and the polling call are written and tested against fakes, but no report has ever
  arrived from Beem, and the callback shape is not confirmed.
- Independent anchoring of the chain (the checkpoints are held by the same server as the records, so this is a first step, not an independent anchor).

## Choices where the brief and practice differ

- **Score verification** counts only water readings (oxygen, temperature, pH) that came from a sensor or an extension attestation.
- **Consistency** is split: 10 points for no gap over 3 days on any active cage, 10 for values inside plausible ranges.
- **"Mortality rising"** needs both a ratio of at least 1.25 and a rise of at least 5 fish, so tiny counts do not trigger it.
- **Turnover risk** is judged only when a deep-water temperature is read, and only on cages with a depth probe; other cages show "no depth probe" and never a guessed value.
- **A broken record chain also holds the next tranche** in the lender view. This goes beyond the brief's rule (score below 60, or last reading older than 3 days) and is stated on screen.
- **"Days lost to incidents"** is defined on screen (days with a Critical alert or a logged incident in the last 30 days). The wording is to be confirmed.
- **Two phones for one farm:** if another device already wrote to the same place in a farm's chain, the server refuses the reading. The app keeps it in the outbox and says so instead of dropping it. There is no merge logic.

## Tests

`npm test` runs **315 tests**, skipping the Postgres-only ones. `npm run test:pg` starts from the same files and
runs **351**: the extra 36 are the store contract re-run against Postgres plus the routes driven over a real
database. Files: hash chain, rules, alerts, score, SMS templates and parser, server API, Beem and Box adapters (fake `fetch`), and the offline engine (fake IndexedDB, including a run against the real server code).

`npm run e2e` (after `npm run build`) starts the production server on port 8790 with no `.env` and checks, in a real Chromium: a reading saved while offline appears in the outbox, is not on the server, and arrives after going online (with the toggle and with the network really cut); the dry-run SMS through the API and the UI; simulated inbound SMS; and input validation.

## Known gaps

- Beem, the Box and Capacitor were never run live (see above). The Beem client now matches the published docs, but
  matching the docs is not the same as having called the API.
- The Swahili is machine-drafted by the project and needs a native review, above all the SMS text and the alert wording.
- Alert thresholds and feeding guidance are demo defaults, not scientific advice.
- The demo history is generated relative to the clock when the app is first opened (or when you press "Reset demo data"). Screenshots use `?now=2026-09-29T06:10:00Z` (09:10 East Africa Time) so they can be repeated.
- The server has no sign-in: anyone who can reach it can read and change the demo data. Do not put it on the public internet with real numbers.
- The JSON store is a single file, fine for a demo, not for production. Set `DATABASE_URL` to use Postgres instead.
- Screenshots and layout were checked at 390x844 and 1280x800 in one Chromium only. Other browsers and screen sizes were not checked. There is no automated accessibility audit, only design rules (contrast tokens, 48 px targets, text of at least 13 px, icon plus word plus colour).
- Farm and site names in the seed are English strings, not translated.
