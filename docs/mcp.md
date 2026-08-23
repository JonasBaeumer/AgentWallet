# MCP Server — Agent Integration

Tranzact exposes its agent-facing surface as a **Model Context Protocol (MCP) server**
over the Streamable HTTP transport, mounted at `/mcp` on the main server. This replaces
the previous skill-based integration (`skills/tranzact-checkout`), where an instruction
file told the agent which REST endpoints to call: an MCP-capable agent now discovers the
tools, their schemas, and the workflow rules directly from the server.

The REST endpoints under `/v1` remain in place — internal workers use them, and
[docs/openclaw.md](openclaw.md) documents them for non-MCP integrations — but the MCP
endpoint is the recommended integration surface for agents.

---

## Connecting

The endpoint is `POST {BASE_URL}/mcp` (Streamable HTTP, stateless — no session
affinity required). Two credentials travel as HTTP headers on the connection:

| Header | Value | Purpose |
|---|---|---|
| `X-Worker-Key` | `WORKER_API_KEY` | Required on every request; same shared secret as `/v1/agent/*` |
| `Authorization` | `Bearer <user API key>` | The user's API key (issued during Telegram signup); required only for `create_intent` |
| `X-Agent-Id` | agentId from `register_agent` | Optional; forwarded to every delegated route so audit events attribute actions to the agent. Add it to the connection config after registration |

### Claude Code

```bash
claude mcp add tranzact --transport http https://pay.example.com/mcp \
  --header "X-Worker-Key: <WORKER_API_KEY>" \
  --header "Authorization: Bearer <USER_API_KEY>"
```

### Generic MCP client config

```json
{
  "mcpServers": {
    "tranzact": {
      "url": "https://pay.example.com/mcp",
      "headers": {
        "X-Worker-Key": "<WORKER_API_KEY>",
        "Authorization": "Bearer <USER_API_KEY>"
      }
    }
  }
}
```

The server declares workflow instructions during the `initialize` handshake, so any
client that surfaces server instructions gives its model the full purchase flow
without extra prompt engineering.

---

## Tools

The seven tools map 1:1 onto the agent purchase flow. Every call delegates
internally to the corresponding REST route, so validation, state-machine rules,
rate limits, idempotency, and audit logging are identical to REST. The MCP
boundary additionally validates arguments before delegating and is stricter in
two places: unknown argument properties are rejected (`additionalProperties:
false`; the REST schemas strip them), and `report_result` requires
`actualAmount` when `success` is true (REST permits omitting it).

| Tool | Wraps | Notes |
|---|---|---|
| `register_agent` | `POST /v1/agent/register` | One-time; returns `agentId` + Telegram `pairingCode`. Rate limit 3/10 min |
| `get_pairing_status` | `GET /v1/agent/user` | `unclaimed` → `claimed` once the user pairs |
| `create_intent` | `POST /v1/intents` | Uses the connection's `Authorization` header. Pass `idempotencyKey` and reuse it when retrying the same request after a lost response — the server then returns the original intent instead of creating a duplicate. Auto-generated when omitted (no retry dedup) |
| `submit_quote` | `POST /v1/agent/quote` | Triggers the Telegram approval request |
| `get_decision` | `GET /v1/agent/decision/:intentId` | Optional `waitSeconds` (max 25) server-side long-poll replaces the old client polling script |
| `reveal_card` | `GET /v1/agent/card/:intentId` | **One-time reveal**; 429 does not consume it. Rate limit 2/min per intent |
| `report_result` | `POST /v1/agent/result` | Always the final step; settles the ledger, cancels the card |

Tool results carry the route's JSON response as text content. Non-2xx responses
come back as tool errors prefixed with the HTTP status (e.g. `HTTP 409: {...}`),
so state-conflict semantics stay visible to the agent.

> **Do not run the stub worker alongside MCP agents.** `create_intent` (like
> `POST /v1/intents`) enqueues a job on the internal `search-queue`; if
> `npm run worker` is running, its stub processor immediately posts a fake
> Amazon quote and triggers an approval request, so the MCP agent's own
> `submit_quote` gets a `409`. Run the stub worker or a real MCP agent, not
> both — the same warning the REST guide gives in `docs/openclaw.md`.

### Approval waiting

The old skill launched a background Python script to poll for the user's decision
and wake the agent via a system event. With MCP, call `get_decision` with
`waitSeconds: 20` in a loop: the server holds each request open and re-checks the
decision every 2.5 s, so the agent makes ~3 calls per minute of waiting instead
of 12. Agent frameworks with a yield/wake mechanism can still layer that on top.

The server instructions preserve the previous integration's cutoff: after ~10
minutes still in `AWAITING_APPROVAL`, the agent stops polling and tells the user
the approval request timed out (intents without `expiresAt` are not expired
server-side, so the client owns the cutoff).

---

## Design notes

- **Stateless transport.** Each POST builds a fresh server + transport pair.
  `GET /mcp` and `DELETE /mcp` return 405 — there is no server-initiated stream
  and no session to delete. This keeps the endpoint horizontally scalable.
- **Delegation via `app.inject()`.** Tools do not reimplement business logic; they
  issue in-process requests against the same Fastify app. The real client IP is
  forwarded (`remoteAddress`) so per-IP rate limits key on the agent, not on
  loopback.
- **Rate-limit interaction.** An MCP tool call consumes the global per-IP budget
  twice: once for the `/mcp` POST itself and once for the injected `/v1` request.
  With the global limit at 60/min this is not a practical constraint for the
  purchase flow.
- **Card credentials** pass through the MCP response exactly once, mirroring the
  REST one-time reveal. They are never logged or persisted by the MCP layer.
