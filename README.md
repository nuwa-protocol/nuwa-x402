# Nuwa x402 SDK and Example

This repo contains the implementation of the x402-based service implementations. We plan keep tracking on the progress of x402 protocol and provide up-to-date examples and packages.


What is inside
- `packages/x402` – TypeScript packages published as `@nuwa-ai/x402` for: 1) paid MCP tools (`createPaidMcpHandler`) fully aligned with the original x402 MCP spec , forked from vercel's implementation. and 2) HTTP payment gating for LLM/API proxies (`X402LlmPayments`). The LLM helper presently supports a naive flat-price charge while v2 `upto` schema-based payments are in development. See packages/x402/README.md for details and roadmap notes.
- `examples/nextjs` – Minimal Next.js app that exposes: 1) a remote MCP server with paid tools and 2) an OpenRouter proxy gated by x402 payments. See examples/nextjs/README.md.

Prerequisites
- Node 18+ (20 recommended), pnpm 9+, an X Layer wallet for receiving payments, and an OpenRouter API key (for the proxy example).
- Default network is now `x-layer-testnet`. Set `NETWORK=x-layer` to use mainnet.

Quick Start
```bash
pnpm install
pnpm dev        # runs the Next.js example
```

Environment
- Example (Next.js) expects the following in `examples/nextjs/.env.local`:
  - `SERVICE_PRIVATE_KEY` – 32-byte 0x-prefixed hex; used only to derive the recipient address.
  - `OPENROUTER_API_KEY` – for the OpenRouter proxy.
  - `NETWORK` – `x-layer-testnet` (default) or `x-layer`. (Base values are still accepted for backward compatibility.)
  - `ALLOWED_ORIGIN` – optional CORS origin for API access from browsers.
- For Coinbase facilitator, you also need:
  - `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (see https://docs.cdp.coinbase.com/).
  - Or set `X402_FACILITATOR_URL` to use a custom facilitator that supports X Layer.

Run The Example
- Start: `pnpm dev` then visit http://localhost:3000 (API-only example). A hosted build is also available at xNUWA https://xnuwa.app for quickly exercising the MCP and LLM endpoints.
- OpenRouter proxy: `GET/POST /openrouter` and `/openrouter/[...path]` – responds `402` with payment requirements until a valid `X-PAYMENT` header is provided. Currently uses the flat-price flow exposed by `X402LlmPayments`.
- MCP server: `GET/POST /mcp` – exposes paid tools; returns an error with `accepts` data until the MCP client supplies `_meta["x402/payment"]`.

Production Notes
- Switch to mainnet by setting `NETWORK=x-layer` and funding the recipient address with the supported stablecoin on X Layer.
- The example always settles before returning and forwards `X-PAYMENT-RESPONSE` with settlement details for observability.
