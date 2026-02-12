#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProbeOpsClient } from './api-client.js';
import { ProbeOpsError, GeoProxyResponse, ProxyRegionInfo, CachedQuota, V1RunResponse } from './types.js';
import {
  formatSslCheck,
  formatDnsLookup,
  formatIsItDown,
  formatLatencyTest,
  formatTraceroute,
  formatPortCheck,
  formatGenericResult,
  formatGeoProxy,
  formatRegions,
  formatProxyRegions,
  formatQuota,
  formatAccountStatus,
} from './formatters.js';

// ── Configuration ───────────────────────────────────────────

const API_KEY = process.env.PROBEOPS_API_KEY;
const BASE_URL = process.env.PROBEOPS_BASE_URL || 'https://probeops.com';

if (!API_KEY) {
  console.error('Error: PROBEOPS_API_KEY environment variable is required.');
  console.error('Get your free API key at https://probeops.com/dashboard/api-keys');
  process.exit(1);
}

const client = new ProbeOpsClient({ apiKey: API_KEY, baseUrl: BASE_URL });

// ── Token Cache (reuse tokens across geo_browse calls) ──────

interface CachedToken {
  data: GeoProxyResponse;
  expiresAt: number; // Unix ms
  extensionNotice?: string; // One-time notification after extend
}

let cachedProxyToken: CachedToken | null = null;

/**
 * Build a user-facing extension notice for quota awareness.
 */
function buildExtensionNotice(data: GeoProxyResponse): string {
  const { consumed, quota, resets_at } = data.daily_usage;
  return `Proxy session extended (+1 hour). ${consumed} of ${quota} daily hours used. Resets at ${resets_at} | Upgrade: https://probeops.com/pricing`;
}

/**
 * Get a valid proxy token with 3-tier logic:
 * 1. > 5 min remaining → reuse cached (no quota cost)
 * 2. 0-5 min remaining → extend existing token (+1 quota unit)
 * 3. Expired/no cache → generate new token (1 quota unit)
 *
 * A single token works across ALL regions (allowed_regions: ["*"]).
 */
async function getOrCreateProxyToken(region: string): Promise<GeoProxyResponse> {
  const now = Date.now();

  if (cachedProxyToken) {
    const remaining = cachedProxyToken.expiresAt - now;

    // Tier 1: > 5 minutes remaining — reuse as-is (no quota cost)
    if (remaining > 5 * 60 * 1000) {
      const remainMin = Math.round(remaining / 60000);
      process.stderr.write(`[probeops] Reusing cached proxy token ${cachedProxyToken.data.token_id} (${remainMin} min remaining, no quota consumed)\n`);
      return cachedProxyToken.data;
    }

    // Tier 2: 0-5 minutes remaining — try to extend
    if (remaining > 0) {
      try {
        process.stderr.write(`[probeops] Token ${cachedProxyToken.data.token_id} nearing expiry (${Math.round(remaining / 60000)} min), extending (+1 quota)\n`);
        const data = await client.extendProxyToken(cachedProxyToken.data.token_id);
        cachedProxyToken = {
          data,
          expiresAt: new Date(data.expires_at).getTime(),
          extensionNotice: buildExtensionNotice(data),
        };
        // Update quota cache with fresh daily_usage from extend response
        quotaCache.proxy = data.daily_usage;
        quotaCache.fetchedAt = Date.now();
        process.stderr.write(`[probeops] Token ${data.token_id} extended, expires ${data.expires_at}, quota ${data.daily_usage.consumed}/${data.daily_usage.quota}\n`);
        return data;
      } catch (err) {
        // Extend failed (expired between check and call, quota exhausted, etc.)
        // Fall through to generate
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[probeops] Extend failed (${msg}), falling back to generate\n`);
      }
    }
  }

  // Tier 3: No cache, expired, or extend failed — generate new token
  process.stderr.write(`[probeops] Generating new proxy token (1 daily quota consumed)\n`);
  const data = await client.getGeoProxy({ region });
  cachedProxyToken = {
    data,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  // Update quota cache
  quotaCache.proxy = data.daily_usage;
  quotaCache.fetchedAt = Date.now();
  process.stderr.write(`[probeops] Token ${data.token_id} created, expires ${data.expires_at}, quota ${data.daily_usage.consumed}/${data.daily_usage.quota}\n`);
  return data;
}

/**
 * Get the proxy server URL for a region.
 * Uses proxy_nodes map from API if available, falls back to proxy_url.
 */
function getProxyServer(data: GeoProxyResponse, region: string): string {
  // Try region-specific URL from proxy_nodes map (returned by API)
  if (data.proxy_nodes && data.proxy_nodes[region]) {
    return data.proxy_nodes[region];
  }
  // Fall back to the primary proxy_url (assigned node)
  if (data.proxy_url) {
    return data.proxy_url;
  }
  // Last resort: derive from region name (should rarely happen)
  process.stderr.write(`[probeops] Warning: no proxy_nodes or proxy_url in API response, using fallback FQDN for ${region}\n`);
  return `https://node-1-${region}.probeops.com:443`;
}

// ── Quota Cache (passive awareness across all tools) ────────

const QUOTA_CACHE_TTL_MS = 60_000; // 60 seconds

let quotaCache: CachedQuota = {
  diagnostic: null,
  proxy: null,
  fetchedAt: 0,
};

async function refreshQuotaCache(): Promise<CachedQuota> {
  if (Date.now() - quotaCache.fetchedAt < QUOTA_CACHE_TTL_MS) {
    return quotaCache;
  }
  const [diagResult, proxyResult] = await Promise.allSettled([
    client.getQuota(),
    client.getProxyDailyUsage(),
  ]);
  quotaCache = {
    diagnostic: diagResult.status === 'fulfilled' ? diagResult.value : quotaCache.diagnostic,
    proxy: proxyResult.status === 'fulfilled' ? proxyResult.value : quotaCache.proxy,
    fetchedAt: Date.now(),
  };
  return quotaCache;
}

function buildQuotaFooter(category: 'diagnostic' | 'proxy'): string {
  const q = quotaCache;
  const parts: string[] = [];

  if (category === 'diagnostic' && q.diagnostic) {
    const d = q.diagnostic;
    parts.push(`Diagnostics: ${d.remaining.day} of ${d.limits.day} remaining today (${d.tier})`);
  }

  if (category === 'proxy') {
    // Show one-time extension notice (cleared after first display)
    if (cachedProxyToken?.extensionNotice) {
      parts.push(cachedProxyToken.extensionNotice);
      cachedProxyToken.extensionNotice = undefined;
    }
    if (q.proxy) {
      const remaining = q.proxy.quota - q.proxy.consumed;
      parts.push(`Proxy hours: ${remaining} of ${q.proxy.quota} remaining today`);
    }
    if (cachedProxyToken && cachedProxyToken.expiresAt > Date.now()) {
      const minsLeft = Math.round((cachedProxyToken.expiresAt - Date.now()) / 60000);
      parts.push(`Active token: ${minsLeft} min remaining`);
    }
  }

  if (parts.length === 0) return '';
  return '\n---\n' + parts.join(' | ');
}

// ── V1 Quota Update Helper ───────────────────────────────────

function updateQuotaFromV1(data: V1RunResponse): void {
  if (data.quota) {
    quotaCache.diagnostic = {
      can_execute: true,
      tier: data.quota.tier,
      limits: data.quota.limits,
      usage: data.quota.usage,
      remaining: data.quota.available,
    };
    quotaCache.fetchedAt = Date.now();
  }
}

// ── Helper ──────────────────────────────────────────────────

function errorText(err: unknown): string {
  if (err instanceof ProbeOpsError) {
    const lines: string[] = [];
    if (err.statusCode === 429) {
      lines.push('Rate limit exceeded.');
      if (err.retryAfter) lines.push(`Retry after: ${err.retryAfter} seconds.`);
      if (err.rateLimitInfo) {
        lines.push(`Limit: ${err.rateLimitInfo.limit} requests, Remaining: ${err.rateLimitInfo.remaining}.`);
      }
      lines.push('Use the probeops://usage resource to check your current quota.');
      return lines.join(' ');
    }
    if (err.statusCode === 401) {
      return 'Authentication failed. Check your PROBEOPS_API_KEY. Get a key at https://probeops.com/dashboard/api-keys';
    }
    if (err.statusCode === 403) {
      return 'Access denied. This feature may require a paid plan. See https://probeops.com/pricing';
    }
    return `ProbeOps API Error (${err.statusCode}): ${err.detail || err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── MCP Server Setup ────────────────────────────────────────

const server = new McpServer({
  name: 'probeops',
  version: '1.0.0',
});

// ── Tools ───────────────────────────────────────────────────

server.tool(
  'ssl_check',
  'Check SSL/TLS certificate for a domain from multiple global regions. Returns certificate details (validity, expiry, issuer, TLS version, SANs) and checks consistency across regions.',
  { domain: z.string().describe('Domain name to check (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.sslCheck({ domain });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatSslCheck(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'dns_lookup',
  'Look up DNS records for a domain from multiple global regions. Supports A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, and PTR record types. Useful for checking DNS propagation across regions.',
  {
    domain: z.string().describe('Domain name to look up (e.g., "example.com")'),
    record_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'PTR']).optional().describe('DNS record type (default: A)'),
  },
  async ({ domain, record_type }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'mx_lookup',
  'Look up MX (Mail Exchange) records for a domain. Shows mail servers and priorities. Useful for verifying email configuration and troubleshooting email delivery.',
  { domain: z.string().describe('Domain name to look up (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type: 'MX' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'txt_lookup',
  'Look up TXT records for a domain. Shows SPF, DKIM, DMARC, domain verification, and other TXT records. Essential for email authentication and domain ownership verification.',
  { domain: z.string().describe('Domain name to look up (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type: 'TXT' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'ns_lookup',
  'Look up NS (Nameserver) records for a domain. Shows authoritative DNS servers. Useful for verifying DNS delegation and nameserver configuration.',
  { domain: z.string().describe('Domain name to look up (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type: 'NS' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'cname_lookup',
  'Look up CNAME (Canonical Name) records for a domain. Shows DNS aliases. Useful for verifying CDN configuration and subdomain routing.',
  { domain: z.string().describe('Domain or subdomain to look up (e.g., "www.example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type: 'CNAME' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'caa_lookup',
  'Look up CAA (Certificate Authority Authorization) DNS records for a domain. Shows which certificate authorities are authorized to issue SSL/TLS certificates.',
  { domain: z.string().describe('Domain name to look up (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.dnsLookup({ domain, record_type: 'CAA' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'reverse_dns_lookup',
  'Perform reverse DNS (PTR) lookup for an IP address. Finds the hostname associated with an IP. Essential for email deliverability verification and server identification.',
  { ip: z.string().describe('IP address to look up (e.g., "8.8.8.8")') },
  async ({ ip }) => {
    try {
      const data = await client.dnsLookup({ domain: ip, record_type: 'PTR' });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatDnsLookup(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'is_it_down',
  'Check if a website is up, down, or partially available from multiple global regions. Returns HTTP status and response time per region.',
  { url: z.string().describe('Full URL to check (e.g., "https://example.com")') },
  async ({ url }) => {
    try {
      const data = await client.isItDown({ url });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatIsItDown(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'latency_test',
  'Measure network latency (ping) to a target from multiple global regions. Returns per-region latency plus average, min, and max.',
  { target: z.string().describe('Hostname or IP to test (e.g., "example.com" or "8.8.8.8")') },
  async ({ target }) => {
    try {
      const data = await client.latencyTest({ target });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatLatencyTest(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'traceroute',
  'Trace the network path to a target from one or more global regions. Shows each hop with latency. Supports TCP, UDP, and ICMP protocols.',
  {
    target: z.string().describe('Hostname or IP to trace (e.g., "example.com")'),
    protocol: z.enum(['tcp', 'udp', 'icmp']).optional().describe('Protocol to use (default: tcp)'),
  },
  async ({ target, protocol }) => {
    try {
      const data = await client.traceroute({ target, protocol });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatTraceroute(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'port_check',
  'Check if a specific port is open, closed, or filtered on a target from multiple global regions. Useful for verifying firewall rules and service availability.',
  {
    target: z.string().describe('Hostname or IP to check (e.g., "example.com")'),
    port: z.number().int().min(1).max(65535).describe('Port number to check (1-65535)'),
  },
  async ({ target, port }) => {
    try {
      const data = await client.portCheck({ target, port });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatPortCheck(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

// ── New Tools (via v1/run) ───────────────────────────────────

server.tool(
  'ping',
  'ICMP ping a target from multiple global regions. Returns packet loss and round-trip times. Useful for basic reachability and latency testing.',
  { target: z.string().describe('Hostname or IP to ping (e.g., "example.com" or "8.8.8.8")') },
  async ({ target }) => {
    try {
      const data = await client.run('ping', target);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'whois',
  'Look up WHOIS registration information for a domain. Shows registrar, creation/expiry dates, nameservers, and registrant info.',
  { domain: z.string().describe('Domain name to look up (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      const data = await client.run('whois', domain);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'nmap_port_check',
  'Check if multiple ports are open or closed on a target from multiple global regions using nmap. Checks specified ports (not a full scan).',
  {
    target: z.string().describe('Hostname or IP to check (e.g., "example.com")'),
    ports: z.string().optional().describe('Ports to check (e.g., "80,443" or "22,80,443,8080"). Default: common ports 1-1024'),
  },
  async ({ target, ports }) => {
    try {
      const params: Record<string, unknown> = {};
      if (ports) params.ports = ports;
      const data = await client.run('nmap', target, params);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'tcp_ping',
  'Measure TCP-level latency to a specific port on a target from multiple global regions. More reliable than ICMP ping for hosts that block ICMP.',
  {
    target: z.string().describe('Hostname or IP to test (e.g., "example.com")'),
    port: z.number().int().min(1).max(65535).describe('Port number to TCP ping (e.g., 443)'),
  },
  async ({ target, port }) => {
    try {
      const data = await client.run('tcping', target, { port });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'keyword_check',
  'Check if a keyword or phrase exists on a web page from multiple global regions. Useful for verifying content delivery and geo-specific content.',
  {
    url: z.string().describe('URL to check (e.g., "https://example.com")'),
    keyword: z.string().describe('Keyword or phrase to search for on the page'),
  },
  async ({ url, keyword }) => {
    try {
      const data = await client.run('keyword_check', url, { keyword });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'websocket_check',
  'Check WebSocket endpoint health and connectivity from multiple global regions. Verifies that a WebSocket server is accepting connections.',
  { url: z.string().describe('WebSocket URL to check (e.g., "wss://example.com/ws")') },
  async ({ url }) => {
    try {
      const data = await client.run('websocket_check', url);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'banner_grab',
  'Grab the service banner from a specific port on a target from multiple global regions. Identifies service type and version.',
  {
    target: z.string().describe('Hostname or IP to check (e.g., "example.com")'),
    port: z.number().int().min(1).max(65535).describe('Port number to grab banner from (e.g., 22, 80, 443)'),
  },
  async ({ target, port }) => {
    try {
      const data = await client.run('banner_grab', target, { port });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'api_health',
  'Check API endpoint health from multiple global regions. Sends an HTTP request and reports status code, response time, and availability.',
  { url: z.string().describe('API URL to check (e.g., "https://api.example.com/health")') },
  async ({ url }) => {
    try {
      const data = await client.run('api_health', url);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

// ── Proxy Tools ─────────────────────────────────────────────

server.tool(
  'get_geo_proxy',
  'Get geo-proxy credentials for a specific region. Returns a proxy JWT token with tier-based quota info. The token can be used with Playwright or any HTTPS proxy client to browse the web from that geographic region. A single token works across all regions.',
  {
    region: z.enum(['eu-central', 'us-east', 'ap-south', 'us-west', 'ca-central', 'ap-southeast']).describe('Region to proxy through'),
  },
  async ({ region }) => {
    try {
      refreshQuotaCache().catch(() => {});
      const data = await getOrCreateProxyToken(region);
      const proxyServer = getProxyServer(data, region);
      const fqdn = proxyServer.replace(/^https?:\/\//, '').replace(/:.*$/, '');
      return { content: [{ type: 'text', text: formatGeoProxy(data, fqdn) + buildQuotaFooter('proxy') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'geo_browse',
  'Browse a URL from a specific geographic region using ProbeOps geo-proxy. Launches a real browser through a geo-located proxy and returns the page content and a screenshot. One-step tool — no manual Playwright setup needed.',
  {
    url: z.string().describe('URL to browse (e.g., "https://example.com/pricing")'),
    region: z.enum(['eu-central', 'us-east', 'ap-south', 'us-west', 'ca-central', 'ap-southeast']).describe('Region to browse from'),
    action: z.enum(['screenshot', 'content', 'both']).optional().describe('What to capture: screenshot, page content text, or both (default: both)'),
  },
  async ({ url, region, action }) => {
    refreshQuotaCache().catch(() => {});
    const captureAction = action || 'both';

    // Step 1: Get proxy credentials (reuses cached token if valid)
    let proxyData;
    try {
      proxyData = await getOrCreateProxyToken(region);
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }

    // Step 2: Get proxy server URL from API response (not hardcoded)
    const proxyServer = getProxyServer(proxyData, region);

    // Step 3: Try Playwright (full browser rendering)
    try {
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          proxy: {
            server: proxyServer,
            username: proxyData.jwt_token,
            password: '',
          },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 720 },
        });

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        const title = await page.title();
        const finalUrl = page.url();

        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

        // Capture text content
        if (captureAction === 'content' || captureAction === 'both') {
          const text = await page.evaluate('document.body.innerText') as string;
          const truncated = text.length > 5000 ? text.slice(0, 5000) + '\n\n... [truncated, full page is ' + text.length + ' chars]' : text;
          content.push({
            type: 'text',
            text: [
              `Geo-Browse: ${url} from ${region}`,
              `Proxy: ${proxyServer}`,
              `Final URL: ${finalUrl}`,
              `Title: ${title}`,
              `Quota: ${proxyData.daily_usage.consumed}/${proxyData.daily_usage.quota} tokens used today`,
              '',
              'Page Content:',
              truncated,
            ].join('\n'),
          });
        }

        // Capture screenshot
        if (captureAction === 'screenshot' || captureAction === 'both') {
          const screenshot = await page.screenshot({ type: 'png', fullPage: false });
          if (captureAction === 'screenshot') {
            content.push({
              type: 'text',
              text: [
                `Geo-Browse: ${url} from ${region}`,
                `Proxy: ${proxyServer}`,
                `Final URL: ${finalUrl}`,
                `Title: ${title}`,
                `Quota: ${proxyData.daily_usage.consumed}/${proxyData.daily_usage.quota} tokens used today`,
              ].join('\n'),
            });
          }
          content.push({
            type: 'image',
            data: screenshot.toString('base64'),
            mimeType: 'image/png',
          });
        }

        await context.close();
        // Append proxy quota footer to the first text content block
        const footer = buildQuotaFooter('proxy');
        if (footer) {
          const firstText = content.find((c): c is { type: 'text'; text: string } => c.type === 'text');
          if (firstText) firstText.text += footer;
        }
        return { content };
      } finally {
        await browser.close();
      }
    } catch (playwrightError) {
      // Step 4: Fallback — HTTP fetch through proxy (no browser needed)
      try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        // Embed JWT as username in proxy URL for Basic auth (matches Rust proxy expectations)
        const proxyUrl = new URL(proxyServer);
        proxyUrl.username = proxyData.jwt_token;
        proxyUrl.password = '';
        const agent = new HttpsProxyAgent(proxyUrl.toString());

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          // @ts-expect-error Node.js fetch supports agent via dispatcher
          dispatcher: agent,
          signal: AbortSignal.timeout(30000),
        });

        const html = await response.text();
        const truncatedHtml = html.length > 5000 ? html.slice(0, 5000) + '\n\n... [truncated]' : html;

        return {
          content: [{
            type: 'text',
            text: [
              `Geo-Browse (HTTP fallback): ${url} from ${region}`,
              `Status: ${response.status} ${response.statusText}`,
              `Content-Type: ${response.headers.get('content-type') || 'unknown'}`,
              `Quota: ${proxyData.daily_usage.consumed}/${proxyData.daily_usage.quota} tokens used today`,
              '',
              'Note: Full browser rendering requires Chromium. Install with: npx playwright install chromium',
              '',
              'Raw HTML:',
              truncatedHtml,
            ].join('\n') + buildQuotaFooter('proxy'),
          }],
        };
      } catch (fetchError) {
        // Both Playwright and HTTP fetch failed — return helpful error
        const pwErr = playwrightError instanceof Error ? playwrightError.message : String(playwrightError);
        return {
          content: [{
            type: 'text',
            text: [
              `Geo-Browse failed for ${url} from ${region}`,
              '',
              `Playwright error: ${pwErr}`,
              '',
              'To use full browser rendering, install Chromium:',
              '  npx playwright install chromium',
              '',
              'Proxy credentials were obtained successfully:',
              `  Token: ${proxyData.token_id}`,
              `  Region: ${region}`,
              `  Proxy: ${proxyServer}`,
              `  Expires: ${proxyData.expires_at}`,
              `  Quota: ${proxyData.daily_usage.consumed}/${proxyData.daily_usage.quota} tokens used today`,
            ].join('\n'),
          }],
          isError: true,
        };
      }
    }
  }
);

server.tool(
  'account_status',
  'Show your ProbeOps account status: subscription tier, diagnostic quota (minute/hour/day/month), proxy token quota, and active proxy token details. Use this to check remaining quota before running multiple tools.',
  {},
  async () => {
    try {
      // Force-refresh cache (awaited)
      quotaCache.fetchedAt = 0;
      const q = await refreshQuotaCache();
      const activeToken = cachedProxyToken && cachedProxyToken.expiresAt > Date.now()
        ? {
            token_id: cachedProxyToken.data.token_id,
            expires_at: cachedProxyToken.data.expires_at,
            allowed_regions: cachedProxyToken.data.allowed_regions || [cachedProxyToken.data.region],
          }
        : null;
      return { content: [{ type: 'text', text: formatAccountStatus(q, activeToken) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

// ── Resources ───────────────────────────────────────────────

server.resource(
  'regions',
  'probeops://regions',
  { description: 'List of available probe regions with location and status' },
  async () => {
    try {
      const data = await client.getRegions();
      return { contents: [{ uri: 'probeops://regions', text: formatRegions(data), mimeType: 'text/plain' }] };
    } catch (err) {
      return { contents: [{ uri: 'probeops://regions', text: errorText(err), mimeType: 'text/plain' }] };
    }
  }
);

server.resource(
  'proxy-regions',
  'probeops://proxy-regions',
  { description: 'List of available geo-proxy regions with proxy URLs for Playwright/browser proxy usage' },
  async () => {
    try {
      // Fetch a token to get live proxy_nodes map from API
      const data = await getOrCreateProxyToken('us-east');
      if (data.proxy_nodes && Object.keys(data.proxy_nodes).length > 0) {
        const regions: ProxyRegionInfo[] = Object.entries(data.proxy_nodes).map(([region, url]) => {
          const fqdn = url.replace(/^https?:\/\//, '').replace(/:.*$/, '');
          return { region, fqdn, location: region, port: 443 };
        });
        return { contents: [{ uri: 'probeops://proxy-regions', text: formatProxyRegions(regions), mimeType: 'text/plain' }] };
      }
    } catch { /* fall through to static list */ }
    // Fallback: static list (only if API unavailable)
    const fallback: ProxyRegionInfo[] = [
      { region: 'eu-central', fqdn: 'node-1-eu-central.probeops.com', location: 'Helsinki, Finland', port: 443 },
      { region: 'us-east', fqdn: 'node-1-us-east.probeops.com', location: 'Ashburn, USA', port: 443 },
      { region: 'ap-south', fqdn: 'node-1-ap-south.probeops.com', location: 'Mumbai, India', port: 443 },
      { region: 'us-west', fqdn: 'node-1-us-west.probeops.com', location: 'Oregon, USA', port: 443 },
      { region: 'ca-central', fqdn: 'node-1-ca-central.probeops.com', location: 'Canada', port: 443 },
      { region: 'ap-southeast', fqdn: 'node-1-ap-southeast.probeops.com', location: 'Sydney, Australia', port: 443 },
    ];
    return { contents: [{ uri: 'probeops://proxy-regions', text: formatProxyRegions(fallback), mimeType: 'text/plain' }] };
  }
);

server.resource(
  'usage',
  'probeops://usage',
  { description: 'Current API usage and remaining quota for your ProbeOps account (diagnostic + proxy)' },
  async () => {
    try {
      quotaCache.fetchedAt = 0;
      const q = await refreshQuotaCache();
      const activeToken = cachedProxyToken && cachedProxyToken.expiresAt > Date.now()
        ? {
            token_id: cachedProxyToken.data.token_id,
            expires_at: cachedProxyToken.data.expires_at,
            allowed_regions: cachedProxyToken.data.allowed_regions || [cachedProxyToken.data.region],
          }
        : null;
      return { contents: [{ uri: 'probeops://usage', text: formatAccountStatus(q, activeToken), mimeType: 'text/plain' }] };
    } catch (err) {
      return { contents: [{ uri: 'probeops://usage', text: errorText(err), mimeType: 'text/plain' }] };
    }
  }
);

// ── Start Server ────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start ProbeOps MCP server:', err);
  process.exit(1);
});
