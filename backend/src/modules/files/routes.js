// Private file upload and download. Bytes are never reachable by URL alone: every download is
// authenticated and checked against the record the file is attached to.
import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { FILE_TYPES } from '../../lib/fileTypes.js';
import { created, idParams, noContent, ok } from '../../lib/http.js';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { uploadLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import {
  fileSummary, openFileStream, persistUploads, removeStoredFile, storedFileExists, upload,
} from '../../services/storage.js';
import { isPublished, publishedWhere } from '../../lib/visibility.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

async function isClassTeacher(user, classId) {
  if (user.role !== 'TEACHER') return false;
  const cls = await prisma.class.findUnique({ where: { id: classId }, select: { teacherId: true } });
  return cls?.teacherId === user.id;
}

async function isEnrolled(user, classId) {
  if (user.role !== 'STUDENT') return false;
  const enrollment = await prisma.enrollment.findUnique({
    where: { classId_studentId: { classId, studentId: user.id } },
    select: { status: true },
  });
  return enrollment?.status === 'ENROLLED';
}

/**
 * Is this picture embedded in rich text the user is allowed to read? The editor inserts pictures
 * as <img src="/api/files/<id>/view">, so the address (which contains an unguessable id) is
 * looked up in the content of the user's own classes. Students only match published content.
 */
async function isEmbeddedInVisibleContent(user, fileId) {
  const contains = `/api/files/${fileId}/view`;
  const now = new Date();
  const student = user.role === 'STUDENT';
  const classes = student
    ? await prisma.enrollment.findMany({ where: { studentId: user.id, status: 'ENROLLED' }, select: { classId: true } })
    : await prisma.class.findMany({ where: { teacherId: user.id }, select: { id: true } });
  const classIds = classes.map((c) => c.classId ?? c.id);
  const live = student ? [publishedWhere(now)] : [];

  // Institution-wide announcements are readable by everyone who is signed in.
  const announcement = await prisma.announcement.findFirst({
    where: {
      contentHtml: { contains },
      deletedAt: null,
      AND: live,
      OR: [
        { audience: 'INSTITUTION' },
        ...(student
          ? [{ classId: { in: classIds }, audience: 'CLASS' }, { classId: { in: classIds }, recipients: { some: { studentId: user.id } } }]
          : [{ classId: { in: classIds } }]),
      ],
    },
    select: { id: true },
  });
  if (announcement) return true;
  if (classIds.length === 0) return false;

  const [lesson, assignment, quiz, syllabus] = await Promise.all([
    prisma.lesson.findFirst({
      where: {
        contentHtml: { contains },
        deletedAt: null,
        ...(student ? { status: 'PUBLISHED' } : {}),
        module: { classId: { in: classIds }, deletedAt: null, AND: live },
      },
      select: { id: true },
    }),
    prisma.assignment.findFirst({ where: { instructionsHtml: { contains }, classId: { in: classIds }, deletedAt: null, AND: live }, select: { id: true } }),
    prisma.quiz.findFirst({ where: { instructionsHtml: { contains }, classId: { in: classIds }, deletedAt: null, AND: live }, select: { id: true } }),
    prisma.class.findFirst({ where: { id: { in: classIds }, syllabusHtml: { contains } }, select: { id: true } }),
  ]);
  return Boolean(lesson || assignment || quiz || syllabus);
}

/**
 * May this user read this file? The answer follows the record the file hangs off.
 * Exported for the test-suite and reused by anything that serves file bytes.
 */
export async function canAccessFile(user, file) {
  if (file.deletedAt) return user.role === 'ADMIN';
  if (user.role === 'ADMIN' || file.ownerId === user.id) return true;

  // Profile pictures are visible to every signed-in user.
  if (await prisma.user.findFirst({ where: { avatarFileId: file.id }, select: { id: true } })) return true;

  if (file.assignmentId) {
    const a = await prisma.assignment.findUnique({
      where: { id: file.assignmentId },
      select: { classId: true, status: true, publishAt: true, deletedAt: true },
    });
    if (!a || a.deletedAt) return false;
    if (await isClassTeacher(user, a.classId)) return true;
    return isPublished(a) && (await isEnrolled(user, a.classId));
  }
  if (file.submissionId) {
    const s = await prisma.assignmentSubmission.findUnique({
      where: { id: file.submissionId },
      select: { studentId: true, assignment: { select: { classId: true } } },
    });
    if (!s) return false;
    return s.studentId === user.id || isClassTeacher(user, s.assignment.classId);
  }
  if (file.studentAnswerId) {
    const answer = await prisma.studentAnswer.findUnique({
      where: { id: file.studentAnswerId },
      select: { attempt: { select: { studentId: true, quiz: { select: { classId: true } } } } },
    });
    if (!answer) return false;
    return answer.attempt.studentId === user.id || isClassTeacher(user, answer.attempt.quiz.classId);
  }
  if (file.correctionRequestId) {
    const c = await prisma.attendanceCorrectionRequest.findUnique({
      where: { id: file.correctionRequestId },
      select: { studentId: true, session: { select: { classId: true } } },
    });
    if (!c) return false;
    return c.studentId === user.id || isClassTeacher(user, c.session.classId);
  }
  if (file.announcementId) {
    const a = await prisma.announcement.findUnique({
      where: { id: file.announcementId },
      select: { classId: true, audience: true, status: true, publishAt: true, deletedAt: true, recipients: { where: { studentId: user.id }, select: { studentId: true } } },
    });
    if (!a || a.deletedAt) return false;
    if (a.classId && (await isClassTeacher(user, a.classId))) return true;
    if (!isPublished(a)) return false;
    if (a.audience === 'INSTITUTION') return true;
    if (!(await isEnrolled(user, a.classId))) return false;
    return a.audience === 'CLASS' || a.recipients.length > 0;
  }
  if (file.messageId) {
    const m = await prisma.message.findUnique({
      where: { id: file.messageId },
      select: { conversation: { select: { participants: { where: { userId: user.id }, select: { userId: true } } } } },
    });
    return Boolean(m && m.conversation.participants.length > 0);
  }
  if (file.threadId || file.replyId) {
    const thread = file.threadId
      ? await prisma.discussionThread.findUnique({ where: { id: file.threadId }, select: { classId: true, isHidden: true, deletedAt: true } })
      : (await prisma.discussionReply.findUnique({ where: { id: file.replyId }, select: { isHidden: true, deletedAt: true, thread: { select: { classId: true, isHidden: true, deletedAt: true } } } }));
    const t = file.threadId ? thread : thread?.thread;
    if (!t) return false;
    if (await isClassTeacher(user, t.classId)) return true;
    const hidden = t.isHidden || t.deletedAt || (!file.threadId && (thread.isHidden || thread.deletedAt));
    return !hidden && (await isEnrolled(user, t.classId));
  }

  // Pictures placed inside rich text (a lesson, instructions, an announcement, the syllabus).
  if (file.mimeType?.startsWith('image/') && (await isEmbeddedInVisibleContent(user, file.id))) return true;

  // Learning resources (class library and lesson attachments).
  const resources = await prisma.learningResource.findMany({
    where: { fileId: file.id },
    select: {
      classId: true,
      isPublished: true,
      module: { select: { status: true, publishAt: true, deletedAt: true } },
      lesson: { select: { status: true, deletedAt: true, module: { select: { status: true, publishAt: true, deletedAt: true } } } },
    },
  });
  for (const r of resources) {
    if (await isClassTeacher(user, r.classId)) return true;
    if (!r.isPublished) continue;
    const mod = r.lesson?.module ?? r.module;
    if (mod && (mod.deletedAt || !isPublished(mod))) continue;
    if (r.lesson && (r.lesson.deletedAt || r.lesson.status !== 'PUBLISHED')) continue;
    if (await isEnrolled(user, r.classId)) return true;
  }
  return false;
}

// ── Upload ────────────────────────────────────────────────────────────────────
filesRouter.get('/types', (req, res) => {
  ok(res, {
    maxBytes: env.maxUploadBytes,
    extensions: Object.entries(FILE_TYPES).map(([extension, t]) => ({ extension, label: t.label })),
  });
});

filesRouter.post('/', uploadLimiter, upload.array('files', 10), async (req, res) => {
  const rows = await persistUploads(req.files, req.user.id, { imagesOnly: req.query.kind === 'image' });
  created(res, rows.map(fileSummary));
});

// ── Download / preview ────────────────────────────────────────────────────────
async function serve(req, res, { inline }) {
  const file = await prisma.file.findUnique({ where: { id: req.valid.params.fileId } });
  // 404 (not 403) for files the user may not see, so ids cannot be probed.
  if (!file || !(await canAccessFile(req.user, file))) throw notFound('File');
  if (!(await storedFileExists(file))) throw new AppError(410, 'FILE_GONE', 'This file is no longer available.');

  const type = FILE_TYPES[file.extension];
  const canInline = inline && Boolean(type?.inline);
  const encodedName = encodeURIComponent(file.originalName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const asciiName = file.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `${canInline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  // Uploaded content must never be able to script the application origin.
  res.setHeader(
    'Content-Security-Policy',
    canInline && file.extension === 'pdf'
      ? "default-src 'none'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'",
  );
  res.setHeader('Accept-Ranges', 'bytes');

  // Range support lets video and audio seek.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.get('range') ?? '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    let start;
    let end;
    if (range[1] === '') {
      const suffix = Number(range[2]);
      start = Math.max(0, file.sizeBytes - suffix);
      end = file.sizeBytes - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? file.sizeBytes - 1 : Math.min(Number(range[2]), file.sizeBytes - 1);
    }
    if (start > end || start >= file.sizeBytes) {
      res.setHeader('Content-Range', `bytes */${file.sizeBytes}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${file.sizeBytes}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return openFileStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.setHeader('Content-Length', String(file.sizeBytes));
  return openFileStream(file).on('error', () => res.destroy()).pipe(res);
}

filesRouter.get('/:fileId', validate({ params: idParams('fileId') }), (req, res) => serve(req, res, { inline: false }));
filesRouter.get('/:fileId/view', validate({ params: idParams('fileId') }), (req, res) => serve(req, res, { inline: true }));

filesRouter.get('/:fileId/meta', validate({ params: idParams('fileId') }), async (req, res) => {
  const file = await prisma.file.findUnique({ where: { id: req.valid.params.fileId } });
  if (!file || !(await canAccessFile(req.user, file))) throw notFound('File');
  ok(res, fileSummary(file));
});

// ── Delete an upload that was never attached to anything ─────────────────────
filesRouter.delete('/:fileId', validate({ params: idParams('fileId') }), async (req, res) => {
  const file = await prisma.file.findUnique({
    where: { id: req.valid.params.fileId },
    include: { avatarOf: { select: { id: true } }, _count: { select: { resources: true, aiReferences: true } } },
  });
  if (!file || file.ownerId !== req.user.id) throw notFound('File');
  const attached =
    file.assignmentId || file.submissionId || file.announcementId || file.messageId || file.threadId || file.replyId ||
    file.studentAnswerId || file.correctionRequestId || file.avatarOf || file._count.resources > 0 || file._count.aiReferences > 0;
  if (attached) throw forbidden('This file is in use. Remove it from the record it is attached to instead.', 'FILE_IN_USE');
  await prisma.file.delete({ where: { id: file.id } });
  await removeStoredFile(file.storedName);
  noContent(res);
});
