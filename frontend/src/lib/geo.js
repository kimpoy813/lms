// Reading the device's location for attendance.
//
// The browser asks the user for permission. The reading is sent once to the server, which
// computes the distance to the classroom and stores only that distance — never the coordinates.

const MESSAGES = {
  1: 'Location permission was denied. Allow location access for this site in your browser settings, then try again.',
  2: 'Your device could not determine its location. Turn on Location (GPS) and try again, preferably near a window.',
  3: 'Getting your location took too long. Move near a window or outdoors and try again.',
};

export class LocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocationError';
    this.code = code; // 'UNSUPPORTED' | 'INSECURE' | 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT'
  }
}

/**
 * Get the best location reading within a few seconds.
 * Phones often report a rough position first and improve it; we keep watching until the
 * accuracy is good enough or the time is up, and return the best reading seen.
 *
 * @param {{ goodEnoughMeters?: number, maxWaitMs?: number, onProgress?: (accuracy: number) => void }} [options]
 * @returns {Promise<{ latitude: number, longitude: number, accuracy: number }>}
 */
export function readLocation({ goodEnoughMeters = 30, maxWaitMs = 12_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new LocationError('UNSUPPORTED', 'This browser cannot share its location. Use the attendance code instead, or ask your teacher to mark you.'));
    if (window.isSecureContext === false) return reject(new LocationError('INSECURE', 'Location only works on a secure (https) connection.'));
    let best = null;
    let done = false;
    let watchId = null;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else reject(error ?? new LocationError('TIMEOUT', MESSAGES[3]));
    };
    const timer = setTimeout(() => finish(), maxWaitMs);
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const reading = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
        if (!best || reading.accuracy < best.accuracy) best = reading;
        onProgress?.(Math.round(best.accuracy));
        if (best.accuracy <= goodEnoughMeters) finish();
      },
      (err) => {
        // A timeout or "unavailable" after a usable reading is not a failure.
        if (best) return finish();
        return finish(new LocationError({ 1: 'DENIED', 2: 'UNAVAILABLE', 3: 'TIMEOUT' }[err.code] ?? 'UNAVAILABLE', MESSAGES[err.code] ?? MESSAGES[2]));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    );
    return undefined;
  });
}

/** Distance between two points in metres (haversine). Used only to draw things; the server decides. */
export function distanceMeters(a, b) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
