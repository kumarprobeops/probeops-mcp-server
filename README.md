# ProbeOps MCP Server

[![npm version](https://img.shields.io/npm/v/@probeops/mcp-server.svg)](https://www.npmjs.com/package/@probeops/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io)

MCP server for running infrastructure diagnostics from 6 global regions. SSL checks, DNS lookups, ping, whois, port checks, traceroute, latency tests, and more — each executed simultaneously from US East, US West, EU Central, Canada, India, and Australia.

Also includes geo-proxy browsing: load any URL through a real browser from a specific region and get page content + screenshots.

Works with **Claude Code**, **Codex**, **Cursor**, **Windsurf**, **Cline**, and any [Model Context Protocol](https://modelcontextprotocol.io) compatible client.

## Quick Start

### 1. Get an API Key

Sign up at [probeops.com](https://probeops.com) and create an API key from the dashboard. Free tier available.

### 2. Add to Your MCP Client

**Claude Code:**
```bash
claude mcp add probeops -- npx -y @probeops/mcp-server
```

**Codex:**
```bash
codex mcp add probeops -- npx -y @probeops/mcp-server
```
Or add to `~/.codex/config.toml`:
```toml
[mcp_servers.probeops]
command = "npx"
args = ["-y", "@probeops/mcp-server"]

[mcp_servers.probeops.env]
PROBEOPS_API_KEY = "your-api-key-here"
```

**Cursor / Windsurf / Cline** (add to `.mcp.json` or your client's MCP config):
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

## What You Get

14 infrastructure diagnostic tools, each running from 6 regions simultaneously. Plus geo-proxy browsing and account management.

Every diagnostic tool call returns per-region results and a quota footer showing remaining usage.

### Diagnostic Tools (14)

| Tool | What it does | Example input |
|------|-------------|---------------|
| `ssl_check` | SSL/TLS certificate validity, expiry, issuer, TLS version, SANs, cross-region consistency | `{ "domain": "example.com" }` |
| `dns_lookup` | DNS record lookup (A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, PTR) with multi-region propagation check | `{ "domain": "example.com", "record_type": "MX" }` |
| `is_it_down` | Website up/down/partial status from multiple regions | `{ "url": "https://example.com" }` |
| `latency_test` | HTTP latency (TTFB) from multiple regions, returns min/avg/max | `{ "target": "example.com" }` |
| `traceroute` | Network path tracing with per-hop latency. TCP, UDP, or ICMP | `{ "target": "example.com", "protocol": "tcp" }` |
| `port_check` | Port open/closed/filtered check from multiple regions | `{ "target": "example.com", "port": 443 }` |
| `ping` | ICMP ping with packet loss and round-trip times | `{ "target": "8.8.8.8" }` |
| `whois` | Domain registration info: registrar, dates, nameservers | `{ "domain": "example.com" }` |
| `nmap_port_check` | Check multiple ports open/closed using nmap (not a full scan) | `{ "target": "example.com", "ports": "80,443" }` |
| `tcp_ping` | TCP-level latency to a specific port (works when ICMP is blocked) | `{ "target": "example.com", "port": 443 }` |
| `keyword_check` | Check if a keyword exists on a web page from multiple regions | `{ "url": "https://example.com", "keyword": "pricing" }` |
| `websocket_check` | WebSocket endpoint connectivity check | `{ "url": "wss://example.com/ws" }` |
| `banner_grab` | Service banner/version detection on a port | `{ "target": "example.com", "port": 22 }` |
| `api_health` | API endpoint health check (HTTP status, response time, availability) | `{ "url": "https://api.example.com/health" }` |

### DNS Shortcuts

These call `dns_lookup` with a preset `record_type` so you don't have to remember record type names:

| Tool | Equivalent to |
|------|--------------|
| `mx_lookup` | `dns_lookup` with `record_type: "MX"` |
| `txt_lookup` | `dns_lookup` with `record_type: "TXT"` |
| `ns_lookup` | `dns_lookup` with `record_type: "NS"` |
| `cname_lookup` | `dns_lookup` with `record_type: "CNAME"` |
| `caa_lookup` | `dns_lookup` with `record_type: "CAA"` |
| `reverse_dns_lookup` | `dns_lookup` with `record_type: "PTR"` (takes an IP address) |

### Geo-Proxy Browsing

| Tool | What it does | Example input |
|------|-------------|---------------|
| `get_geo_proxy` | Get proxy credentials for a region. Use with Playwright or any HTTPS proxy client | `{ "region": "eu-central" }` |
| `geo_browse` | Browse a URL from a region using a real browser. Returns page content and/or screenshot | `{ "url": "https://example.com", "region": "ap-south" }` |

### Account

| Tool | What it does |
|------|-------------|
| `account_status` | Current quota usage (minute/hour/day/month), subscription tier, active proxy token |

## Resources

| URI | Description |
|-----|-------------|
| `probeops://regions` | Probe regions with location, country, and node count |
| `probeops://proxy-regions` | Geo-proxy regions with FQDNs and proxy URLs |
| `probeops://usage` | Current API usage, remaining quota, active token status |

## Global Regions

All diagnostic tools run from these 6 regions simultaneously:

| Region Code | Location | Country |
|-------------|----------|---------|
| `us-east` | Ashburn, Virginia | United States |
| `us-west` | Boardman, Oregon | United States |
| `eu-central` | Helsinki | Finland |
| `ca-central` | Montreal | Canada |
| `ap-south` | Mumbai | India |
| `ap-southeast` | Sydney | Australia |

## Geo-Proxy Token Management

The server manages proxy tokens automatically:

| Token State | Action | Quota Cost |
|-------------|--------|------------|
| > 5 min remaining | Reuse cached token | 0 |
| 0-5 min remaining | Auto-extend +1 hour | 1 unit |
| Expired or no token | Generate new token | 1 unit |

- A single token works across all 6 regions. Switching regions does not consume quota.
- Daily quota = total hours of proxy browsing per day.
- Quota resets at midnight UTC.

## Output Examples

### SSL Check
```
ssl_check({ domain: "github.com" })

SSL Certificate Report for github.com
  Status: VALID
  Subject: github.com
  Issuer: DigiCert (DigiCert Inc)
  Expires in: 245 days
  TLS: TLSv1.3 (TLS_AES_256_GCM_SHA384)

  Region Results:
  | Region | Location | Status | Time |
  |--------|----------|--------|------|
  | us-east | Ashburn | OK | 45ms |
  | eu-central | Helsinki | OK | 38ms |
  | ap-south | Mumbai | OK | 112ms |
  | us-west | Boardman | OK | 52ms |
  | ca-central | Montreal | OK | 41ms |
  | ap-southeast | Sydney | OK | 98ms |

  Completed in 125ms
---
Diagnostics: 97 of 100 remaining today (Free)
```

### Ping
```
ping({ target: "1.1.1.1" })

Ping: 1.1.1.1

  ap-south (Mumbai):
    PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
    64 bytes from 1.1.1.1: icmp_seq=1 ttl=56 time=1.35 ms
    3 packets transmitted, 3 received, 0% packet loss
    rtt min/avg/max/mdev = 1.353/1.398/1.474/0.054 ms
    Response time: 2147ms

  eu-central (Helsinki):
    PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
    64 bytes from 1.1.1.1: icmp_seq=1 ttl=54 time=21.2 ms
    3 packets transmitted, 3 received, 0% packet loss
    rtt min/avg/max/mdev = 20.651/20.941/21.217/0.231 ms
    Response time: 2031ms
  ...

  Completed in 2332ms
---
Diagnostics: 96 of 100 remaining today (Free)
```

### Whois
```
whois({ domain: "example.com" })

Whois: example.com

  us-east (Ashburn):
    Domain Name: EXAMPLE.COM
    Registry Domain ID: 2336799_DOMAIN_COM-VRSN
    Registrar: RESERVED-Internet Assigned Numbers Authority
    Creation Date: 1995-08-14T04:00:00Z
    Registry Expiry Date: 2025-08-13T04:00:00Z
    Name Server: A.IANA-SERVERS.NET
    Name Server: B.IANA-SERVERS.NET
    DNSSEC: signedDelegation
    Response time: 734ms
  ...

  Completed in 852ms
---
Diagnostics: 95 of 100 remaining today (Free)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROBEOPS_API_KEY` | Yes | - | Your ProbeOps API key ([get one free](https://probeops.com/dashboard/api-keys)) |
| `PROBEOPS_BASE_URL` | No | `https://probeops.com` | API base URL (for staging or self-hosted instances) |

## Rate Limits

|  | **Free** | **Standard** | **Professional** |
|--|----------|-------------|-----------------|
| Per minute | 15 | 30 | 50 |
| Per hour | 100 | 500 | 2,000 |
| Per day | 100 | 1,000 | 5,000 |
| Per month | 500 | 20,000 | 100,000 |
| Concurrent | 3 | 5 | 10 |
| Proxy hours/day | 3 | 5 | 10 |
| Regions | 4 of 6 | All 6 | All 6 |

Free tier requires no credit card. Check usage anytime with `account_status`.

See [probeops.com/pricing](https://probeops.com/pricing) for current details.

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

## Requirements

- **Node.js** >= 18.0.0
- **Playwright** (optional) - only needed for `geo_browse` screenshots
  ```bash
  npx playwright install chromium
  ```
  Without Playwright, `geo_browse` falls back to HTTP fetch (raw HTML, no screenshots).

## FAQ

**Q: How is this different from running `curl` or `dig` locally?**
Every check runs from 6 global regions simultaneously. You see DNS propagation, latency, and availability from the perspective of real users worldwide, not your local network.

**Q: Do I need to install anything besides Node.js?**
No. `npx -y @probeops/mcp-server` handles everything. Playwright is optional (only for `geo_browse` screenshots).

**Q: Can I use this in CI/CD pipelines?**
Yes. Set `PROBEOPS_API_KEY` as an environment variable and call the MCP server from any MCP-compatible tool.

**Q: Is the API key sent securely?**
Yes. All communication uses HTTPS. The key is sent via the `X-API-Key` header, never in URLs or logs.

## License

MIT - see [LICENSE](LICENSE)

## Links

- [ProbeOps Platform](https://probeops.com)
- [Get API Key](https://probeops.com/dashboard/api-keys)
- [Pricing](https://probeops.com/pricing)
- [Report Issues](https://github.com/kumarprobeops/probeops-mcp-server/issues)
- [npm Package](https://www.npmjs.com/package/@probeops/mcp-server)
