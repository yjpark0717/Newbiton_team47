import type { Point, RouteResult } from './types';

const EARTH_RADIUS_METERS = 6_371_000;
const MOCK_ROAD_FACTOR = 1.25;
const MOCK_AVERAGE_SPEED_KMH = 30;
const MOCK_BASE_FARE = 4_800;
const MOCK_INCLUDED_DISTANCE_METERS = 1_600;
const MOCK_FARE_PER_KILOMETER = 1_000;

/** Calculates the great-circle distance between two coordinates. */
function getStraightLineDistanceMeters(first: Point, second: Point): number {
  const latitudeDelta = toRadians(second.lat - first.lat);
  const longitudeDelta = toRadians(second.lng - first.lng);
  const firstLatitude = toRadians(first.lat);
  const secondLatitude = toRadians(second.lat);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

/** Converts degrees to radians for the distance calculation. */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Estimates a mock taxi fare from the estimated road distance. */
function estimateMockTaxiFare(distanceMeters: number): number {
  const chargeableDistance = Math.max(
    0,
    distanceMeters - MOCK_INCLUDED_DISTANCE_METERS,
  );
  const distanceFare =
    Math.ceil(chargeableDistance / 1_000) * MOCK_FARE_PER_KILOMETER;

  return MOCK_BASE_FARE + distanceFare;
}

/** Returns a mock car route; replace this function with a server-side API adapter later. */
export async function getCarRoute(points: Point[]): Promise<RouteResult> {
  if (points.length < 2) {
    throw new Error('At least two points are required to calculate a route.');
  }

  const straightLineDistance = points.slice(1).reduce((totalDistance, point, index) => {
    return totalDistance + getStraightLineDistanceMeters(points[index], point);
  }, 0);
  const distanceMeters = Math.round(straightLineDistance * MOCK_ROAD_FACTOR);
  const durationSeconds = Math.round(
    (distanceMeters / 1_000 / MOCK_AVERAGE_SPEED_KMH) * 3_600,
  );

  return {
    distanceMeters,
    durationSeconds,
    taxiFare: estimateMockTaxiFare(distanceMeters),
    path: points,
  };
}