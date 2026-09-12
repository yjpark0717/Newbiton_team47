/** A geographic point used by the route comparison module. */
export type Point = {
  lat: number;
  lng: number;
  name?: string;
};

/** A single passenger's origin and destination. */
export type RideInput = {
  start: Point;
  end: Point;
};

/** The two rides that may be compared for a shared taxi trip. */
export type CompareInput = {
  ownerRide: RideInput;
  requesterRide: RideInput;
};

/** Normalized route data returned by a car-routing provider. */
export type RouteResult = {
  distanceMeters: number;
  durationSeconds: number;
  taxiFare: number;
  tollFare?: number;
  path?: Point[];
};

/** A shared-route candidate with fare, time, and recommendation results. */
export type CandidateResult = {
  id: string;
  label: string;
  order: string[];
  route: RouteResult;
  ownerSharedRoute: RouteResult;
  requesterSharedRoute: RouteResult;
  totalFare: number;
  ownerPay: number;
  requesterPay: number;
  ownerSaved: number;
  requesterSaved: number;
  ownerExtraSeconds: number;
  requesterExtraSeconds: number;
  recommended: boolean;
};

/** Complete comparison result for the two rides. */
export type CompareResult = {
  ownerAlone: RouteResult;
  requesterAlone: RouteResult;
  candidates: CandidateResult[];
  bestCandidate: CandidateResult | null;
};