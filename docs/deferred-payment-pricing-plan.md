# Deferred Payment Per Address: Refactor Plan

This plan enables dynamic pricing based on user identity (payer address) and a “pay previous request” workflow. It covers changes to:

- packages/x402/src/llm/index.ts
- examples/nextjs/src/app/openrouter/proxy-handler.ts

## Objectives

- Identify user by address from decoded x402 payment header.
- First successful request registers the user with a 0-amount payment; after success, compute that request’s cost and store it as the user’s debt (USD).
- Subsequent requests require payment equal to the last stored debt for that address; after success, compute the new cost and store it for next time.
- Keep the x402 verification + settlement flow intact; add minimal, backwards-compatible extension points.

## Data And Interfaces

- IOU/debt store (example app):
  - getOwedUSD(address): Promise<number | 0>
  - setOwedUSD(address, amountUSD: number, meta?): Promise<void>
  - clear(address): Promise<void> (optional)
  - Start with in-memory Map in the example; can be swapped to Redis/DB later.

- Cost extraction:
  - extractCostUSD(response: Response, request: Request): Promise<number>
  - Stub in the example app; later, parse OpenRouter usage or headers and convert to USD.

## Library Changes (packages/x402/src/llm/index.ts)

1) Dynamic Config Builder in gateWithX402Payment

- Add a new overload for the `config` parameter so it can be either:
  - EnsurePaymentConfig, or
  - (ctx: { request: Request; rawPayment?: PaymentPayload }) => EnsurePaymentConfig | Promise<EnsurePaymentConfig>

- Implementation:
  - Before calling `createRequirements`, attempt a non-fatal decode of the payment header (`X-PAYMENT`) to get `rawPayment` (address may be present), ignoring decode errors.
  - If `config` is a function, call it with `{ request, rawPayment }` to resolve a concrete EnsurePaymentConfig.
  - Proceed with the existing flow: `createRequirements -> checkPaymentHeader -> verifyPayment -> handler -> settlePayment`.

- Notes:
  - This lets the caller pick a price dynamically per request based on the (claimed) address in `rawPayment`.

2) Surface Payer From Verification (optional)

- Update `verifyPayment()` success return to also include `payer?: Address` from the underlying facilitator verification result.
- Non-breaking: it’s an optional property on the success object.
- Optional: pass `payer` into the handler context.

3) Optional settleOnError flag

- Add `settleOnError?: boolean` to `gateWithX402Payment` options and thread to `settlePayment`.
- If true, attempt settlement regardless of upstream response status; else keep current behavior (skip when `status >= 400`).
- This is useful if you always want the previous-request’s debt to settle even when the current upstream call fails.

4) No changes to price processing

- Keep using USD input; `processPriceToAtomicAmount` continues to convert per-network.

## Example App Changes (examples/nextjs/src/app/openrouter/proxy-handler.ts)

1) Add an in-memory IOU store keyed by payer address

```ts
const pendingByAddress = new Map<string, number>(); // USD
function getOwedUSD(addr: string) { return pendingByAddress.get(addr) ?? 0; }
function setOwedUSD(addr: string, usd: number) { pendingByAddress.set(addr, usd); }
```

2) Supply a dynamic config builder to payments.gateWithX402Payment

- Replace the fixed `resolvePaymentConfig` usage with a function that returns an `EnsurePaymentConfig` using the claimed address in `rawPayment` (if present):

```ts
const dynamicConfig = async (ctx: { request: Request; rawPayment?: any }) => {
  const env = getEnv();
  const account = getServiceAccount();
  const claimed = (ctx.rawPayment as any)?.payer
              ?? (ctx.rawPayment as any)?.from
              ?? (ctx.rawPayment as any)?.owner;
  const owedUSD = claimed ? getOwedUSD(claimed) : 0; // registration flow when unknown
  return {
    payTo: account.address,
    price: owedUSD,           // in USD
    network: env.NETWORK,
    config: {
      description: "Access to OpenRouter proxy",
      mimeType: "application/json",
    },
  } as EnsurePaymentConfig;
};
```

- Behavior:
  - No/invalid header → price=0 → 402 flow with zero amount (user registration step).
  - With header → price=debt for that address.

3) Compute current request’s cost and save as next debt in onSettle

- In the upstream handler, compute the next USD cost and keep it in a closure variable to be used in `onSettle`:

```ts
let nextCostUSD: number | null = null;
const handler = async () => {
  const upstreamResponse = await makeUpstream();
  nextCostUSD = await extractCostUSD(upstreamResponse.clone(), request);
  return upstreamResponse;
};

const onSettle = (settlementResult: PaymentSettlementResult) => {
  const ok = settlementResult.ok && settlementResult.settlement;
  const payer = ok ? (settlementResult.settlement!.payer as string | undefined) : undefined;
  if (ok && payer && nextCostUSD != null) {
    setOwedUSD(payer, nextCostUSD);
  }
};
```

4) Cost extractor stub

```ts
async function extractCostUSD(resp: Response, req: Request): Promise<number> {
  try {
    const cloned = resp.clone();
    const text = await cloned.text();
    if (!text) return 0;
    const json = JSON.parse(text);
    // TODO: implement usage→USD logic for OpenRouter, e.g. tokens * per-model pricing
    return 0;
  } catch {
    return 0;
  }
}
```

5) Updated call to gateWithX402Payment

```ts
const paymentGated = await payments.gateWithX402Payment(
  request,
  dynamicConfig,           // dynamic pricing per caller
  () => handler(),
  { onSettle },            // optionally { onSettle, settleOnError: true }
);
```

6) Keep existing logging

- `logPaymentResponseHeader(paymentGated, settlementLogger);` remains for observability.

## End-to-End Flow After Refactor

- First-time user, no header → returns 402 with zero-amount requirement.
- User re-sends with header for 0 → verify + settle; handler runs; compute cost; store owedUSD[address].
- Next request → dynamic price is previous owedUSD; verify + settle; compute new cost; update owedUSD.
- Repeat.

## Testing Plan

- Dynamic config:
  - No header → returns price 0 (registration step).
  - With mocked rawPayment for address A → returns price owedUSD[A].
- E2E:
  - First request without header → 402 with zero requirement.
  - First request with header price=0 → 200; store next cost > 0.
  - Second request with header → requirement equals last cost; after success, store new cost.
- Verify `X-PAYMENT-RESPONSE` header present on success.
- Optional: with `settleOnError`, assert previous debt settles even when upstream fails.

## Open Questions / Future Work

- OpenRouter pricing source: finalize whether cost is in headers, usage, or model tables; implement real extractor.
- Persistence: replace in-memory Map with Redis/DB; add TTL, idempotency, and concurrency control for multiple in-flight requests from same address.
- Security: ultimately trust the verified `settlement.payer` in `onSettle` rather than the claimed `rawPayment` when persisting owedUSD.

## Rationale

- Keeps the x402 core flow intact; adds an extension point to select price per request.
- Example app owns identity-based pricing and debt tracking; easily swappable store and cost extractor.
- Minimal surface area change and backward compatible.
