// Smoke test: spawn the built server over stdio, list tools, call a few read-only ones.
// Usage: set the GOOGLE_ADS_* env vars (or `set -a; . ../innovate-hub/infra/google-ads-mcp/.env`) then `npm run smoke`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ${JSON.stringify(args)} ${res.isError ? "[ERROR]" : ""}\n${text.slice(0, 900)}${text.length > 900 ? "\n…" : ""}`);
  return res;
}

await call("list_accessible_customers");
await call("account_overview", { date_range: "LAST_30_DAYS" });
await call("list_campaigns");
await call("campaign_performance", { date_range: "LAST_7_DAYS" });
await call("keyword_performance", { date_range: "LAST_30_DAYS", limit: 5 });
await call("search_terms_report", { date_range: "LAST_30_DAYS", limit: 5 });
await call("list_ads", { limit: 3 });
await call("gaql_fields", { name_like: "campaign.bidding%" });
await call("gaql_search", { query: "SELECT campaign.id, campaign.name FROM campaign LIMIT 2" });
// A bad query must return a readable error, not a crash.
await call("gaql_search", { query: "SELECT nope.field FROM campaign" });
// validate_only mutate: exercises the mutate path without changing anything.
await call("mutate", { operations: [{ campaignOperation: { update: { resourceName: "customers/0/campaigns/0", status: "PAUSED" }, updateMask: "status" } }], validate_only: true });

await client.close();
