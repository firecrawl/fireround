# Scripts

Every `pnpm` script in `package.json`, one line each; the ones under `scripts/` read `.env` on their own, and the ones that open the embedded database need the dev server stopped (a pid lock guards it). Back to the [README](../README.md).

## Run the app

| Script | What it does |
|---|---|
| `pnpm dev` | The dashboard on http://localhost:3000 |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm vercel-build` | What Vercel runs: apply migrations, then build |

## Pipeline

| Script | What it does |
|---|---|
| `pnpm sweep` | Sweep the default preset over the last week; `-- --preset seed`, `-- --window day`, `-- --window month-2` for one past calendar month |
| `pnpm backfill -- --months 3` | Print the rate-card estimate for N months of history per preset, plus the free Form D span; add `--yes` to start it against the running app (`BASE_URL`, `CRON_SECRET`) |
| `pnpm alexandria-backfill -- --limit 60` | Alexandria for companies already stored: each pending company with a verified domain, one at a time, firmographics on (20 by default); `--max-credits N` caps the spend, `--refresh-firmographics` runs only the FullEnrich lookup for rows written while its terms were unaccepted |
| `pnpm resolve-investors -- --out <dir>` | Plan every visible investor's website, logo, and profile as the lanes resolve them, and re-verify every stored domain on its homepage, without writing to the store: `plan.json`, `plan.csv`, and `report.md` (coverage before and after, what is set, confirmed, replaced, cleared, a person, refused, or unresolved, and a sample to check by hand) land in `--out`. About 7 credits an investor without a domain and 5 a stored one. `--limit N`, `--ids a,b`, `--no-reverify`, `--resume <plan.jsonl>` after a cut-off run, `--merge a/plan.json,b/plan.json` to lay a re-plan of some ids over a full run (no call); `-- --apply --plan <dir>/plan.json` writes a reviewed plan with no Firecrawl call, skipping any row whose domain moved since |
| `pnpm investor-domains -- --dry-run --limit 2000` | Resolve stored investors without a domain in batches, as the lanes do (a 2-credit search and a 5-credit homepage verdict that reads the logo too), then read the logos of those with a domain and none (one branding scrape, 1 credit); the dry run prints the counts and credits, drop the flag to run. `--skip-people`, `--no-logos`, `--logos-only`, `--retry-days N`, `--clear <ids>`, `--recheck <ids>` |
| `pnpm feed-token -- --label "Slack #deals"` | Mint a feed token and print its RSS, Atom, and JSON Feed URLs (`--preset`, `--origin`) |
| `curl -X POST .../api/cron/backfill-dossiers` | Not a script: the route that gives every visible company a checked dossier (`?reverifyOnly=1`, `?limit=5`, `concurrency`, `maxTotalCredits`; `GET` for progress). The commands: [deploy.md](deploy.md#dossiers-for-every-company) |
| `curl -X POST .../api/cron/history-rounds` | Not a script: the route that promotes every checked dossier's prior rounds, and every Apollo lead, to verified history rounds (`?limit=10`, `concurrency`, `maxTotalCredits`; `GET` for progress). The commands: [deploy.md](deploy.md#history-rounds-for-every-checked-dossier) |
| `curl -X POST .../api/cron/backfill-apollo` | Not a script: the route that looks up every visible company in Apollo through Alexandria and queues the rounds it lists that the store lacks as history leads (`?limit=20`, `maxCredits`, `leads=0`; `GET` for progress). The commands: [deploy.md](deploy.md#apollo-for-every-visible-company) |
| `curl .../api/cron/accuracy` | Not a script: the daily accuracy check, on the schedule at 05:00 UTC and by hand with the cron bearer (`?dry=1` reports without writing, `remedies=0`, `profile`, `dossier`, `history` caps). The commands: [deploy.md](deploy.md#the-daily-accuracy-check) |
| `curl .../api/cron/health` | Not a script: the production health check, on the schedule every 10 minutes and by hand with the cron bearer (`?dry=1` reports what fails without writing or sending, `?test=1` sends one test line to `ALERT_SLACK_WEBHOOK_URL`). What it checks: [deploy.md](deploy.md#production-alerts) |
| `pnpm accuracy-check` | Print what the daily accuracy check would flag today (counts per rule and the most urgent flags) without writing; `-- --top 50`, `--limit 40`, `--json`. Reads only, so it is safe against production |
| `pnpm bench-reconcile -- <model> [<model>]` | Score reconcile models against `evals/golden-rounds.json` on identical prompts: per-field accuracy, agreement, latency, tokens, cost |
| `pnpm bench-publication-audit -- <cases.json> [--overlay rows.json]` | Score the publication audit against hand-checked rounds (`[{ id, clean, problems }]`): wrong rows caught, clean rows held or changed. Reads the store and each round's pages; writes nothing |
| `pnpm bench-pipeline` | Replay the 42 sourced fixture excerpts through extraction, resolver, price, and evidence check; `-- --assert` gates deterministic CI, `-- --stored` uses captured markdown and Firecrawl JSON, `-- --model <id>` compares a structured reader with the model read-back. See [bench-pipeline.md](bench-pipeline.md) |

## Maintenance

Each of these applies a rule that now runs on every new record to a store built before the rule existed. They live in `scripts/maintenance/`, apart from the scripts a running instance uses, and most print what they would change until given `--apply`.

| Script | What it does |
|---|---|
| `pnpm merge-duplicates` | Fold duplicate rounds, sources, and investor spellings; clear ungrounded amounts; move borrowed days to a surer source; publish verified rows left flagged |
| `pnpm merge-duplicate-rounds` | Print every duplicate-round merge (survivor, company fold, sources, investors, deliveries, fields, deletions) without writing; `-- --pair <id>,<id>` for one pair, `-- --apply` to merge, `--force` for a pair the rule does not join |
| `pnpm retitle-sources -- --dry-run` | Give sources titled from a sibling article their own title back (drop the flag to write) |
| `pnpm reverify-profiles` | Clear company profiles written before the homepage identity check so the next enrichment redoes them (`--name-alone` widens it) |
| `pnpm prune-corroboration -- --dry-run` | Drop corroboration sources that describe another company's round (drop the flag to write) |
| `pnpm prune-unsupported-investors` | Print each round whose own verification rejects an investor it still shows: the links it would remove, the leads it would clear, the verdict's words, and the sources; `-- --apply` to write (the links go, a cleared lead stays a participant, the row is rescored and noted), `--round <id>[,<id>]` for some rows. Reads only the store, safe to run again |
| `pnpm prune-unrelated-sources` | Print, per round, each source link that is not about the round and why (a job posting, a front page or other non-article, an aggregator's other story, a page that never names the company) without writing. `-- --read-pages` reads with Firecrawl, once each, the pages nothing stored ties to the company (about a credit a page, cached in `data/prune-sources-pages.json`, or `--page-cache <file>`): a page with a sentence naming the company and a figure stays and the sentence is written onto the link, a full page that never names it goes, and a page too short, in another script, or naming the company without a figure is left unverified. `--apply` writes (links go, sources linked to no round go), `--round <id>[,<id>]` for some rows. A round's last source never goes: the round is listed as held for review. Safe to run again |
| `pnpm repair-investors` | Print what today's investor name hygiene makes of every stored investor without writing: a description of investors ("executives from OpenAI", "some business angels") comes off its rounds, a spelling today's key folds into another firm ("a16z's Speedrun accelerator" into "a16z speedrun", "Wells Fargo & Co" out of "wells fargo and", "FJ Labs" out of "fj" now that the key keeps "AI" and "Labs") moves its links there with a lead kept a lead, a name whose shown form changes ("Eli Lilly (NYSE: LLY)", "Arm Holdings Inc", "Dr Michael Boyer") is renamed in place, and a row no round links to goes. A row moving off a key frees it for the firm that belongs there in the same pass. A spelling whose new key belongs to another firm by its words is held for a person; `-- --decisions held.json` carries out a person's decisions first (a rename with the site the round really names, or a forced merge, each citing its page; a decision whose row moved on is skipped). `-- --apply` to write; safe to run again |
| `pnpm repair-certainty` | Preview certainty classification of visible stored rounds with the supporting quote and source; reports counts and rows needing review. Run against an isolated restored copy before `-- --apply`, which updates certainty and places unsupported early reports in review. It does not automatically change the production database. |
| `pnpm prune-trending-posts` | Print every stored X post marked relevant that today's relevance rule would not keep (a shared word, a namesake, a figure far from the name) without writing; `-- --sql <file>` also writes the reviewed SQL (a backup table of those rows, then the update), `-- --apply` marks them irrelevant. A post whose stored snippet never names the company (its name was in the title, which is not kept) is left as it is. Only demotes, and the rows stay |
| `pnpm prune-page-snapshots` | Apply the same 90-day markdown snapshot retention as the daily accuracy workflow; `SNAPSHOT_RETENTION_DAYS` overrides the age for a manual run |
| `pnpm repair-money` | Replay stored rounds under the money and visibility rules: a valuation no sentence supports for its round, a row that breaks an invariant, a row only secondhand pages state. Prints each change and why; `-- --reground` reads an unsupported valuation's own sources again (Firecrawl and a model key, `RECONCILE_MODEL_REPAIR` picks the model; `--pause <ms>` between rows), `--apply` writes |
| `pnpm repair-financing` | Replay stored rounds under the financing and stage rules and print what changes; `-- --reground` reads sources with Firecrawl, `--limit N`, `--ids a,b`, `--verbose`, `--apply` writes |
| `pnpm repair-audit` | Re-evaluate existing rows under the issuer, identity, financing, stage, and company-date rules; dry run by default, `-- --reground` reads a source through Firecrawl, `--apply` writes only quoted changes |
| `pnpm repair-late-history` | Print the rounds first seen past the news window after their announcement, which belong in history; `-- --apply` moves them |
| `pnpm repair-trust-freshness` | Re-check each visible round's trusted evidence and date, searching with Firecrawl where the store cannot settle it, and print which would be hidden, redated, or moved to history; `-- --limit=N --offset=N` for a slice, `--apply` writes |
| `pnpm repair-request-names` | Give companies a request created with a homepage tagline in their name their clean name; display name only, safe to run again |
| `pnpm fix-records -- --file fixes.json` | Print hand-checked corrections to stored rows (a new day with the page that states it, a rejection, a forced merge, a company's own domain, a stage the page names, a description the company's own page supports, a round's leads and participants as its announcement states them, a company's headquarters or sector, or a missing earlier round queued on the history ledger as a lead with its page, `requeue` sending a lead that ended without a source back with a new page) without writing; `--apply` to write. Every fix but a merge cites the page it rests on, and each names what the row holds now, so a row that has moved on is refused and a fix already in place is skipped |
| `pnpm seed-tombstones -- --dir <folder>` | Print the merge tombstones (`round_merges`) for merges applied before the table existed, read from the folder's `--apply` logs (`*.applied.txt`), fix files' `merge` entries, and `*merge-backup*/round_sources.csv` backups, each checked against the store (the dropped row gone, the kept row there, chains followed); `--apply` to write. Run it once after the migration |
| `pnpm reset-data -- --yes` | Start the data over: rounds, companies, sources, investors, runs go; coverage, feed tokens, delivery targets, and monitors stay |

## Database

| Script | What it does |
|---|---|
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL`; with no URL set there is nothing to do, the embedded database migrates itself |
| `pnpm db:generate` | Generate a migration from `packages/core/src/db/schema.ts` with drizzle-kit |
| `pnpm backup-db -- --dir <folder> --label prod` | Dump `DATABASE_URL` with pg_dump (custom format, no owners or grants) to `fireround-<label>-<UTC time>.dump`, with a manifest of every table's row count taken in the same snapshot, checked with `pg_restore --list`; then prune the label's dumps past the newest `--keep` (14). Refuses a Neon `-pooler` host and a client (`PG_BIN`) whose major differs from the server's; reads only. `-- --verify <file.dump> --into <local URL>` restores into an empty database on this machine and compares every table with the manifest. The runbook: [deploy.md](deploy.md#back-up-and-restore-the-database) |

## Gates

| Script | What it does |
|---|---|
| `pnpm test` | The suite on an in-memory Postgres, no network, no key; `TEST_DATABASE_URL=postgres://... pnpm exec vitest run --no-file-parallelism` runs them against a real server |
| `pnpm typecheck` | Next typegen, then `tsc` for the app and for `packages/core` |
| `pnpm lint` | Biome check |
| `pnpm format` | Biome format, writing in place |
