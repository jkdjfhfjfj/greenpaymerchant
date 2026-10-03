import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const logLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const configuredLogLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const logLevel = configuredLogLevel || "info";

if (!logLevels.has(logLevel)) {
  throw new Error("Invalid LOG_LEVEL. Expected fatal, error, warn, info, debug, trace, or silent.");
}

export const logger = pino({
  level: logLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
