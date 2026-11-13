import fs from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API the dev server forwards /api and /socket.io to.
const apiTarget = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000';
// Extra host names the dev server answers to (comma separated), e.g. ".example.dev" when the
// dev server sits behind a tunnel or a cloud workspace proxy.
const extraHosts = (process.env.DEV_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);

const proxy = {
  // xfwd passes X-Forwarded-* on, so the API sees the original protocol and client address.
  '/api': { target: apiTarget, changeOrigin: false, xfwd: true },
  '/socket.io': { target: apiTarget, changeOrigin: false, xfwd: true, ws: true },
};

// Two things the dev server does for Python in the browser (src/lib/pyRunner), so that it works
// in development as it does when deployed:
//   - the frame students' programs run in gets the headers that shut it off from the site (the dev
//     server sends no security headers otherwise). They are read from vercel.json, where the CDN
//     takes them from;
//   - Pyodide's two JavaScript files are handed out as they are when the page fetches them as
//     data. The dev server would rewrite them like any module of the app, and the sandbox, which
//     has no network, could not load what the rewritten file imports. A build copies them untouched.
const sandboxRule = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')).headers.find((rule) => rule.source.startsWith('/pyrunner/'));
const pythonInBrowser = () => {
  const headers = (req, res, next) => {
    if (req.url?.startsWith('/pyrunner/')) for (const { key, value } of sandboxRule?.headers ?? []) res.setHeader(key, value);
    next();
  };
  const untouched = (req, res, next) => {
    const file = /\/node_modules\/pyodide\/(pyodide(?:\.asm)?\.mjs)(?:\?|$)/.exec(req.url ?? '')?.[1];
    // "empty" is fetch(); an import of the same file says "script".
    if (!file || req.headers['sec-fetch-dest'] !== 'empty') return next();
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return fs.createReadStream(new URL(`../node_modules/pyodide/${file}`, import.meta.url)).on('error', next).pipe(res);
  };
  return {
    name: 'edusphere-python-in-browser',
    configureServer: (server) => void server.middlewares.use(headers).use(untouched),
    configurePreviewServer: (server) => void server.middlewares.use(headers),
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), pythonInBrowser()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: ['localhost', '127.0.0.1', ...extraHosts], proxy },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: ['localhost', '127.0.0.1', ...extraHosts], proxy },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return 'react';
          if (/[\\/]node_modules[\\/](@tiptap|prosemirror-[^\\/]+|@tiptap[\\/]pm)[\\/]/.test(id)) return 'editor';
          if (/[\\/]node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor)[\\/]/.test(id)) return 'charts';
          if (/[\\/]node_modules[\\/](@codemirror|codemirror|@lezer)[\\/]/.test(id)) return 'code';
          if (/[\\/]node_modules[\\/](leaflet)[\\/]/.test(id)) return 'map';
          return undefined;
        },
      },
    },
  },
  test: { environment: 'jsdom', globals: false, include: ['src/**/*.test.{js,jsx}'] },
});
