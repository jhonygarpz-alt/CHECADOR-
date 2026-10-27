const EARTH_RADIUS_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

/** Distancia en metros entre dos coordenadas (fórmula de Haversine). */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export const isLatitude = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
export const isLongitude = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

/** Devuelve la ubicación más cercana a (lat, lng) junto con su distancia. */
export function nearestLocation(locations, lat, lng) {
  let best = null;
  for (const loc of locations) {
    const distance = distanceMeters(lat, lng, loc.lat, loc.lng);
    if (!best || distance < best.distance) best = { location: loc, distance };
  }
  return best;
}
