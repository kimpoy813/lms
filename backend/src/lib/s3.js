// Minimal AWS Signature Version 4 client for S3-compatible object stores (Cloudflare R2, AWS S3,
// MinIO, Supabase S3). Uses only Node's built-in crypto, streams, and fetch so no heavy SDK
// dependencies or ESM-require quirks are introduced.
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectKey(key) {
  return String(key)
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeRfc3986)
    .join('/');
}

export function objectKeyWithPrefix(prefix, key) {
  const cleanPrefix = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
  const cleanKey = String(key).replace(/^\/+/, '');
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

export function buildS3Url(cfg, key) {
  const region = cfg.region || 'auto';
  const base = cfg.endpoint
    ? new URL(cfg.endpoint)
    : new URL(`https://s3.${region === 'auto' ? 'us-east-1' : region}.amazonaws.com`);
  const basePath = base.pathname.replace(/\/+$/, '');
  const encodedKey = encodeObjectKey(objectKeyWithPrefix(cfg.prefix, key));
  const pathStyle = cfg.forcePathStyle ?? Boolean(cfg.endpoint);
  const url = new URL(base.origin);
  if (pathStyle) {
    url.pathname = `${basePath}/${encodeRfc3986(cfg.bucket)}/${encodedKey}`;
  } else {
    url.hostname = `${cfg.bucket}.${base.hostname}`;
    url.pathname = `${basePath}/${encodedKey}`;
  }
  return url;
}

function formatAmzDate(now) {
  const iso = now.toISOString();
  const amzDate = iso.replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secretAccessKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams.entries()) pairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export function signS3Headers(cfg, { method, url, headers = {}, payloadHash = EMPTY_SHA256, now = new Date() }) {
  const region = cfg.region || 'auto';
  const { amzDate, dateStamp } = formatAmzDate(now);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const lowered = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) lowered[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  }

  const signedKeys = Object.keys(lowered).sort();
  const canonicalHeaders = signedKeys.map((k) => `${k}:${lowered[k]}\n`).join('');
  const signedHeaders = signedKeys.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, region)).update(stringToSign).digest('hex');

  return {
    ...lowered,
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function presignS3Url(cfg, { method = 'PUT', key, contentType, expiresIn = 300, now = new Date() }) {
  const region = cfg.region || 'auto';
  const { amzDate, dateStamp } = formatAmzDate(now);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const url = buildS3Url(cfg, key);
  const signedHeaders = contentType ? 'content-type;host' : 'host';

  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${cfg.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.floor(expiresIn)))));
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);

  const headerLines = contentType ? `content-type:${contentType.trim()}\nhost:${url.host}\n` : `host:${url.host}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery(url.searchParams),
    headerLines,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, region)).update(stringToSign).digest('hex');
  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

async function s3Request(cfg, { method, key, headers = {}, body, payloadHash = EMPTY_SHA256 }) {
  const url = buildS3Url(cfg, key);
  const signed = signS3Headers(cfg, { method, url, headers, payloadHash });
  // fetch sets its own Host header from URL; remove synthetic lowercase host header before sending.
  const { host: _host, ...wireHeaders } = signed;
  return fetch(url.toString(), { method, headers: wireHeaders, body });
}

export async function s3PutBuffer(cfg, key, buffer, contentType = 'application/octet-stream') {
  const res = await s3Request(cfg, {
    method: 'PUT',
    key,
    body: buffer,
    payloadHash: sha256Hex(buffer),
    headers: {
      'content-type': contentType,
      'content-length': String(buffer.length),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`S3 PUT failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
}

export function s3GetStream(cfg, key, range) {
  const rangeHeader = range && range.start !== undefined && range.end !== undefined ? `bytes=${range.start}-${range.end}` : undefined;
  const promise = s3Request(cfg, {
    method: 'GET',
    key,
    headers: rangeHeader ? { range: rangeHeader } : {},
  });
  return Readable.from(
    (async function* streamBody() {
      const res = await promise;
      if (res.status === 404) throw Object.assign(new Error('stored file not found'), { code: 'ENOENT' });
      if (!res.ok) throw new Error(`S3 GET failed (${res.status})`);
      if (!res.body) return;
      for await (const chunk of Readable.fromWeb(res.body)) yield Buffer.from(chunk);
    })(),
    { objectMode: false },
  );
}

export async function s3GetBuffer(cfg, key) {
  const res = await s3Request(cfg, { method: 'GET', key });
  if (res.status === 404) throw Object.assign(new Error('stored file not found'), { code: 'ENOENT' });
  if (!res.ok) throw new Error(`S3 GET failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function s3Head(cfg, key) {
  const res = await s3Request(cfg, { method: 'HEAD', key });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`S3 HEAD failed (${res.status})`);
  return true;
}

export async function s3Delete(cfg, key) {
  const res = await s3Request(cfg, { method: 'DELETE', key });
  if (res.status === 404) return;
  if (!res.ok) throw new Error(`S3 DELETE failed (${res.status})`);
}
