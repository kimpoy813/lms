import { describe, expect, it } from 'vitest';
import { askAgainWhileBusy, runnerProblem, totalTimeHint } from './codeRunner.js';

const busy = (retryAfterSeconds) => Object.assign(new Error('busy'), { code: 'CODE_RUNNER_BUSY', details: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds } });

describe('askAgainWhileBusy', () => {
  it('asks again after the wait the server suggested, a little longer each time', async () => {
    const waits = [];
    let calls = 0;
    const result = await askAgainWhileBusy(
      async () => {
        calls += 1;
        if (calls < 3) throw busy(4);
        return 'checked';
      },
      { wait: async (ms) => { waits.push(ms); } },
    );
    expect(result).toBe('checked');
    expect(calls).toBe(3);
    expect(waits).toEqual([4000, 6000]);
  });

  it('gives up after the allowed number of tries and passes the last answer on', async () => {
    let calls = 0;
    const seen = [];
    await expect(askAgainWhileBusy(async () => { calls += 1; throw busy(); }, { retries: 2, wait: async () => {}, onWait: (attempt, seconds) => seen.push([attempt, seconds]) })).rejects.toMatchObject({ code: 'CODE_RUNNER_BUSY' });
    expect(calls).toBe(3);
    expect(seen).toEqual([[1, 4], [2, 6]]);
  });

  it('never waits longer than ten seconds, whatever the server says', async () => {
    const waits = [];
    let calls = 0;
    await askAgainWhileBusy(async () => { calls += 1; if (calls === 1) throw busy(600); return 1; }, { wait: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([10_000]);
  });

  it('does not repeat a request that failed for another reason', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('no'), { code: 'CODE_RUNNER_UNAVAILABLE' });
    await expect(askAgainWhileBusy(async () => { calls += 1; throw failure; }, { wait: async () => {} })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('stops when nobody is waiting for the answer any more', async () => {
    let calls = 0;
    let wanted = true;
    await expect(askAgainWhileBusy(async () => { calls += 1; throw busy(1); }, { wait: async () => { wanted = false; }, stillWanted: () => wanted })).rejects.toMatchObject({ code: 'CODE_RUNNER_BUSY' });
    expect(calls).toBe(1);
  });
});

describe('runnerProblem', () => {
  it('tells a student in a quiz that the code is kept', () => {
    expect(runnerProblem({ code: 'CODE_RUNNER_PREPARING' }, { inQuiz: true })).toMatch(/being prepared.*saved with your answer/);
    expect(runnerProblem({ code: 'CODE_RUNNER_UNAVAILABLE' }, { inQuiz: true })).toMatch(/your teacher will mark it/);
    expect(runnerProblem({ code: 'CODE_RUNNER_BUSY' })).toMatch(/busy.*try again in a minute/);
  });

  it('shows the message for a field, then the server’s own message', () => {
    expect(runnerProblem({ code: 'VALIDATION_ERROR', fields: { language: 'This problem accepts: Python 3.' }, message: 'Please correct the highlighted fields.' })).toBe('This problem accepts: Python 3.');
    expect(runnerProblem({ code: 'ATTEMPT_CLOSED', message: 'This attempt has ended.' })).toBe('This attempt has ended.');
  });
});

describe('totalTimeHint', () => {
  it('says nothing while every test can use its full time', () => {
    expect(totalTimeHint(50_000, 10, 3000)).toBeUndefined();
    expect(totalTimeHint(50_000, 25, 2000)).toBeUndefined();
    expect(totalTimeHint(null, 25, 15_000)).toBeUndefined();
    expect(totalTimeHint(50_000, 0, 3000)).toBeUndefined();
  });

  it('tells how many tests a slow program gets through', () => {
    expect(totalTimeHint(50_000, 25, 3000)).toBe('The checker gives one program 50 seconds for all its tests together. A program that needs the full 3 s every time gets through about 16 of these 25 tests; the rest then count as too slow.');
    expect(totalTimeHint(50_000, 5, 15_000)).toMatch(/full 15 s every time gets through about 3 of these 5 tests/);
    expect(totalTimeHint(50_000, 2, 60_000)).toMatch(/about 1 of these 2 tests/);
  });
});
