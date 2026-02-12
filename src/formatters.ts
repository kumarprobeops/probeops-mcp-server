import {
  SslCheckResponse,
  DnsLookupResponse,
  IsItDownResponse,
  LatencyTestResponse,
  TracerouteResponse,
  PortCheckResponse,
  GeoProxyResponse,
  GeoProxyDailyUsage,
  RegionsResponse,
  QuotaResponse,
  RegionResult,
  ProxyRegionInfo,
  CachedQuota,
} from './types.js';

// ── Helpers ─────────────────────────────────────────────────

function regionTable(regions: RegionResult[]): string {
  if (!regions.length) return '  No regions checked.';
  const lines = ['  | Region | Location | Status | Time |'];
  lines.push('  |--------|----------|--------|------|');
  for (const r of regions) {
    const status = r.success ? 'OK' : `FAIL: ${r.error || 'unknown'}`;
    const location = r.location || r.region;
    lines.push(`  | ${r.region} | ${location} | ${status} | ${r.response_time_ms}ms |`);
  }
  return lines.join('\n');
}

function lockedNote(count: number): string {
  if (count === 0) return '';
  return `\n  ${count} additional region(s) available with authentication. Sign up at https://probeops.com`;
}

// ── SSL Check ───────────────────────────────────────────────

export function formatSslCheck(data: SslCheckResponse): string {
  const lines: string[] = [`SSL Certificate Report for ${data.domain}`];

  if (data.certificate) {
    const cert = data.certificate;
    const status = cert.is_valid ? (cert.is_expired ? 'EXPIRED' : 'VALID') : 'INVALID';
    lines.push(`  Status: ${status}`);
    lines.push(`  Subject: ${cert.subject.common_name}`);
    lines.push(`  Issuer: ${cert.issuer.common_name}${cert.issuer.organization ? ` (${cert.issuer.organization})` : ''}`);
    lines.push(`  Valid: ${cert.valid_from} to ${cert.valid_until}`);
    lines.push(`  Expires in: ${cert.days_until_expiry} days`);
    lines.push(`  TLS: ${cert.cipher.version} (${cert.cipher.name})`);
    lines.push(`  Hostname Match: ${cert.hostname_match ? 'Yes' : 'NO - MISMATCH'}`);

    if (cert.sans.length > 0) {
      const sansDisplay = cert.sans.slice(0, 5).join(', ');
      lines.push(`  SANs: ${sansDisplay}${cert.sans.length > 5 ? ` (+${cert.sans.length - 5} more)` : ''}`);
    }

    if (data.certificates_consistent === false) {
      lines.push(`\n  WARNING: Certificates differ across regions!`);
      if (data.inconsistency_details) {
        lines.push(`  Details: ${data.inconsistency_details}`);
      }
    }
  } else {
    lines.push('  Status: COULD NOT RETRIEVE CERTIFICATE');
  }

  lines.push('');
  lines.push('  Region Results:');
  lines.push(regionTable(data.regions_checked));
  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`\n  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── DNS Lookup ──────────────────────────────────────────────

export function formatDnsLookup(data: DnsLookupResponse): string {
  const lines: string[] = [`DNS Lookup: ${data.domain} (${data.record_type})`];
  lines.push('');

  for (const r of data.regions_checked) {
    const location = r.location || r.region;
    lines.push(`  ${r.region} (${location}):`);
    if (r.success && r.result?.output) {
      const records = r.result.output.trim().split('\n');
      for (const record of records) {
        lines.push(`    ${record}`);
      }
    } else {
      lines.push(`    Error: ${r.error || 'No response'}`);
    }
    lines.push(`    Response time: ${r.response_time_ms}ms`);
    lines.push('');
  }

  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── Is It Down ──────────────────────────────────────────────

export function formatIsItDown(data: IsItDownResponse): string {
  const statusEmoji = data.global_status === 'up' ? 'UP' : data.global_status === 'down' ? 'DOWN' : 'PARTIAL';
  const lines: string[] = [`Website Status: ${data.url}`];
  lines.push(`  Global Status: ${statusEmoji}`);
  lines.push('');
  lines.push('  Region Results:');
  lines.push(regionTable(data.regions_checked));
  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`\n  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── Latency Test ────────────────────────────────────────────

export function formatLatencyTest(data: LatencyTestResponse): string {
  const lines: string[] = [`Latency Test: ${data.target}`];

  if (data.average_latency_ms !== undefined) {
    lines.push(`  Average: ${data.average_latency_ms.toFixed(1)}ms`);
    lines.push(`  Min: ${data.min_latency_ms?.toFixed(1)}ms | Max: ${data.max_latency_ms?.toFixed(1)}ms`);
  }

  lines.push('');
  lines.push('  Region Results:');

  for (const r of data.regions_checked) {
    const location = r.location || r.region;
    if (r.success) {
      lines.push(`  | ${r.region} | ${location} | ${r.response_time_ms}ms |`);
    } else {
      lines.push(`  | ${r.region} | ${location} | FAILED: ${r.error || 'timeout'} |`);
    }
  }

  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`\n  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── Traceroute ──────────────────────────────────────────────

export function formatTraceroute(data: TracerouteResponse): string {
  const lines: string[] = [`Traceroute: ${data.target}`];
  lines.push('');

  for (const r of data.regions_checked) {
    const location = r.location || r.region;
    lines.push(`  From ${r.region} (${location}):`);
    if (r.success && r.result?.output) {
      const hops = r.result.output.trim().split('\n');
      for (const hop of hops) {
        lines.push(`    ${hop}`);
      }
    } else {
      lines.push(`    Error: ${r.error || 'No response'}`);
    }
    lines.push(`    Duration: ${r.response_time_ms}ms`);
    lines.push('');
  }

  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── Port Check ──────────────────────────────────────────────

export function formatPortCheck(data: PortCheckResponse): string {
  const statusLabel = data.global_status.toUpperCase();
  const lines: string[] = [`Port Check: ${data.target}:${data.port}`];
  lines.push(`  Global Status: ${statusLabel}`);
  lines.push('');
  lines.push('  Region Results:');
  lines.push(regionTable(data.regions_checked));
  lines.push(lockedNote(data.regions_locked.length));
  lines.push(`\n  Completed in ${data.execution_time_ms}ms`);

  return lines.join('\n');
}

// ── Geo Proxy ───────────────────────────────────────────────

export function formatGeoProxy(data: GeoProxyResponse, proxyFqdn?: string): string {
  const lines: string[] = [`Geo Proxy Token (multi-region)`];
  lines.push(`  Token ID: ${data.token_id}`);
  lines.push(`  Expires: ${data.expires_at}`);
  lines.push(`  Regions: ${data.allowed_regions?.join(', ') || data.region}`);
  if (data.probe_node_name) {
    lines.push(`  Primary Node: ${data.probe_node_name}`);
  }

  lines.push('');
  lines.push('  Quota:');
  lines.push(`    Daily tokens used: ${data.daily_usage.consumed}/${data.daily_usage.quota}`);
  lines.push(`    Resets at: ${data.daily_usage.resets_at}`);

  lines.push('');
  lines.push('  Tier Limits:');
  lines.push(`    Rate limit: ${data.tier_limits.requests_per_hour} req/hr`);
  lines.push(`    Concurrent tabs: ${data.tier_limits.concurrent_tabs}`);
  lines.push(`    Session duration: ${data.tier_limits.session_duration_minutes} min`);
  lines.push(`    Bandwidth: ${data.tier_limits.data_transfer_mb} MB/day`);
  lines.push(`    Max TTL: ${data.tier_limits.max_token_ttl_hours} hours`);

  lines.push('');
  lines.push('  Proxy Servers (this token works on ALL):');
  if (data.proxy_nodes && Object.keys(data.proxy_nodes).length > 0) {
    for (const [region, url] of Object.entries(data.proxy_nodes)) {
      lines.push(`    ${region}: ${url}`);
    }
  } else if (proxyFqdn) {
    lines.push(`    ${data.region}: https://${proxyFqdn}:443`);
  }

  lines.push('');
  lines.push('  Proxy Auth (for Playwright / browser):');
  lines.push(`    Username: <jwt_token value>`);
  lines.push(`    Password: (empty string)`);

  if (data.abuse_warning) {
    lines.push(`\n  Warning: ${data.abuse_warning}`);
  }

  return lines.join('\n');
}

// ── Regions ─────────────────────────────────────────────────

export function formatRegions(data: RegionsResponse): string {
  const lines: string[] = [`ProbeOps Probe Regions (${data.total} available)`];
  lines.push('');
  lines.push('  | Region | Location | Country |');
  lines.push('  |--------|----------|---------|');
  for (const r of data.regions) {
    lines.push(`  | ${r.region} | ${r.location} | ${r.flag_emoji} ${r.country} |`);
  }

  return lines.join('\n');
}

// ── Proxy Regions ───────────────────────────────────────────

export function formatProxyRegions(regions: ProxyRegionInfo[]): string {
  const lines: string[] = [`ProbeOps Geo-Proxy Regions (${regions.length} available)`];
  lines.push('');
  lines.push('  | Region | FQDN | Location | Port |');
  lines.push('  |--------|------|----------|------|');
  for (const r of regions) {
    lines.push(`  | ${r.region} | ${r.fqdn} | ${r.location} | ${r.port} |`);
  }

  return lines.join('\n');
}

// ── Quota ───────────────────────────────────────────────────

export function formatQuota(data: QuotaResponse): string {
  const lines: string[] = [`ProbeOps API Usage (${data.tier} tier)`];
  lines.push(`  Can Execute: ${data.can_execute ? 'Yes' : 'No - quota exceeded'}`);
  lines.push('');
  lines.push('  | Window | Used | Limit | Remaining |');
  lines.push('  |--------|------|-------|-----------|');
  lines.push(`  | Minute | ${data.usage.minute} | ${data.limits.minute} | ${data.remaining.minute} |`);
  lines.push(`  | Hour | ${data.usage.hour} | ${data.limits.hour} | ${data.remaining.hour} |`);
  lines.push(`  | Day | ${data.usage.day} | ${data.limits.day} | ${data.remaining.day} |`);
  lines.push(`  | Month | ${data.usage.month} | ${data.limits.month} | ${data.remaining.month} |`);

  return lines.join('\n');
}

// ── Account Status (unified) ───────────────────────────────

export function formatAccountStatus(
  quota: CachedQuota,
  activeToken: { token_id: string; expires_at: string; allowed_regions: string[] } | null,
): string {
  const lines: string[] = ['ProbeOps Account Status'];

  // Diagnostic quota
  if (quota.diagnostic) {
    const d = quota.diagnostic;
    lines.push('');
    lines.push(`  Tier: ${d.tier}`);
    lines.push(`  Can Execute: ${d.can_execute ? 'Yes' : 'No - quota exceeded'}`);
    lines.push('');
    lines.push('  Diagnostic Quota:');
    lines.push('  | Window | Used | Limit | Remaining |');
    lines.push('  |--------|------|-------|-----------|');
    lines.push(`  | Minute | ${d.usage.minute} | ${d.limits.minute} | ${d.remaining.minute} |`);
    lines.push(`  | Hour | ${d.usage.hour} | ${d.limits.hour} | ${d.remaining.hour} |`);
    lines.push(`  | Day | ${d.usage.day} | ${d.limits.day} | ${d.remaining.day} |`);
    lines.push(`  | Month | ${d.usage.month} | ${d.limits.month} | ${d.remaining.month} |`);
  } else {
    lines.push('');
    lines.push('  Diagnostic Quota: (unavailable)');
  }

  // Proxy quota
  lines.push('');
  if (quota.proxy) {
    const p = quota.proxy;
    const remaining = p.quota - p.consumed;
    lines.push('  Proxy Token Quota:');
    lines.push(`    Consumed: ${p.consumed} / ${p.quota} daily`);
    lines.push(`    Remaining: ${remaining}`);
    lines.push(`    Resets at: ${p.resets_at}`);
  } else {
    lines.push('  Proxy Token Quota: (unavailable - may require paid plan)');
  }

  // Active proxy token
  lines.push('');
  if (activeToken) {
    const expiresMs = new Date(activeToken.expires_at).getTime() - Date.now();
    const minsLeft = Math.max(0, Math.round(expiresMs / 60000));
    lines.push('  Active Proxy Token:');
    lines.push(`    Token ID: ${activeToken.token_id}`);
    lines.push(`    Regions: ${activeToken.allowed_regions.join(', ')}`);
    lines.push(`    Expires in: ${minsLeft} minutes`);
  } else {
    lines.push('  Active Proxy Token: (none active)');
  }

  return lines.join('\n');
}
