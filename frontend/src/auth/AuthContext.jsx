// Who is signed in. The session lives in an HTTP-only cookie; this context only mirrors what
// GET /api/auth/session says about it.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onAuthEvent, setCsrfToken, setPhotoReduction, setUploadLimit } from '../lib/api.js';
import { setTimeZone } from '../lib/format.js';
import { queryClient } from '../lib/query.js';
import { connectSocket, disconnectSocket } from '../lib/socket.js';

const AuthContext = createContext(null);

// What the server can do. `realtime: false` means it cannot push updates (it runs as short-lived
// function invocations), so live screens refresh on a timer instead — see lib/live.js.
// `email: false` means it cannot send e-mail: nothing that would need a message is offered.
const DEFAULT_RUNTIME = { realtime: true, maxUploadBytes: null, reducePhotosOverBytes: 0, email: true };
const SIGNED_OUT = { user: null, permissions: [], settings: {}, runtime: DEFAULT_RUNTIME };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', ...SIGNED_OUT });

  const accept = useCallback((payload) => {
    const runtime = { ...DEFAULT_RUNTIME, ...payload.runtime };
    setCsrfToken(payload.csrfToken);
    setUploadLimit(runtime.maxUploadBytes);
    setPhotoReduction(runtime.reducePhotosOverBytes);
    setTimeZone(payload.settings?.['institution.timezone']);
    setState({ status: 'in', user: payload.user, permissions: payload.permissions ?? [], settings: payload.settings ?? {}, runtime });
    if (runtime.realtime) connectSocket();
    else disconnectSocket();
  }, []);

  const clear = useCallback(() => {
    setCsrfToken(null);
    disconnectSocket();
    queryClient.clear();
    setState({ status: 'out', ...SIGNED_OUT });
  }, []);

  const refresh = useCallback(async () => {
    try {
      // `optional` makes "not signed in" a normal answer (null) instead of a 401.
      const payload = await api.get('/auth/session', { optional: 1 });
      if (payload) accept(payload);
      else clear();
    } catch (err) {
      if (err.status === 401) clear();
      else setState((s) => (s.status === 'loading' ? { ...s, status: 'error', error: err } : s));
    }
  }, [accept, clear]);

  useEffect(() => {
    refresh();
    // A request anywhere in the app found the session gone (expired, or signed out in another tab).
    onAuthEvent('unauthorized', clear);
    return () => onAuthEvent('unauthorized', null);
  }, [refresh, clear]);

  const value = useMemo(
    () => ({
      ...state,
      isAdmin: state.user?.role === 'ADMIN',
      isTeacher: state.user?.role === 'TEACHER',
      isStudent: state.user?.role === 'STUDENT',
      /** Administrators can do everything; other roles need the permission switched on. */
      can: (key) => state.user?.role === 'ADMIN' || state.permissions.includes(key),
      async login(email, password) {
        const payload = await api.post('/auth/login', { email, password });
        queryClient.clear();
        accept(payload);
        return payload.user;
      },
      async logout() {
        try {
          await api.post('/auth/logout');
        } finally {
          clear();
        }
      },
      refresh,
    }),
    [state, accept, clear, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
