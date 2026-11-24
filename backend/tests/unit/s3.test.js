import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildS3Url, objectKeyWithPrefix, presignS3Url, s3Delete, s3GetBuffer, s3GetStream, s3Head, s3PutBuffer, signS3Headers } from '../../src/lib/s3.js';

describe('S3 / Cloudflare R2 SigV4 helpers', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const r2 = {
    bucket: 'discenda-uploads',
    region: 'auto',
    endpoint: 'https://acct123.r2.cloudflarestorage.com',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    prefix: 'school-1',
    forcePathStyle: true,
  };

  it('builds path-style URLs for Cloudflare R2 and virtual-hosted URLs for AWS S3', () => {
    expect(objectKeyWithPrefix('school-1', 'files/ab/cd')).toBe('school-1/files/ab/cd');
    expect(buildS3Url(r2, 'files/ab/abcd').toString()).toBe(
      'https://acct123.r2.cloudflarestorage.com/discenda-uploads/school-1/files/ab/abcd',
    );

    const aws = {
      bucket: 'my-lms-bucket',
      region: 'ap-southeast-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'secret',
      prefix: '',
      forcePathStyle: false,
    };
    expect(buildS3Url(aws, 'files/12/hello.pdf').toString()).toBe(
      'https://my-lms-bucket.s3.ap-southeast-1.amazonaws.com/files/12/hello.pdf',
    );
  });

  it('produces deterministic SigV4 authorization headers', () => {
    const url = buildS3Url(r2, 'files/01/01abcdef');
    const now = new Date('2026-11-18T08:00:00.000Z');
    const first = signS3Headers(r2, { method: 'GET', url, now });
    const second = signS3Headers(r2, { method: 'GET', url, now });

    expect(first.authorization).toBe(second.authorization);
    expect(first['x-amz-date']).toBe('20261118T080000Z');
    expect(first.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261118\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
  });

  it('creates valid presigned PUT URLs with bounded expiration', () => {
    const now = new Date('2026-11-18T08:00:00.000Z');
    const signedUrl = new URL(
      presignS3Url(r2, {
        method: 'PUT',
        key: 'files/aa/sample.pdf',
        contentType: 'application/pdf',
        expiresIn: 600,
        now,
      }),
    );

    expect(signedUrl.pathname).toBe('/discenda-uploads/school-1/files/aa/sample.pdf');
    expect(signedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(signedUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(signedUrl.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('performs put, head, byte-range stream, buffer read, and delete requests cleanly', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers });
      if (init.method === 'HEAD') return new Response(null, { status: 200 });
      if (init.method === 'GET' && init.headers.range === 'bytes=0-3') {
        return new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode('hell')); c.close(); },
        }), { status: 206 });
      }
      if (init.method === 'GET') return new Response(Buffer.from('hello world'), { status: 200 });
      return new Response(null, { status: 200 });
    });

    await s3PutBuffer(r2, 'files/ab/sample', Buffer.from('hello world'), 'text/plain');
    expect(await s3Head(r2, 'files/ab/sample')).toBe(true);
    expect((await s3GetBuffer(r2, 'files/ab/sample')).toString()).toBe('hello world');

    const stream = s3GetStream(r2, 'files/ab/sample', { start: 0, end: 3 });
    expect(stream).toBeInstanceOf(Readable);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('hell');

    await s3Delete(r2, 'files/ab/sample');
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'HEAD', 'GET', 'GET', 'DELETE']);
    expect(calls[3].headers.range).toBe('bytes=0-3');
  });
});
