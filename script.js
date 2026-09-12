(function(){
  // Firestore를 "공유 상태 저장소"로 써서 서로 다른 기기의 탭끼리 통신하고,
  // 우회 시간/절약 금액은 server.js의 /api/route-compare(네이버 지도 API)로 실제 계산한다.
  // 서버가 없거나 API 키가 없으면 routeCompare.browser.js의 추정치로 자동 대체된다.
  var INCOMING_MS = 20000;
  var PRESENCE_INTERVAL_MS = 3000;
  var PEER_TIMEOUT_MS = 8000;
  var REQUEST_TIMEOUT_MS = 25000;

  // 지오코딩(주소->좌표) 서버 호출이 실패했을 때 쓰는 대체 지점 목록(서울 주요 역).
  var RIDE_POOL = [
    { lat: 37.4979, lng: 127.0276, name: '강남역' },
    { lat: 37.5048, lng: 127.0254, name: '신논현역' },
    { lat: 37.5065, lng: 127.0537, name: '삼성역' },
    { lat: 37.5172, lng: 127.0473, name: '잠실역' },
    { lat: 37.4980, lng: 127.0495, name: '양재역' },
    { lat: 37.3947, lng: 127.1112, name: '판교역' }
  ];

  var screens = ['location','list','waiting','matched'];
  var railLabels = { location:'1. 위치 설정', list:'2. 동승자 선택', waiting:'3. 요청 대기', matched:'4. 매칭 완료' };
  var current = 'location';

  var peers = {};           // id -> {id, name, ride}
  var rawPresence = {};     // id -> {name, ride, updatedAt}
  var incoming = [];        // [{requestId, fromId, fromName, detour, save, expiresAt}]
  var pendingRequest = null; // {requestId, toId, toName, detour, save}
  var pendingTimeoutHandle = null;
  var confirmTargetPeer = null;
  var confirmTargetRoute = null;
  var selectedRider = null;
  var isVisible = false; // "동승 가능한 사람 찾기"를 눌러야 다른 사람에게 후보로 보임
  var routeCache = {};   // peerId -> {status:'loading'|'ready'|'error', detourMin, save, theirDetourMin, theirSave}

  var me = loadOrCreateIdentity();

  function hashString(str){
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  function fallbackGeocode(address){
    var base = RIDE_POOL[hashString(address || '') % RIDE_POOL.length];
    return { lat: base.lat, lng: base.lng, name: address || base.name };
  }
  function geocode(address){
    if (!address) return Promise.resolve(fallbackGeocode(address));
    return fetch('/api/geocode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: address })
    }).then(function(res){
      if (!res.ok) throw new Error('geocode failed');
      return res.json();
    }).catch(function(){ return fallbackGeocode(address); });
  }

  function loadOrCreateIdentity(){
    var id = sessionStorage.getItem('carpool-demo-my-id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 7).toUpperCase();
      sessionStorage.setItem('carpool-demo-my-id', id);
    }
    var ride;
    var rideRaw = sessionStorage.getItem('carpool-demo-my-ride');
    if (rideRaw) {
      ride = JSON.parse(rideRaw);
    } else {
      ride = { start: RIDE_POOL[0], end: RIDE_POOL[5] };
      sessionStorage.setItem('carpool-demo-my-ride', JSON.stringify(ride));
    }
    return { id: id, name: '이용자 ' + id, ride: ride };
  }

  // ---- Firebase 연결 ----
  var configReady = typeof firebase !== 'undefined' && window.FIREBASE_CONFIG &&
    window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.apiKey.indexOf('입력') === -1;
  var db = null, presenceCol = null, requestsCol = null;
  if (configReady) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    db = firebase.firestore();
    presenceCol = db.collection('presence');
    requestsCol = db.collection('requests');
  } else {
    document.getElementById('protocol-warning').hidden = false;
  }

  // ---- 경로 비교 (실서버 -> 실패 시 브라우저 추정치로 대체) ----
  function compareRide(myRide, peerRide){
    var input = { ownerRide: myRide, requesterRide: peerRide };
    return fetch('/api/route-compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    }).then(function(res){
      return res.json().then(function(data){
        if (!res.ok) throw new Error(data.error || '경로 비교 실패');
        return data;
      });
    }).catch(function(){
      if (window.compareSharedRideMock) return window.compareSharedRideMock(input);
      return Promise.reject(new Error('경로 비교를 할 수 없습니다.'));
    });
  }
  function pickBestCandidate(result){
    if (result.bestCandidate) return result.bestCandidate;
    return result.candidates.reduce(function(best, c){
      return (!best || c.ownerSaved > best.ownerSaved) ? c : best;
    }, null);
  }
  function ensureRouteFor(peer){
    if (routeCache[peer.id]) return;
    routeCache[peer.id] = { status: 'loading' };
    compareRide(me.ride, peer.ride).then(function(result){
      var best = pickBestCandidate(result);
      routeCache[peer.id] = {
        status: 'ready',
        detourMin: Math.max(0, Math.round(best.ownerExtraSeconds / 60)),
        save: Math.max(0, Math.round(best.ownerSaved)),
        theirDetourMin: Math.max(0, Math.round(best.requesterExtraSeconds / 60)),
        theirSave: Math.max(0, Math.round(best.requesterSaved))
      };
      if (current === 'list') renderList();
    }).catch(function(){
      routeCache[peer.id] = { status: 'error' };
      if (current === 'list') renderList();
    });
  }

  // ---- 내 존재를 알리기(presence) ----
  var unsubPresence = null;
  function writePresence(){
    if (!presenceCol) return;
    presenceCol.doc(me.id).set({ name: me.name, ride: me.ride, updatedAt: Date.now() }).catch(console.error);
  }
  function watchPresence(){
    if (!presenceCol || unsubPresence) return;
    unsubPresence = presenceCol.onSnapshot(function(snapshot){
      rawPresence = {};
      snapshot.forEach(function(docSnap){
        if (docSnap.id === me.id) return;
        rawPresence[docSnap.id] = docSnap.data();
      });
      refreshPeersFromRaw();
    }, console.error);
  }
  function unwatchPresence(){
    if (unsubPresence) { unsubPresence(); unsubPresence = null; }
    rawPresence = {};
    peers = {};
  }
  function refreshPeersFromRaw(){
    var now = Date.now();
    peers = {};
    Object.keys(rawPresence).forEach(function(id){
      var data = rawPresence[id];
      if (now - data.updatedAt > PEER_TIMEOUT_MS) return;
      peers[id] = { id: id, name: data.name, ride: data.ride };
    });
    if (current === 'list') renderList();
  }

  // ---- 나에게 온 요청(incoming) ----
  var unsubIncoming = null;
  function watchIncoming(){
    if (!requestsCol || unsubIncoming) return;
    unsubIncoming = requestsCol.where('toId', '==', me.id).onSnapshot(function(snapshot){
      incoming = snapshot.docs
        .filter(function(d){ return d.data().status === 'pending'; })
        .map(function(d){
          var data = d.data();
          return { requestId: d.id, fromId: data.fromId, fromName: data.fromName, detour: data.detour, save: data.save, expiresAt: data.createdAt + INCOMING_MS };
        });
      if (current === 'list') renderList();
    }, console.error);
  }
  function unwatchIncoming(){
    if (unsubIncoming) { unsubIncoming(); unsubIncoming = null; }
    incoming = [];
  }

  function becomeVisible(){
    if (isVisible || !configReady) return;
    isVisible = true;
    writePresence();
    watchPresence();
    watchIncoming();
  }
  function becomeHidden(){
    if (!isVisible) return;
    isVisible = false;
    if (presenceCol) presenceCol.doc(me.id).delete().catch(console.error);
    unwatchPresence();
    unwatchIncoming();
  }

  setInterval(function(){ if (isVisible) { writePresence(); refreshPeersFromRaw(); } }, PRESENCE_INTERVAL_MS);
  window.addEventListener('pagehide', function(){
    if (isVisible && presenceCol) presenceCol.doc(me.id).delete().catch(function(){});
  });

  setInterval(function(){
    var now = Date.now();
    var expired = incoming.filter(function(r){ return r.expiresAt <= now; });
    expired.forEach(function(r){ respondToIncoming(r, 'decline'); });
    updateIncomingUI();
  }, 500);

  function clearPendingTimeout(){
    if (pendingTimeoutHandle) { clearTimeout(pendingTimeoutHandle); pendingTimeoutHandle = null; }
  }

  // ---- 내가 보낸 요청(outgoing)의 응답 지켜보기 ----
  var unsubOutgoing = null;
  function watchOutgoing(requestId){
    unwatchOutgoing();
    unsubOutgoing = requestsCol.doc(requestId).onSnapshot(function(docSnap){
      if (!docSnap.exists || !pendingRequest || pendingRequest.requestId !== requestId) return;
      var data = docSnap.data();
      if (data.status === 'accepted') {
        clearPendingTimeout();
        unwatchOutgoing();
        selectedRider = { name: pendingRequest.toName, save: pendingRequest.save };
        pendingRequest = null;
        renderFareNote();
        goTo('matched');
      } else if (data.status === 'declined') {
        clearPendingTimeout();
        unwatchOutgoing();
        pendingRequest = null;
        showListNotice('상대가 동승 요청을 거절했어요.');
        goTo('list');
      }
    }, console.error);
  }
  function unwatchOutgoing(){ if (unsubOutgoing) { unsubOutgoing(); unsubOutgoing = null; } }

  function cancelPendingRequest(){
    if (!pendingRequest) return;
    if (requestsCol) requestsCol.doc(pendingRequest.requestId).update({ status: 'cancelled' }).catch(console.error);
    unwatchOutgoing();
    clearPendingTimeout();
    pendingRequest = null;
  }

  function personIcon(){
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
  }
  function chevronIcon(){
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  }
  function riderInfoHTML(r){
    return '<div class="avatar">' + personIcon() + '</div>' +
      '<div class="rider-stats">' +
        '<div class="rider-name">' + r.name + '</div>' +
        '<div class="stat-line"><span class="stat-label">우회 시간</span><span class="stat-value">+' + r.detour + '분</span></div>' +
        '<div class="stat-line"><span class="stat-label">절약 금액</span><span class="stat-value save">-' + r.save.toLocaleString('ko-KR') + '원</span></div>' +
      '</div>';
  }
  function riderPendingHTML(peer, label){
    return '<div class="avatar">' + personIcon() + '</div>' +
      '<div class="rider-stats">' +
        '<div class="rider-name">' + peer.name + '</div>' +
        '<div class="stat-line"><span class="stat-label">' + label + '</span></div>' +
      '</div>';
  }

  var cardList = document.getElementById('card-list');

  function buildRiderCard(peer){
    var cache = routeCache[peer.id];
    if (!cache) { ensureRouteFor(peer); cache = routeCache[peer.id]; }
    var btn = document.createElement('button');
    btn.className = 'rider-card';
    btn.type = 'button';
    if (cache.status === 'loading') {
      btn.disabled = true;
      btn.innerHTML = riderPendingHTML(peer, '경로 계산 중…');
    } else if (cache.status === 'error') {
      btn.disabled = true;
      btn.innerHTML = riderPendingHTML(peer, '경로 계산 실패');
    } else {
      btn.innerHTML = riderInfoHTML({ name: peer.name, detour: cache.detourMin, save: cache.save }) + '<span class="chevron">' + chevronIcon() + '</span>';
      btn.addEventListener('click', function(){ openConfirm(peer, cache); });
    }
    return btn;
  }

  function buildIncomingCard(r){
    var wrap = document.createElement('div');
    wrap.className = 'incoming-card';
    wrap.dataset.requestId = r.requestId;
    var remainSec = Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000));
    var pct = Math.max(0, Math.min(100, (r.expiresAt - Date.now()) / INCOMING_MS * 100));
    wrap.innerHTML =
      '<div class="incoming-head"><span class="badge-incoming">동승 요청 도착</span></div>' +
      '<div class="rider-card-inner">' + riderInfoHTML({ name: r.fromName, detour: r.detour, save: r.save }) + '</div>' +
      '<p class="incoming-note"><span class="countdown-num">' + remainSec + '</span>초 이내에 동승 수락 여부를 선택해주세요</p>' +
      '<div class="incoming-bar"><div class="incoming-bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="incoming-actions">' +
        '<button class="btn btn-outline btn-sm" data-action="decline" type="button">거절</button>' +
        '<button class="btn btn-primary btn-sm" data-action="accept" type="button">수락</button>' +
      '</div>';
    wrap.querySelector('[data-action="decline"]').addEventListener('click', function(){ respondToIncoming(r, 'decline'); });
    wrap.querySelector('[data-action="accept"]').addEventListener('click', function(){ respondToIncoming(r, 'accept'); });
    return wrap;
  }

  function buildEmptyState(){
    var div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = '아직 주변에 검색 중인 다른 사람이 없어요.<br>다른 기기에서도 이 페이지를 열어 "동승 가능한 사람 찾기"를 눌러보세요.';
    return div;
  }

  function respondToIncoming(r, decision){
    if (requestsCol) requestsCol.doc(r.requestId).update({ status: decision === 'accept' ? 'accepted' : 'declined' }).catch(console.error);
    incoming = incoming.filter(function(x){ return x.requestId !== r.requestId; });
    if (decision === 'accept') {
      selectedRider = { name: r.fromName, save: r.save };
      renderFareNote();
      goTo('matched');
    } else if (current === 'list') {
      renderList();
    }
  }

  function updateIncomingUI(){
    if (current !== 'list') return;
    incoming.forEach(function(r){
      var el = cardList.querySelector('[data-request-id="' + r.requestId + '"]');
      if (!el) return;
      var remainMs = Math.max(0, r.expiresAt - Date.now());
      var numEl = el.querySelector('.countdown-num');
      if (numEl) numEl.textContent = Math.ceil(remainMs / 1000);
      var fill = el.querySelector('.incoming-bar-fill');
      if (fill) fill.style.width = Math.max(0, Math.min(100, remainMs / INCOMING_MS * 100)) + '%';
    });
  }

  function renderList(){
    cardList.innerHTML = '';
    incoming.forEach(function(r){ cardList.appendChild(buildIncomingCard(r)); });
    // 나에게 이미 요청을 보낸 상대는 위쪽 "동승 요청 도착" 카드로만 보여주고,
    // 아래 일반 후보 목록에는 중복으로 띄우지 않는다.
    var incomingFromIds = incoming.map(function(r){ return r.fromId; });
    var candidateIds = Object.keys(peers).filter(function(id){ return incomingFromIds.indexOf(id) === -1; });
    if (candidateIds.length === 0 && incoming.length === 0) {
      cardList.appendChild(buildEmptyState());
    } else {
      candidateIds.forEach(function(id){ cardList.appendChild(buildRiderCard(peers[id])); });
    }
  }

  function sendRequestTo(peer, cache){
    if (!requestsCol) return;
    var requestId = me.id + '-' + Date.now();
    pendingRequest = { requestId: requestId, toId: peer.id, toName: peer.name, detour: cache.detourMin, save: cache.save };
    requestsCol.doc(requestId).set({
      fromId: me.id, fromName: me.name, toId: peer.id, toName: peer.name,
      detour: cache.theirDetourMin, save: cache.theirSave, status: 'pending', createdAt: Date.now()
    }).catch(console.error);
    watchOutgoing(requestId);
    clearPendingTimeout();
    pendingTimeoutHandle = setTimeout(function(){
      if (pendingRequest && pendingRequest.requestId === requestId) {
        cancelPendingRequest();
        showListNotice('응답이 없어 요청이 취소됐어요.');
        goTo('list');
      }
    }, REQUEST_TIMEOUT_MS);
    goTo('waiting');
  }

  function showListNotice(text){
    var el = document.getElementById('list-notice');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showListNotice._t);
    showListNotice._t = setTimeout(function(){ el.hidden = true; }, 3200);
  }

  var rail = document.getElementById('rail');
  screens.forEach(function(s){
    var b = document.createElement('button');
    b.textContent = railLabels[s];
    b.addEventListener('click', function(){ goTo(s); });
    b.dataset.screen = s;
    rail.appendChild(b);
  });

  function goTo(name){
    if (current === 'waiting' && name !== 'waiting') cancelPendingRequest();
    current = name;
    screens.forEach(function(s){
      document.getElementById('screen-' + s).classList.toggle('is-active', s === name);
    });
    Array.prototype.forEach.call(rail.children, function(b){
      b.classList.toggle('is-current', b.dataset.screen === name);
    });
    if (name === 'list' || name === 'waiting') {
      becomeVisible();
    } else {
      becomeHidden();
    }
    if (name === 'list') renderList();
    if (name === 'waiting') {
      document.getElementById('waiting-title').textContent =
        pendingRequest ? (pendingRequest.toName + '님의 응답을 기다리는 중..') : '상대 요청 기다리는 중..';
    }
  }

  var dim = document.getElementById('dim');
  var confirmCard = document.getElementById('confirm-card');
  var confirmPreview = document.getElementById('confirm-preview');

  function openConfirm(peer, cache){
    confirmTargetPeer = peer;
    confirmTargetRoute = cache;
    confirmPreview.innerHTML = riderInfoHTML({ name: peer.name, detour: cache.detourMin, save: cache.save });
    dim.classList.add('is-active');
    confirmCard.classList.add('is-active');
  }
  function closeConfirm(){
    dim.classList.remove('is-active');
    confirmCard.classList.remove('is-active');
    confirmTargetPeer = null;
    confirmTargetRoute = null;
  }

  function renderFareNote(){
    var note = document.getElementById('fare-note');
    if (!selectedRider) { note.hidden = true; note.innerHTML = ''; return; }
    note.hidden = false;
    note.innerHTML = '<span>' + selectedRider.name + '님과 동승 · 절약 금액</span><b>' + selectedRider.save.toLocaleString('ko-KR') + '원</b>';
  }

  document.getElementById('btn-locate').addEventListener('click', function(){
    document.getElementById('input-origin').value = '현재 위치 (내 GPS 좌표)';
  });
  document.getElementById('btn-find').addEventListener('click', function(){
    var findBtn = document.getElementById('btn-find');
    var originText = document.getElementById('input-origin').value.trim();
    var destText = document.getElementById('input-dest').value.trim();
    findBtn.disabled = true;
    Promise.all([geocode(originText), geocode(destText)]).then(function(points){
      me.ride = { start: points[0], end: points[1] };
      sessionStorage.setItem('carpool-demo-my-ride', JSON.stringify(me.ride));
      routeCache = {}; // 내 출발/도착지가 바뀌었을 수 있으니 이전 계산 결과는 버린다.
    }).catch(function(){ /* geocode()는 실패해도 대체 좌표로 resolve하므로 사실상 발생하지 않음 */ }).then(function(){
      findBtn.disabled = false;
      goTo('list');
    });
  });
  document.getElementById('btn-decline').addEventListener('click', closeConfirm);
  document.getElementById('btn-accept').addEventListener('click', function(){
    var target = confirmTargetPeer;
    var cache = confirmTargetRoute;
    closeConfirm();
    if (target && cache) sendRequestTo(target, cache);
  });
  document.getElementById('btn-cancel').addEventListener('click', function(){
    cancelPendingRequest();
    goTo('list');
  });
  document.getElementById('btn-restart').addEventListener('click', function(){ goTo('location'); });

  document.getElementById('device-badge').textContent = '이 기기는 "' + me.name + '"로 표시돼요';

  goTo('location');
})();
