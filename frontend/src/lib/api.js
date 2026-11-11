// The only place that talks to the server.
//
// • Session: an HTTP-only cookie the browser manages; nothing sensitive is kept in JS storage.
// • CSRF: every state-changing request echoes the session's token in X-CSRF-Token.
// • Errors: thrown as ApiError with the server's message, code and per-field messages.

import { formatLimit } from './format.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    /** { fieldName: message } for validation errors */
    this.fields = details?.fields ?? null;
  }
}

let csrfToken = null;
let uploadLimit = null;
const listeners = { unauthorized: null, passwordChange: null };

export const setCsrfToken = (token) => {
  csrfToken = token ?? null;
};
/** The largest single file the server accepts, in bytes (it says so when the session starts). */
export const setUploadLimit = (bytes) => {
  uploadLimit = bytes > 0 ? bytes : null;
};
/** The auth layer registers what should happen when the session ends or a password change is required. */
export const onAuthEvent = (name, fn) => {
  listeners[name] = fn;
};

function buildUrl(path, query) {
  const url = `/api${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(res) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* not JSON */
  }
  const e = payload?.error;
  if (e) return new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Something went wrong.', e.details);
  if (res.status === 413) {
    return new ApiError(413, 'FILE_TOO_LARGE', uploadLimit ? `That is too large to send. One file can be at most ${formatLimit(uploadLimit)}.` : 'That file is too large.');
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) return new ApiError(res.status, 'SERVER_UNAVAILABLE', 'The server is not responding right now. Please try again in a moment.');
  return new ApiError(res.status, 'ERROR', `The request failed (${res.status}).`);
}

async function send(method, path, { body, query, signal, form } = {}, retried = false) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined && !form) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(buildUrl(path, query), { method, headers, credentials: 'same-origin', signal, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', navigator.onLine === false ? 'You are offline. Check your connection and try again.' : 'Could not reach the server. Check your connection and try again.');
  }
  if (res.ok) return res;
  const error = await parseError(res);
  // The token can go stale when the session was renewed in another tab: fetch a fresh one once.
  if (error.code === 'BAD_CSRF_TOKEN' && !retried) {
    try {
      const session = await send('GET', '/auth/session');
      csrfToken = (await session.json()).data.csrfToken;
      return send(method, path, { body, query, signal, form }, true);
    } catch {
      /* fall through to the original error */
    }
  }
  if (error.status === 401 && error.code === 'UNAUTHENTICATED' && !path.startsWith('/auth/')) listeners.unauthorized?.();
  if (error.code === 'PASSWORD_CHANGE_REQUIRED') listeners.passwordChange?.();
  throw error;
}

async function json(method, path, options) {
  const res = await send(method, path, options);
  if (res.status === 204) return { data: null, meta: null };
  const payload = await res.json();
  return { data: payload.data, meta: payload.meta ?? null };
}

export const api = {
  get: async (path, query, options) => (await json('GET', path, { ...options, query })).data,
  /** Like get, but returns { data, meta } (pagination and other list metadata). */
  list: (path, query, options) => json('GET', path, { ...options, query }),
  post: async (path, body = {}, options) => (await json('POST', path, { ...options, body })).data,
  put: async (path, body = {}, options) => (await json('PUT', path, { ...options, body })).data,
  patch: async (path, body = {}, options) => (await json('PATCH', path, { ...options, body })).data,
  delete: async (path, body, options) => (await json('DELETE', path, { ...options, body })).data,

  /** POST a multipart form (e.g. one document to be parsed). `fields` is { name: File | string }. */
  async postForm(path, fields) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value, value instanceof File ? value.name : undefined);
    return (await json('POST', path, { form })).data;
  },

  /**
   * Upload files; resolves to [{ id, name, mimeType, sizeBytes }].
   *
   * Each file travels in its own request: some hosts cap the size of a request, and several
   * files in one would add up. A file over the server's limit is refused here, before any bytes
   * are sent — a host that enforces the cap answers with an error page, not a useful message.
   * If a later file fails, the error carries the ones already stored as `err.saved`.
   */
  async upload(files, path = '/files', field = 'files') {
    const list = [...files];
    const tooLarge = uploadLimit ? list.find((file) => file.size > uploadLimit) : null;
    if (tooLarge) {
      throw new ApiError(413, 'FILE_TOO_LARGE', `“${tooLarge.name}” is larger than ${formatLimit(uploadLimit)}, the most this site accepts for one file.`);
    }
    const saved = [];
    for (const file of list) {
      const form = new FormData();
      form.append(field, file, file.name);
      try {
        saved.push(...(await json('POST', path, { form })).data);
      } catch (err) {
        err.saved = saved;
        throw err;
      }
    }
    return saved;
  },

  /** Download a protected file or export and hand it to the browser's "save" flow. */
  async download(path, query, fallbackName = 'download') {
    const res = await send('GET', path, { query });
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    const name = utf ? decodeURIComponent(utf[1]) : plain ? plain[1] : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return name;
  },
};

/** URL of a protected file for <img>, <video> or "open in new tab" (the cookie authorises it). */
export const fileUrl = (id, { inline = true } = {}) => (id ? `/api/files/${id}${inline ? '/view' : ''}` : null);

/** Message suitable for a toast. */
export const errorMessage = (err) => (err instanceof ApiError ? err.message : err?.message || 'Something went wrong. Please try again.');
