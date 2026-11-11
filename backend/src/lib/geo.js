// Geodesy helpers for geofenced attendance. All distance decisions are made on the server with
// these functions — a distance computed in the browser is never trusted.

const EARTH_RADIUS_METERS = 6_371_008.8; // IUGG mean Earth radius

const toRadians = (degrees) => (degrees * Math.PI) / 180;

export function isValidLatitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * Great-circle distance between two WGS-84 coordinates using the haversine formula.
 * Accurate to well under a metre at classroom scale.
 * @returns {number} distance in metres
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const dPhi = toRadians(lat2 - lat1);
  const dLambda = toRadians(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decide whether a reported position satisfies a geofence.
 *
 * Order of checks matters: an unusable reading is reported as such (so the client can retry)
 * before any distance verdict is given. Presence is never inferred from a missing or vague fix.
 *
 * @param {{ latitude: number, longitude: number, radiusMeters: number, maxAccuracyMeters: number }} fence
 * @param {{ latitude?: number, longitude?: number, accuracy?: number } | null | undefined} position
 * @returns {{ ok: true, distanceMeters: number, accuracyMeters: number }
 *          | { ok: false, reason: 'LOCATION_REQUIRED' | 'LOCATION_INVALID' | 'LOW_ACCURACY' | 'OUTSIDE_RADIUS',
 *              distanceMeters?: number, accuracyMeters?: number }}
 */
export function evaluateGeofence(fence, position) {
  if (!position || position.latitude === undefined || position.latitude === null) {
    return { ok: false, reason: 'LOCATION_REQUIRED' };
  }
  const { latitude, longitude, accuracy } = position;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    return { ok: false, reason: 'LOCATION_INVALID' };
  }
  // A fix without a usable accuracy estimate cannot be validated against the policy.
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0) {
    return { ok: false, reason: 'LOW_ACCURACY' };
  }
  if (accuracy > fence.maxAccuracyMeters) {
    return { ok: false, reason: 'LOW_ACCURACY', accuracyMeters: accuracy };
  }
  const distanceMeters = haversineMeters(fence.latitude, fence.longitude, latitude, longitude);
  if (distanceMeters > fence.radiusMeters) {
    return { ok: false, reason: 'OUTSIDE_RADIUS', distanceMeters, accuracyMeters: accuracy };
  }
  return { ok: true, distanceMeters, accuracyMeters: accuracy };
}
