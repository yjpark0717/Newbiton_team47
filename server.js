const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 5500);
const NAVER_CLIENT_ID = process.env.NAVER_MAPS_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_MAPS_CLIENT_SECRET;
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/script.js': 'script.js',
  '/styles.css': 'styles.css',
  '/routeCompare.browser.js': 'routeCompare.browser.js',
  '/firebase-config.js': 'firebase-config.js',
};

const candidateDefinitions = [
  ['a-start-b-start-b-end-a-end', 'A_START -> B_START -> B_END -> A_END', ['A_START', 'B_START', 'B_END', 'A_END']],
  ['a-start-b-start-a-end-b-end', 'A_START -> B_START -> A_END -> B_END', ['A_START', 'B_START', 'A_END', 'B_END']],
  ['b-start-a-start-a-end-b-end', 'B_START -> A_START -> A_END -> B_END', ['B_START', 'A_START', 'A_END', 'B_END']],
  ['b-start-a-start-b-end-a-end', 'B_START -> A_START -> B_END -> A_END', ['B_START', 'A_START', 'B_END', 'A_END']],
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function getApiHeaders() {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_MAPS_CLIENT_ID와 NAVER_MAPS_CLIENT_SECRET가 필요합니다.');
  }
  return {
    'x-ncp-apigw-api-key-id': NAVER_CLIENT_ID,
    'x-ncp-apigw-api-key': NAVER_CLIENT_SECRET,
  };
}

async function geocodeAddress(address) {
  const url = new URL('https://maps.apigw.ntruss.com/map-geocode/v2/geocode');
  url.searchParams.set('query', address);
  const result = await fetch(url, { headers: getApiHeaders() });
  const body = await result.json();
  if (!result.ok) throw new Error(`Geocoding API 오류(${result.status}): ${body.errorMessage || body.message || '권한 또는 요청을 확인하세요.'}`);
  if (!body.addresses?.length) throw new Error(`주소를 찾지 못했습니다: ${address}`);
  const addressResult = body.addresses[0];
  return { lat: Number(addressResult.y), lng: Number(addressResult.x), name: address };
}

function toRouteResult(body, points) {
  const summary = body.route?.traoptimal?.[0]?.summary;
  if (!summary) throw new Error('네이버 Directions 5 응답에 경로가 없습니다.');
  return {
    distanceMeters: summary.distance,
    durationSeconds: Math.round(summary.duration / 1000),
    taxiFare: summary.taxiFare || 0,
    tollFare: summary.tollFare || 0,
    path: points,
  };
}

async function getNaverCarRoute(points) {
  if (points.length < 2) throw new Error('경로에는 두 개 이상의 좌표가 필요합니다.');
  const url = new URL('https://maps.apigw.ntruss.com/map-direction/v1/driving');
  url.searchParams.set('start', `${points[0].lng},${points[0].lat}`);
  url.searchParams.set('goal', `${points[points.length - 1].lng},${points[points.length - 1].lat}`);
  if (points.length > 2) {
    url.searchParams.set('waypoints', points.slice(1, -1).map((point) => `${point.lng},${point.lat}`).join('|'));
  }
  const result = await fetch(url, { headers: getApiHeaders() });
  const body = await result.json();
  if (!result.ok || body.code !== 0) {
    throw new Error(`Directions 5 API 오류(${result.status}, code ${body.code ?? 'unknown'}): ${body.message || '권한 또는 요청을 확인하세요.'}`);
  }
  return toRouteResult(body, points);
}

function getSegment(order, points, start, end) {
  const startIndex = order.indexOf(start);
  const endIndex = order.indexOf(end);
  return order.slice(startIndex, endIndex + 1).map((stop) => points[stop]);
}

function splitFareBySoloFare(totalFare, ownerSoloFare, requesterSoloFare) {
  const combinedSoloFare = ownerSoloFare + requesterSoloFare;
  if (combinedSoloFare <= 0) {
    const ownerPay = Math.round(totalFare / 2);
    return { ownerPay, requesterPay: totalFare - ownerPay };
  }

  const ownerPay = Math.round(totalFare * ownerSoloFare / combinedSoloFare);
  return { ownerPay, requesterPay: totalFare - ownerPay };
}

async function compareWithNaver(input) {
  const points = {
    A_START: input.ownerRide.start,
    A_END: input.ownerRide.end,
    B_START: input.requesterRide.start,
    B_END: input.requesterRide.end,
  };
  const [ownerAlone, requesterAlone] = await Promise.all([
    getNaverCarRoute([points.A_START, points.A_END]),
    getNaverCarRoute([points.B_START, points.B_END]),
  ]);
  const candidates = await Promise.all(candidateDefinitions.map(async ([id, label, order]) => {
    const ownerSharedPoints = getSegment(order, points, 'A_START', 'A_END');
    const requesterSharedPoints = getSegment(order, points, 'B_START', 'B_END');
    const [route, ownerSharedRoute, requesterSharedRoute] = await Promise.all([
      getNaverCarRoute(order.map((stop) => points[stop])),
      getNaverCarRoute(ownerSharedPoints),
      getNaverCarRoute(requesterSharedPoints),
    ]);
    const { ownerPay, requesterPay } = splitFareBySoloFare(
      route.taxiFare,
      ownerAlone.taxiFare,
      requesterAlone.taxiFare,
    );
    const ownerSaved = ownerAlone.taxiFare - ownerPay;
    const requesterSaved = requesterAlone.taxiFare - requesterPay;
    const ownerExtraSeconds = ownerSharedRoute.durationSeconds - ownerAlone.durationSeconds;
    const requesterExtraSeconds = requesterSharedRoute.durationSeconds - requesterAlone.durationSeconds;
    return {
      id, label, order, route, ownerSharedRoute, requesterSharedRoute,
      totalFare: route.taxiFare, ownerPay, requesterPay, ownerSaved, requesterSaved,
      ownerExtraSeconds, requesterExtraSeconds,
      recommended: ownerSaved > 0 && requesterSaved > 0 && ownerExtraSeconds <= 900 && requesterExtraSeconds <= 900,
    };
  }));
  const bestCandidate = candidates.filter((candidate) => candidate.recommended).sort(
    (first, second) => (second.ownerSaved + second.requesterSaved) - (first.ownerSaved + first.requesterSaved),
  )[0] || null;
  return { ownerAlone, requesterAlone, candidates, bestCandidate };
}

function pickFormattedAddress(entry) {
  const region = entry.region || {};
  const areaNames = ['area1', 'area2', 'area3', 'area4']
    .map((key) => region[key] && region[key].name)
    .filter(Boolean);
  const land = entry.land || {};
  const landName = land.name ? ` ${land.name}` : '';
  const number = land.number1 ? ` ${land.number1}${land.number2 ? '-' + land.number2 : ''}` : '';
  return `${areaNames.join(' ')}${landName}${number}`.trim();
}

async function reverseGeocodeNaver(lat, lng) {
  const url = new URL('https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc');
  url.searchParams.set('coords', `${lng},${lat}`);
  url.searchParams.set('output', 'json');
  url.searchParams.set('orders', 'roadaddr,addr');
  const result = await fetch(url, { headers: getApiHeaders() });
  const rawText = await result.text();
  if (!result.ok) {
    throw new Error(`Reverse Geocoding API 오류(${result.status}): ${rawText || 'Reverse Geocoding 상품이 활성화되어 있는지 확인하세요.'}`);
  }
  const body = rawText ? JSON.parse(rawText) : {};
  if (!body.results || !body.results.length) {
    throw new Error((body.status && body.status.message) || '주소를 찾을 수 없습니다.');
  }
  const roadResult = body.results.find((entry) => entry.name === 'roadaddr');
  const addrResult = body.results.find((entry) => entry.name === 'addr');
  const formatted = pickFormattedAddress(roadResult || addrResult || body.results[0]);
  return formatted || `위도 ${lat.toFixed(5)}, 경도 ${lng.toFixed(5)}`;
}

async function handleReverseGeocode(request, response) {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const { lat, lng } = JSON.parse(body);
      if (typeof lat !== 'number' || typeof lng !== 'number') throw new Error('lat/lng가 필요합니다.');
      const name = await reverseGeocodeNaver(lat, lng);
      sendJson(response, 200, { name });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

function handleConfig(request, response) {
  sendJson(response, 200, { naverMapClientId: NAVER_CLIENT_ID || null });
}

async function handleGeocode(request, response) {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const { address } = JSON.parse(body);
      if (!address) throw new Error('address가 필요합니다.');
      const point = await geocodeAddress(address);
      sendJson(response, 200, point);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

async function handleCompare(request, response) {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const input = JSON.parse(body);
      const result = await compareWithNaver(input);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'POST' && requestUrl.pathname === '/api/route-compare') return handleCompare(request, response);
  if (request.method === 'POST' && requestUrl.pathname === '/api/geocode') return handleGeocode(request, response);
  if (request.method === 'POST' && requestUrl.pathname === '/api/reverse-geocode') return handleReverseGeocode(request, response);
  if (request.method === 'GET' && requestUrl.pathname === '/api/config') return handleConfig(request, response);
  const fileName = STATIC_FILES[requestUrl.pathname];
  if (!fileName) return sendJson(response, 404, { error: 'Not found' });
  const filePath = path.join(__dirname, fileName);
  if (!fs.existsSync(filePath)) return sendJson(response, 404, { error: 'File not found' });
  const contentType = fileName.endsWith('.css') ? 'text/css; charset=utf-8' : fileName.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  response.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(response);
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
