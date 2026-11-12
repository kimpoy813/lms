import '@fontsource-variable/inter';
import './index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { toast, Toaster } from './components/toast.jsx';
import { onPhotosReduced } from './lib/api.js';
import { describeReduction } from './lib/photos.js';
import { queryClient } from './lib/query.js';

// A person whose photo was made smaller on the way out is told so, with the sizes.
onPhotosReduced((reduced) => toast.info(describeReduction(reduced), { duration: 7000 }));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// Offline support: the service worker caches the app shell only — never API responses,
// so private data is not left behind on a shared computer.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
