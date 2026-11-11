// Driver adapter used by the Prisma CLI when PRISMA_SCHEMA_ENGINE=js.
//
// Prisma normally downloads a native "schema engine" binary from binaries.prisma.sh to run
// migrations. On networks where that host is blocked, Prisma 6 can instead run the same engine
// compiled to WebAssembly and talk to PostgreSQL through node-postgres. That path is marked
// experimental by Prisma and supports `migrate deploy | status | reset | diff` — but NOT
// `migrate dev` (use the default engine for authoring new migrations).
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { pgFieldsFromUrl } from '../src/db/connection.js';

// @prisma/adapter-pg 6.19 has no mapping for the PostgreSQL `name` type (OID 19) that system
// catalogs return, so the WASM engine cannot read them. Report those columns as `text` instead.
const NAME_OID = 19;
const NAME_ARRAY_OID = 1003;
const TEXT_OID = 25;
const TEXT_ARRAY_OID = 1009;

function relabelNameColumns(result) {
  const relabel = (r) => {
    if (!r || !Array.isArray(r.fields)) return;
    for (const field of r.fields) {
      if (field.dataTypeID === NAME_OID) field.dataTypeID = TEXT_OID;
      else if (field.dataTypeID === NAME_ARRAY_OID) field.dataTypeID = TEXT_ARRAY_OID;
    }
  };
  if (Array.isArray(result)) result.forEach(relabel);
  else relabel(result);
  return result;
}

let patched = false;
function patchPgClient() {
  if (patched) return;
  patched = true;
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = function query(...args) {
    for (let i = 0; i < args.length; i += 1) {
      if (typeof args[i] === 'function') {
        const callback = args[i];
        args[i] = (err, res) => callback(err, relabelNameColumns(res));
      }
    }
    const out = originalQuery.apply(this, args);
    return out && typeof out.then === 'function' ? out.then(relabelNameColumns) : out;
  };
}

export function createMigrationAdapter(databaseUrl) {
  patchPgClient();
  // Discrete parameters (not `connectionString`) so the adapter can swap the database name when
  // it needs a temporary shadow database. TLS follows the same rule as the application
  // (src/db/connection.js): `sslmode=require` encrypts and verifies the server certificate.
  return new PrismaPg({ ...pgFieldsFromUrl(databaseUrl), allowExitOnIdle: true });
}
