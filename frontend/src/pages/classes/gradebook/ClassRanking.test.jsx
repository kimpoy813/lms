import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { StudentRankingCard } from './ClassRanking.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'stu-1', role: 'STUDENT' }, isStudent: true, isAdmin: false, isTeacher: false, can: () => false }),
}));

vi.mock('../useClass.js', () => ({
  useClass: () => ({ cls: { id: 'cls-1', status: 'ACTIVE' }, canManage: false, isStudent: true, base: '/classes/cls-1' }),
}));

function renderWithProviders(node) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('StudentRankingCard', () => {
  it('masks the private code by default, reveals it on click, and shows anonymous standings', () => {
    const ranking = {
      enabled: true,
      showScores: true,
      released: true,
      releasedAt: '2026-11-18T08:00:00Z',
      myCode: 'K7M9P2X4',
      scopes: [{ scope: 'OVERALL', name: 'Overall grade', kind: 'OVERALL' }],
      activeScope: 'OVERALL',
      activeScopeName: 'Overall grade',
      myRank: 2,
      myPercent: 93.5,
      myLabel: '1.50',
      myRemark: 'Very Good',
      totalStudents: 3,
      totalRanked: 2,
      unrankedCount: 1,
      stats: { topPercent: 97, averagePercent: 95.25 },
      entries: [
        { rank: 1, code: 'Q4W8R2T6', isSelf: false, percent: 97, label: '1.00', remark: 'Excellent', isPassing: true },
        { rank: 2, code: 'K7M9P2X4', isSelf: true, percent: 93.5, label: '1.50', remark: 'Very Good', isPassing: true },
      ],
    };

    const { container, unmount } = renderWithProviders(<StudentRankingCard ranking={ranking} readOnly={false} />);
    expect(container.textContent).toContain('Rank #2 of 2');
    expect(container.textContent).toContain('••••••••');
    expect(container.textContent).toContain('Q4W8R2T6');
    expect(container.textContent).toContain('You');

    const toggleBtn = container.querySelector('button[aria-label="Show secret code"]');
    expect(toggleBtn).toBeTruthy();
    act(() => toggleBtn.click());
    expect(container.textContent).toContain('K7M9P2X4');
    unmount();
  });

  it('shows waiting state when enabled but no grading period has been published yet', () => {
    const ranking = {
      enabled: true,
      showScores: true,
      released: false,
      myCode: 'ABC12345',
      scopes: [],
      activeScope: null,
      activeScopeName: null,
      myRank: null,
      myPercent: null,
      myLabel: null,
      myRemark: null,
      totalStudents: 2,
      totalRanked: 0,
      unrankedCount: 2,
      stats: { topPercent: null, averagePercent: null },
      entries: [],
    };
    const { container, unmount } = renderWithProviders(<StudentRankingCard ranking={ranking} readOnly={false} />);
    expect(container.textContent).toContain('No rankings released yet');
    expect(container.textContent).toContain('Change code');
    unmount();
  });

  it('hides peer grade columns when showScores is false while keeping student own grade', () => {
    const ranking = {
      enabled: true,
      showScores: false,
      released: true,
      releasedAt: '2026-11-18T08:00:00Z',
      myCode: 'K7M9P2X4',
      scopes: [{ scope: 'OVERALL', name: 'Overall grade', kind: 'OVERALL' }],
      activeScope: 'OVERALL',
      activeScopeName: 'Overall grade',
      myRank: 1,
      myPercent: 95,
      myLabel: '1.25',
      myRemark: 'Very Good',
      totalStudents: 2,
      totalRanked: 2,
      unrankedCount: 0,
      stats: { topPercent: null, averagePercent: null },
      entries: [
        { rank: 1, code: 'K7M9P2X4', isSelf: true },
        { rank: 2, code: 'ZZZZ9999', isSelf: false },
      ],
    };

    const { container, unmount } = renderWithProviders(<StudentRankingCard ranking={ranking} readOnly={false} />);
    expect(container.textContent).toContain('Rank #1 of 2');
    expect(container.textContent).toContain('95%');
    expect(container.textContent).not.toContain('Grade %');
    unmount();
  });
});
