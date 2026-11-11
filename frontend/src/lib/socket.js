// One Socket.IO connection per signed-in tab. The session cookie authenticates it.
import { useEffect } from 'react';
import { io } from 'socket.io-client';

let socket = null;

export function connectSocket() {
  if (socket) return socket;
  socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelayMax: 15_000 });
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}

export const getSocket = () => socket;

/** Subscribe to a server event for the lifetime of a component. */
export function useSocketEvent(event, handler) {
  useEffect(() => {
    const s = socket;
    if (!s) return undefined;
    s.on(event, handler);
    return () => s.off(event, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, handler, socket]);
}
