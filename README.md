# google-ads-api-mcp

An MCP ([Model Context Protocol](https://modelcontextprotocol.io)) server for the [Google Ads API](https://developers.google.com/google-ads/api/docs/start). Lets any MCP client — Claude, Cursor, obot, etc. — report on and manage Google Ads accounts: GAQL queries, campaign/ad group/keyword performance, search terms, budgets, pausing, negatives.

Zero Google client-library dependency: it talks to the REST endpoint directly with `fetch`, so it starts fast under `npx` and tracks new API versions with one environment variable.

## Tools

**Discover**

| Tool | Description |
|---|---|
| `list_accessible_customers` | Accounts the credentials can reach, plus the full MCC client tree |
| `account_overview` | Account details + account-wide totals for a date range |
| `gaql_fields` | Field metadata: data types, enum values, what selects with what |

**Read**

| Tool | Description |
|---|---|
| `list_campaigns` / `list_ad_groups` / `list_ads` | Structure with status, budgets, bids, RSA headlines/descriptions, policy status |
| `campaign_performance` / `ad_group_performance` | Metrics by date range, optionally segmented by date/week/month/device/network |
| `keyword_performance` | Keywords with quality score, match type, bid, metrics |
| `search_terms_report` | Real search queries with matched keyword — the negative-keyword goldmine |
| `geo_performance` | Metrics by user location |
| `gaql_search` | Any GAQL query, paginated, with micros converted |

**Write**

| Tool | Description |
|---|---|
| `set_campaign_status` / `set_ad_group_status` / `set_ad_status` | Enable or pause |
| `set_campaign_budget` | Daily budget in currency units; refuses shared budgets unless told otherwise |
| `update_keyword` | Status and/or max CPC bid |
| `add_keywords` / `add_negative_keywords` | Bulk add, campaign- or ad-group-level negatives, `validate_only` dry run |
| `remove_resource` | Remove a keyword, ad, ad group, campaign by resource name |
| `mutate` | Raw `GoogleAdsService.mutate` passthrough for everything else, with `validate_only` |

Niceties handled for you:

- **Micros → money** — `cost_micros: 3300000` comes back as `cost: 3.3`; budgets and bids are given and returned in currency units.
- **Pagination** — `gaql_search` follows page tokens until your `limit`.
- **Readable errors** — `GoogleAdsFailure` details are flattened to `ERROR_CODE — message (field: …)` plus the request id.
- **MCC aware** — set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` to a manager account and every tool can target any client under it via `customer_id`.
- **Token caching** — the refresh token is exchanged once per hour, not per call.

## Setup

You need four things from Google, all one-time:

1. **Developer token** — Google Ads → a *manager* account → Tools → API Center. A test-account token works for test accounts only; apply for Basic access for production.
2. **OAuth client** — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Desktop app). Enable the *Google Ads API* on the project.
3. **Refresh token** — run any OAuth flow for scope `https://www.googleapis.com/auth/adwords` with that client. The [official guide](https://developers.google.com/google-ads/api/docs/oauth/cloud-project) has scripts; any generic "get refresh token" helper works.
4. **Customer IDs** — the account to report on, and (if you go through an MCC) the manager account ID.

Then configure your MCP client:

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "npx",
      "args": ["-y", "google-ads-api-mcp"],
      "env": {
        "GOOGLE_ADS_DEVELOPER_TOKEN": "...",
        "GOOGLE_ADS_OAUTH_CLIENT_ID": "....apps.googleusercontent.com",
        "GOOGLE_ADS_OAUTH_CLIENT_SECRET": "...",
        "GOOGLE_ADS_REFRESH_TOKEN": "1//...",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "1234567890",
        "GOOGLE_ADS_CUSTOMER_ID": "0987654321"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | yes | From API Center in a manager account |
| `GOOGLE_ADS_OAUTH_CLIENT_ID` | yes | OAuth 2.0 client ID |
| `GOOGLE_ADS_OAUTH_CLIENT_SECRET` | yes | OAuth 2.0 client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | yes | Refresh token with the `adwords` scope |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | no | Manager (MCC) account to authenticate through; needed when the account is accessed via a manager |
| `GOOGLE_ADS_CUSTOMER_ID` | no | Default client account when a tool call omits `customer_id` |
| `GOOGLE_ADS_API_VERSION` | no | Default `v24`. Bump when Google releases a new version; versions sunset roughly yearly |

### Docker

```bash
docker build -t google-ads-api-mcp .
docker run -e GOOGLE_ADS_DEVELOPER_TOKEN=... -e GOOGLE_ADS_OAUTH_CLIENT_ID=... -e GOOGLE_ADS_OAUTH_CLIENT_SECRET=... -e GOOGLE_ADS_REFRESH_TOKEN=... google-ads-api-mcp
```

The container speaks MCP over stdio; use your platform's stdio wrapper (e.g. obot's runtime) to expose it over HTTP.

## GAQL cheatsheet

Ask the model to use `gaql_fields` when unsure, but the shape is always:

```sql
SELECT campaign.name, metrics.clicks, metrics.cost_micros
FROM campaign
WHERE segments.date DURING LAST_30_DAYS AND campaign.status = 'ENABLED'
ORDER BY metrics.cost_micros DESC
LIMIT 50
```

Useful `FROM` resources: `campaign`, `ad_group`, `ad_group_ad`, `keyword_view`, `search_term_view`, `geographic_view`, `conversion_action`, `campaign_budget`, `asset`, `change_event`, `recommendation`, `customer_client`.

## Development

```bash
npm install
npm run build
GOOGLE_ADS_DEVELOPER_TOKEN=... GOOGLE_ADS_OAUTH_CLIENT_ID=... GOOGLE_ADS_OAUTH_CLIENT_SECRET=... GOOGLE_ADS_REFRESH_TOKEN=... GOOGLE_ADS_CUSTOMER_ID=... node dist/index.js
npm run smoke   # spawns the server over stdio and exercises the read tools against your account
```

## License

MIT
