import { getCarRoute } from './getCarRoute';
import type {
  CandidateResult,
  CompareInput,
  CompareResult,
  Point,
  RouteResult,
} from './types';

type StopId = 'A_START' | 'A_END' | 'B_START' | 'B_END';

type CandidateDefinition = {
  id: string;
  label: string;
  order: StopId[];
};

const CANDIDATE_DEFINITIONS: CandidateDefinition[] = [
  {
    id: 'a-start-b-start-b-end-a-end',
    label: 'A_START -> B_START -> B_END -> A_END',
    order: ['A_START', 'B_START', 'B_END', 'A_END'],
  },
  {
    id: 'a-start-b-start-a-end-b-end',
    label: 'A_START -> B_START -> A_END -> B_END',
    order: ['A_START', 'B_START', 'A_END', 'B_END'],
  },
  {
    id: 'b-start-a-start-a-end-b-end',
    label: 'B_START -> A_START -> A_END -> B_END',
    order: ['B_START', 'A_START', 'A_END', 'B_END'],
  },
  {
    id: 'b-start-a-start-b-end-a-end',
    label: 'B_START -> A_START -> B_END -> A_END',
    order: ['B_START', 'A_START', 'B_END', 'A_END'],
  },
];

/** Builds a lookup table from stop IDs to their coordinates. */
function createStopPoints(input: CompareInput): Record<StopId, Point> {
  return {
    A_START: input.ownerRide.start,
    A_END: input.ownerRide.end,
    B_START: input.requesterRide.start,
    B_END: input.requesterRide.end,
  };
}

/** Extracts one passenger's contiguous ride segment from a candidate order. */
function getPassengerSegment(
  order: StopId[],
  points: Record<StopId, Point>,
  start: StopId,
  end: StopId,
): Point[] {
  const startIndex = order.indexOf(start);
  const endIndex = order.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || startIndex >= endIndex) {
    throw new Error(`Invalid passenger segment: ${start} -> ${end}`);
  }

  return order.slice(startIndex, endIndex + 1).map((stopId) => points[stopId]);
}

/** Splits the shared fare in proportion to what each passenger would pay alone. */
function splitFareBySoloFare(
  totalFare: number,
  ownerSoloFare: number,
  requesterSoloFare: number,
): { ownerPay: number; requesterPay: number } {
  const combinedSoloFare = ownerSoloFare + requesterSoloFare;
  if (combinedSoloFare <= 0) {
    const ownerPay = Math.round(totalFare / 2);
    return { ownerPay, requesterPay: totalFare - ownerPay };
  }

  const ownerPay = Math.round(
    (totalFare * ownerSoloFare) / combinedSoloFare,
  );
  return { ownerPay, requesterPay: totalFare - ownerPay };
}

/** Calculates the comparison values for one shared-route candidate. */
async function createCandidateResult(
  definition: CandidateDefinition,
  points: Record<StopId, Point>,
  ownerAlone: RouteResult,
  requesterAlone: RouteResult,
): Promise<CandidateResult> {
  const fullRoutePoints = definition.order.map((stopId) => points[stopId]);
  const ownerSharedPoints = getPassengerSegment(
    definition.order,
    points,
    'A_START',
    'A_END',
  );
  const requesterSharedPoints = getPassengerSegment(
    definition.order,
    points,
    'B_START',
    'B_END',
  );

  const [route, ownerSharedRoute, requesterSharedRoute] = await Promise.all([
    getCarRoute(fullRoutePoints),
    getCarRoute(ownerSharedPoints),
    getCarRoute(requesterSharedPoints),
  ]);
  const totalFare = route.taxiFare;
  const { ownerPay, requesterPay } = splitFareBySoloFare(
    totalFare,
    ownerAlone.taxiFare,
    requesterAlone.taxiFare,
  );
  const ownerSaved = ownerAlone.taxiFare - ownerPay;
  const requesterSaved = requesterAlone.taxiFare - requesterPay;
  const ownerExtraSeconds =
    ownerSharedRoute.durationSeconds - ownerAlone.durationSeconds;
  const requesterExtraSeconds =
    requesterSharedRoute.durationSeconds - requesterAlone.durationSeconds;
  const recommended =
    ownerSaved > 0 &&
    requesterSaved > 0 &&
    ownerExtraSeconds <= 15 * 60 &&
    requesterExtraSeconds <= 15 * 60;

  return {
    id: definition.id,
    label: definition.label,
    order: definition.order,
    route,
    ownerSharedRoute,
    requesterSharedRoute,
    totalFare,
    ownerPay,
    requesterPay,
    ownerSaved,
    requesterSaved,
    ownerExtraSeconds,
    requesterExtraSeconds,
    recommended,
  };
}

/** Compares solo rides with four possible shared-route orders. */
export async function compareSharedRide(
  input: CompareInput,
): Promise<CompareResult> {
  const points = createStopPoints(input);
  const [ownerAlone, requesterAlone] = await Promise.all([
    getCarRoute([input.ownerRide.start, input.ownerRide.end]),
    getCarRoute([input.requesterRide.start, input.requesterRide.end]),
  ]);
  const candidates = await Promise.all(
    CANDIDATE_DEFINITIONS.map((definition) =>
      createCandidateResult(definition, points, ownerAlone, requesterAlone),
    ),
  );
  const recommendedCandidates = candidates.filter(
    (candidate) => candidate.recommended,
  );
  const bestCandidate = recommendedCandidates.reduce<CandidateResult | null>(
    (best, candidate) => {
      if (!best) {
        return candidate;
      }

      const candidateSavings = candidate.ownerSaved + candidate.requesterSaved;
      const bestSavings = best.ownerSaved + best.requesterSaved;

      return candidateSavings > bestSavings ? candidate : best;
    },
    null,
  );

  return {
    ownerAlone,
    requesterAlone,
    candidates,
    bestCandidate,
  };
}
