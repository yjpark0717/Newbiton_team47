(function (global) {
  var EARTH_RADIUS_METERS = 6371000;
  var ROAD_FACTOR = 1.25;
  var AVERAGE_SPEED_KMH = 30;
  var BASE_FARE = 4800;
  var INCLUDED_DISTANCE_METERS = 1600;
  var FARE_PER_KILOMETER = 1000;
  var definitions = [
    ['a-start-b-start-b-end-a-end', 'A_START -> B_START -> B_END -> A_END', ['A_START', 'B_START', 'B_END', 'A_END']],
    ['a-start-b-start-a-end-b-end', 'A_START -> B_START -> A_END -> B_END', ['A_START', 'B_START', 'A_END', 'B_END']],
    ['b-start-a-start-a-end-b-end', 'B_START -> A_START -> A_END -> B_END', ['B_START', 'A_START', 'A_END', 'B_END']],
    ['b-start-a-start-b-end-a-end', 'B_START -> A_START -> B_END -> A_END', ['B_START', 'A_START', 'B_END', 'A_END']]
  ];

  function radians(value) {
    return value * Math.PI / 180;
  }

  function distanceBetween(first, second) {
    var latitudeDelta = radians(second.lat - first.lat);
    var longitudeDelta = radians(second.lng - first.lng);
    var firstLatitude = radians(first.lat);
    var secondLatitude = radians(second.lat);
    var value = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(value));
  }

  function route(points) {
    var straightLineDistance = 0;
    for (var index = 1; index < points.length; index += 1) {
      straightLineDistance += distanceBetween(points[index - 1], points[index]);
    }
    var distanceMeters = Math.round(straightLineDistance * ROAD_FACTOR);
    var durationSeconds = Math.round(distanceMeters / 1000 / AVERAGE_SPEED_KMH * 3600);
    var chargeableDistance = Math.max(0, distanceMeters - INCLUDED_DISTANCE_METERS);
    var taxiFare = BASE_FARE + Math.ceil(chargeableDistance / 1000) * FARE_PER_KILOMETER;
    return { distanceMeters: distanceMeters, durationSeconds: durationSeconds, taxiFare: taxiFare, path: points };
  }

  function segment(order, points, start, end) {
    var startIndex = order.indexOf(start);
    var endIndex = order.indexOf(end);
    return order.slice(startIndex, endIndex + 1).map(function (stop) { return points[stop]; });
  }

  function compare(input) {
    var points = {
      A_START: input.ownerRide.start,
      A_END: input.ownerRide.end,
      B_START: input.requesterRide.start,
      B_END: input.requesterRide.end
    };
    var ownerAlone = route([points.A_START, points.A_END]);
    var requesterAlone = route([points.B_START, points.B_END]);
    var candidates = definitions.map(function (definition) {
      var order = definition[2];
      var fullRoute = route(order.map(function (stop) { return points[stop]; }));
      var ownerSharedRoute = route(segment(order, points, 'A_START', 'A_END'));
      var requesterSharedRoute = route(segment(order, points, 'B_START', 'B_END'));
      var ownerPay = fullRoute.taxiFare / 2;
      var requesterPay = fullRoute.taxiFare / 2;
      var ownerSaved = ownerAlone.taxiFare - ownerPay;
      var requesterSaved = requesterAlone.taxiFare - requesterPay;
      var ownerExtraSeconds = ownerSharedRoute.durationSeconds - ownerAlone.durationSeconds;
      var requesterExtraSeconds = requesterSharedRoute.durationSeconds - requesterAlone.durationSeconds;
      return {
        id: definition[0], label: definition[1], order: order, route: fullRoute,
        ownerSharedRoute: ownerSharedRoute, requesterSharedRoute: requesterSharedRoute,
        totalFare: fullRoute.taxiFare, ownerPay: ownerPay, requesterPay: requesterPay,
        ownerSaved: ownerSaved, requesterSaved: requesterSaved,
        ownerExtraSeconds: ownerExtraSeconds, requesterExtraSeconds: requesterExtraSeconds,
        recommended: ownerSaved > 0 && requesterSaved > 0 && ownerExtraSeconds <= 900 && requesterExtraSeconds <= 900
      };
    });
    var recommended = candidates.filter(function (candidate) { return candidate.recommended; });
    var bestCandidate = recommended.reduce(function (best, candidate) {
      if (!best || candidate.ownerSaved + candidate.requesterSaved > best.ownerSaved + best.requesterSaved) return candidate;
      return best;
    }, null);
    return Promise.resolve({ ownerAlone: ownerAlone, requesterAlone: requesterAlone, candidates: candidates, bestCandidate: bestCandidate });
  }

  global.compareSharedRideMock = compare;
}(window));