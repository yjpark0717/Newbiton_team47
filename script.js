(function(){
  // TODO: 지도/거리 계산 담당이 실제 후보 데이터로 교체
  var riders = [
    { id: 'A', name: '이용자 A', detour: 4, save: 3200 },
    { id: 'B', name: '이용자 B', detour: 9, save: 5400 },
    { id: 'C', name: '이용자 C', detour: 2, save: 1500, incoming: true }
  ];
  var INCOMING_SECONDS = 20;

  var screens = ['location','list','waiting','matched'];
  var railLabels = { location:'1. 위치 설정', list:'2. 동승자 선택', waiting:'3. 요청 대기', matched:'4. 매칭 완료' };
  var current = 'location';
  var waitingTimer = null;
  var incomingTimer = null;
  var selectedRider = null;

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

  function buildRiderCard(r){
    var btn = document.createElement('button');
    btn.className = 'rider-card';
    btn.type = 'button';
    btn.innerHTML = riderInfoHTML(r) + '<span class="chevron">' + chevronIcon() + '</span>';
    btn.addEventListener('click', function(){ openConfirm(r); });
    return btn;
  }

  function buildIncomingCard(r){
    var wrap = document.createElement('div');
    wrap.className = 'incoming-card';
    wrap.innerHTML =
      '<div class="incoming-head">' +
        '<span class="badge-incoming">동승 요청 도착</span>' +
      '</div>' +
      '<div class="rider-card-inner">' + riderInfoHTML(r) + '</div>' +
      '<p class="incoming-note"><span class="countdown-num">' + INCOMING_SECONDS + '</span>초 이내에 동승 수락 여부를 선택해주세요</p>' +
      '<div class="incoming-bar"><div class="incoming-bar-fill"></div></div>' +
      '<div class="incoming-actions">' +
        '<button class="btn btn-outline btn-sm" data-action="decline" type="button">거절</button>' +
        '<button class="btn btn-primary btn-sm" data-action="accept" type="button">수락</button>' +
      '</div>';
    wrap.querySelector('[data-action="decline"]').addEventListener('click', function(){
      handleIncomingDecision(r, 'decline');
    });
    wrap.querySelector('[data-action="accept"]').addEventListener('click', function(){
      handleIncomingDecision(r, 'accept');
    });
    return wrap;
  }

  function renderList(){
    if (incomingTimer) { clearInterval(incomingTimer); incomingTimer = null; }
    cardList.innerHTML = '';
    var incomingRider = null;
    riders.forEach(function(r){
      if (r.incoming) {
        incomingRider = r;
        cardList.appendChild(buildIncomingCard(r));
      }
    });
    riders.forEach(function(r){
      if (!r.incoming) cardList.appendChild(buildRiderCard(r));
    });
    if (incomingRider) startIncomingCountdown(incomingRider);
  }

  function startIncomingCountdown(r){
    var remaining = INCOMING_SECONDS;
    var fill = cardList.querySelector('.incoming-bar-fill');
    if (fill) {
      requestAnimationFrame(function(){
        fill.style.transitionDuration = INCOMING_SECONDS + 's';
        fill.style.width = '0%';
      });
    }
    incomingTimer = setInterval(function(){
      remaining--;
      var numEl = cardList.querySelector('.countdown-num');
      if (numEl) numEl.textContent = Math.max(remaining, 0);
      if (remaining <= 0) {
        clearInterval(incomingTimer);
        incomingTimer = null;
        handleIncomingDecision(r, 'decline');
      }
    }, 1000);
  }

  function handleIncomingDecision(r, decision){
    if (incomingTimer) { clearInterval(incomingTimer); incomingTimer = null; }
    var idx = riders.indexOf(r);
    if (idx > -1) riders.splice(idx, 1);
    if (decision === 'accept') {
      selectedRider = r;
      renderFareNote();
      goTo('matched');
    } else {
      renderList();
    }
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
    if (waitingTimer) { clearTimeout(waitingTimer); waitingTimer = null; }
    current = name;
    screens.forEach(function(s){
      document.getElementById('screen-' + s).classList.toggle('is-active', s === name);
    });
    Array.prototype.forEach.call(rail.children, function(b){
      b.classList.toggle('is-current', b.dataset.screen === name);
    });
    if (name === 'list') {
      renderList();
    }
    if (name === 'waiting') {
      waitingTimer = setTimeout(function(){
        renderFareNote();
        goTo('matched');
      }, 2200);
    }
  }

  var dim = document.getElementById('dim');
  var confirmCard = document.getElementById('confirm-card');
  var confirmPreview = document.getElementById('confirm-preview');

  function openConfirm(r){
    selectedRider = r;
    confirmPreview.innerHTML = riderInfoHTML(r);
    dim.classList.add('is-active');
    confirmCard.classList.add('is-active');
  }
  function closeConfirm(){
    dim.classList.remove('is-active');
    confirmCard.classList.remove('is-active');
  }

  function renderFareNote(){
    var note = document.getElementById('fare-note');
    if (!selectedRider) { note.innerHTML = ''; return; }
    note.innerHTML =
      '<span>이번 동승으로 절약된 금액</span><b>' + selectedRider.save.toLocaleString('ko-KR') + '원</b>';
  }

  document.getElementById('btn-locate').addEventListener('click', function(){
    document.getElementById('input-origin').value = '현재 위치 (내 GPS 좌표)';
  });
  document.getElementById('btn-find').addEventListener('click', function(){ goTo('list'); });
  document.getElementById('btn-decline').addEventListener('click', closeConfirm);
  document.getElementById('btn-accept').addEventListener('click', function(){
    closeConfirm();
    goTo('waiting');
  });
  document.getElementById('btn-cancel').addEventListener('click', function(){ goTo('list'); });
  document.getElementById('btn-restart').addEventListener('click', function(){ goTo('location'); });

  goTo('location');
})();
