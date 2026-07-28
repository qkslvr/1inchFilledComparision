# Deployment

Three pieces:

| Piece | Where | Why there |
| --- | --- | --- |
| Collector | A VM you control | Holds two live WebSockets and prices every live order once a second. Nothing serverless can do this. |
| Postgres | Railway | Shared state between the writer and the reader. |
| Dashboard | Vercel | Static page + one read-only function. |

The collector connects **out** to Railway, so the VM needs no inbound access, no
tunnel and no public address.

Each chain lives in its own Postgres schema — `chain_8453` for Base, `chain_1`
for Ethereum — which is what the SQLite build got from having one file per
chain. Queries stay unqualified; the connection's `search_path` decides.

## 1. Railway

Create a Postgres instance. You need two connection strings from it:

- the **public proxy URL** — for the collector VM and for Vercel
- the internal `*.railway.internal` URL — only if you later run something inside Railway

Then create a read-only role for Vercel, so a leaked frontend env can't write:

```sql
CREATE ROLE vercel_ro LOGIN PASSWORD '<pick one>';
GRANT USAGE ON SCHEMA chain_8453, chain_1 TO vercel_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA chain_8453, chain_1 TO vercel_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA chain_8453, chain_1 GRANT SELECT ON TABLES TO vercel_ro;
```

Run this *after* the first collector start, which is what creates the schemas.

## 2. Collector VM

Needs Node 20+. No native build toolchain: `pg` is pure JavaScript.

```bash
git clone git@github.com:qkslvr/1inchFilledComparision.git ~/workspace/1inchFilledComparision
cd ~/workspace/1inchFilledComparision
npm ci --omit=optional          # skips better-sqlite3, only the import script needs it
cp .env.example .env            # then fill in DATABASE_URL + ONEINCH_API_KEY
npm run collect                 # Base
CHAIN=ethereum npm run collect  # Ethereum, second process
```

The first start creates and migrates that chain's schema.

As systemd units, one per chain:

```ini
# /etc/systemd/system/shadow-collector@.service
[Unit]
Description=Shadow resolver collector (%i)
After=network-online.target

[Service]
Type=simple
User=prabal
WorkingDirectory=/home/prabal/workspace/1inchFilledComparision
Environment=CHAIN=%i
EnvironmentFile=/home/prabal/workspace/1inchFilledComparision/.env
ExecStart=/usr/bin/npm run collect
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now shadow-collector@base shadow-collector@ethereum
```

Restarts are safe: the collector resumes non-terminal orders from the database
and records a `ws_gap` event covering the downtime.

## 3. Importing the existing SQLite data

Run this from the machine holding the `.sqlite` files (it needs
`better-sqlite3`, which is an optional dependency — `npm ci` without
`--omit=optional`). Row ids are preserved; the source files are opened
read-only and never modified.

```bash
export DATABASE_URL='postgres://...'          # Railway public URL
CHAIN=base     npm run import:sqlite -- ./shadow.sqlite
CHAIN=ethereum npm run import:sqlite -- ./shadow-eth.sqlite

# build the verdicts the dashboard reads (imported history has none)
CHAIN=base     npm run backfill:outcomes
CHAIN=ethereum npm run backfill:outcomes
```

`import:sqlite` refuses to run against a schema that already holds orders unless
you pass `--force`, in which case conflicting rows are skipped rather than
overwritten.

## 4. Vercel

Import the repo. The defaults in `vercel.json` are correct: build command
`npm run build:static` (renders `src/dash/page.ts` to `public/index.html`),
output directory `public`, and a rewrite from `/data.json` to `/api/data` so the
page's fetch stays same-origin.

Set one environment variable:

- `DATABASE_URL` — the Railway public URL **using the `vercel_ro` role**

The function caches for 4 seconds at the edge (`s-maxage=4`) against a 5-second
poll, so extra open tabs don't multiply into connection pressure. Railway ships
no pgBouncer, so the pool is capped at one connection per instance.

## Local dashboard

Still available on the VM, same data and same page:

```bash
npm run dash          # http://127.0.0.1:8787
```

## Reports

Unchanged, still a CLI, still writes `report.md` / `report.json` next to the
repo:

```bash
CHAIN=base npm run report
```
