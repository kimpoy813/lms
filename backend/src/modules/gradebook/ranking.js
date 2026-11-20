// Teacher-controlled anonymous class ranking for released grades.
// Privacy contract:
//   - Every enrolled student receives a distinct random secret code per class so codes cannot
//     be correlated across classes.
//   - Student views, student exports, and anonymous teacher exports contain ONLY ranks and secret
//     codes (plus scores when enabled by the teacher) — never names, e-mails, student numbers,
//     user IDs, or name-based tie ordering.
//   - Teacher named views and named exports never contain secret codes, keeping the mapping
//     between identity and secret code isolated to the student themselves.
import { prisma } from '../../db/prisma.js';
import { AppError, conflict, fieldErrors, notFound } from '../../lib/errors.js';
import { round } from '../../lib/http.js';
import { normalizeCode, randomCode } from '../../lib/tokens.js';
import { OVERALL_SCOPE } from './compute.js';
import { computeClassGrades } from './service.js';

export const RANKING_CODE_MIN = 6;
export const RANKING_CODE_MAX = 16;

export function normalizeRankingCode(raw) {
  return normalizeCode(raw);
}

/**
 * Reject custom student codes that embed the student's own name, e-mail local part, or student
 * number so classmates cannot identify them from the ranking list.
 */
export function rankingCodeIdentityIssue(normalizedCode, user) {
  if (!normalizedCode) return 'Enter a secret code.';
  if (normalizedCode.length < RANKING_CODE_MIN || normalizedCode.length > RANKING_CODE_MAX) {
    return `Use between ${RANKING_CODE_MIN} and ${RANKING_CODE_MAX} letters and numbers.`;
  }
  const candidates = [
    user?.firstName,
    user?.middleName,
    user?.lastName,
    user?.email ? String(user.email).split('@')[0] : null,
    user?.studentNumber ?? user?.studentProfile?.studentNumber,
  ].filter(Boolean);

  const tokens = new Set();
  for (const raw of candidates) {
    const whole = normalizeCode(raw);
    if (whole.length >= 3) tokens.add(whole);
    for (const part of String(raw).split(/[\s._-]+/)) {
      const norm = normalizeCode(part);
      if (norm.length >= 3) tokens.add(norm);
    }
  }

  for (const token of tokens) {
    if (normalizedCode.includes(token)) {
      return 'Choose a secret code that does not include your name, e-mail, or student number.';
    }
  }
  return null;
}

/**
 * Pure standard competition ranking (`1, 1, 3, ...`).
 * Ties are broken strictly by `code` (for anonymous/student views) or `name` (for teacher named
 * views) so anonymous lists never leak alphabetical identity through tie order.
 */
export function rankStudents(rows, { sortTieBy = 'code' } = {}) {
  const graded = rows.filter((r) => r.percent !== null && r.percent !== undefined && Number.isFinite(Number(r.percent)));
  const ungraded = rows.filter((r) => r.percent === null || r.percent === undefined || !Number.isFinite(Number(r.percent)));

  const tieCompare = sortTieBy === 'name'
    ? (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || String(a.studentNumber ?? '').localeCompare(String(b.studentNumber ?? ''))
    : (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''));

  const sortedGraded = [...graded].sort((a, b) => (Number(b.percent) - Number(a.percent)) || tieCompare(a, b));
  const sortedUngraded = [...ungraded].sort(tieCompare);

  let lastPercent = null;
  let currentRank = 0;
  const ranked = sortedGraded.map((row, idx) => {
    const pct = Number(row.percent);
    if (lastPercent === null || pct !== lastPercent) {
      currentRank = idx + 1;
      lastPercent = pct;
    }
    return { ...row, percent: pct, rank: currentRank };
  });

  return {
    ranked,
    unranked: sortedUngraded,
    stats: {
      totalStudents: rows.length,
      totalRanked: ranked.length,
      unrankedCount: sortedUngraded.length,
      topPercent: ranked.length > 0 ? ranked[0].percent : null,
      averagePercent: ranked.length > 0 ? round(ranked.reduce((sum, r) => sum + r.percent, 0) / ranked.length, 2) : null,
    },
  };
}

/** Generate a random 8-character class-unique ranking code. */
async function nextUniqueCode(db, classId, usedCodes, excludeCode = null) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = randomCode(8);
    if (candidate === excludeCode || usedCodes.has(candidate)) continue;
    const exists = await db.enrollment.findFirst({ where: { classId, rankingCode: candidate }, select: { id: true } });
    if (!exists) return candidate;
    usedCodes.add(candidate);
  }
  throw new AppError(500, 'CODE_GENERATION_FAILED', 'Could not assign a unique ranking code. Try again.');
}

/**
 * Ensure every active (`ENROLLED`) student in the class has a unique per-class `rankingCode`.
 * Safe under concurrency via conditional update + retry on unique violation.
 * @returns {Promise<Map<string, string>>} studentId -> rankingCode
 */
export async function ensureClassRankingCodes(classId, db = prisma) {
  const enrollments = await db.enrollment.findMany({
    where: { classId, status: 'ENROLLED' },
    select: { id: true, studentId: true, rankingCode: true },
  });
  const used = new Set(enrollments.map((e) => e.rankingCode).filter(Boolean));
  const byStudent = new Map();

  for (const e of enrollments) {
    if (e.rankingCode) {
      byStudent.set(e.studentId, e.rankingCode);
      continue;
    }
    let assigned = null;
    for (let attempt = 0; attempt < 5 && !assigned; attempt += 1) {
      const candidate = await nextUniqueCode(db, classId, used);
      try {
        const res = await db.enrollment.updateMany({
          where: { id: e.id, rankingCode: null },
          data: { rankingCode: candidate },
        });
        if (res.count === 1) {
          assigned = candidate;
          used.add(candidate);
        } else {
          const fresh = await db.enrollment.findUnique({ where: { id: e.id }, select: { rankingCode: true } });
          if (fresh?.rankingCode) {
            assigned = fresh.rankingCode;
            used.add(assigned);
          }
        }
      } catch (err) {
        if (err?.code === 'P2002') {
          used.add(candidate);
          continue;
        }
        throw err;
      }
    }
    if (!assigned) throw new AppError(500, 'CODE_GENERATION_FAILED', 'Could not assign a ranking code. Try again.');
    byStudent.set(e.studentId, assigned);
  }

  return byStudent;
}

/** Replace the logged-in student's secret ranking code in one class with a fresh random code. */
export async function regenerateStudentRankingCode(classId, studentId) {
  const existing = await prisma.enrollment.findUnique({
    where: { classId_studentId: { classId, studentId } },
    select: { id: true, status: true, rankingCode: true },
  });
  if (!existing || existing.status !== 'ENROLLED') throw notFound('Enrollment');

  const peers = await prisma.enrollment.findMany({
    where: { classId, rankingCode: { not: null } },
    select: { rankingCode: true },
  });
  const used = new Set(peers.map((p) => p.rankingCode));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await nextUniqueCode(prisma, classId, used, existing.rankingCode);
    try {
      await prisma.enrollment.update({ where: { id: existing.id }, data: { rankingCode: candidate } });
      return { code: candidate };
    } catch (err) {
      if (err?.code === 'P2002') {
        used.add(candidate);
        continue;
      }
      throw err;
    }
  }
  throw new AppError(500, 'CODE_GENERATION_FAILED', 'Could not assign a new ranking code. Try again.');
}

/** Let a student pick a custom secret ranking code, after enforcing format, privacy, and uniqueness. */
export async function setCustomStudentRankingCode(classId, user, rawCode) {
  const normalized = normalizeRankingCode(rawCode);
  const fullUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      firstName: true,
      middleName: true,
      lastName: true,
      email: true,
      studentProfile: { select: { studentNumber: true } },
    },
  });
  const issue = rankingCodeIdentityIssue(normalized, fullUser ?? user);
  if (issue) throw fieldErrors({ code: issue });

  const existing = await prisma.enrollment.findUnique({
    where: { classId_studentId: { classId, studentId: user.id } },
    select: { id: true, status: true, rankingCode: true },
  });
  if (!existing || existing.status !== 'ENROLLED') throw notFound('Enrollment');
  if (existing.rankingCode === normalized) return { code: normalized };

  const collision = await prisma.enrollment.findFirst({
    where: { classId, rankingCode: normalized, NOT: { id: existing.id } },
    select: { id: true },
  });
  if (collision) {
    throw conflict('Another student in this class already uses that code. Choose a different one.', 'CODE_IN_USE');
  }

  try {
    await prisma.enrollment.update({ where: { id: existing.id }, data: { rankingCode: normalized } });
    return { code: normalized };
  } catch (err) {
    if (err?.code === 'P2002') {
      throw conflict('Another student in this class already uses that code. Choose a different one.', 'CODE_IN_USE');
    }
    throw err;
  }
}

function buildScopes(periods, cls) {
  const scopes = [];
  if (periods.length > 0) {
    const allPublished = periods.every((p) => Boolean(p.publishedAt));
    const overallReleased = Boolean(cls.gradesFinalizedAt || allPublished);
    const overallReleasedAt = cls.gradesFinalizedAt
      ?? (overallReleased ? new Date(Math.max(...periods.map((p) => new Date(p.publishedAt).getTime()))) : null);
    scopes.push({
      scope: OVERALL_SCOPE,
      name: 'Overall grade',
      kind: 'OVERALL',
      released: overallReleased,
      releasedAt: overallReleasedAt,
    });
  }
  for (const p of periods) {
    scopes.push({
      scope: p.id,
      name: p.name,
      kind: 'PERIOD',
      released: Boolean(cls.gradesFinalizedAt || p.publishedAt),
      releasedAt: cls.gradesFinalizedAt ?? p.publishedAt ?? null,
    });
  }
  return scopes;
}

/**
 * Compute and shape class rankings for either a student (strictly anonymized with secret codes
 * and gated on released periods + `gradeRankingEnabled`) or a teacher (named table + separate
 * anonymous preview, always accessible to preview before publishing).
 */
export async function buildClassRanking(cls, { viewerUser = null, canManage = false, requestedScope = null, db = prisma } = {}) {
  const codesByStudent = await ensureClassRankingCodes(cls.id, db);
  const { periods, students } = await computeClassGrades(cls, { db });

  const finalsMap = new Map();
  if (cls.gradesFinalizedAt) {
    const finals = await db.finalGrade.findMany({
      where: { classId: cls.id },
      select: { studentId: true, scope: true, percent: true, label: true, remark: true, isPassing: true, isOverridden: true },
    });
    for (const f of finals) finalsMap.set(`${f.studentId}:${f.scope}`, f);
  }

  const scopes = buildScopes(periods, cls);
  const showScores = cls.gradeRankingShowScores !== false;

  const extractCell = (row, scopeKey) => {
    const fin = finalsMap.get(`${row.student.id}:${scopeKey}`);
    const computed = scopeKey === OVERALL_SCOPE
      ? row.result.overall
      : row.result.periods.find((p) => p.id === scopeKey);
    const cell = fin ?? computed;
    return {
      percent: cell?.percent ?? null,
      label: cell?.label ?? null,
      remark: cell?.remark ?? null,
      isPassing: cell?.isPassing ?? null,
      isOverridden: Boolean(cell?.isOverridden),
    };
  };

  if (!canManage) {
    if (!cls.gradeRankingEnabled) return null;
    const myCode = viewerUser ? codesByStudent.get(viewerUser.id) ?? null : null;
    const releasedScopes = scopes.filter((s) => s.released);

    if (requestedScope) {
      if (!scopes.some((s) => s.scope === requestedScope)) throw notFound('Grading period');
      if (!releasedScopes.some((s) => s.scope === requestedScope)) {
        throw new AppError(403, 'RANKING_NOT_RELEASED', 'Rankings for that grading period have not been released yet.');
      }
    }

    if (releasedScopes.length === 0) {
      return {
        enabled: true,
        showScores,
        released: false,
        releasedAt: null,
        myCode,
        scopes: [],
        activeScope: null,
        activeScopeName: null,
        myRank: null,
        myPercent: null,
        myLabel: null,
        myRemark: null,
        totalStudents: students.length,
        totalRanked: 0,
        unrankedCount: students.length,
        stats: { topPercent: null, averagePercent: null },
        entries: [],
      };
    }

    const active = requestedScope
      ? releasedScopes.find((s) => s.scope === requestedScope)
      : (releasedScopes.find((s) => s.scope === OVERALL_SCOPE) ?? releasedScopes.at(-1));

    const rawRows = students.map((row) => {
      const cell = extractCell(row, active.scope);
      return {
        studentId: row.student.id,
        code: codesByStudent.get(row.student.id),
        percent: cell.percent,
        label: cell.label,
        remark: cell.remark,
        isPassing: cell.isPassing,
      };
    });

    const { ranked, unranked, stats } = rankStudents(rawRows, { sortTieBy: 'code' });
    const myRanked = viewerUser ? ranked.find((r) => r.studentId === viewerUser.id) : null;
    const myUnranked = !myRanked && viewerUser ? unranked.find((r) => r.studentId === viewerUser.id) : null;
    const mine = myRanked ?? myUnranked;

    return {
      enabled: true,
      showScores,
      released: true,
      releasedAt: active.releasedAt,
      myCode,
      scopes: releasedScopes.map((s) => ({ scope: s.scope, name: s.name, kind: s.kind, releasedAt: s.releasedAt })),
      activeScope: active.scope,
      activeScopeName: active.name,
      myRank: myRanked ? myRanked.rank : null,
      myPercent: mine?.percent ?? null,
      myLabel: mine?.label ?? null,
      myRemark: mine?.remark ?? null,
      totalStudents: stats.totalStudents,
      totalRanked: stats.totalRanked,
      unrankedCount: stats.unrankedCount,
      stats: {
        topPercent: showScores ? stats.topPercent : null,
        averagePercent: showScores ? stats.averagePercent : null,
      },
      // Strictly anonymous: no studentId, name, email, or studentNumber.
      entries: ranked.map((r) => ({
        rank: r.rank,
        code: r.code,
        isSelf: viewerUser ? r.studentId === viewerUser.id : false,
        ...(showScores ? { percent: r.percent, label: r.label, remark: r.remark, isPassing: r.isPassing } : {}),
      })),
    };
  }

  // Teacher / Admin view: provide named honor roll and separate anonymous preview (never joined in one row).
  if (requestedScope && !scopes.some((s) => s.scope === requestedScope)) {
    throw notFound('Grading period');
  }
  const active = requestedScope
    ? scopes.find((s) => s.scope === requestedScope)
    : (scopes.find((s) => s.scope === OVERALL_SCOPE) ?? scopes[0] ?? null);

  if (!active) {
    return {
      enabled: Boolean(cls.gradeRankingEnabled),
      showScores,
      scopes: [],
      activeScope: null,
      activeScopeName: null,
      released: false,
      stats: { totalStudents: students.length, totalRanked: 0, unrankedCount: students.length, topPercent: null, averagePercent: null },
      namedEntries: [],
      anonymousEntries: [],
    };
  }

  const namedRaw = students.map((row) => {
    const cell = extractCell(row, active.scope);
    return {
      studentId: row.student.id,
      name: row.student.name,
      firstName: row.student.firstName,
      lastName: row.student.lastName,
      studentNumber: row.student.studentNumber,
      ...cell,
    };
  });

  const anonRaw = students.map((row) => {
    const cell = extractCell(row, active.scope);
    return {
      code: codesByStudent.get(row.student.id),
      percent: cell.percent,
      label: cell.label,
      remark: cell.remark,
      isPassing: cell.isPassing,
    };
  });

  const namedResult = rankStudents(namedRaw, { sortTieBy: 'name' });
  const anonResult = rankStudents(anonRaw, { sortTieBy: 'code' });

  return {
    enabled: Boolean(cls.gradeRankingEnabled),
    showScores,
    released: active.released,
    releasedAt: active.releasedAt,
    scopes: scopes.map((s) => ({ scope: s.scope, name: s.name, kind: s.kind, released: s.released, releasedAt: s.releasedAt })),
    activeScope: active.scope,
    activeScopeName: active.name,
    stats: namedResult.stats,
    // Teacher view separates identity (namedEntries) from student codes (anonymousEntries).
    namedEntries: namedResult.ranked.map((r) => ({
      rank: r.rank,
      studentId: r.studentId,
      name: r.name,
      firstName: r.firstName,
      lastName: r.lastName,
      studentNumber: r.studentNumber,
      percent: r.percent,
      label: r.label,
      remark: r.remark,
      isPassing: r.isPassing,
      isOverridden: r.isOverridden,
    })),
    anonymousEntries: anonResult.ranked.map((r) => ({
      rank: r.rank,
      code: r.code,
      ...(showScores ? { percent: r.percent, label: r.label, remark: r.remark, isPassing: r.isPassing } : {}),
    })),
  };
}
