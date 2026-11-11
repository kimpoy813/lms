// Global search across everything the signed-in user is allowed to see.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { fullName, ok } from '../../lib/http.js';
import { excerpt } from '../../lib/sanitize.js';
import { publishedWhere } from '../../lib/visibility.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { classIdsFor, classLabel } from '../classes/access.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

const like = (q) => ({ contains: q, mode: 'insensitive' });
const classInclude = { course: { select: { code: true, title: true } }, section: { select: { name: true } } };

searchRouter.get('/', validate({ query: z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(20).default(6) }) }), async (req, res) => {
  const { q, limit } = req.valid.query;
  const user = req.user;
  const now = new Date();
  const student = user.role === 'STUDENT';
  const classIds = await classIdsFor(user);
  const inClasses = { classId: { in: classIds } };
  // NB: publishedWhere() is itself an { OR } clause, so it is always combined through AND here —
  // spreading it next to the text-match OR would silently drop one of the two.
  const visible = student ? [publishedWhere(now)] : [];
  const text = (...fields) => ({ OR: fields.map((f) => ({ [f]: like(q) })) });

  const [classes, modules, lessons, assignments, quizzes, announcements, resources, threads, people] = await Promise.all([
    prisma.class.findMany({
      where: { id: { in: classIds }, OR: [{ course: { title: like(q) } }, { course: { code: like(q) } }, { section: { name: like(q) } }, { description: like(q) }] },
      include: { ...classInclude, teacher: { select: { firstName: true, lastName: true } } }, take: limit,
    }),
    prisma.learningModule.findMany({ where: { ...inClasses, deletedAt: null, AND: [...visible, text('title', 'description')] }, include: { class: { include: classInclude } }, take: limit }),
    prisma.lesson.findMany({
      where: { deletedAt: null, ...(student ? { status: 'PUBLISHED' } : {}), module: { ...inClasses, deletedAt: null, AND: visible }, AND: [text('title', 'contentHtml')] },
      include: { module: { select: { id: true, title: true, classId: true, class: { include: classInclude } } } }, take: limit,
    }),
    prisma.assignment.findMany({ where: { ...inClasses, deletedAt: null, AND: [...visible, text('title', 'instructionsHtml')] }, include: { class: { include: classInclude } }, take: limit }),
    prisma.quiz.findMany({ where: { ...inClasses, deletedAt: null, AND: [...visible, text('title', 'instructionsHtml')] }, include: { class: { include: classInclude } }, take: limit }),
    prisma.announcement.findMany({
      where: {
        deletedAt: null,
        AND: [
          ...visible,
          text('title', 'contentHtml'),
          { OR: [{ audience: 'INSTITUTION' }, student ? { ...inClasses, OR: [{ audience: 'CLASS' }, { audience: 'SELECTED', recipients: { some: { studentId: user.id } } }] } : inClasses] },
        ],
      },
      include: { class: { include: classInclude } }, orderBy: { createdAt: 'desc' }, take: limit,
    }),
    prisma.learningResource.findMany({
      where: {
        ...inClasses,
        AND: [
          text('title', 'description'),
          ...(student
            ? [
                { isPublished: true },
                { OR: [{ moduleId: null }, { module: { deletedAt: null, AND: visible } }] },
                { OR: [{ lessonId: null }, { lesson: { deletedAt: null, status: 'PUBLISHED', module: { deletedAt: null, AND: visible } } }] },
              ]
            : []),
        ],
      },
      include: { class: { include: classInclude } }, take: limit,
    }),
    prisma.discussionThread.findMany({
      where: { ...inClasses, deletedAt: null, AND: [text('title', 'body'), ...(student ? [{ OR: [{ isHidden: false }, { authorId: user.id }] }] : [])] },
      include: { class: { include: classInclude } }, orderBy: { lastActivityAt: 'desc' }, take: limit,
    }),
    // People: administrators search everyone; teachers search students of their own classes.
    student
      ? []
      : prisma.user.findMany({
          where: {
            anonymizedAt: null,
            AND: q.split(/\s+/).slice(0, 3).map((word) => ({ OR: [{ firstName: like(word) }, { lastName: like(word) }, { email: like(word) }, { studentProfile: { studentNumber: like(word) } }] })),
            ...(user.role === 'TEACHER' ? { enrollments: { some: { status: 'ENROLLED', class: { teacherId: user.id } } } } : {}),
          },
          select: { id: true, firstName: true, lastName: true, email: true, role: true, studentProfile: { select: { studentNumber: true } } },
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], take: limit,
        }),
  ]);

  const groups = [
    { type: 'class', label: 'Classes', items: classes.map((c) => ({ id: c.id, title: `${classLabel(c)} — ${c.course.title}`, subtitle: fullName(c.teacher), link: `/classes/${c.id}` })) },
    { type: 'module', label: 'Modules', items: modules.map((m) => ({ id: m.id, title: m.title, subtitle: classLabel(m.class), link: `/classes/${m.classId}/modules/${m.id}` })) },
    { type: 'lesson', label: 'Lessons', items: lessons.map((l) => ({ id: l.id, title: l.title, subtitle: `${classLabel(l.module.class)} · ${l.module.title}`, link: `/classes/${l.module.classId}/modules/${l.module.id}?lesson=${l.id}` })) },
    { type: 'assignment', label: 'Assignments', items: assignments.map((a) => ({ id: a.id, title: a.title, subtitle: classLabel(a.class), link: `/classes/${a.classId}/assignments/${a.id}` })) },
    { type: 'quiz', label: 'Quizzes and exams', items: quizzes.map((x) => ({ id: x.id, title: x.title, subtitle: classLabel(x.class), link: `/classes/${x.classId}/quizzes/${x.id}` })) },
    { type: 'announcement', label: 'Announcements', items: announcements.map((a) => ({ id: a.id, title: a.title, subtitle: `${a.class ? classLabel(a.class) : 'Institution'} · ${excerpt(a.contentHtml, 80)}`, link: a.classId ? `/classes/${a.classId}/announcements?open=${a.id}` : `/announcements?open=${a.id}` })) },
    { type: 'resource', label: 'Resources', items: resources.map((r) => ({ id: r.id, title: r.title, subtitle: classLabel(r.class), link: `/classes/${r.classId}/resources` })) },
    { type: 'discussion', label: 'Discussions', items: threads.map((t) => ({ id: t.id, title: t.title, subtitle: classLabel(t.class), link: `/classes/${t.classId}/discussions/${t.id}` })) },
    {
      type: 'person', label: 'People',
      items: people.map((p) => ({ id: p.id, title: fullName(p), subtitle: [p.role === 'STUDENT' ? p.studentProfile?.studentNumber : p.role.toLowerCase(), p.email].filter(Boolean).join(' · '), link: user.role === 'ADMIN' ? `/admin/users?open=${p.id}` : `/messages?to=${p.id}` })),
    },
  ].filter((g) => g.items.length > 0);
  ok(res, { query: q, total: groups.reduce((a, g) => a + g.items.length, 0), groups });
});
