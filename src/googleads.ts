import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

/**
 * Per-request Google access token (http mode). When set, it is used as-is and the
 * refresh-token flow is skipped, so an auth proxy (e.g. Nango) owns login + refresh.
 */
export const requestToken = new AsyncLocalStorage<string>();

const BASE = "https://googleads.googleapis.com";

/** Error carrying the structured GoogleAdsFailure details so tools can surface them. */
export class GoogleAdsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
    public readonly errors?: unknown[]
  ) {
    super(message);
    this.name = "GoogleAdsError";
  }
}

// ---------------------------------------------------------------------------
// OAuth: refresh token -> short-lived access token, cached in memory.
// ---------------------------------------------------------------------------

let cached: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  const perRequest = requestToken.getStore();
  if (perRequest) return perRequest;
  if (!config.refreshToken) {
    throw new GoogleAdsError("No access token: send Authorization: Bearer <Google access token> (http mode) or set GOOGLE_ADS_REFRESH_TOKEN (stdio mode).", 401);
  }
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new GoogleAdsError(
      `OAuth token refresh failed: ${data.error ?? res.status} ${data.error_description ?? ""}`.trim(),
      res.status
    );
  }
  // Refresh a minute early so an in-flight request never hits an expired token.
  cached = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
  return cached.token;
}

// ---------------------------------------------------------------------------
// Low-level request helper.
// ---------------------------------------------------------------------------

async function request<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "developer-token": config.developerToken,
    "Content-Type": "application/json",
  };
  if (config.loginCustomerId) headers["login-customer-id"] = config.loginCustomerId;

  const res = await fetch(`${BASE}/${config.apiVersion}/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON error body (e.g. HTML 404 for an unknown API version) */
  }
  if (!res.ok) {
    const failure = json?.error?.details?.find((d: any) => Array.isArray(d.errors));
    const messages: string[] =
      failure?.errors?.map((e: any) => {
        const code = e.errorCode ? Object.values(e.errorCode).join("/") : "";
        const field = e.location?.fieldPathElements?.map((f: any) => f.fieldName).join(".");
        return [code, e.message, field ? `(field: ${field})` : ""].filter(Boolean).join(" — ");
      }) ?? [];
    const summary =
      messages.length > 0
        ? messages.join("\n")
        : json?.error?.message ?? `HTTP ${res.status}${text && !json ? " (non-JSON response — check GOOGLE_ADS_API_VERSION)" : ""}`;
    throw new GoogleAdsError(summary, res.status, failure?.requestId, failure?.errors);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Public API surface used by the tools.
// ---------------------------------------------------------------------------

export interface SearchResult {
  rows: any[];
  fieldMask?: string;
  /** True when more rows existed than `limit` allowed. */
  truncated: boolean;
}

/** Run a GAQL query, following pagination until `limit` rows are collected. */
export async function search(customerId: string, query: string, limit = 1000): Promise<SearchResult> {
  const rows: any[] = [];
  let pageToken: string | undefined;
  let fieldMask: string | undefined;
  do {
    const page = await request<{ results?: any[]; nextPageToken?: string; fieldMask?: string }>(
      `customers/${customerId}/googleAds:search`,
      { query, pageToken }
    );
    fieldMask ??= page.fieldMask;
    for (const r of page.results ?? []) {
      if (rows.length >= limit) return { rows, fieldMask, truncated: true };
      rows.push(r);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { rows, fieldMask, truncated: false };
}

export interface MutateOptions {
  validateOnly?: boolean;
  partialFailure?: boolean;
}

/** Apply mutate operations atomically (unless partialFailure). Operations use the REST field names, e.g. `{ campaignOperation: { update, updateMask } }`. */
export async function mutate(customerId: string, operations: unknown[], opts: MutateOptions = {}) {
  return request<{ mutateOperationResponses?: any[]; partialFailureError?: unknown }>(
    `customers/${customerId}/googleAds:mutate`,
    {
      mutateOperations: operations,
      validateOnly: opts.validateOnly ?? false,
      partialFailure: opts.partialFailure ?? false,
    }
  );
}

/** Query the GoogleAdsFieldService for GAQL field metadata. */
export async function searchFields(query: string, pageSize = 200) {
  const res = await request<{ results?: any[]; totalResultsCount?: string }>("googleAdsFields:search", {
    query,
    pageSize,
  });
  return { fields: res.results ?? [], total: Number(res.totalResultsCount ?? 0) };
}

/** Customer IDs directly accessible by the OAuth user (not the MCC tree). */
export async function listAccessibleCustomers(): Promise<string[]> {
  const res = await request<{ resourceNames?: string[] }>("customers:listAccessibleCustomers", undefined, "GET");
  return (res.resourceNames ?? []).map((r) => r.replace("customers/", ""));
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

export function toMicros(units: number): string {
  return String(Math.round(units * 1_000_000));
}

/** Metric names that are micros but do not end in "Micros". */
const MICRO_METRICS = new Set([
  "averageCpc",
  "averageCpm",
  "averageCpv",
  "averageCpe",
  "averageCost",
  "costPerConversion",
  "costPerAllConversions",
  "costPerCurrentModelAttributedConversion",
  "activeViewCpm",
]);

/**
 * Convert micros to currency units throughout a result tree:
 * `costMicros: "3300000"` becomes `cost: 3.3`, `averageCpc: "410000"` becomes `averageCpc: 0.41`.
 */
export function convertMicros<T>(value: T): T {
  if (Array.isArray(value)) return value.map(convertMicros) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const numeric = typeof v === "string" || typeof v === "number";
      if (k.endsWith("Micros") && numeric) out[k.slice(0, -"Micros".length)] = Number(v) / 1_000_000;
      else if (MICRO_METRICS.has(k) && numeric) out[k] = Number(v) / 1_000_000;
      else if (k === "metrics" && v && typeof v === "object") out[k] = convertMetrics(v as Record<string, unknown>);
      else out[k] = convertMicros(v);
    }
    return out as T;
  }
  return value;
}

/** Inside a metrics object, int64 counters arrive as strings ("42"); make them numbers and convert micros. */
function convertMetrics(metrics: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metrics)) {
    const numeric = typeof v === "string" || typeof v === "number";
    if (k.endsWith("Micros") && numeric) out[k.slice(0, -"Micros".length)] = Number(v) / 1_000_000;
    else if (MICRO_METRICS.has(k) && numeric) out[k] = Number(v) / 1_000_000;
    else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

/** Quote a GAQL string literal. */
export function gaqlString(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
