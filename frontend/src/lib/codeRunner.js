// Asking the server to run a program.
//
// A judge that starts a machine for every program can be busy for a few seconds, for example when
// a whole class presses "Run" in the same minute. The server then answers CODE_RUNNER_BUSY instead
// of keeping the request waiting; asking again a moment later is what a student would do by hand.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `request` and, while the answer is "busy", wait and call it again.
 * @param {() => Promise<any>} request
 * @param {{ retries?: number, onWait?: (attempt: number, seconds: number) => void, wait?: (ms: number) => Promise<void>, stillWanted?: () => boolean }} [options]
 *   onWait is told before every wait; stillWanted lets the caller give up (the screen was left).
 */
export async function askAgainWhileBusy(request, { retries = 3, onWait, wait = sleep, stillWanted = () => true } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      if (err?.code !== 'CODE_RUNNER_BUSY' || attempt > retries || !stillWanted()) throw err;
      // The server's hint, a little longer each time, never more than ten seconds.
      const hinted = Number(err.details?.retryAfterSeconds);
      const seconds = Math.min(10, (Number.isFinite(hinted) && hinted > 0 ? hinted : 4) + (attempt - 1) * 2);
      onWait?.(attempt, seconds);
      await wait(seconds * 1000);
      if (!stillWanted()) throw err;
    }
  }
}

/** What to tell the person when a program could not be run. */
export function runnerProblem(err, { inQuiz = false } = {}) {
  const saved = 'Your code is saved with your answer';
  if (err?.code === 'CODE_RUNNER_BUSY') return `The code checker is busy right now. ${inQuiz ? `${saved}; try “Submit for checking” again in a minute.` : 'Please try again in a minute.'}`;
  if (err?.code === 'CODE_RUNNER_PREPARING') return `The machine that runs programs is being prepared, which takes a few minutes. ${inQuiz ? `${saved}; try again shortly.` : 'Please try again shortly.'}`;
  if (err?.code === 'CODE_RUNNER_UNAVAILABLE') return `Automatic checking is not available on this server right now. ${inQuiz ? `${saved}, and your teacher will mark it.` : 'Please try again later.'}`;
  return err?.fields?.language ?? err?.message ?? 'The program could not be run.';
}

/**
 * For the teacher who sets the time limit of a problem. Said only when it can matter: a program that is slow on every test may not
 * get through all of them, because the checker has a limit for a whole program too.
 */
export function totalTimeHint(totalMs, tests, limitMs) {
  if (!totalMs || !(tests > 0) || !(limitMs > 0) || tests * limitMs <= totalMs) return undefined;
  const reachable = Math.max(1, Math.floor(totalMs / limitMs));
  return `The checker gives one program ${Math.round(totalMs / 1000)} seconds for all its tests together. A program that needs the full ${limitMs / 1000} s every time gets through about ${reachable} of these ${tests} tests; the rest then count as too slow.`;
}
