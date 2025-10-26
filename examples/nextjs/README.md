# Next.js Example (x402)

Minimal Next.js app demonstrating two flows:
- Remote MCP server with paid tools at `/mcp`
- OpenRouter proxy gated by x402 at `/openrouter` and `/openrouter/[...path]`

Setup
- Node 18+ (20 recommended) and pnpm 9+
- Create `examples/nextjs/.env.local`:
```
# Recipient account (used to derive payTo). DO NOT use a hot mainnet key in dev.
SERVICE_PRIVATE_KEY=0x...
# Network: base-sepolia (default) or base
NETWORK=base-sepolia
# For the OpenRouter proxy
OPENROUTER_API_KEY=sk-or-...
# Optional CORS origin to allow browser apps
ALLOWED_ORIGIN=http://localhost:3000
# If using Coinbase facilitator for MCP or LLM helpers
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
```

Run
- From repo root: `pnpm dev`
- Next.js dev server listens on http://localhost:3000

Endpoints
- `GET/POST /mcp` – MCP server
  - Paid tools: see examples/nextjs/src/app/mcp/route.ts:1
  - Supply `_meta["x402/payment"]` in the MCP client request. If missing/invalid, you receive an error with `accepts` requirements.
- `GET/POST /openrouter` and `/openrouter/[...path]` – OpenRouter proxy
  - Without `X-PAYMENT` header returns `402` and a JSON body describing `accepts`.
  - With a valid payment the request is forwarded; settlement happens before response returns.
  - The response includes `X-PAYMENT-RESPONSE` header on successful settlement.

Production
- Switch to mainnet by setting `NETWORK=base` and funding the recipient address with USDC.
- Ensure your facilitator credentials are set if you use Coinbase’s facilitator in production.
