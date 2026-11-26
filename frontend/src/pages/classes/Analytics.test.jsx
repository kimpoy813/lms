import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Analytics from './Analytics.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { apiGet, classContext } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  classContext: { canManage: true },
}));

vi.mock('../../lib/api.js', () => ({ api: { get: apiGet } }));
vi.mock('./useClass.js', () => ({
  useClass: () => ({ cls: { id: 'class-1' }, canManage: classContext.canManage, base: '/classes/class-1' }),
}));
vi.mock('./AnalyticsCharts.jsx', () => ({ default: () => null }));

let root;
let container;

function data() {
  const students = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    const atRisk = number <= 3;
    return {
      id: `student-${number}`,
      name: `Student ${number}`,
      studentNumber: `2026-000${number}`,
      percent: 90 - number,
      attendanceRate: 95,
      missing: atRisk ? 2 : 0,
      missingItems: atRisk ? [{ title: `Missing task ${number}` }] : [],
      risk: {
        level: atRisk ? (number === 1 ? 'HIGH' : 'MEDIUM') : 'NONE',
        reasons: atRisk ? [{ text: `Student ${number} needs a check-in` }] : [],
      },
    };
  });
  return {
    summary: { students: 8, averageGrade: 85, averageAttendance: 95, atRisk: 3, highRisk: 1, lessonCompletion: 70, onTime: 10, late: 2, missing: 6 },
    thresholds: { gradeBelow: 75, attendanceBelow: 80, missingAtLeast: 2 },
    assessments: [],
    students,
  };
}

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter><Analytics /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  root = null;
  container = null;
});

describe('Class analytics student list', () => {
  beforeEach(() => {
    classContext.canManage = true;
    apiGet.mockReset().mockResolvedValue(data());
  });

  it('searches by student number and keeps the risk filter available', async () => {
    await renderPage();
    expect(document.body.textContent).toContain('8 students match the current filters');

    const search = document.querySelector('input[placeholder="Search students by name or ID…"]');
    await act(async () => { setInputValue(search, '2026-0008'); });
    expect(document.body.textContent).toContain('1 student matches the current filters');
    expect(document.body.textContent).toContain('Student 8');
    expect(document.body.textContent).not.toContain('Student 7');

    await act(async () => { setInputValue(search, ''); });
    const riskFilter = [...document.querySelectorAll('button[role="radio"]')].find((button) => button.textContent === 'May need help');
    await act(async () => { riskFilter.click(); });
    expect(document.body.textContent).toContain('3 students match the current filters');
    expect(document.body.textContent).toContain('Student 1');
    expect(document.body.textContent).not.toContain('Student 8');
  });
});
