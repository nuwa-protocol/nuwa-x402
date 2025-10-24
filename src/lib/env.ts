import { z } from "zod";

const envSchema = z.object({
	SERVICE_PRIVATE_KEY: z
		.string()
		.regex(
			/^0x[0-9a-fA-F]{64}$/,
			"SERVICE_PRIVATE_KEY must be a 32-byte 0x-prefixed hex string",
		),
	NETWORK: z.enum(["base", "base-sepolia"]).default("base-sepolia"),
	ALLOWED_ORIGIN: z.string().url().optional(),
	OPENROUTER_API_KEY: z.string().min(1),
});

const parsed = envSchema.parse({
	SERVICE_PRIVATE_KEY: process.env.SERVICE_PRIVATE_KEY,
	NETWORK: process.env.NETWORK,
	ALLOWED_ORIGIN: process.env.ALLOWED_ORIGIN,
	OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
});

export const env = parsed;
