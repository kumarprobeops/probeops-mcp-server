#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ProbeOpsClient, PublicClient } from './api-client.js';
import { ProbeOpsError, GeoProxyResponse, ProxyRegionInfo, CachedQuota, V1RunResponse } from './types.js';

const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version as string;
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

// Region geo-emulation settings (sourced from ProbeOps Horizon)
const REGION_CONFIG: Record<string, { timezone: string; locale: string; lat: number; lng: number; location: string }> = {
  'eu-central': { timezone: 'Europe/Helsinki', locale: 'en-FI', lat: 60.17, lng: 24.94, location: 'Helsinki, Finland' },
  'us-east':    { timezone: 'America/New_York', locale: 'en-US', lat: 39.04, lng: -77.49, location: 'Ashburn, Virginia' },
  'ap-south':   { timezone: 'Asia/Kolkata', locale: 'en-IN', lat: 19.08, lng: 72.88, location: 'Mumbai, India' },
  'us-west':    { timezone: 'America/Los_Angeles', locale: 'en-US', lat: 45.59, lng: -121.18, location: 'Boardman, Oregon' },
  'ca-central': { timezone: 'America/Toronto', locale: 'en-CA', lat: 45.50, lng: -73.57, location: 'Montreal, Canada' },
  'ap-southeast': { timezone: 'Australia/Sydney', locale: 'en-AU', lat: -33.87, lng: 151.21, location: 'Sydney, Australia' },
};

// ── Demo Mode ────────────────────────────────────────────────

const DEMO_MODE = !API_KEY;
const client = DEMO_MODE ? null : new ProbeOpsClient({ apiKey: API_KEY!, baseUrl: BASE_URL });
const publicClient = DEMO_MODE ? new PublicClient(BASE_URL) : null;

// Persistent daily usage cap for demo mode
const DEMO_DIR = join(homedir(), '.probeops-mcp');
const USAGE_FILE = join(DEMO_DIR, 'usage.json');
const DEMO_DAILY_LIMIT = 10;

interface DemoUsage {
  date: string;
  count: number;
}

function getDemoUsage(): DemoUsage {
  const today = new Date().toISOString().split('T')[0];
  try {
    const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8')) as DemoUsage;
    if (data.date === today) return data;
  } catch {}
  return { date: today, count: 0 };
}

function incrementDemoUsage(): DemoUsage {
  const usage = getDemoUsage();
  usage.count++;
  try {
    mkdirSync(DEMO_DIR, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {}
  return usage;
}

function isDemoLimitReached(): boolean {
  return getDemoUsage().count >= DEMO_DAILY_LIMIT;
}

function buildDemoFooter(): string {
  const usage = getDemoUsage();
  const remaining = Math.max(0, DEMO_DAILY_LIMIT - usage.count);
  if (remaining > 0) {
    return `\n---\nDemo Mode (${usage.count}/${DEMO_DAILY_LIMIT} daily calls used) | 2 of 6 regions\nGet all 21 tools + 6 regions: https://probeops.com/register?utm_source=mcp&utm_medium=demo_footer`;
  }
  return `\n---\nDaily demo limit reached (${DEMO_DAILY_LIMIT}/${DEMO_DAILY_LIMIT})\nGet your free API key: https://probeops.com/dashboard/api-keys?utm_source=mcp&utm_medium=demo_limit\nSetup: export PROBEOPS_API_KEY=your_key_here`;
}

function demoLimitMessage(): string {
  return [
    'Daily demo limit reached (10/10)',
    '',
    'Get your free API key for unlimited access:',
    '  1. Sign up: https://probeops.com/register?utm_source=mcp&utm_medium=demo_limit',
    '  2. Get key: https://probeops.com/dashboard/api-keys',
    '  3. Set env: export PROBEOPS_API_KEY=your_key_here',
    '',
    'Or use the get_api_key tool for platform-specific setup instructions.',
  ].join('\n');
}

function gatedToolMessage(toolName: string): string {
  return [
    `This tool requires a ProbeOps API key.`,
    '',
    `Tool: ${toolName}`,
    `Status: AUTH_REQUIRED`,
    '',
    'Get your free API key:',
    '  1. Sign up: https://probeops.com/register?utm_source=mcp&utm_medium=gated_tool',
    '  2. Get key: https://probeops.com/dashboard/api-keys',
    '  3. Set env: export PROBEOPS_API_KEY=your_key_here',
    '',
    'Or use the get_api_key tool for platform-specific setup instructions.',
  ].join('\n');
}

if (DEMO_MODE) {
  process.stderr.write('\n  ProbeOps MCP Server \u2014 Demo Mode\n');
  process.stderr.write('  11 tools available | 2 regions per call | 10 calls/day\n');
  process.stderr.write('  Unlock all 21 tools + 6 regions: https://probeops.com/register?utm_source=mcp&utm_medium=demo\n');
  process.stderr.write('  Setup: export PROBEOPS_API_KEY=your_key_here\n\n');
}

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
 * Uses a mutex to prevent parallel calls from generating duplicate tokens.
 */
let tokenMutex: Promise<GeoProxyResponse> | null = null;

function getOrCreateProxyToken(region: string): Promise<GeoProxyResponse> {
  // If a token operation is already in flight, wait for it
  if (tokenMutex) {
    return tokenMutex.then(() => getOrCreateProxyTokenImpl(region));
  }
  const promise = getOrCreateProxyTokenImpl(region);
  tokenMutex = promise;
  promise.finally(() => { tokenMutex = null; });
  return promise;
}

async function getOrCreateProxyTokenImpl(region: string): Promise<GeoProxyResponse> {
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
        const data = await client!.extendProxyToken(cachedProxyToken.data.token_id);
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
  const data = await client!.getGeoProxy({ region });
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
    client!.getQuota(),
    client!.getProxyDailyUsage(),
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
  version: PKG_VERSION,
});

// ── Tools ───────────────────────────────────────────────────

server.tool(
  'ssl_check',
  'Check SSL/TLS certificate for a domain from multiple global regions. Returns certificate details (validity, expiry, issuer, TLS version, SANs) and checks consistency across regions.',
  { domain: z.string().describe('Domain name to check (e.g., "example.com")') },
  async ({ domain }) => {
    try {
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.sslCheck(domain);
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatSslCheck(data) + buildDemoFooter() }] };
      }
      const data = await client!.sslCheck({ domain });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, record_type);
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, 'MX');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type: 'MX' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, 'TXT');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type: 'TXT' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, 'NS');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type: 'NS' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, 'CNAME');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type: 'CNAME' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(domain, 'CAA');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain, record_type: 'CAA' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.dnsLookup(ip, 'PTR');
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatDnsLookup(data) + buildDemoFooter() }] };
      }
      const data = await client!.dnsLookup({ domain: ip, record_type: 'PTR' });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.isItDown(url);
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatIsItDown(data) + buildDemoFooter() }] };
      }
      const data = await client!.isItDown({ url });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.latencyTest(target);
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatLatencyTest(data) + buildDemoFooter() }] };
      }
      const data = await client!.latencyTest({ target });
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
      if (DEMO_MODE) {
        return { content: [{ type: 'text', text: gatedToolMessage('traceroute') }] };
      }
      const data = await client!.traceroute({ target, protocol });
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
      if (DEMO_MODE) {
        if (isDemoLimitReached()) return { content: [{ type: 'text', text: demoLimitMessage() }] };
        const data = await publicClient!.portCheck(target, port);
        incrementDemoUsage();
        return { content: [{ type: 'text', text: formatPortCheck(data) + buildDemoFooter() }] };
      }
      const data = await client!.portCheck({ target, port });
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('ping') }] };
      const data = await client!.run('ping', target);
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('whois') }] };
      const data = await client!.run('whois', domain);
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('nmap_port_check') }] };
      const params: Record<string, unknown> = {};
      if (ports) params.ports = ports;
      const data = await client!.run('nmap', target, params);
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('tcp_ping') }] };
      const data = await client!.run('tcping', target, { port });
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

server.tool(
  'keyword_check',
  'Check if a keyword exists in a web page\'s raw HTML source from multiple global regions. Searches raw HTML — does not execute JavaScript, so content rendered client-side (SPAs, dynamic widgets) may not be detected. Useful for verifying static content delivery and geo-specific content.',
  {
    url: z.string().describe('URL to check (e.g., "https://example.com")'),
    keyword: z.string().describe('Keyword or phrase to search for on the page'),
  },
  async ({ url, keyword }) => {
    try {
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('keyword_check') }] };
      const data = await client!.run('keyword_check', url, { keyword });
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('websocket_check') }] };
      const data = await client!.run('websocket_check', url);
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('banner_grab') }] };
      const data = await client!.run('banner_grab', target, { port });
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
      if (DEMO_MODE) return { content: [{ type: 'text', text: gatedToolMessage('api_health') }] };
      const data = await client!.run('api_health', url);
      updateQuotaFromV1(data);
      return { content: [{ type: 'text', text: formatGenericResult(data) + buildQuotaFooter('diagnostic') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }
  }
);

// ── Get API Key Tool ─────────────────────────────────────────

server.tool(
  'get_api_key',
  'Get instructions to set up your ProbeOps API key for full access to all 21 tools and 6 global regions.',
  {},
  async () => {
    if (!DEMO_MODE) {
      return { content: [{ type: 'text', text: 'API key is already configured. Use account_status to check your quota.' }] };
    }
    const usage = getDemoUsage();
    return {
      content: [{
        type: 'text',
        text: [
          'ProbeOps API Key Setup',
          '======================',
          '',
          'Step 1: Create your free account',
          '  https://probeops.com/register?utm_source=mcp&utm_medium=get_api_key',
          '',
          'Step 2: Generate an API key',
          '  https://probeops.com/dashboard/api-keys?utm_source=mcp&utm_medium=get_api_key',
          '',
          'Step 3: Set the environment variable',
          '',
          '  macOS/Linux (add to ~/.bashrc or ~/.zshrc):',
          '    export PROBEOPS_API_KEY=your_key_here',
          '',
          '  Windows (PowerShell):',
          '    $env:PROBEOPS_API_KEY="your_key_here"',
          '',
          '  Windows (Command Prompt):',
          '    set PROBEOPS_API_KEY=your_key_here',
          '',
          'Step 4: Configure your MCP client',
          '',
          '  Claude Desktop (~/.claude/claude_desktop_config.json):',
          '    {',
          '      "mcpServers": {',
          '        "probeops": {',
          '          "command": "npx",',
          '          "args": ["-y", "@probeops/mcp-server"],',
          '          "env": { "PROBEOPS_API_KEY": "your_key_here" }',
          '        }',
          '      }',
          '    }',
          '',
          '  Cursor (.cursor/mcp.json):',
          '    {',
          '      "mcpServers": {',
          '        "probeops": {',
          '          "command": "npx",',
          '          "args": ["-y", "@probeops/mcp-server"],',
          '          "env": { "PROBEOPS_API_KEY": "your_key_here" }',
          '        }',
          '      }',
          '    }',
          '',
          `Demo usage today: ${usage.count}/${DEMO_DAILY_LIMIT} calls`,
          '',
          'Free tier includes: 21 tools, 6 regions, 100 calls/day',
        ].join('\n'),
      }],
    };
  }
);

// ── Proxy Tools ─────────────────────────────────────────────

if (!DEMO_MODE) {
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

    // Step 1: Detect if Playwright is available BEFORE acquiring a token
    let hasPlaywright = false;
    try {
      const pw = await import('playwright-core');
      const fs = await import('fs');
      const execPath = pw.chromium.executablePath();
      hasPlaywright = !!execPath && fs.existsSync(execPath);
    } catch {
      hasPlaywright = false;
    }

    // Step 2: Get proxy credentials (reuses cached token if valid)
    let proxyData;
    try {
      proxyData = await getOrCreateProxyToken(region);
    } catch (err) {
      return { content: [{ type: 'text', text: errorText(err) }], isError: true };
    }

    const proxyServer = getProxyServer(proxyData, region);

    // Step 3a: Playwright path (full browser rendering)
    if (hasPlaywright) {
      try {
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ headless: true });
        try {
          const regionCfg = REGION_CONFIG[region];
          const context = await browser.newContext({
            proxy: {
              server: proxyServer,
              username: proxyData.jwt_token,
              password: '',
            },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            ...(regionCfg && {
              timezoneId: regionCfg.timezone,
              locale: regionCfg.locale,
              geolocation: { latitude: regionCfg.lat, longitude: regionCfg.lng },
              permissions: ['geolocation'],
            }),
          });

          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // Brief wait for key visual elements to render after DOM is ready
          await page.waitForTimeout(2000);

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
        // Playwright detected but failed to launch — fall through to HTTP fallback
        process.stderr.write(`[probeops] Playwright launch failed, falling back to HTTP: ${playwrightError instanceof Error ? playwrightError.message : playwrightError}\n`);
      }
    }

    // Step 3b: HTTP fallback (uses node:https with HttpsProxyAgent)
    try {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      const https = await import('node:https');
      const http = await import('node:http');

      const proxyUrl = new URL(proxyServer);
      proxyUrl.username = proxyData.jwt_token;
      proxyUrl.password = '';
      const agent = new HttpsProxyAgent(proxyUrl.toString());

      const MAX_REDIRECTS = 5;
      const body = await new Promise<string>((resolve, reject) => {
        let redirectCount = 0;

        function doRequest(requestUrl: string) {
          const parsedUrl = new URL(requestUrl);
          const mod = parsedUrl.protocol === 'https:' ? https : http;
          const req = mod.request(requestUrl, {
            agent,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 30000,
          }, (res) => {
            // Follow 3xx redirects
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              redirectCount++;
              if (redirectCount > MAX_REDIRECTS) {
                reject(new Error(`Too many redirects (>${MAX_REDIRECTS})`));
                return;
              }
              const redirectUrl = new URL(res.headers.location, requestUrl).toString();
              process.stderr.write(`[probeops] Following redirect ${res.statusCode} → ${redirectUrl}\n`);
              res.resume(); // drain the response
              doRequest(redirectUrl);
              return;
            }
            let data = '';
            res.on('data', (chunk: Buffer) => data += chunk.toString());
            res.on('end', () => resolve(data));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
          req.end();
        }

        doRequest(url);
      });

      const truncatedHtml = body.length > 5000 ? body.slice(0, 5000) + '\n\n... [truncated]' : body;

      const regionCfg = REGION_CONFIG[region];
      return {
        content: [{
          type: 'text',
          text: [
            `Geo-Browse (HTTP fallback): ${url} from ${region}`,
            regionCfg ? `Region: ${regionCfg.location} | Timezone: ${regionCfg.timezone} | Locale: ${regionCfg.locale}` : '',
            `Proxy: ${proxyServer}`,
            `Quota: ${proxyData.daily_usage.consumed}/${proxyData.daily_usage.quota} tokens used today`,
            '',
            hasPlaywright ? '' : 'Note: For full browser rendering with screenshots, install Chromium:\n  npx playwright-core install chromium\n',
            'Raw HTML:',
            truncatedHtml,
          ].filter(Boolean).join('\n') + buildQuotaFooter('proxy'),
        }],
      };
    } catch (fetchError) {
      const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
      return {
        content: [{
          type: 'text',
          text: [
            `Geo-Browse failed for ${url} from ${region}`,
            '',
            `Error: ${errMsg}`,
            '',
            'To use full browser rendering, install Chromium:',
            '  npx playwright-core install chromium',
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
);
} // end if (!DEMO_MODE) — proxy tools

server.tool(
  'account_status',
  'Show your ProbeOps account status: subscription tier, diagnostic quota (minute/hour/day/month), proxy token quota, and active proxy token details. Use this to check remaining quota before running multiple tools.',
  {},
  async () => {
    try {
      if (DEMO_MODE) {
        const usage = getDemoUsage();
        const remaining = Math.max(0, DEMO_DAILY_LIMIT - usage.count);
        const gatedTools = ['ping', 'whois', 'nmap_port_check', 'tcp_ping', 'traceroute', 'keyword_check', 'websocket_check', 'banner_grab', 'api_health'];
        const proxyTools = ['get_geo_proxy', 'geo_browse'];
        return {
          content: [{
            type: 'text',
            text: [
              'ProbeOps MCP Server \u2014 Demo Mode',
              '',
              `  Mode: demo`,
              `  Demo calls today: ${usage.count} of ${DEMO_DAILY_LIMIT}`,
              `  Remaining: ${remaining}`,
              `  Tools available: 11 (of 21)`,
              `  Regions per call: 2 (of 6)`,
              '',
              '  Gated tools (require API key):',
              `    ${gatedTools.join(', ')}`,
              '',
              '  Proxy tools (require API key):',
              `    ${proxyTools.join(', ')}`,
              '',
              '  Get full access:',
              '    https://probeops.com/register?utm_source=mcp&utm_medium=account_status',
              '    Setup: export PROBEOPS_API_KEY=your_key_here',
            ].join('\n'),
          }],
        };
      }
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
      if (DEMO_MODE) {
        const data = await publicClient!.getRegions();
        return { contents: [{ uri: 'probeops://regions', text: formatRegions(data), mimeType: 'text/plain' }] };
      }
      const data = await client!.getRegions();
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
    if (DEMO_MODE) {
      return { contents: [{ uri: 'probeops://proxy-regions', text: 'Geo-proxy regions require an API key.\nGet your free key: https://probeops.com/register?utm_source=mcp&utm_medium=resource', mimeType: 'text/plain' }] };
    }
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
    if (DEMO_MODE) {
      const usage = getDemoUsage();
      const remaining = Math.max(0, DEMO_DAILY_LIMIT - usage.count);
      const text = [
        'ProbeOps MCP Server \u2014 Demo Mode',
        '',
        `  Demo calls today: ${usage.count} of ${DEMO_DAILY_LIMIT}`,
        `  Remaining: ${remaining}`,
        `  Tools available: 11 (of 21)`,
        `  Regions per call: 2 (of 6)`,
        '',
        '  Get full access: https://probeops.com/register?utm_source=mcp&utm_medium=resource',
      ].join('\n');
      return { contents: [{ uri: 'probeops://usage', text, mimeType: 'text/plain' }] };
    }
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
