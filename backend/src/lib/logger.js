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
    await import('pino-pretty');
    transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    // pino-pretty is a dev dependency; fall back to JSON logs when it is absent.
  }
}

export const logger = pino({ level: env.logLevel, redact, transport });
