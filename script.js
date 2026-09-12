(function(){
  var riders = [];

  var screens = ['location','list','waiting','matched'];
  var railLabels = { location:'1. 위치 설정', list:'2. 동승자 선택', waiting:'3. 요청 대기', matched:'4. 매칭 완료' };
  var current = 'location';
  var waitingTimer = null;
  var selectedRider = null;

  function personIcon(){
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
  }
  function chevronIcon(){
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  }
  function formatMinutes(seconds){
    return Math.max(1, Math.round(seconds / 60)) + '분';
  }
  function riderCardHTML(r){
    var totalSave = r.ownerSaved + r.requesterSaved;
    var recommended = r.recommended ? '<span class="sort-pill">추천</span>' : '';
    return '<div class="avatar">' + personIcon() + '</div>' +
      '<div class="rider-stats">' +
        '<div class="stat-line"><span class="stat-label">A 이동 시간</span><span class="stat-value">' + formatMinutes(r.ownerSharedRoute.durationSeconds) + ' (단독 ' + formatMinutes(r.ownerSharedRoute.durationSeconds - r.ownerExtraSeconds) + ')</span></div>' +
        '<div class="stat-line"><span class="stat-label">B 이동 시간</span><span class="stat-value">' + formatMinutes(r.requesterSharedRoute.durationSeconds) + ' (단독 ' + formatMinutes(r.requesterSharedRoute.durationSeconds - r.requesterExtraSeconds) + ')</span></div>' +
        '<div class="stat-line"><span class="stat-label">전체 이동 시간</span><span class="stat-value">' + formatMinutes(r.route.durationSeconds) + '</span></div>' +
        '<div class="stat-line"><span class="stat-label">총 절약 금액</span><span class="stat-value save">-' + totalSave.toLocaleString('ko-KR') + '원</span></div>' +
        '<div class="stat-line"><span class="stat-label">경로</span><span class="stat-value route-label">' + r.label + '</span></div>' + recommended +
      '</div>';
  }

  var cardList = document.getElementById('card-list');
  function renderCandidates(result){
    riders = result.candidates.slice().sort(function(a, b){
      return (b.ownerSaved + b.requesterSaved) - (a.ownerSaved + a.requesterSaved);
    });
    cardList.innerHTML = '';
    riders.forEach(function(r){
    var btn = document.createElement('button');
    btn.className = 'rider-card';
    btn.type = 'button';
    btn.innerHTML = riderCardHTML(r) + '<span class="chevron">' + chevronIcon() + '</span>';
    btn.addEventListener('click', function(){ openConfirm(r); });
    cardList.appendChild(btn);
    });
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
    confirmPreview.innerHTML = riderCardHTML(r);
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
      '<span>A 절약 금액</span><b>' + Math.round(selectedRider.ownerSaved).toLocaleString('ko-KR') + '원</b>' +
      '<span>B 절약 금액</span><b>' + Math.round(selectedRider.requesterSaved).toLocaleString('ko-KR') + '원</b>';
  }

  document.getElementById('btn-locate').addEventListener('click', function(){
    document.getElementById('input-origin').value = '현재 위치 (내 GPS 좌표)';
  });
  document.getElementById('btn-find').addEventListener('click', function(){
    var input = {
      ownerRide: {
        start: { lat: 37.4979, lng: 127.0276, name: document.getElementById('input-origin').value },
        end: { lat: 37.5048, lng: 127.0254, name: document.getElementById('input-dest').value }
      },
      requesterRide: {
        start: { lat: 37.5065, lng: 127.0537, name: 'B 출발지' },
        end: { lat: 37.5172, lng: 127.0473, name: 'B 도착지' }
      }
    };
    fetch('/api/route-compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }).then(function(response){
      return response.json().then(function(result){
        if (!response.ok) throw new Error(result.error || '경로 비교에 실패했습니다.');
        return result;
      });
    }).then(function(result){
      renderCandidates(result);
      goTo('list');
    }).catch(function(error){
      window.alert(error.message);
    });
  });
  document.getElementById('btn-decline').addEventListener('click', closeConfirm);
  document.getElementById('btn-accept').addEventListener('click', function(){
    closeConfirm();
    goTo('waiting');
  });
  document.getElementById('btn-cancel').addEventListener('click', function(){ goTo('list'); });
  document.getElementById('btn-restart').addEventListener('click', function(){ goTo('location'); });

  goTo('location');
})();
