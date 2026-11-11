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

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
