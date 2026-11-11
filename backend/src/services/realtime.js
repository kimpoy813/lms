// Socket.IO: real-time notifications, direct messages and the live attendance monitor.
// Sockets authenticate with the same HTTP-only session cookie as the REST API.
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { readSessionToken, resolveSession } from '../middleware/auth.js';

let io = null;

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  const allowed = new Set([env.appUrl, ...env.corsOrigins]);
  const hosts = [req.headers.host];
  if (env.trustProxy && req.headers['x-forwarded-host']) {
    hosts.push(...String(req.headers['x-forwarded-host']).split(',').map((h) => h.trim()));
  }
  for (const host of hosts.filter(Boolean)) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return allowed.has(origin.replace(/\/+$/, ''));
}

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    serveClient: false,
    cors: env.corsOrigins.length > 0 ? { origin: env.corsOrigins, credentials: true } : undefined,
    // Reject cross-site WebSocket handshakes: browsers attach cookies to them automatically.
    allowRequest: (req, callback) => callback(null, originAllowed(req)),
    maxHttpBufferSize: 100_000,
  });

  io.use(async (socket, next) => {
    try {
      const session = await resolveSession(readSessionToken(socket.request.headers.cookie));
      if (!session) return next(new Error('UNAUTHENTICATED'));
      socket.data.user = { id: session.user.id, role: session.user.role };
      socket.data.sessionId = session.id;
      return next();
    } catch (err) {
      logger.error({ err }, 'socket authentication failed');
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(`user:${user.id}`);

    // Live attendance monitor — only the class teacher (or an administrator) may watch a session.
    socket.on('attendance:watch', async (sessionId, ack) => {
      try {
        if (typeof sessionId !== 'string' || sessionId.length > 40) throw new Error('bad id');
        const session = await prisma.attendanceSession.findUnique({
          where: { id: sessionId },
          select: { id: true, class: { select: { teacherId: true } } },
        });
        const allowed = session && (user.role === 'ADMIN' || session.class.teacherId === user.id);
        if (!allowed) {
          if (typeof ack === 'function') ack({ ok: false });
          return;
        }
        socket.join(`attendance:${sessionId}`);
        if (typeof ack === 'function') ack({ ok: true });
      } catch {
        if (typeof ack === 'function') ack({ ok: false });
      }
    });

    socket.on('attendance:unwatch', (sessionId) => {
      if (typeof sessionId === 'string') socket.leave(`attendance:${sessionId}`);
    });
  });

  return io;
}

export function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToUsers(userIds, event, payload) {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}

export function emitToRoom(room, event, payload) {
  io?.to(room).emit(event, payload);
}

/** Disconnect every socket that belongs to a revoked session / suspended user. */
export function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export async function closeRealtime() {
  if (!io) return;
  await new Promise((resolve) => io.close(() => resolve()));
  io = null;
}
