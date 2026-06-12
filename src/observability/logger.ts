import { pino, type Logger, type LoggerOptions } from "pino";

export type AppLogger = Logger;

export const sharedRedactPaths = [
  "req.body.basicAuth.password",
  "req.body.formLogin.password",
  "job.data.credentials.*",
  "job.data.config.basicAuth.password",
  "job.data.config.formLogin.password",
  "*.basicAuth.password",
  "*.formLogin.password",
  "*.credentials.*",
  "*.encryptionKey",
  "*.downloadTokenSecret",
  "*.ownerNonce",
  "*.ownerToken"
];

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: sharedRedactPaths, remove: true },
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime
};

let rootLogger: AppLogger | undefined;

function getRootLogger(): AppLogger {
  if (!rootLogger) {
    rootLogger = pino(baseOptions);
  }
  return rootLogger;
}

export function createLogger(name: string): AppLogger {
  return getRootLogger().child({ service: name });
}

export function loggerOptionsForFastify(): LoggerOptions {
  return baseOptions;
}
