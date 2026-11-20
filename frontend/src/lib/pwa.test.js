import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetPwaForTest, canInstallPwa, enableWebPush, initPwaListeners, promptInstallPwa, subscribeInstallPrompt, subscriptionMatchesKey, urlBase64ToUint8Array } from './pwa.js';

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

  it('decodes base64url VAPID public keys to Uint8Array and rotates mismatched push subscriptions', async () => {
    const bytes = urlBase64ToUint8Array('AQID');
    expect([...bytes]).toEqual([1, 2, 3]);

    const oldSub = {
      endpoint: 'https://push.example/old',
      options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer },
      unsubscribe: vi.fn().mockResolvedValue(true),
      toJSON: () => ({ endpoint: 'https://push.example/old', keys: { p256dh: 'oldp', auth: 'olda' } }),
    };
    const newSub = {
      endpoint: 'https://push.example/new',
      options: { applicationServerKey: bytes.buffer },
      toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'newp', auth: 'newa' } }),
    };

    expect(subscriptionMatchesKey(oldSub, 'AQID')).toBe(false);
    expect(subscriptionMatchesKey(newSub, 'AQID')).toBe(true);

    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue(oldSub),
      subscribe: vi.fn().mockResolvedValue(newSub),
    };
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager }) },
    });
    window.PushManager = function PushManager() {};

    const apiClient = { post: vi.fn().mockResolvedValue({ subscribed: true }) };
    const sub = await enableWebPush('AQID', apiClient);

    expect(oldSub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/notifications/push/subscribe', {
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'newp', auth: 'newa' },
    });
    expect(sub).toBe(newSub);
  });
});
