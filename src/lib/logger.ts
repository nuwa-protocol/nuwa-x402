type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LOG_LEVEL_INDEX = LOG_LEVELS.reduce<Record<LogLevel, number>>(
	(acc, level, index) => {
		acc[level] = index;
		return acc;
	},
	{} as Record<LogLevel, number>,
);

function resolveLogLevel(): LogLevel {
	const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
	return envLevel && LOG_LEVELS.includes(envLevel) ? envLevel : "info";
}

export class Logger {
	constructor(
		private readonly scope: string[],
		private readonly minLevel: LogLevel,
	) {}

	child(childScope: string) {
		return new Logger([...this.scope, childScope], this.minLevel);
	}

	debug(...args: unknown[]) {
		this.output("debug", ...args);
	}

	info(...args: unknown[]) {
		this.output("info", ...args);
	}

	warn(...args: unknown[]) {
		this.output("warn", ...args);
	}

	error(...args: unknown[]) {
		this.output("error", ...args);
	}

	private output(level: LogLevel, ...args: unknown[]) {
		if (LOG_LEVEL_INDEX[level] < LOG_LEVEL_INDEX[this.minLevel]) {
			return;
		}

		const scopeLabel = this.scope.length ? `[${this.scope.join(":")}]` : "";
		const line = scopeLabel ? [scopeLabel, ...args] : args;
		const fn =
			level === "debug"
				? console.debug
				: level === "info"
					? console.info
					: level === "warn"
						? console.warn
						: console.error;
		fn(...line);
	}
}

const rootLogger = new Logger(["app"], resolveLogLevel());

export function createLogger(scope: string | string[]) {
	const segments = Array.isArray(scope) ? scope : scope.split(":");
	return segments.reduce(
		(current, segment) => current.child(segment),
		rootLogger,
	);
}

export const logger = rootLogger;
