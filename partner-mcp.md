# Partner MCP (AI agent integration)

Partners (MSPs) connect **their** AI agents to GlowOps fleet data through a dedicated MCP endpoint. Each partner has a login, assigned customer businesses, and rotatable MCP API keys.

## Isolation model

```
Partner A ──MCP key A──► only businesses bound to A
Partner B ──MCP key B──► only businesses bound to B
```

- Customer fleets stay in separate `businessId` partitions.
- MCP tools refuse businesses the partner is not assigned to.
- **Do not merge customer data into one tenant** for convenience. MSP rollup views (later) are explicit and audited — not shared storage.

## Security (Phase 0 demo → production path)

| Control | Now (local / getglowop demo) | Production target |
|---|---|---|
| Partner login | Email + PBKDF2 password, HttpOnly session cookie | Entra ID / OIDC (Go Live Easy Auth) |
| MCP auth | `Authorization: Bearer gow_mcp_…` (hashed at rest) | Same + short TTL keys, IP allowlists optional |
| Tenancy | `partner_businesses` allowlist | Postgres RLS on `business_id` |
| Secrets | Shown once at mint | Key Vault / Secrets Manager; never in git |
| Compliance narrative | Designed for **SOC 2** SaaS controls | SOC 2 Type I → II with evidence |

SOC 1 is for controls that affect customers’ financial statements. GlowOps is fleet inventory SaaS — **SOC 2** is the right track. Partner isolation is a SOC 2 access-control story, not a reason to claim SOC 1.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `/partner/` | Partner session | Mint/revoke MCP keys, see assigned businesses |
| `/mcp` | Bearer MCP key | JSON-RPC MCP (`initialize`, `tools/list`, `tools/call`) |
| `/app/` | None (demo) | Human GLOW Op Report UI |

## Tools

- `glowops_list_businesses`
- `glowops_fleet_summary`
- `glowops_list_devices`
- `glowops_get_device`
- `glowops_score_device`

## Agent config example

```json
{
  "mcpServers": {
    "glowops": {
      "url": "https://getglowop.com/mcp",
      "headers": {
        "Authorization": "Bearer gow_mcp_…"
      }
    }
  }
}
```

## Demo partner

- Email: `partner@getglowop.com`
- Password: `GlowOps-Partner-2026!`
- Bound business: `demo`

Change the password before any real customer data lands here.
