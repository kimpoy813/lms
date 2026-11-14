import { describe, expect, it } from 'vitest';
import {
  LEAVING_KINDS, MAX_WARNINGS, MIN_RESUME_SECONDS, VIOLATION_KINDS, VIOLATION_TEXT,
  durationText, pageOpening, reopenClock, rulesApply, secondsLeftWhenEnded, violationOutcome, violationText,
} from '../../src/modules/quizzes/rules.js';

const at = (iso) => new Date(iso);

describe('the kinds of violation', () => {
  it('each have words for people', () => {
    expect(Object.keys(VIOLATION_TEXT).sort()).toEqual([...VIOLATION_KINDS].sort());
    for (const kind of VIOLATION_KINDS) expect(violationText(kind)).toMatch(/^[a-z]/);
    expect(violationText('SOMETHING_NEW')).toBe('broke a rule of the quiz');
    for (const kind of LEAVING_KINDS) expect(VIOLATION_KINDS).toContain(kind);
  });
});

describe('which attempts the rules bind', () => {
  it('only those started under them, while they are switched on', () => {
    const accepted = { rulesAcceptedAt: at('2026-11-13T01:00:00Z') };
    expect(rulesApply({ strictMode: true }, accepted)).toBe(true);
    // Started before the teacher switched the rules on: the student was never shown them.
    expect(rulesApply({ strictMode: true }, { rulesAcceptedAt: null })).toBe(false);
    // Switched off while the attempt is running.
    expect(rulesApply({ strictMode: false }, accepted)).toBe(false);
    expect(rulesApply(null, accepted)).toBe(false);
    expect(rulesApply({ strictMode: true }, null)).toBe(false);
  });
});

describe('what one more violation leads to', () => {
  it('ends the attempt at once when no warnings are allowed', () => {
    expect(violationOutcome({ violationWarnings: 0 }, { violationCount: 0 })).toEqual({ number: 1, allowed: 0, terminate: true, warningsLeft: 0 });
    expect(violationOutcome({}, {})).toEqual({ number: 1, allowed: 0, terminate: true, warningsLeft: 0 });
  });

  it('warns as often as the teacher allows, and ends the attempt on the violation after that', () => {
    const quiz = { violationWarnings: 2 };
    expect(violationOutcome(quiz, { violationCount: 0 })).toEqual({ number: 1, allowed: 2, terminate: false, warningsLeft: 1 });
    expect(violationOutcome(quiz, { violationCount: 1 })).toEqual({ number: 2, allowed: 2, terminate: false, warningsLeft: 0 });
    expect(violationOutcome(quiz, { violationCount: 2 })).toEqual({ number: 3, allowed: 2, terminate: true, warningsLeft: 0 });
  });

  it('keeps the number of warnings within bounds whatever is stored', () => {
    expect(violationOutcome({ violationWarnings: 99 }, { violationCount: MAX_WARNINGS })).toMatchObject({ allowed: MAX_WARNINGS, terminate: true });
    expect(violationOutcome({ violationWarnings: -3 }, { violationCount: 0 })).toMatchObject({ allowed: 0, terminate: true });
  });
});

describe('the quiz page says it has opened the attempt', () => {
  it('is expected the first time', () => {
    expect(pageOpening({ pageOpenedAt: null, awaySince: null })).toBe('FIRST');
  });

  it('is a violation of its own when nothing said that the page was closed', () => {
    expect(pageOpening({ pageOpenedAt: at('2026-11-13T01:00:00Z'), awaySince: null })).toBe('UNREPORTED');
  });

  it('is the end of an absence that was already counted', () => {
    expect(pageOpening({ pageOpenedAt: at('2026-11-13T01:00:00Z'), awaySince: at('2026-11-13T01:05:00Z') })).toBe('AFTER_LEAVING');
  });
});

describe('the time left when an attempt was ended', () => {
  it('is what the clock still showed', () => {
    expect(secondsLeftWhenEnded({ deadlineAt: at('2026-11-13T01:30:00Z'), terminatedAt: at('2026-11-13T01:12:30.400Z') })).toBe(1050);
  });

  it('is never negative, and unknown without a clock', () => {
    expect(secondsLeftWhenEnded({ deadlineAt: at('2026-11-13T01:30:00Z'), terminatedAt: at('2026-11-13T01:30:02Z') })).toBe(0);
    expect(secondsLeftWhenEnded({ deadlineAt: null, terminatedAt: at('2026-11-13T01:12:00Z') })).toBeNull();
    expect(secondsLeftWhenEnded({ deadlineAt: at('2026-11-13T01:30:00Z'), terminatedAt: null })).toBeNull();
  });
});

describe('the clock of a reopened attempt', () => {
  const now = at('2026-11-13T02:00:00Z');
  const ended = { deadlineAt: at('2026-11-13T01:30:00Z'), terminatedAt: at('2026-11-13T01:10:00Z') }; // 20 minutes were left
  const timed = { timeLimitMinutes: 30, availableUntil: null };

  it('gives back the time that was left', () => {
    expect(reopenClock(timed, ended, {}, now)).toEqual({ resumeSeconds: 1200, deadlineAt: null });
  });

  it('leaves at least a minute, however little was left', () => {
    const lastSeconds = { deadlineAt: at('2026-11-13T01:30:00Z'), terminatedAt: at('2026-11-13T01:29:55Z') };
    expect(reopenClock(timed, lastSeconds, {}, now)).toEqual({ resumeSeconds: MIN_RESUME_SECONDS, deadlineAt: null });
  });

  it('gives the minutes the teacher says, more or fewer than were left', () => {
    expect(reopenClock(timed, ended, { minutes: 45 }, now).resumeSeconds).toBe(2700);
    expect(reopenClock(timed, ended, { minutes: 5 }, now).resumeSeconds).toBe(300);
    // An untimed quiz can be given a timer for this one attempt.
    expect(reopenClock({ timeLimitMinutes: null, availableUntil: null }, { deadlineAt: null, terminatedAt: now }, { minutes: 10 }, now).resumeSeconds).toBe(600);
  });

  it('sets no timer for a quiz that has none', () => {
    expect(reopenClock({ timeLimitMinutes: null, availableUntil: null }, { deadlineAt: null, terminatedAt: now }, {}, now)).toEqual({ resumeSeconds: null, deadlineAt: null });
  });

  it('gives the whole time limit when the attempt had no clock but the quiz has one now', () => {
    expect(reopenClock(timed, { deadlineAt: null, terminatedAt: now }, {}, now).resumeSeconds).toBe(1800);
  });

  it('must be continued before the quiz closes', () => {
    const closes = at('2026-11-13T09:00:00Z');
    expect(reopenClock({ ...timed, availableUntil: closes }, ended, {}, now)).toEqual({ resumeSeconds: 1200, deadlineAt: closes });
  });

  it('can be given its own time to continue by, also later than the quiz closes', () => {
    const later = at('2026-11-14T09:00:00Z');
    expect(reopenClock({ ...timed, availableUntil: at('2026-11-13T09:00:00Z') }, ended, { continueBy: later }, now).deadlineAt).toBe(later);
  });

  it('needs a time to continue by once the quiz has closed', () => {
    const closed = { ...timed, availableUntil: at('2026-11-13T01:45:00Z') };
    expect(reopenClock(closed, ended, {}, now)).toEqual({ errors: { continueBy: expect.stringMatching(/has closed/) } });
    const later = at('2026-11-13T05:00:00Z');
    expect(reopenClock(closed, ended, { continueBy: later }, now)).toEqual({ resumeSeconds: 1200, deadlineAt: later });
  });

  it('refuses a time that has passed', () => {
    expect(reopenClock(timed, ended, { continueBy: at('2026-11-13T01:59:00Z') }, now)).toEqual({ errors: { continueBy: expect.stringMatching(/not passed/) } });
    expect(reopenClock(timed, ended, { continueBy: now }, now)).toHaveProperty('errors.continueBy');
  });
});

describe('a length of time in words', () => {
  it.each([
    [0, '0 seconds'], [1, '1 second'], [59, '59 seconds'], [60, '1 minute'], [89, '1 minute'], [90, '2 minutes'], [1200, '20 minutes'],
    [3600, '1 hour'], [3900, '1 hour 5 minutes'], [7260, '2 hours 1 minute'], [-5, '0 seconds'], [44.6, '45 seconds'],
  ])('%d seconds → %s', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });
});
