import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetPwaForTest, canInstallPwa, initPwaListeners, promptInstallPwa, subscribeInstallPrompt } from './pwa.js';

describe('pwa install helpers', () => {
  beforeEach(() => {
    _resetPwaForTest();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  });

  it('tracks beforeinstallprompt and resolves promptInstallPwa cleanly', async () => {
    const states = [];
    const unsubListeners = initPwaListeners();
    const unsubSub = subscribeInstallPrompt((v) => states.push(v));

    expect(canInstallPwa()).toBe(false);
    expect(states).toEqual([false]);

    const prompt = vi.fn().mockResolvedValue(undefined);
    const ev = new Event('beforeinstallprompt', { cancelable: true });
    ev.prompt = prompt;
    ev.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(canInstallPwa()).toBe(true);
    expect(states).toEqual([false, true]);

    const outcome = await promptInstallPwa();
    expect(outcome).toBe('accepted');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(canInstallPwa()).toBe(false);
    expect(states).toEqual([false, true, false]);

    unsubSub();
    unsubListeners();
  });
});
