/** Strip dashes/spaces from a Google Ads customer ID ("123-456-7890" -> "1234567890"). */
export function normalizeCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, "");
}

function required(name: string, hint: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name} (${hint})`);
    process.exit(1);
  }
  return v;
}

function optionalCustomerId(name: string): string | undefined {
  const v = process.env[name];
  return v ? normalizeCustomerId(v) : undefined;
}

export const config = {
  developerToken: required("GOOGLE_ADS_DEVELOPER_TOKEN", "from API Center in a manager account"),
  clientId: required("GOOGLE_ADS_OAUTH_CLIENT_ID", "OAuth 2.0 client ID from Google Cloud"),
  clientSecret: required("GOOGLE_ADS_OAUTH_CLIENT_SECRET", "OAuth 2.0 client secret"),
  refreshToken: required("GOOGLE_ADS_REFRESH_TOKEN", "refresh token with the adwords scope"),
  /** Manager (MCC) account to authenticate through; sent as the login-customer-id header. */
  loginCustomerId: optionalCustomerId("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
  /** Default client account for tools when customer_id is not passed. */
  defaultCustomerId: optionalCustomerId("GOOGLE_ADS_CUSTOMER_ID"),
  apiVersion: process.env.GOOGLE_ADS_API_VERSION ?? "v24",
};

/** Resolve the customer ID for a tool call: explicit arg wins, then the env default. */
export function resolveCustomerId(explicit?: string): string {
  const id = explicit ? normalizeCustomerId(explicit) : config.defaultCustomerId;
  if (!id) {
    throw new Error(
      "No customer_id given and GOOGLE_ADS_CUSTOMER_ID is not set. Pass customer_id or use list_accessible_customers to find one."
    );
  }
  return id;
}
