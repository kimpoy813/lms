import { createRequire } from 'node:module';
import pino from 'pino';
import { env } from '../config/env.js';

// Values under these keys never reach the logs.
const redact = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.passwordHash',
    '*.token',
    '*.apiKey',
  ],
  censor: '[redacted]',
};

let transport;
if (env.isDevelopment) {
  try {
    // Only asks whether pino-pretty is installed. Deliberately not `await import()`: one top-level
    // await makes every module that imports this one impossible to load with require(), which is
    // how some hosts load an application (see api/index.js).
    createRequire(import.meta.url).resolve('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    // pino-pretty is a dev dependency; fall back to JSON logs when it is absent.
  }
}

export const logger = pino({ level: env.logLevel, redact, transport });
