# GlowOps live dashboard (local)

Stdlib Python + SQLite. No login.

## Run

```bat
Start-GlowOps.bat
```

Or: `python server.py` → http://127.0.0.1:8787/

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | `{ok, auth: none}` |
| GET | `/api/summary?tenant=demo` | Fleet KPIs + byCall |
| GET | `/api/devices?tenant=demo` | Scored inventory |
| GET | `/api/export.csv?tenant=demo` | CSV |
| POST | `/api/ingest` | Graph managedDevices / `{value:[…]}` |
| POST | `/api/agent/heartbeat` | Agent ping (+ optional devices) |
| POST | `/api/score` | Score one device, no persist |
| GET | `/download/agent.zip` | Downloadable agent |

## Agent

```bat
python agent\agent.py sample
python agent\agent.py inventory --file sample-devices.json
python agent\agent.py heartbeat
```

Env: `GLOWOPS_URL`, `GLOWOPS_TENANT`, `GLOWOPS_AGENT_ID`.

## Scoring

Ported from Go Live Device Lifecycle Advisor (`packages/shared/src/device-lifecycle/scoring.ts`).
