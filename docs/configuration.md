# Configuration

Every environment variable, in one table. Only `FIRECRAWL_API_KEY` is required; the rest have working defaults. Where to set them and why: [deploy.md](deploy.md). Back to the [README](../README.md).

## Variables

| Variable | | Purpose |
|---|---|---|
| `FIRECRAWL_API_KEY` | required | Your Firecrawl key |
| `DATABASE_URL` | optional | Any Postgres 15+; unset uses embedded PGlite. A pooled URL (Neon's `-pooler` host, PlanetScale's PgBouncer on port 6432) is right for the app; scripts, migrations, and backups switch to the direct endpoint themselves |
| `DATABASE_DRIVER` | optional | `neon` or `pg`, overriding the choice from the URL |
| `DATABASE_POOL_MAX` | optional | Connections one process holds in its pg pool (default 3). Hosts can raise this; behind a PgBouncer, keep instances times this under its client-connection ceiling |
| `PGLITE_DIR` | optional | Where the embedded database lives; default `./data/fireround` |
| `CRON_SECRET` | recommended on any public deployment | Bearer for the cron routes; you set it (any random string of 16+ characters) and Vercel sends it on every cron call |
| `ALERT_SLACK_WEBHOOK_URL` | optional | A Slack incoming webhook for a private channel that receives production alerts from `/api/cron/health`; unset logs them instead ([deploy.md](deploy.md#production-alerts)) |
| `DASHBOARD_PASSWORD` | optional | Basic auth on the dashboard and `/api/v1`; unset means open (or, with `PUBLIC_DEMO`, no admin tier) |
| `PUBLIC_DEMO` | optional | `1` hosts a read-only public instance: reads are open; admin paths and operator writes are not. Company requests are a separate opt-in public write |
| `LANDING` | optional | `1` serves the landing page at `/` and keeps the dashboard at `/feed`; the page always answers at `/home` |
| `COMPANY_REQUESTS` | optional | `1` accepts public company website requests and runs verified research in a durable workflow; needs Firecrawl and a configured dossier verification model. Unset hides the entry points and returns 404 from the request API |
| `COMPANY_REQUESTS_DAILY_MAX` | optional | Maximum new company research jobs per UTC day across the instance; default 50. Each address may start at most three per day. Rate counting fails closed for requests |
| `MCP_API_KEY` | required for MCP on password-protected private deployments | Bearer for `/api/mcp`; without it, a private instance with `DASHBOARD_PASSWORD` refuses MCP. A keyless public demo exposes read tools, not `mark_seen`; a private instance without a password remains open |
| `APP_ORIGIN` | optional | Public HTTPS origin for webhooks, Slack links, and share cards; company newsroom monitors use it for section-change webhooks |
| `FIRECRAWL_WEBHOOK_SECRET` | required in production for monitors | Verifies the signature on monitor webhooks (Firecrawl dashboard, Advanced settings) |
| `WEBHOOK_BEARER_TOKEN` | optional | A bearer the monitor sends on top of the signature |
| `AI_GATEWAY_API_KEY` | optional | Turns on the reconcile step through the Vercel AI Gateway; needed on Vercel too, since a deployed function does not see the OIDC token in its environment |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | optional | Other reconcile providers; the first key set wins |
| `RECONCILE_MODEL` | optional | Model id; default `openai/gpt-6-luna`. Both GPT 6 Luna and GPT 5.6 Luna served the September 2026 blind read-back benchmark through a gateway Zero Data Retention provider; enforce ZDR in your gateway routing settings when required |
| `RECONCILE_MODEL_FEED`, `RECONCILE_MODEL_CORROBORATE`, `RECONCILE_MODEL_HISTORY`, `RECONCILE_MODEL_ANNOUNCEMENTS`, `RECONCILE_MODEL_REPAIR` | optional | One read-back step's own model (the feed's lanes, corroboration, history rounds, the X lane's announcements, the money repair's re-ground); unset, the step uses `RECONCILE_MODEL` |
| `DOSSIER_VERIFY_MODEL` | optional | The model that checks each deep dive's dossier against its sources before it is saved; default `RECONCILE_MODEL` when that is set (so a ZDR pin carries over), else `openai/gpt-6-sol`. With no model key at all no dossier is saved and Deep dive refuses to start |
| `RECONCILE_PROVIDER` | optional | Pick a provider when several keys are set |
| `RECONCILE` | optional | `off` skips the step |
| `PUBLICATION_AUDIT_MODEL` | optional | The publication audit's model; defaults to Claude Sonnet 5.5 on the gateway (a different family from the read-back). `PUBLICATION_AUDIT=off` turns the audit off. The gate itself is the `publication_audit` setting ([data-quality.md](data-quality.md)) |
| `TYPESAFE_API_KEY` | optional | Turns on Jev, TypeSafe AI's classifier, on search results. When researching a company's earlier rounds it ranks own announcements and articles first, skips pages that only mention a raise in passing, and never lets a funding database verify or date a round; a result it is sure states a round becomes a lead to verify. On the live feed it can only add: an article the directory-title rule alone declined is read after all when Jev is sure it announces a round, and then faces every check a kept page does; it never drops a page the rules keep (`pnpm jev-shadow` compares the two). Without it, or on any error, the rules decide alone. `pnpm eval-jev` measures it against the rules on labelled results |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | optional | Turn on Add to Slack; both come from the Slack app Settings helps you create |
| `SLACK_WEBHOOK_KEY` | required for Slack deliveries | 32+ characters that encrypt admin delivery targets and public subscription webhook URLs, and sign public manage links. Set before upgrading an existing Slack install and keep it stable ([slack.md](slack.md)) |
| `SLACK_SIGNING_SECRET` | required for Slack lifecycle events | Slack app signing secret; verifies `app_uninstalled` and `tokens_revoked` at `/api/webhooks/slack` so credentials can be deleted when Slack revokes them |
| `SLACK_SUBSCRIPTION_CAP` | optional | Live public Slack channels the instance accepts; default 500 |
| `RESEND_API_KEY`, `DIGEST_FROM` | optional | Email digests through Resend, a self-host option; both needed to send, and the public pages mention email only when both are set. Each digest carries a one-click unsubscribe link and `List-Unsubscribe` headers, signed with the Resend key |
| `EDGAR_USER_AGENT` | optional | The User-Agent the Form D lane sends to EDGAR, `your-app/version (you@example.com)` |
| `HOUSE_DOMAIN` | optional | The company the feed is built on gets a featured strip and its own mark; default `firecrawl.dev`, `off` turns it off |
| `SCHEDULE` | optional | `0` stops `pnpm start` ticking the schedule; `1` turns it on under `pnpm dev` |
| `SCHEDULE_TICK_ON_START` | optional | `1` ticks once as the in-process schedule arms, instead of waiting for the next hour |
| `CONTACT_EMAIL` | optional | The contact address `/privacy`, `/terms`, and `/support` print; unset, they show only the GitHub issues link |
| `NEXT_PUBLIC_FAVICON_FALLBACK` | optional | `off` skips the browser favicon lookup |
| `TEST_DATABASE_URL` | optional | Run the tests against a real Postgres |
| `PG_BIN` | optional | The bin directory of the PostgreSQL client `pnpm backup-db` runs (psql, pg_dump, pg_restore), such as `/opt/homebrew/opt/postgresql@18/bin`; default the ones on `PATH`. Its major must match the server's |
| `SNAPSHOT_RETENTION_DAYS` | optional | Days `pnpm prune-page-snapshots` keeps stored page snapshots; default 90 |

## Coverage

One knob in Settings picks Lite, Standard, Deep, or Max: how wide the net is, how deep each company is read, how often everything runs. Every rung is the same product; credits scale with the rung. Lite, the default, is a weekly sweep of the news for about 3.3K to 3.6K credits a month on the default preset (about 10K with all three shipped presets), and Settings prices every rung against your presets before you switch. The table and the method: [coverage.md](coverage.md).
