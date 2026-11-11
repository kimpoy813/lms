import { afterEach, describe, expect, it, vi } from 'vitest';
import { distanceMeters, LocationError, readLocation } from './geo.js';

const fakeGeolocation = (script) => {
  const api = {
    clearWatch: vi.fn(),
    watchPosition: vi.fn((ok, fail) => {
      script({ ok: (accuracy, latitude = 15.145, longitude = 120.5887) => ok({ coords: { latitude, longitude, accuracy } }), fail: (code) => fail({ code }) });
      return 7;
    }),
  };
  Object.defineProperty(globalThis.navigator, 'geolocation', { value: api, configurable: true });
  return api;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('distanceMeters', () => {
  it('is zero for the same point and about 111 km per degree of latitude', () => {
    const p = { latitude: 15.145, longitude: 120.5887 };
    expect(distanceMeters(p, p)).toBe(0);
    expect(distanceMeters(p, { latitude: 16.145, longitude: 120.5887 })).toBeGreaterThan(110_000);
    expect(distanceMeters(p, { latitude: 16.145, longitude: 120.5887 })).toBeLessThan(112_000);
  });
  it('measures a classroom-sized distance to within a metre', () => {
    // 0.00045 degrees of latitude is about 50 m.
    const d = distanceMeters({ latitude: 15.145, longitude: 120.5887 }, { latitude: 15.14545, longitude: 120.5887 });
    expect(Math.abs(d - 50)).toBeLessThan(1);
  });
});

describe('readLocation', () => {
  it('resolves as soon as a reading is accurate enough', async () => {
    const geo = fakeGeolocation(({ ok }) => setTimeout(() => ok(12), 0));
    const reading = await readLocation({ goodEnoughMeters: 30 });
    expect(reading).toEqual({ latitude: 15.145, longitude: 120.5887, accuracy: 12 });
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
  });

  it('keeps the best of several rough readings when time runs out', async () => {
    vi.useFakeTimers();
    const progress = [];
    fakeGeolocation(({ ok }) => {
      setTimeout(() => ok(180), 10);
      setTimeout(() => ok(65), 20);
      setTimeout(() => ok(90), 30);
    });
    const promise = readLocation({ goodEnoughMeters: 30, maxWaitMs: 1000, onProgress: (a) => progress.push(a) });
    await vi.advanceTimersByTimeAsync(1100);
    expect((await promise).accuracy).toBe(65);
    expect(progress).toEqual([180, 65, 65]);
  });

  it('explains a denied permission', async () => {
    fakeGeolocation(({ fail }) => setTimeout(() => fail(1), 0));
    await expect(readLocation()).rejects.toMatchObject({ name: 'LocationError', code: 'DENIED' });
  });

  it('does not fail when the device gives up after a usable reading', async () => {
    fakeGeolocation(({ ok, fail }) => { setTimeout(() => ok(70), 0); setTimeout(() => fail(3), 5); });
    expect((await readLocation({ goodEnoughMeters: 30 })).accuracy).toBe(70);
  });

  it('rejects when the browser has no geolocation', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'geolocation');
    delete globalThis.navigator.geolocation;
    await expect(readLocation()).rejects.toBeInstanceOf(LocationError);
    if (original) Object.defineProperty(globalThis.navigator, 'geolocation', original);
  });
});
