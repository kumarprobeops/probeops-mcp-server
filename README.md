# ProbeOps MCP Server

[![npm version](https://img.shields.io/npm/v/@probeops/mcp-server.svg)](https://www.npmjs.com/package/@probeops/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

**Infrastructure diagnostics and geo-proxy browsing for MCP clients.** Check SSL certificates, look up DNS records, monitor website uptime, measure latency, run traceroutes, scan ports, and browse the web from 6 global regions — all from your AI coding assistant.

Works with **Claude Code**, **Cursor**, **Windsurf**, **Cline**, and any [Model Context Protocol](https://modelcontextprotocol.io) compatible client.

```
You: "Is my production deployment healthy?"

ProbeOps MCP:
  SSL check on api.example.com      Valid, 89 days until expiry
  DNS lookup for api.example.com    A: 93.184.216.34 (consistent across 6 regions)
  Uptime check from 6 regions       All UP (avg 45ms)
  Port 443 open everywhere          6/6 regions confirm
  "Your deployment is healthy across all regions."

You: "What does our pricing page look like from India?"

ProbeOps MCP:
  geo_browse from ap-south           Page content + screenshot captured
  Proxy: Mumbai, India               Token reused (no quota consumed)
```

## Why ProbeOps MCP?

- **Multi-region diagnostics**: Every check runs from 6 locations simultaneously (US East, US West, EU, Canada, India, Australia)
- **16 tools in one server**: SSL, DNS (8 record types), uptime, latency, traceroute, port scan, geo-proxy, geo-browse
- **Geo-proxy browsing**: Browse any website from a specific country using a real browser with Playwright — see screenshots and page content
- **Smart token management**: Auto-extends proxy sessions to minimize quota consumption
- **Unified quota footer**: Every response shows remaining quota so you always know your usage
- **Zero config**: `npx -y @probeops/mcp-server` — no Docker, no database, no setup

## Quick Start

### 1. Get a Free API Key

Sign up at [probeops.com](https://probeops.com) and create an API key from the dashboard.

### 2. Add to Your MCP Client

**One-line install (Claude Code):**
```bash
claude mcp add probeops -- npx -y @probeops/mcp-server
```

**Manual config** (Claude Code, Cursor, Windsurf, Cline — add to `.mcp.json` or your client's MCP settings):

```json
{
  "mcpServers": {
    "probeops": {
      "command": "npx",
      "args": ["-y", "@probeops/mcp-server"],
      "env": {
        "PROBEOPS_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

That's it. Your MCP client now has 16 infrastructure diagnostic tools.

## Use Cases

### DevOps & SRE
- **Pre-deployment checks**: "Check SSL, DNS, and port 443 on staging.example.com before I deploy"
- **Incident investigation**: "Is api.example.com down? Check from all regions"
- **DNS propagation**: "I just changed the DNS for example.com — has it propagated globally?"
- **Certificate monitoring**: "When does the SSL certificate for example.com expire?"

### Email & Domain Configuration
- **Email deliverability**: "Check MX, SPF, DKIM, and DMARC records for example.com"
- **Domain verification**: "Look up TXT records for example.com to find the Google verification token"
- **Nameserver audit**: "What nameservers are authoritative for example.com?"

### Network Troubleshooting
- **Latency diagnosis**: "Measure latency to api.example.com from all regions"
- **Route analysis**: "Run a traceroute to 8.8.8.8 from Europe and Asia"
- **Firewall verification**: "Is port 5432 open on db.example.com from outside?"
- **Reverse DNS**: "What hostname is associated with IP 203.0.113.1?"

### Geo-Targeted Testing
- **Regional content**: "Show me what example.com/pricing looks like from Germany vs India"
- **CDN verification**: "Browse example.com from 3 different regions and compare the responses"
- **Geo-redirect testing**: "Does example.com redirect differently from the US vs Europe?"
- **Localization QA**: "Take a screenshot of our landing page as seen from Australia"

## Tools (16)

### SSL & Certificates

| Tool | Description | Example |
|------|-------------|---------|
| `ssl_check` | Check SSL/TLS certificate validity, expiry, issuer, TLS version, SANs, and cross-region consistency | `{ "domain": "example.com" }` |
| `caa_lookup` | Look up CAA records to see which CAs can issue certificates for a domain | `{ "domain": "example.com" }` |

### DNS (7 tools)

| Tool | Description | Example |
|------|-------------|---------|
| `dns_lookup` | Look up any DNS record type (A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, PTR) with multi-region propagation check | `{ "domain": "example.com", "record_type": "A" }` |
| `mx_lookup` | Look up MX records — verify mail server configuration and priorities | `{ "domain": "example.com" }` |
| `txt_lookup` | Look up TXT records — check SPF, DKIM, DMARC, domain verification tokens | `{ "domain": "example.com" }` |
| `ns_lookup` | Look up NS records — verify authoritative nameservers and delegation | `{ "domain": "example.com" }` |
| `cname_lookup` | Look up CNAME records — verify CDN configuration and subdomain routing | `{ "domain": "www.example.com" }` |
| `reverse_dns_lookup` | Reverse DNS (PTR) lookup — find the hostname for an IP address | `{ "ip": "8.8.8.8" }` |

### Monitoring & Network

| Tool | Description | Example |
|------|-------------|---------|
| `is_it_down` | Check if a website is up, down, or partially available from multiple regions | `{ "url": "https://example.com" }` |
| `latency_test` | Measure network latency (TTFB) from multiple regions with min/avg/max stats | `{ "target": "example.com" }` |
| `traceroute` | Trace network path with per-hop latency (TCP, UDP, or ICMP) | `{ "target": "example.com", "protocol": "tcp" }` |
| `port_check` | Check if a port is open, closed, or filtered from multiple regions | `{ "target": "example.com", "port": 443 }` |

### Geo-Proxy Browsing

| Tool | Description | Example |
|------|-------------|---------|
| `get_geo_proxy` | Get proxy credentials for a specific region — use with Playwright or any HTTPS proxy client | `{ "region": "eu-central" }` |
| `geo_browse` | Browse a URL from a geographic region — returns page content and/or a viewport screenshot | `{ "url": "https://example.com", "region": "us-east" }` |

### Account

| Tool | Description | Example |
|------|-------------|---------|
| `account_status` | Show subscription tier, diagnostic quota, proxy quota, and active token details | `{}` |

## Resources

| URI | Description |
|-----|-------------|
| `probeops://regions` | Available probe regions with location, country, and node count |
| `probeops://proxy-regions` | Geo-proxy regions with FQDNs and proxy URLs for Playwright |
| `probeops://usage` | Current API usage, remaining quota, and active token status |

## Global Regions

All tools run from **6 probe regions** simultaneously:

| Region Code | Location | Country |
|-------------|----------|---------|
| `us-east` | Ashburn, Virginia | United States |
| `us-west` | Boardman, Oregon | United States |
| `eu-central` | Helsinki | Finland |
| `ca-central` | Montreal | Canada |
| `ap-south` | Mumbai | India |
| `ap-southeast` | Sydney | Australia |

## Geo-Proxy: Smart Token Management

The MCP server manages proxy tokens automatically to minimize quota consumption:

| Token State | Action | Quota Cost |
|-------------|--------|------------|
| > 5 min remaining | Reuse cached token | 0 (free) |
| 0–5 min remaining | Auto-extend +1 hour | 1 unit |
| Expired or no token | Generate new token | 1 unit |

- A single token works across **all 6 regions** — switching regions does not consume quota
- Daily quota = total hours of proxy browsing per day
- Free tier: 3 hours/day, Standard: 5 hours/day, Professional: 10 hours/day
- Quota resets at midnight UTC

After each auto-extend, a one-time notice is shown:
```
Proxy session extended (+1 hour). 3 of 5 daily hours used. Resets at 2026-02-13T00:00:00Z
```

## Tool Output Examples

### SSL Certificate Check
```
ssl_check({ domain: "github.com" })

SSL Certificate Report for github.com
  Status: VALID
  Subject: github.com
  Issuer: DigiCert (DigiCert Inc)
  Expires in: 245 days
  TLS: TLSv1.3 (TLS_AES_256_GCM_SHA384)

  | Region | Location | Status | Time |
  |--------|----------|--------|------|
  | us-east | Ashburn | OK | 45ms |
  | eu-central | Helsinki | OK | 38ms |
  | ap-south | Mumbai | OK | 112ms |
  ...
---
Diagnostics: 47 of 50 remaining today (Free)
```

### Email Configuration Audit
```
mx_lookup({ domain: "google.com" })

DNS Lookup: google.com (MX)
  us-east: 10 smtp.google.com. (12ms)
  eu-central: 10 smtp.google.com. (8ms)

txt_lookup({ domain: "google.com" })

DNS Lookup: google.com (TXT)
  "v=spf1 include:_spf.google.com ~all"
  "google-site-verification=..."
```

### Geo-Browse with Screenshot
```
geo_browse({ url: "https://example.com/pricing", region: "eu-central" })

Geo-Browse: https://example.com/pricing from eu-central
  Proxy: node-1-eu-central.probeops.com
  Final URL: https://example.com/pricing
  Title: Pricing - Example

  Page Content:
  Plans start at $9/month...

  [Screenshot attached as image]
---
Proxy hours: 8 of 10 remaining today | Active token: 47 min remaining
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROBEOPS_API_KEY` | Yes | — | Your ProbeOps API key ([get one free](https://probeops.com/dashboard/api-keys)) |
| `PROBEOPS_BASE_URL` | No | `https://probeops.com` | API base URL (for staging or self-hosted instances) |

## Pricing

|  | **Free** | **Standard** | **Professional** |
|--|----------|-------------|-----------------|
| **Price** | Free forever | [See pricing](https://probeops.com/pricing) | [See pricing](https://probeops.com/pricing) |
| Per minute | 15 | 30 | 50 |
| Per hour | 100 | 500 | 2,000 |
| Per day | 100 | 1,000 | 5,000 |
| Per month | 500 | 20,000 | 100,000 |
| Concurrent | 3 | 5 | 10 |
| Proxy browsing | 3 hours/day | 5 hours/day | 10 hours/day |
| Regions | 4 of 6 | All 6 | All 6 |

Limits are designed for MCP usage — per-minute is generous enough for parallel tool calls, daily/monthly caps scale with your needs. Check your current usage anytime with the `account_status` tool.

> Limits may change as we evolve pricing. See [probeops.com/pricing](https://probeops.com/pricing) for current details.

## Development

```bash
git clone https://github.com/kumarprobeops/probeops-mcp-server.git
cd probeops-mcp-server
npm install
npm run build
```

Test locally:
```bash
PROBEOPS_API_KEY=your-key node dist/index.js
```

Watch mode:
```bash
npm run dev
```

## Requirements

- **Node.js** >= 18.0.0
- **Playwright** (optional) — for `geo_browse` full browser rendering with screenshots
  ```bash
  npx playwright install chromium
  ```
  Without Playwright, `geo_browse` falls back to HTTP fetch (raw HTML, no screenshots).

## FAQ

**Q: How is this different from running `curl` or `dig` locally?**
Every ProbeOps check runs from 6 global regions simultaneously. You see latency, DNS propagation, and availability from the perspective of real users worldwide — not just your local network.

**Q: Do I need to install anything besides Node.js?**
No. `npx -y @probeops/mcp-server` downloads and runs everything. Playwright is optional (only needed for `geo_browse` screenshots).

**Q: Does switching proxy regions use extra quota?**
No. A single proxy token works across all 6 regions. Switching regions mid-session is free.

**Q: What happens when my proxy token expires?**
The server auto-extends it if you have remaining quota. If quota is exhausted, it reports the reset time. No manual token management needed.

**Q: Can I use this in CI/CD pipelines?**
Yes. Set `PROBEOPS_API_KEY` as an environment variable and call the MCP server from any MCP-compatible automation tool.

**Q: Is the API key sent securely?**
Yes. All API communication uses HTTPS. The key is sent via the `X-API-Key` header, never in URLs or logs.

## License

MIT — see [LICENSE](LICENSE)

## Links

- [ProbeOps Platform](https://probeops.com)
- [API Documentation](https://probeops.com/docs)
- [Get Free API Key](https://probeops.com/dashboard/api-keys)
- [Pricing Plans](https://probeops.com/pricing)
- [Report Issues](https://github.com/kumarprobeops/probeops-mcp-server/issues)
- [npm Package](https://www.npmjs.com/package/@probeops/mcp-server)
