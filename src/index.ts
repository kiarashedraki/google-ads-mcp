#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config, resolveCustomerId, transportMode } from "./config.js";
import {
  GoogleAdsError,
  convertMicros,
  gaqlString,
  listAccessibleCustomers,
  mutate,
  requestToken,
  search,
  searchFields,
  toMicros,
} from "./googleads.js";

const VERSION = "0.2.0";

/** Build a server with every tool registered. stdio uses one; http builds one per request (stateless). */
function createServer(): McpServer {
const server = new McpServer({ name: "google-ads-api-mcp", version: VERSION });

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown): ToolResult {
  let message: string;
  if (e instanceof GoogleAdsError) {
    message = e.message + (e.requestId ? `\n(request id: ${e.requestId})` : "");
  } else if (e instanceof Error) {
    message = e.message;
  } else {
    message = typeof e === "object" && e !== null ? JSON.stringify(e) : String(e);
  }
  return { content: [{ type: "text", text: `Google Ads API error: ${message}` }], isError: true };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------------------------------------------------------------------------
// Shared schemas and GAQL builders.
// ---------------------------------------------------------------------------

const customerIdSchema = z
  .string()
  .optional()
  .describe("Google Ads customer ID (10 digits, dashes allowed). Defaults to GOOGLE_ADS_CUSTOMER_ID.");

const limitSchema = z.number().int().min(1).max(10000).default(500).describe("Max rows to return");

const DATE_RANGES = [
  "TODAY",
  "YESTERDAY",
  "LAST_7_DAYS",
  "LAST_14_DAYS",
  "LAST_30_DAYS",
  "THIS_WEEK_SUN_TODAY",
  "THIS_WEEK_MON_TODAY",
  "LAST_WEEK_SUN_SAT",
  "LAST_WEEK_MON_SUN",
  "LAST_BUSINESS_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "ALL_TIME",
] as const;

const dateSchema = {
  date_range: z
    .enum(DATE_RANGES)
    .default("LAST_30_DAYS")
    .describe("Preset date range. Ignored when start_date and end_date are both given. ALL_TIME applies no date filter."),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom range start, YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Custom range end, YYYY-MM-DD"),
};

type DateArgs = { date_range: (typeof DATE_RANGES)[number]; start_date?: string; end_date?: string };

/** GAQL date predicate for a date-range argument set; empty string for ALL_TIME. */
function dateClause({ date_range, start_date, end_date }: DateArgs): string {
  if (start_date && end_date) return `segments.date BETWEEN ${gaqlString(start_date)} AND ${gaqlString(end_date)}`;
  if (date_range === "ALL_TIME") return "";
  return `segments.date DURING ${date_range}`;
}

const SEGMENTS = ["none", "date", "week", "month", "device", "network"] as const;
const segmentSchema = z
  .enum(SEGMENTS)
  .default("none")
  .describe("Break rows down by a segment (date, week, month, device, network) or return totals");

const SEGMENT_FIELD: Record<(typeof SEGMENTS)[number], string | null> = {
  none: null,
  date: "segments.date",
  week: "segments.week",
  month: "segments.month",
  device: "segments.device",
  network: "segments.ad_network_type",
};

const METRICS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.ctr",
  "metrics.average_cpc",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.cost_per_conversion",
  "metrics.all_conversions",
];

function where(...clauses: (string | number | false | undefined | "")[]): string {
  const c = clauses.filter((x): x is string => typeof x === "string" && x.length > 0);
  return c.length ? ` WHERE ${c.join(" AND ")}` : "";
}

/** Build and run a reporting query, returning converted rows and a note when truncated. */
async function report(customerId: string, fields: string[], from: string, whereClause: string, orderBy: string, limit: number) {
  const query = `SELECT ${fields.join(", ")} FROM ${from}${whereClause}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit}`;
  const res = await search(customerId, query, limit);
  return {
    customer_id: customerId,
    row_count: res.rows.length,
    ...(res.truncated ? { truncated: true, note: `More rows exist; raise limit or narrow the query.` } : {}),
    rows: convertMicros(res.rows),
    query,
  };
}

// ---------------------------------------------------------------------------
// Account discovery.
// ---------------------------------------------------------------------------

server.registerTool(
  "list_accessible_customers",
  {
    title: "List accessible customers",
    description:
      "List the Google Ads accounts reachable with the configured credentials: the accounts the OAuth user can access directly, plus the full client tree under GOOGLE_ADS_LOGIN_CUSTOMER_ID when it is a manager (MCC). Use this to find a customer_id.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const direct = await listAccessibleCustomers();
      let tree: any[] = [];
      if (config.loginCustomerId) {
        const res = await search(
          config.loginCustomerId,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.level, customer_client.manager, customer_client.status, customer_client.currency_code, customer_client.time_zone, customer_client.test_account FROM customer_client ORDER BY customer_client.level",
          500
        );
        tree = res.rows.map((r: any) => r.customerClient);
      }
      return ok({
        login_customer_id: config.loginCustomerId ?? null,
        default_customer_id: config.defaultCustomerId ?? null,
        directly_accessible: direct,
        manager_tree: tree,
      });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "account_overview",
  {
    title: "Account overview",
    description:
      "Account details (name, currency, time zone, auto-tagging, status) plus account-wide totals for the date range: impressions, clicks, cost, conversions.",
    inputSchema: { customer_id: customerIdSchema, ...dateSchema },
    annotations: READ,
  },
  async ({ customer_id, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const details = await search(
        cid,
        "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.auto_tagging_enabled, customer.status, customer.optimization_score FROM customer",
        1
      );
      const totals = await search(cid, `SELECT ${METRICS.join(", ")} FROM customer${where(dateClause(dates))}`, 1);
      const campaigns = await search(
        cid,
        "SELECT campaign.status FROM campaign WHERE campaign.status != 'REMOVED'",
        1000
      );
      const byStatus: Record<string, number> = {};
      for (const r of campaigns.rows) byStatus[r.campaign.status] = (byStatus[r.campaign.status] ?? 0) + 1;
      return ok({
        customer: convertMicros(details.rows[0]?.customer ?? {}),
        date_range: dateClause(dates) || "ALL_TIME",
        totals: convertMicros(totals.rows[0]?.metrics ?? {}),
        campaigns_by_status: byStatus,
      });
    } catch (e) {
      return err(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Structure: campaigns, ad groups, ads.
// ---------------------------------------------------------------------------

server.registerTool(
  "list_campaigns",
  {
    title: "List campaigns",
    description:
      "List campaigns with status, channel type, bidding strategy, daily budget (currency units), schedule and serving status. No metrics; use campaign_performance for those.",
    inputSchema: {
      customer_id: customerIdSchema,
      include_removed: z.boolean().default(false),
      status: z.enum(["ENABLED", "PAUSED"]).optional().describe("Only campaigns with this status"),
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, include_removed, status, limit }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "campaign.status",
            "campaign.serving_status",
            "campaign.advertising_channel_type",
            "campaign.bidding_strategy_type",
            "campaign.start_date_time",
            "campaign.end_date_time",
            "campaign.campaign_budget",
            "campaign_budget.amount_micros",
            "campaign_budget.explicitly_shared",
            "campaign.optimization_score",
          ],
          "campaign",
          where(!include_removed && "campaign.status != 'REMOVED'", status && `campaign.status = '${status}'`),
          "campaign.name",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "list_ad_groups",
  {
    title: "List ad groups",
    description: "List ad groups (id, name, status, type, default CPC bid) with their campaign. Optionally filter to one campaign.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      include_removed: z.boolean().default(false),
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, include_removed, limit }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          ["campaign.id", "campaign.name", "ad_group.id", "ad_group.name", "ad_group.status", "ad_group.type", "ad_group.cpc_bid_micros"],
          "ad_group",
          where(!include_removed && "ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'", campaign_id && `campaign.id = ${Number(campaign_id)}`),
          "campaign.name, ad_group.name",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "list_ads",
  {
    title: "List ads",
    description:
      "List ads with type, status, policy approval, ad strength, final URLs and — for responsive search ads — all headlines and descriptions with pinning. Filter by campaign or ad group.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      include_removed: z.boolean().default(false),
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, ad_group_id, include_removed, limit }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "ad_group.id",
            "ad_group.name",
            "ad_group_ad.ad.id",
            "ad_group_ad.ad.name",
            "ad_group_ad.ad.type",
            "ad_group_ad.status",
            "ad_group_ad.policy_summary.approval_status",
            "ad_group_ad.policy_summary.review_status",
            "ad_group_ad.ad_strength",
            "ad_group_ad.ad.final_urls",
            "ad_group_ad.ad.responsive_search_ad.headlines",
            "ad_group_ad.ad.responsive_search_ad.descriptions",
            "ad_group_ad.ad.responsive_search_ad.path1",
            "ad_group_ad.ad.responsive_search_ad.path2",
          ],
          "ad_group_ad",
          where(
            !include_removed && "ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'",
            campaign_id && `campaign.id = ${Number(campaign_id)}`,
            ad_group_id && `ad_group.id = ${Number(ad_group_id)}`
          ),
          "campaign.name, ad_group.name",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Performance reports.
// ---------------------------------------------------------------------------

server.registerTool(
  "campaign_performance",
  {
    title: "Campaign performance",
    description:
      "Per-campaign metrics for a date range: impressions, clicks, CTR, avg CPC, cost, conversions, conversion value, cost/conv, plus search impression share. Optionally segment by date/week/month/device/network. Money is in account currency units.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_ids: z.array(z.string()).optional().describe("Restrict to these campaign IDs"),
      include_removed: z.boolean().default(false),
      segment: segmentSchema,
      ...dateSchema,
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_ids, include_removed, segment, limit, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const seg = SEGMENT_FIELD[segment];
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "campaign.status",
            "campaign.advertising_channel_type",
            "campaign_budget.amount_micros",
            ...(seg ? [seg] : []),
            ...METRICS,
            "metrics.search_impression_share",
            "metrics.search_budget_lost_impression_share",
            "metrics.search_rank_lost_impression_share",
          ],
          "campaign",
          where(
            dateClause(dates),
            !include_removed && "campaign.status != 'REMOVED'",
            campaign_ids?.length && `campaign.id IN (${campaign_ids.map(Number).join(", ")})`
          ),
          seg ? `${seg}, metrics.cost_micros DESC` : "metrics.cost_micros DESC",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "ad_group_performance",
  {
    title: "Ad group performance",
    description: "Per-ad-group metrics for a date range, optionally filtered to a campaign and segmented.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      include_removed: z.boolean().default(false),
      segment: segmentSchema,
      ...dateSchema,
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, include_removed, segment, limit, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const seg = SEGMENT_FIELD[segment];
      return ok(
        await report(
          cid,
          ["campaign.id", "campaign.name", "ad_group.id", "ad_group.name", "ad_group.status", ...(seg ? [seg] : []), ...METRICS],
          "ad_group",
          where(
            dateClause(dates),
            !include_removed && "ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'",
            campaign_id && `campaign.id = ${Number(campaign_id)}`
          ),
          seg ? `${seg}, metrics.cost_micros DESC` : "metrics.cost_micros DESC",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "keyword_performance",
  {
    title: "Keyword performance",
    description:
      "Per-keyword metrics for a date range with match type, status, quality score and effective CPC bid. Filter by campaign or ad group. Sorted by cost.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      include_removed: z.boolean().default(false),
      ...dateSchema,
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, ad_group_id, include_removed, limit, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "ad_group.id",
            "ad_group.name",
            "ad_group_criterion.criterion_id",
            "ad_group_criterion.keyword.text",
            "ad_group_criterion.keyword.match_type",
            "ad_group_criterion.status",
            "ad_group_criterion.quality_info.quality_score",
            "ad_group_criterion.effective_cpc_bid_micros",
            ...METRICS,
          ],
          "keyword_view",
          where(
            dateClause(dates),
            !include_removed && "ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'",
            campaign_id && `campaign.id = ${Number(campaign_id)}`,
            ad_group_id && `ad_group.id = ${Number(ad_group_id)}`
          ),
          "metrics.cost_micros DESC, metrics.impressions DESC",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "search_terms_report",
  {
    title: "Search terms report",
    description:
      "Actual search queries that triggered your ads, with the matching keyword, status (ADDED/EXCLUDED/NONE) and metrics. The main source for finding negative keywords to add. Sorted by impressions.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      ad_group_id: z.string().optional(),
      min_impressions: z.number().int().min(0).default(0),
      ...dateSchema,
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, ad_group_id, min_impressions, limit, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "ad_group.id",
            "ad_group.name",
            "search_term_view.search_term",
            "search_term_view.status",
            "segments.keyword.info.text",
            "segments.keyword.info.match_type",
            "segments.search_term_match_type",
            ...METRICS,
          ],
          "search_term_view",
          where(
            dateClause(dates),
            campaign_id && `campaign.id = ${Number(campaign_id)}`,
            ad_group_id && `ad_group.id = ${Number(ad_group_id)}`,
            min_impressions > 0 && `metrics.impressions >= ${min_impressions}`
          ),
          "metrics.impressions DESC",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "geo_performance",
  {
    title: "Geographic performance",
    description:
      "Metrics by user location for a date range (country/region/city geo target constants). Resolve the constant names with gaql_search on geo_target_constant if needed.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional(),
      ...dateSchema,
      limit: limitSchema,
    },
    annotations: READ,
  },
  async ({ customer_id, campaign_id, limit, ...dates }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      return ok(
        await report(
          cid,
          [
            "campaign.id",
            "campaign.name",
            "geographic_view.country_criterion_id",
            "geographic_view.location_type",
            "segments.geo_target_city",
            "segments.geo_target_region",
            ...METRICS,
          ],
          "geographic_view",
          where(dateClause(dates), campaign_id && `campaign.id = ${Number(campaign_id)}`),
          "metrics.impressions DESC",
          limit
        )
      );
    } catch (e) {
      return err(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Raw GAQL + field metadata.
// ---------------------------------------------------------------------------

server.registerTool(
  "gaql_search",
  {
    title: "Run GAQL query",
    description:
      "Run any Google Ads Query Language (GAQL) query against a customer. Use for anything the specific report tools do not cover (assets, conversion actions, change history, bidding strategies, audiences, geo targets, budgets, recommendations…). Pagination is handled; rows are capped by limit. Money fields are converted from micros unless convert_micros is false. Use gaql_fields to discover selectable fields.",
    inputSchema: {
      customer_id: customerIdSchema,
      query: z.string().describe("GAQL, e.g. SELECT campaign.id, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS"),
      limit: limitSchema,
      convert_micros: z.boolean().default(true),
    },
    annotations: READ,
  },
  async ({ customer_id, query, limit, convert_micros }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const res = await search(cid, query, limit);
      return ok({
        customer_id: cid,
        row_count: res.rows.length,
        truncated: res.truncated,
        field_mask: res.fieldMask,
        rows: convert_micros ? convertMicros(res.rows) : res.rows,
      });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "gaql_fields",
  {
    title: "GAQL field metadata",
    description:
      "Look up GAQL fields, resources, segments and metrics: data type, whether selectable/filterable/sortable, enum values, and which resources they can be selected with. Use name_like with SQL wildcards (e.g. 'campaign.%' for every campaign field, 'metrics.%conversion%').",
    inputSchema: {
      name_like: z.string().describe("LIKE pattern on the field name, e.g. 'ad_group_criterion.keyword.%'"),
      category: z.enum(["RESOURCE", "ATTRIBUTE", "SEGMENT", "METRIC"]).optional(),
      selectable_only: z.boolean().default(true),
      limit: z.number().int().min(1).max(500).default(100),
    },
    annotations: READ,
  },
  async ({ name_like, category, selectable_only, limit }) => {
    try {
      const clauses = [`name LIKE ${gaqlString(name_like)}`];
      if (category) clauses.push(`category = ${gaqlString(category)}`);
      if (selectable_only) clauses.push("selectable = true");
      const res = await searchFields(
        `SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, type_url, enum_values, selectable_with WHERE ${clauses.join(" AND ")}`,
        limit
      );
      return ok({
        total_matching: res.total,
        fields: res.fields.map((f: any) => ({
          name: f.name,
          category: f.category,
          data_type: f.dataType,
          selectable: f.selectable,
          filterable: f.filterable,
          sortable: f.sortable,
          repeated: f.isRepeated,
          enum_values: f.enumValues,
          // Trim the (often huge) compatibility list to resources only.
          selectable_with_resources: f.selectableWith?.filter((s: string) => !s.includes(".")),
        })),
      });
    } catch (e) {
      return err(e);
    }
  }
);

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

const statusSchema = z.enum(["ENABLED", "PAUSED"]);
const matchTypeSchema = z.enum(["EXACT", "PHRASE", "BROAD"]);

server.registerTool(
  "set_campaign_status",
  {
    title: "Enable or pause campaign",
    description: "Set a campaign to ENABLED or PAUSED.",
    inputSchema: { customer_id: customerIdSchema, campaign_id: z.string(), status: statusSchema },
    annotations: WRITE,
  },
  async ({ customer_id, campaign_id, status }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const res = await mutate(cid, [
        { campaignOperation: { update: { resourceName: `customers/${cid}/campaigns/${Number(campaign_id)}`, status }, updateMask: "status" } },
      ]);
      return ok({ updated: res.mutateOperationResponses?.[0], status });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "set_campaign_budget",
  {
    title: "Set campaign daily budget",
    description:
      "Change a campaign's daily budget, given in account currency units (e.g. 5.50). Looks up the campaign's budget resource first. Refuses to change a shared budget unless allow_shared is true, since that affects every campaign using it.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string(),
      daily_amount: z.number().positive().describe("New daily budget in currency units"),
      allow_shared: z.boolean().default(false),
    },
    annotations: WRITE,
  },
  async ({ customer_id, campaign_id, daily_amount, allow_shared }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const cur = await search(
        cid,
        `SELECT campaign.name, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${Number(campaign_id)}`,
        1
      );
      const row = cur.rows[0];
      if (!row) return err(new Error(`Campaign ${campaign_id} not found in customer ${cid}`));
      if (row.campaignBudget?.explicitlyShared && !allow_shared) {
        return err(new Error(`Campaign "${row.campaign.name}" uses a shared budget (${row.campaign.campaignBudget}). Pass allow_shared: true to change it for all campaigns sharing it.`));
      }
      const res = await mutate(cid, [
        {
          campaignBudgetOperation: {
            update: { resourceName: row.campaign.campaignBudget, amountMicros: toMicros(daily_amount) },
            updateMask: "amount_micros",
          },
        },
      ]);
      return ok({
        campaign: row.campaign.name,
        budget: row.campaign.campaignBudget,
        previous_daily_amount: Number(row.campaignBudget?.amountMicros ?? 0) / 1e6,
        new_daily_amount: daily_amount,
        result: res.mutateOperationResponses?.[0],
      });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "set_ad_group_status",
  {
    title: "Enable or pause ad group",
    description: "Set an ad group to ENABLED or PAUSED.",
    inputSchema: { customer_id: customerIdSchema, ad_group_id: z.string(), status: statusSchema },
    annotations: WRITE,
  },
  async ({ customer_id, ad_group_id, status }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const res = await mutate(cid, [
        { adGroupOperation: { update: { resourceName: `customers/${cid}/adGroups/${Number(ad_group_id)}`, status }, updateMask: "status" } },
      ]);
      return ok({ updated: res.mutateOperationResponses?.[0], status });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "set_ad_status",
  {
    title: "Enable or pause ad",
    description: "Set an ad (within its ad group) to ENABLED or PAUSED.",
    inputSchema: { customer_id: customerIdSchema, ad_group_id: z.string(), ad_id: z.string(), status: statusSchema },
    annotations: WRITE,
  },
  async ({ customer_id, ad_group_id, ad_id, status }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const res = await mutate(cid, [
        {
          adGroupAdOperation: {
            update: { resourceName: `customers/${cid}/adGroupAds/${Number(ad_group_id)}~${Number(ad_id)}`, status },
            updateMask: "status",
          },
        },
      ]);
      return ok({ updated: res.mutateOperationResponses?.[0], status });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "update_keyword",
  {
    title: "Update keyword",
    description:
      "Change a keyword's status (ENABLED/PAUSED) and/or its max CPC bid (currency units). Identify the keyword by ad_group_id and criterion_id from keyword_performance.",
    inputSchema: {
      customer_id: customerIdSchema,
      ad_group_id: z.string(),
      criterion_id: z.string(),
      status: statusSchema.optional(),
      cpc_bid: z.number().positive().optional().describe("New max CPC bid in currency units"),
    },
    annotations: WRITE,
  },
  async ({ customer_id, ad_group_id, criterion_id, status, cpc_bid }) => {
    try {
      if (!status && cpc_bid === undefined) return err(new Error("Provide status and/or cpc_bid"));
      const cid = resolveCustomerId(customer_id);
      const update: Record<string, unknown> = {
        resourceName: `customers/${cid}/adGroupCriteria/${Number(ad_group_id)}~${Number(criterion_id)}`,
      };
      const mask: string[] = [];
      if (status) (update.status = status), mask.push("status");
      if (cpc_bid !== undefined) (update.cpcBidMicros = toMicros(cpc_bid)), mask.push("cpc_bid_micros");
      const res = await mutate(cid, [{ adGroupCriterionOperation: { update, updateMask: mask.join(",") } }]);
      return ok({ updated: res.mutateOperationResponses?.[0], status, cpc_bid });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "add_keywords",
  {
    title: "Add keywords",
    description:
      "Add keywords to an ad group. Each keyword has text, match type and an optional max CPC bid (currency units). Set validate_only to check for policy/duplicate errors without saving.",
    inputSchema: {
      customer_id: customerIdSchema,
      ad_group_id: z.string(),
      keywords: z
        .array(
          z.object({
            text: z.string(),
            match_type: matchTypeSchema.default("PHRASE"),
            cpc_bid: z.number().positive().optional(),
          })
        )
        .min(1)
        .max(1000),
      status: statusSchema.default("ENABLED"),
      validate_only: z.boolean().default(false),
    },
    annotations: WRITE,
  },
  async ({ customer_id, ad_group_id, keywords, status, validate_only }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const ops = keywords.map((k) => ({
        adGroupCriterionOperation: {
          create: {
            adGroup: `customers/${cid}/adGroups/${Number(ad_group_id)}`,
            status,
            keyword: { text: k.text, matchType: k.match_type },
            ...(k.cpc_bid !== undefined ? { cpcBidMicros: toMicros(k.cpc_bid) } : {}),
          },
        },
      }));
      const res = await mutate(cid, ops, { validateOnly: validate_only, partialFailure: !validate_only });
      return ok({
        validate_only,
        created: res.mutateOperationResponses?.map((r: any) => r.adGroupCriterionResult?.resourceName).filter(Boolean),
        partial_failure_error: res.partialFailureError,
      });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "add_negative_keywords",
  {
    title: "Add negative keywords",
    description:
      "Add negative keywords at campaign level (default) or ad group level. Typical follow-up to search_terms_report. Negatives at campaign level block the term for every ad group in the campaign.",
    inputSchema: {
      customer_id: customerIdSchema,
      campaign_id: z.string().optional().describe("Campaign for campaign-level negatives"),
      ad_group_id: z.string().optional().describe("Ad group for ad-group-level negatives (use instead of campaign_id)"),
      keywords: z
        .array(z.object({ text: z.string(), match_type: matchTypeSchema.default("PHRASE") }))
        .min(1)
        .max(1000),
      validate_only: z.boolean().default(false),
    },
    annotations: WRITE,
  },
  async ({ customer_id, campaign_id, ad_group_id, keywords, validate_only }) => {
    try {
      if (!campaign_id && !ad_group_id) return err(new Error("Provide campaign_id or ad_group_id"));
      const cid = resolveCustomerId(customer_id);
      const ops = keywords.map((k) =>
        ad_group_id
          ? {
              adGroupCriterionOperation: {
                create: {
                  adGroup: `customers/${cid}/adGroups/${Number(ad_group_id)}`,
                  negative: true,
                  keyword: { text: k.text, matchType: k.match_type },
                },
              },
            }
          : {
              campaignCriterionOperation: {
                create: {
                  campaign: `customers/${cid}/campaigns/${Number(campaign_id)}`,
                  negative: true,
                  keyword: { text: k.text, matchType: k.match_type },
                },
              },
            }
      );
      const res = await mutate(cid, ops, { validateOnly: validate_only, partialFailure: !validate_only });
      return ok({
        validate_only,
        level: ad_group_id ? "ad_group" : "campaign",
        created: res.mutateOperationResponses
          ?.map((r: any) => r.campaignCriterionResult?.resourceName ?? r.adGroupCriterionResult?.resourceName)
          .filter(Boolean),
        partial_failure_error: res.partialFailureError,
      });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "remove_resource",
  {
    title: "Remove resource",
    description:
      "Remove (soft-delete) a keyword, negative keyword, ad, ad group or campaign by its resource name (e.g. customers/123/adGroupCriteria/456~789). Removal is permanent in Google Ads; removed entities stay visible in reports with status REMOVED.",
    inputSchema: {
      customer_id: customerIdSchema,
      resource_name: z.string().describe("Full resource name as returned by other tools"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ customer_id, resource_name }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const kind = resource_name.split("/")[2];
      const opKey: Record<string, string> = {
        adGroupCriteria: "adGroupCriterionOperation",
        campaignCriteria: "campaignCriterionOperation",
        adGroupAds: "adGroupAdOperation",
        adGroups: "adGroupOperation",
        campaigns: "campaignOperation",
        campaignBudgets: "campaignBudgetOperation",
      };
      const key = opKey[kind];
      if (!key) return err(new Error(`Unsupported resource type "${kind}". Use the mutate tool for other types.`));
      const res = await mutate(cid, [{ [key]: { remove: resource_name } }]);
      return ok({ removed: res.mutateOperationResponses?.[0] });
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "mutate",
  {
    title: "Raw mutate",
    description:
      "Advanced: send raw GoogleAdsService.mutate operations using REST field names (camelCase), e.g. [{ campaignOperation: { update: { resourceName, status }, updateMask: 'status' } }]. Supports every resource the API can create/update/remove (campaigns, ads, assets, conversion actions, extensions…). Use validate_only: true first to dry-run. Operations are atomic unless partial_failure is true.",
    inputSchema: {
      customer_id: customerIdSchema,
      operations: z.array(z.record(z.unknown())).min(1).max(5000),
      validate_only: z.boolean().default(false),
      partial_failure: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ customer_id, operations, validate_only, partial_failure }) => {
    try {
      const cid = resolveCustomerId(customer_id);
      const res = await mutate(cid, operations, { validateOnly: validate_only, partialFailure: partial_failure });
      return ok({ validate_only, ...res });
    } catch (e) {
      return err(e);
    }
  }
);

return server;
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

const describe = `api ${config.apiVersion}, login ${config.loginCustomerId ?? "-"}, default customer ${config.defaultCustomerId ?? "-"}`;

if (transportMode === "stdio") {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`google-ads-api-mcp ${VERSION} connected over stdio (${describe})`);
} else {
  // Stateless Streamable HTTP. Every request must carry `Authorization: Bearer <Google access token>`
  // with the adwords scope; it is used for that request only (an auth proxy such as Nango refreshes it).
  const PORT = Number(process.env.PORT || 8000);
  const HOST = process.env.HOST || "0.0.0.0";
  const MCP_PATH = process.env.MCP_PATH || "/mcp";
  const MAX_BODY_BYTES = 1_000_000;

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : undefined;
  };

  const httpServer = http.createServer(async (req, res) => {
    const path = (req.url || "/").split("?")[0];
    if (path === "/health" || path === "/healthz") return send(res, 200, { ok: true, version: VERSION });
    if (path !== MCP_PATH) return send(res, 404, { error: "not found" });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { Allow: "POST" });

    const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization || "").trim());
    if (!m) {
      return send(res, 401, { error: "missing Authorization: Bearer <Google access token>" }, { "WWW-Authenticate": "Bearer" });
    }
    const token = m[1].trim();

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null });
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await requestToken.run(token, () => transport.handleRequest(req, res, body));
    } catch (e) {
      if (!res.headersSent) send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`google-ads-api-mcp ${VERSION} listening on http://${HOST}:${PORT}${MCP_PATH} (${describe})`);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => httpServer.close(() => process.exit(0)));
  }
}
