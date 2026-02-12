import {
  ProbeOpsConfig,
  ProbeOpsError,
  SslCheckRequest,
  SslCheckResponse,
  DnsLookupRequest,
  DnsLookupResponse,
  IsItDownRequest,
  IsItDownResponse,
  LatencyTestRequest,
  LatencyTestResponse,
  TracerouteRequest,
  TracerouteResponse,
  PortCheckRequest,
  PortCheckResponse,
  GeoProxyRequest,
  GeoProxyResponse,
  GeoProxyDailyUsage,
  RegionsResponse,
  QuotaResponse,
  V1RunResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://probeops.com';

export class ProbeOpsClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProbeOpsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': 'probeops-mcp-server/1.0.0',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });

    if (!response.ok) {
      let detail: string | undefined;
      let retryAfter: number | undefined;
      let rateLimitInfo: { limit: number; remaining: number; reset: number } | undefined;

      // Parse rate limit headers
      const retryHeader = response.headers.get('Retry-After');
      if (retryHeader) retryAfter = parseInt(retryHeader, 10);
      const limitHeader = response.headers.get('X-RateLimit-Limit');
      const remainHeader = response.headers.get('X-RateLimit-Remaining');
      const resetHeader = response.headers.get('X-RateLimit-Reset');
      if (limitHeader && remainHeader && resetHeader) {
        rateLimitInfo = {
          limit: parseInt(limitHeader, 10),
          remaining: parseInt(remainHeader, 10),
          reset: parseInt(resetHeader, 10),
        };
      }

      try {
        const errorBody = await response.json() as { detail?: string | { error?: string; message?: string; retry_after?: number } };
        if (typeof errorBody.detail === 'string') {
          detail = errorBody.detail;
        } else if (errorBody.detail && typeof errorBody.detail === 'object') {
          detail = errorBody.detail.message || errorBody.detail.error;
          if (errorBody.detail.retry_after) retryAfter = errorBody.detail.retry_after;
        }
      } catch {
        // ignore parse errors
      }

      throw new ProbeOpsError(
        `API request failed: ${response.status} ${response.statusText}`,
        response.status,
        detail,
        retryAfter,
        rateLimitInfo
      );
    }

    return response.json() as Promise<T>;
  }

  // ── API v1 Generic Method ────────────────────────────────

  async run(tool: string, target: string, params: Record<string, unknown> = {}): Promise<V1RunResponse> {
    return this.request<V1RunResponse>('POST', '/api/v1/run', { tool, target, params });
  }

  // ── Tool Methods (thin wrappers over v1/run) ───────────

  async sslCheck(params: SslCheckRequest): Promise<V1RunResponse> {
    return this.run('ssl_check', params.domain);
  }

  async dnsLookup(params: DnsLookupRequest): Promise<V1RunResponse> {
    return this.run('dns_lookup', params.domain, { record_type: params.record_type || 'A' });
  }

  async isItDown(params: IsItDownRequest): Promise<V1RunResponse> {
    return this.run('is_it_down', params.url);
  }

  async latencyTest(params: LatencyTestRequest): Promise<V1RunResponse> {
    return this.run('latency_test', params.target);
  }

  async traceroute(params: TracerouteRequest): Promise<V1RunResponse> {
    return this.run('traceroute', params.target, { protocol: params.protocol || 'tcp' });
  }

  async portCheck(params: PortCheckRequest): Promise<V1RunResponse> {
    return this.run('port_check', params.target, { port: params.port });
  }

  async getGeoProxy(params: GeoProxyRequest): Promise<GeoProxyResponse> {
    return this.request<GeoProxyResponse>('POST', '/api/forward-proxy/tokens/generate', {
      region: params.region,
      expires_in_hours: params.expires_in_hours || 1,
      label: params.label || 'MCP Server',
    });
  }

  // ── Resource Methods ──────────────────────────────────────

  async getRegions(): Promise<RegionsResponse> {
    return this.request<RegionsResponse>('GET', '/api/tools/regions');
  }

  async getQuota(): Promise<QuotaResponse> {
    return this.request<QuotaResponse>('GET', '/api/diagnostics/quota-status');
  }

  async getProxyDailyUsage(): Promise<GeoProxyDailyUsage> {
    return this.request<GeoProxyDailyUsage>('GET', '/api/forward-proxy/tokens/daily-usage');
  }

  async extendProxyToken(tokenId: string): Promise<GeoProxyResponse> {
    return this.request<GeoProxyResponse>('POST', `/api/forward-proxy/tokens/${tokenId}/extend`);
  }
}
