# @nuwa-ai/x402

Small helpers to add x402 payments to:
- MCP servers: mark tools as paid and verify/settle before running (tracks the original x402 MCP specification)
- HTTP/LLM proxies: gate endpoints with x402 and settle automatically (currently via a naive flat-price flow while v2 `upto` schema support is in progress)

Status
- `mcp` – aligned with the original x402 MCP spec used by x402-compatible clients today.
- `llm` – implements flat-price payments only; full v2 `upto` schema-based payments are under active development.

Exports
- `mcp` – `createPaidMcpHandler(serverInit, serverOptions, { recipient, network, facilitator })` for Nextjs, referred to vercel's [x402-mcp](https://github.com/ethanniser/x402-mcp).
- `llm` – `X402LlmPayments` and helpers (`createPaymentPlugin`, `logPaymentResponseHeader`, `decodePaymentResponseHeader`)
- Common types re-exported from `x402/types`

Install
- In this monorepo it is consumed via workspace. For external projects: `pnpm add @nuwa-ai/x402 x402 @modelcontextprotocol/sdk viem zod mcp-handler`.

MCP: Paid Tools
```ts
import { privateKeyToAccount } from "viem/accounts";
import z from "zod";
import { createPaidMcpHandler, type FacilitatorConfig } from "@nuwa-ai/x402/mcp";
import { facilitator } from "@coinbase/x402"; // FacilitatorConfig implementation

const seller = privateKeyToAccount(process.env.SERVICE_PRIVATE_KEY as `0x${string}`);
// Networks migrated from Base→X Layer; keep Base values temporarily for compatibility
const network =
  (process.env.NETWORK as "x-layer" | "x-layer-testnet" | "base" | "base-sepolia") ??
  "x-layer-testnet";

export const handler = createPaidMcpHandler(
  (server) => {
    // Paid tool – requires a valid _meta["x402/payment"] from the client
    server.paidTool(
      "add",
      "Add two numbers",
      { price: 0.001 }, // USD
      { a: z.number().int(), b: z.number().int() },
      {},
      async (args) => ({ content: [{ type: "text", text: String(args.a + args.b) }] }),
    );

    // Free tool – works like a normal MCP tool
    server.tool(
      "hello",
      "Say hello",
      { name: z.string() },
      async (args) => ({ content: [{ type: "text", text: `Hello ${args.name}` }] }),
    );
  },
  { serverInfo: { name: "example-mcp", version: "0.0.1" } },
  { recipient: seller.address, facilitator: facilitator as unknown as FacilitatorConfig, network },
);
```
Behavior
- If the client does not supply `_meta["x402/payment"]`, the server returns an error with an `accepts` array describing acceptable payment requirements.
- On success, the tool callback runs. Settlement is attempted afterward; if successful, `_meta["x402/payment-response"]` is attached to the result.
- On the client side (xNUWA), the MCP client will automatically handle the payment and extract payment info.

HTTP/LLM: Payment-Gated Endpoints
```ts
import type { NextRequest } from "next/server";
import { X402LlmPayments, type EnsurePaymentConfig } from "@nuwa-ai/x402/llm";
import { privateKeyToAccount } from "viem/accounts";

const seller = privateKeyToAccount(process.env.SERVICE_PRIVATE_KEY as `0x${string}`);
const payments = new X402LlmPayments(); // or pass a FacilitatorConfig

export async function POST(request: NextRequest) {
  const config: EnsurePaymentConfig = {
    payTo: seller.address,
    price: 0.01,          // USD
    network: "x-layer-testnet",
    config: { description: "My paid API", mimeType: "application/json" },
  };

  return payments.gateWithX402Payment(request, config, async () => {
    // Your upstream work here (call model provider, etc.)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}
```
Behavior
- Without an `X-PAYMENT` header the handler returns `402` and a JSON body describing `accepts` (requirements).
- With a valid payment: verifies first, runs your handler, then settles before returning. On success, adds `X-PAYMENT-RESPONSE` header with settlement details.
- Pricing today is fixed per endpoint invocation; v2 `upto` schema-driven pricing is forthcoming.

Facilitator
- The library uses `x402/verify` under the hood. You can pass a `FacilitatorConfig` to both MCP and LLM helpers.
- With Coinbase’s facilitator, provide `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET`, or import `facilitator` from `@coinbase/x402` and pass it through.

Configuration Notes
- `price` is in USD. The helpers compute the on-chain amount automatically for the selected `network` and asset.
- Networks: `x-layer-testnet` (default) and `x-layer` going forward. Base networks remain accepted for backward compatibility in this package, but end-to-end settlement requires facilitator and asset support on the target chain.
- For HTTP endpoints you can customize error messages, input/output schemas, and timeouts via `config` (`PaymentMiddlewareConfig`).

Utilities
- `logPaymentResponseHeader(response)` – logs decoded `X-PAYMENT-RESPONSE`.
- `decodePaymentResponseHeader(responseOrHeaders)` – parse the header programmatically.

See Also
- End-to-end usage in examples/nextjs (OpenRouter proxy and paid MCP server). You can exercise a hosted build at https://xnuwa.app.
