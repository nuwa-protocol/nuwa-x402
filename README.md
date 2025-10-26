# Nuwa x402 Monorepo

Helpers and examples for adding x402 payments to AI agents, MCP servers, and HTTP/LLM proxies.

What is inside
- `packages/x402` – TypeScript helpers published as `@nuwa-ai/x402` for: 1) paid MCP tools (`createPaidMcpHandler`) and 2) HTTP payment gating for LLM/API proxies (`X402LlmPayments`). See packages/x402/README.md.
- `examples/nextjs` – Minimal Next.js app that exposes: 1) a remote MCP server with paid tools and 2) an OpenRouter proxy gated by x402 payments. See examples/nextjs/README.md.

Prerequisites
- Node 18+ (20 recommended), pnpm 9+, a Base wallet for receiving payments, and an OpenRouter API key (for the proxy example).
- Default network is `base-sepolia` (testnet). Set `NETWORK=base` to use mainnet.

Quick Start
```bash
pnpm install
pnpm dev        # runs the Next.js example
```

Environment
- Example (Next.js) expects the following in `examples/nextjs/.env.local`:
  - `SERVICE_PRIVATE_KEY` – 32-byte 0x-prefixed hex; used only to derive the recipient address.
  - `OPENROUTER_API_KEY` – for the OpenRouter proxy.
  - `NETWORK` – `base-sepolia` (default) or `base`.
  - `ALLOWED_ORIGIN` – optional CORS origin for API access from browsers.
- If you use the Coinbase facilitator, you also need:
  - `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (see https://docs.cdp.coinbase.com/).

Run The Example
- Start: `pnpm dev` then visit http://localhost:3000 (API-only example).
- OpenRouter proxy: `GET/POST /openrouter` and `/openrouter/[...path]` – responds `402` with payment requirements until a valid `X-PAYMENT` header is provided.
- MCP server: `GET/POST /mcp` – exposes paid tools; returns an error with `accepts` data until the MCP client supplies `_meta["x402/payment"]`.

Production Notes
- Switch to mainnet by setting `NETWORK=base` and funding the recipient address with USDC.
- The example always settles before returning and forwards `X-PAYMENT-RESPONSE` with settlement details for observability.
