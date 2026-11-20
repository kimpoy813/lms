import { describe, expect, it } from 'vitest';
import { normalizeRankingCode, rankStudents, rankingCodeIdentityIssue } from '../../src/modules/gradebook/ranking.js';

describe('rankStudents', () => {
  it('computes standard competition ranking (1, 1, 3) and excludes ungraded rows', () => {
    const rows = [
      { studentId: 's1', code: 'ZZZZ9999', name: 'Alice Cruz', percent: 94.5 },
      { studentId: 's2', code: 'AAAA1111', name: 'Zara Reyes', percent: 94.5 },
      { studentId: 's3', code: 'MMMM5555', name: 'Ben Santos', percent: 98 },
      { studentId: 's4', code: 'BBBB2222', name: 'Cara Lim', percent: 88.25 },
      { studentId: 's5', code: 'CCCC3333', name: 'Dan Ong', percent: null },
    ];

    const { ranked, unranked, stats } = rankStudents(rows, { sortTieBy: 'code' });
    expect(ranked.map((r) => [r.rank, r.code, r.percent])).toEqual([
      [1, 'MMMM5555', 98],
      [2, 'AAAA1111', 94.5], // tie ordered strictly by code, NOT by name ('Zara' comes before 'Alice' here!)
      [2, 'ZZZZ9999', 94.5],
      [4, 'BBBB2222', 88.25],
    ]);
    expect(unranked.map((r) => r.code)).toEqual(['CCCC3333']);
    expect(stats).toEqual({
      totalStudents: 5,
      totalRanked: 4,
      unrankedCount: 1,
      topPercent: 98,
      averagePercent: 93.81,
    });
  });

  it('orders ties by name only for the teacher named view', () => {
    const rows = [
      { studentId: 's1', code: 'ZZZZ9999', name: 'Alice Cruz', studentNumber: '2026-002', percent: 90 },
      { studentId: 's2', code: 'AAAA1111', name: 'Zara Reyes', studentNumber: '2026-001', percent: 90 },
    ];
    const named = rankStudents(rows, { sortTieBy: 'name' });
    expect(named.ranked.map((r) => r.name)).toEqual(['Alice Cruz', 'Zara Reyes']);
  });
});

describe('ranking code validation and identity safety', () => {
  const user = {
    firstName: 'Maria',
    middleName: 'Dela',
    lastName: 'Santos',
    email: 'msantos2026@school.edu.ph',
    studentNumber: '2026-00412',
  };

  it('normalizes input to uppercase alphanumeric characters', () => {
    expect(normalizeRankingCode(' ph-oe_nix 42 ')).toBe('PHOENIX42');
  });

  it('rejects empty, too-short, or too-long codes', () => {
    expect(rankingCodeIdentityIssue('', user)).toBeTruthy();
    expect(rankingCodeIdentityIssue('ABC12', user)).toBeTruthy();
    expect(rankingCodeIdentityIssue('A'.repeat(17), user)).toBeTruthy();
  });

  it('rejects codes embedding own first name, last name, email prefix, or student number', () => {
    expect(rankingCodeIdentityIssue('MARIA999', user)).toMatch(/name, e-mail, or student number/i);
    expect(rankingCodeIdentityIssue('XYSANTOS1', user)).toMatch(/name, e-mail, or student number/i);
    expect(rankingCodeIdentityIssue('MSANTOS2026', user)).toMatch(/name, e-mail, or student number/i);
    expect(rankingCodeIdentityIssue('202600412', user)).toMatch(/name, e-mail, or student number/i);
    expect(rankingCodeIdentityIssue('00412XYZ', user)).toMatch(/name, e-mail, or student number/i);
  });

  it('accepts unrelated secret codes between 6 and 16 characters', () => {
    expect(rankingCodeIdentityIssue('PHOENIX42', user)).toBeNull();
    expect(rankingCodeIdentityIssue('K7M9P2X4', user)).toBeNull();
  });
});
