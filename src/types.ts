// ProbeOps API Types
// These match the backend FastAPI response schemas

// ── Common Types ──────────────────────────────────────────────

export interface RegionResult {
  region: string;
  location?: string;
  flag_emoji?: string;
  success: boolean;
  response_time_ms: number;
  error: string | null;
  result?: {
    output: string;
    command?: string;
  };
}

export interface LockedRegion {
  region: string;
  location?: string;
  flag_emoji?: string;
}

export interface RegionInfo {
  region: string;
  location: string;
  country: string;
  flag_emoji: string;
}

// ── SSL Check ─────────────────────────────────────────────────

export interface SslCheckRequest {
  domain: string;
}

export interface CertificateInfo {
  is_valid: boolean;
  is_expired: boolean;
  days_until_expiry: number;
  valid_from: string;
  valid_until: string;
  subject: {
    common_name: string;
    organization?: string;
  };
  issuer: {
    common_name: string;
    organization?: string;
    country?: string;
  };
  sans: string[];
  sans_truncated: boolean;
  hostname_match: boolean;
  cipher: {
    name: string;
    version: string;
    bits: number;
  };
  serial_number: string;
  fingerprint: string;
}

export interface SslCheckResponse {
  domain: string;
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  certificate: CertificateInfo | null;
  region_certificates: Array<{
    region: string;
    certificate: CertificateInfo;
  }>;
  certificates_consistent: boolean;
  inconsistency_details: string | null;
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── DNS Lookup ────────────────────────────────────────────────

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SOA' | 'CAA' | 'PTR';

export interface DnsLookupRequest {
  domain: string;
  record_type?: DnsRecordType;
}

export interface DnsLookupResponse {
  domain: string;
  record_type: string;
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── Is It Down ────────────────────────────────────────────────

export interface IsItDownRequest {
  url: string;
}

export interface IsItDownResponse {
  url: string;
  global_status: 'up' | 'down' | 'partial';
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── Latency Test ──────────────────────────────────────────────

export interface LatencyTestRequest {
  target: string;
}

export interface LatencyTestResponse {
  target: string;
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  average_latency_ms?: number;
  min_latency_ms?: number;
  max_latency_ms?: number;
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── Traceroute ────────────────────────────────────────────────

export type TracerouteProtocol = 'tcp' | 'udp' | 'icmp';

export interface TracerouteRequest {
  target: string;
  protocol?: TracerouteProtocol;
}

export interface TracerouteResponse {
  target: string;
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── Port Check ────────────────────────────────────────────────

export interface PortCheckRequest {
  target: string;
  port: number;
}

export interface PortCheckResponse {
  target: string;
  port: number;
  regions_checked: RegionResult[];
  regions_locked: LockedRegion[];
  global_status: 'open' | 'closed' | 'filtered';
  is_authenticated: boolean;
  execution_time_ms: number;
  checked_at: string;
}

// ── Geo Proxy ─────────────────────────────────────────────────

export interface GeoProxyRequest {
  region: string;
  expires_in_hours?: number;
  label?: string;
}

export interface GeoProxyTierLimits {
  session_duration_minutes: number;
  data_transfer_mb: number;
  concurrent_tabs: number;
  requests_per_hour: number;
  max_active_tokens: number;
  max_token_ttl_hours: number;
}

export interface GeoProxyDailyUsage {
  consumed: number;
  quota: number;
  resets_at: string;
}

export interface GeoProxyResponse {
  token_id: string;
  jwt_token: string;
  region: string;
  probe_node_id: number | null;
  probe_node_name: string | null;
  expires_at: string;
  max_requests_per_hour: number;
  allowed_domains: string[];
  allowed_regions: string[];
  tier_limits: GeoProxyTierLimits;
  daily_usage: GeoProxyDailyUsage;
  concurrent_tabs: number;
  rate_limit_per_hour: number;
  forward_proxy_daily_bandwidth_mb: number | null;
  max_tokens: number;
  abuse_warning: string | null;
  proxy_url?: string | null;
  proxy_nodes?: Record<string, string>;
  extended?: boolean;
  extensions_count?: number;
}

// ── Regions ───────────────────────────────────────────────────

export interface RegionsResponse {
  regions: RegionInfo[];
  total: number;
}

// ── Quota / Usage ─────────────────────────────────────────────

export interface QuotaResponse {
  can_execute: boolean;
  tier: string;
  limits: {
    minute: number;
    hour: number;
    day: number;
    month: number;
    concurrent?: number;
  };
  usage: {
    minute: number;
    hour: number;
    day: number;
    month: number;
  };
  remaining: {
    minute: number;
    hour: number;
    day: number;
    month: number;
  };
}

export interface CachedQuota {
  diagnostic: QuotaResponse | null;
  proxy: GeoProxyDailyUsage | null;
  fetchedAt: number;
}

// ── API Client Config ─────────────────────────────────────────

export interface ProbeOpsConfig {
  apiKey: string;
  baseUrl?: string;
}

// ── Proxy Region Info ─────────────────────────────────────────

export interface ProxyRegionInfo {
  region: string;
  fqdn: string;
  location: string;
  port: number;
}

// ── API Error ─────────────────────────────────────────────────

export class ProbeOpsError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public detail?: string,
    public retryAfter?: number,
    public rateLimitInfo?: {
      limit: number;
      remaining: number;
      reset: number;
    }
  ) {
    super(message);
    this.name = 'ProbeOpsError';
  }
}
