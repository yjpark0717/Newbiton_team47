(function(){
  // 같은 브라우저에서 연 여러 탭끼리 BroadcastChannel로 직접 통신하는 데모용 구현.
  // 실제 서비스에서는 지도/거리 계산 담당이 만드는 서버가 이 자리를 대신하게 됨.
  var CHANNEL_NAME = 'carpool-demo-v1';
  var INCOMING_MS = 20000;
  var PRESENCE_INTERVAL_MS = 3000;
  var PEER_TIMEOUT_MS = 8000;
  var REQUEST_TIMEOUT_MS = 25000;

  var screens = ['location','list','waiting','matched'];
  var railLabels = { location:'1. 위치 설정', list:'2. 동승자 선택', waiting:'3. 요청 대기', matched:'4. 매칭 완료' };
  var current = 'location';

  var peers = {};           // id -> {id, name, detour, save, lastSeen}
  var incoming = [];        // [{requestId, fromId, fromName, detour, save, expiresAt}]
  var pendingRequest = null; // {requestId, toId, toName, detour, save}
  var pendingTimeoutHandle = null;
  var confirmTargetPeer = null;
  var selectedRider = null;
  var isVisible = false; // "동승 가능한 사람 찾기"를 눌러야 다른 탭에 후보로 보임

  var me = loadOrCreateIdentity();

  function loadOrCreateIdentity(){
    var id = sessionStorage.getItem('carpool-demo-my-id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 7).toUpperCase();
      sessionStorage.setItem('carpool-demo-my-id', id);
    }
    var stats;
    var statsRaw = sessionStorage.getItem('carpool-demo-my-stats');
    if (statsRaw) {
      stats = JSON.parse(statsRaw);
    } else {
      stats = {
        detour: 2 + Math.floor(Math.random() * 10),
        save: 1000 * (1 + Math.floor(Math.random() * 6))
      };
      sessionStorage.setItem('carpool-demo-my-stats', JSON.stringify(stats));
    }
    return { id: id, name: '이용자 ' + id, detour: stats.detour, save: stats.save };
  }

  var channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel(CHANNEL_NAME) : null;
  function send(msg){ if (channel) channel.postMessage(msg); }

  if (channel) {
    channel.onmessage = function(ev){
      var msg = ev.data || {};
      if (msg.type === 'hello') {
        if (msg.id !== me.id && isVisible) broadcastPresence();
        return;
      }
      if (msg.type === 'presence') {
        if (msg.id === me.id) return;
        peers[msg.id] = { id: msg.id, name: msg.name, detour: msg.detour, save: msg.save, lastSeen: Date.now() };
        if (current === 'list') renderList();
        return;
      }
      if (msg.type === 'bye') {
        if (peers[msg.id]) { delete peers[msg.id]; if (current === 'list') renderList(); }
        return;
      }
      if (msg.toId !== me.id) return; // 나머지 메시지는 수신 대상이 나일 때만 처리
      if (msg.type === 'request') {
        incoming.push({
          requestId: msg.requestId, fromId: msg.fromId, fromName: msg.fromName,
          detour: msg.detour, save: msg.save, expiresAt: Date.now() + INCOMING_MS
        });
        if (current === 'list') renderList();
      } else if (msg.type === 'cancel') {
        incoming = incoming.filter(function(r){ return r.requestId !== msg.requestId; });
        if (current === 'list') renderList();
      } else if (msg.type === 'accept') {
        if (pendingRequest && pendingRequest.requestId === msg.requestId) {
          clearPendingTimeout();
          selectedRider = { name: pendingRequest.toName, save: pendingRequest.save };
          pendingRequest = null;
          renderFareNote();
          goTo('matched');
        }
      } else if (msg.type === 'decline') {
        if (pendingRequest && pendingRequest.requestId === msg.requestId) {
          clearPendingTimeout();
          pendingRequest = null;
          showListNotice('상대가 동승 요청을 거절했어요.');
          goTo('list');
        }
      }
    };
  }

  function broadcastPresence(){
    send({ type:'presence', id: me.id, name: me.name, detour: me.detour, save: me.save });
  }
  function clearPendingTimeout(){
    if (pendingTimeoutHandle) { clearTimeout(pendingTimeoutHandle); pendingTimeoutHandle = null; }
  }
  function cancelPendingRequest(){
    if (!pendingRequest) return;
    send({ type:'cancel', requestId: pendingRequest.requestId, toId: pendingRequest.toId });
    clearPendingTimeout();
    pendingRequest = null;
  }
  function becomeVisible(){
    if (isVisible) return;
    isVisible = true;
    broadcastPresence();
    send({ type:'hello', id: me.id }); // 이미 검색 중인 다른 탭들의 정보를 즉시 받아오기
  }
  function becomeHidden(){
    if (!isVisible) return;
    isVisible = false;
    send({ type:'bye', id: me.id });
  }

  setInterval(function(){ if (isVisible) broadcastPresence(); }, PRESENCE_INTERVAL_MS);
  window.addEventListener('pagehide', function(){ if (isVisible) send({ type:'bye', id: me.id }); });

  setInterval(function(){
    var now = Date.now();
    var changed = false;
    Object.keys(peers).forEach(function(id){
      if (now - peers[id].lastSeen > PEER_TIMEOUT_MS) { delete peers[id]; changed = true; }
    });
    if (changed && current === 'list') renderList();
  }, PRESENCE_INTERVAL_MS);

  setInterval(function(){
    var now = Date.now();
    var expired = incoming.filter(function(r){ return r.expiresAt <= now; });
    expired.forEach(function(r){ respondToIncoming(r, 'decline'); });
    updateIncomingUI();
  }, 500);

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

  var cardList = document.getElementById('card-list');

  function buildRiderCard(p){
    var btn = document.createElement('button');
    btn.className = 'rider-card';
    btn.type = 'button';
    btn.innerHTML = riderInfoHTML(p) + '<span class="chevron">' + chevronIcon() + '</span>';
    btn.addEventListener('click', function(){ openConfirm(p); });
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
    div.innerHTML = '아직 주변에 열려 있는 다른 창이 없어요.<br>같은 브라우저에서 이 페이지를 새 탭으로 열어보세요.';
    return div;
  }

  function respondToIncoming(r, decision){
    incoming = incoming.filter(function(x){ return x.requestId !== r.requestId; });
    send({ type: decision, requestId: r.requestId, toId: r.fromId });
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

  function sendRequestTo(peer){
    var requestId = me.id + '-' + Date.now();
    pendingRequest = { requestId: requestId, toId: peer.id, toName: peer.name, detour: peer.detour, save: peer.save };
    send({ type:'request', requestId: requestId, fromId: me.id, fromName: me.name, toId: peer.id, detour: peer.detour, save: peer.save });
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

  function openConfirm(p){
    confirmTargetPeer = p;
    confirmPreview.innerHTML = riderInfoHTML(p);
    dim.classList.add('is-active');
    confirmCard.classList.add('is-active');
  }
  function closeConfirm(){
    dim.classList.remove('is-active');
    confirmCard.classList.remove('is-active');
    confirmTargetPeer = null;
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
  document.getElementById('btn-find').addEventListener('click', function(){ goTo('list'); });
  document.getElementById('btn-decline').addEventListener('click', closeConfirm);
  document.getElementById('btn-accept').addEventListener('click', function(){
    var target = confirmTargetPeer;
    closeConfirm();
    if (target) sendRequestTo(target);
  });
  document.getElementById('btn-cancel').addEventListener('click', function(){
    cancelPendingRequest();
    goTo('list');
  });
  document.getElementById('btn-restart').addEventListener('click', function(){ goTo('location'); });

  document.getElementById('device-badge').textContent = '이 창은 "' + me.name + '"로 표시돼요';
  if (!channel || location.protocol === 'file:') {
    document.getElementById('protocol-warning').hidden = false;
  }

  goTo('location');
})();
