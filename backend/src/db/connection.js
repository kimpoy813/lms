// Turns a PostgreSQL connection URL into node-postgres options.
//
// This file has no dependencies inside the project so that the Prisma CLI adapter
// (prisma/js-engine-adapter.js) can use it without loading the application configuration.
//
// Why not hand the URL to node-postgres as it is: hosted databases (Neon, Supabase, RDS …) put
// `sslmode=require` in their URLs. node-postgres currently reads that as "encrypt and verify the
// certificate", prints a warning about it on every start, and has announced that a future version
// will read it as "encrypt without verifying". The rule here is fixed instead:
//
//   sslmode absent, disable, allow            → no TLS
//   sslmode=no-verify                         → TLS, certificate not checked (self-signed servers)
//   any other sslmode (require, verify-full…) → TLS, certificate checked against the system CAs,
//                                               or against the file named by sslrootcert
import fs from 'node:fs';

const NO_TLS = new Set(['disable', 'allow']);
// Client certificates and libpq-compatibility switches are rare; when one is present the URL is
// passed through untouched and node-postgres applies its own rules.
const PASS_THROUGH = ['sslcert', 'sslkey', 'uselibpqcompat', 'sslnegotiation'];

/** @returns {import('node:tls').ConnectionOptions | undefined} */
export function tlsOptions(params) {
  const mode = params.get('sslmode');
  if (!mode || NO_TLS.has(mode)) return undefined;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  const ca = params.get('sslrootcert');
  return { rejectUnauthorized: true, ...(ca && ca !== 'system' ? { ca: fs.readFileSync(ca, 'utf8') } : {}) };
}

/**
 * Options for `new pg.Pool()` / `new pg.Client()`.
 * @param {string} databaseUrl
 * @returns {import('pg').PoolConfig}
 */
export function pgOptionsFromUrl(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { connectionString: databaseUrl };
  }
  const params = url.searchParams;
  if (!url.hostname || PASS_THROUGH.some((key) => params.has(key))) return { connectionString: databaseUrl };

  const options = {};
  const ssl = tlsOptions(params);
  if (ssl) options.ssl = ssl;
  // SCRAM channel binding ties the password exchange to the TLS session. node-postgres uses it
  // when the server offers it and falls back to plain SCRAM when it does not.
  if (ssl && params.get('channel_binding') === 'require') options.enableChannelBinding = true;
  for (const key of ['sslmode', 'sslrootcert', 'channel_binding']) params.delete(key);
  options.connectionString = url.toString();
  return options;
}

/**
 * The same connection as discrete fields (the Prisma migration adapter needs to swap the database
 * name, which a connection string would override).
 */
export function pgFieldsFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const params = url.searchParams;
  const ssl = tlsOptions(params);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(ssl ? { ssl } : {}),
    ...(ssl && params.get('channel_binding') === 'require' ? { enableChannelBinding: true } : {}),
  };
}
