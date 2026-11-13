// The frame in which the web app runs a student's Python program (frontend/public/pyrunner/,
// frontend/src/lib/pyRunner): what the server says about it when it serves the file.
//
// The program in that frame is not trusted: a teacher's starter code runs in a student's browser,
// and one day a student's program may run in a teacher's. These headers are what keeps it away
// from the site:
//   - `sandbox allow-scripts` gives the document an origin of its own, however it is opened: no
//     cookies, no storage, nothing of the site it could read or call as the person signed in;
//   - `connect-src 'none'` and the empty default leave it without a network; Python's files are
//     handed in by the page;
//   - scripts may come from the page's own inline script and from blobs (the worker and Python),
//     and may compile WebAssembly: that is what Python in a browser is.
// On Vercel the file is served by the CDN and the same headers are in vercel.json; a test compares.

/** Paths below this prefix are the sandbox. */
export const PYTHON_SANDBOX_PREFIX = '/pyrunner/';

/**
 * The headers that differ from those of a page of the site.
 * @param {string} [frameAncestors] who may embed the frame: the site itself (FRAME_ANCESTORS)
 */
export function pythonSandboxHeaders(frameAncestors = "'self'") {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      'worker-src blob:',
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
      'sandbox allow-scripts',
    ].join(';'),
    'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=()',
    'Referrer-Policy': 'no-referrer',
  };
}

/**
 * The headers of a file of the built web app, by its path inside the build.
 * @param {string} relativePath for example `assets/index-abc.js` or `pyrunner/frame.html`
 */
export function webAppFileHeaders(relativePath, frameAncestors) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  return {
    // Files below assets/ carry a hash of their content in their name; everything else may change.
    'Cache-Control': parts[0] === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(parts[0] === PYTHON_SANDBOX_PREFIX.replaceAll('/', '') ? pythonSandboxHeaders(frameAncestors) : {}),
  };
}
