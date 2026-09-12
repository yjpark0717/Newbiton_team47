import { compareSharedRide } from './index';
import type { CompareInput } from './index';

/** Example input for testing the shared-ride comparison. */
export const exampleInput: CompareInput = {
  ownerRide: {
    start: { lat: 37.4979, lng: 127.0276, name: 'A start' },
    end: { lat: 37.5048, lng: 127.0254, name: 'A end' },
  },
  requesterRide: {
    start: { lat: 37.5065, lng: 127.0537, name: 'B start' },
    end: { lat: 37.5172, lng: 127.0473, name: 'B end' },
  },
};

/** Runs the example and returns the complete comparison result. */
export async function runRouteCompareExample() {
  return compareSharedRide(exampleInput);
}