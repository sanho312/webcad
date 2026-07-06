// ============================================================
//  WebCAD 로비(랜딩) 화면
//  - 웹 접속 시 로그인 게이트보다 먼저 로비가 뜬다
//  - 작업하기 / 에셋스토어 / 도면공유 / 플랜구독 / 사용법 / 로그인
//  - 인증은 auth.js(window.WEBCAD_AUTH_API)와 연동
// ============================================================
(() => {
  const AUTH = () => window.WEBCAD_AUTH_API || null;      // 로그인 게이트 API (auth 미설정이면 null)
  const authConfigured = !!(window.WEBCAD_AUTH && window.WEBCAD_AUTH.url) || localStorage.getItem('webcad_auth_demo') === '1';
  let session = null; // 로그인 세션 (webcad-auth 이벤트로 갱신)

  // ---------- 스타일 ----------
  const style = document.createElement('style');
  style.textContent = `
  #lobby{position:fixed;inset:0;z-index:300;display:flex;flex-direction:column;align-items:center;justify-content:center;
    overflow:auto;padding:32px 20px;box-sizing:border-box;
    background:radial-gradient(1200px 700px at 50% -10%, rgba(20,60,150,0.38), transparent 60%),
      linear-gradient(180deg,#070b18 0%,#0a1224 55%,#070a16 100%);
    -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);color:#eef2ff;
    -webkit-user-select:none;user-select:none;}
  html.light #lobby{background:radial-gradient(1200px 700px at 50% -10%, rgba(120,160,255,0.35), transparent 60%),
      linear-gradient(180deg,#eef2fa 0%,#e5ecf7 60%,#eef2fa 100%);color:#101a2e;}
  #lobby.hidden{display:none;}
  #lobby .lbHero{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:26px;text-align:center;}
  #lobby .lbLogo{font-size:44px;font-weight:750;letter-spacing:-0.03em;
    background:linear-gradient(180deg,#eaf1ff,#9fc0ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
  html.light #lobby .lbLogo{background:linear-gradient(180deg,#1c2b4a,#2f6bff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
  #lobby .lbSub{font-size:14px;color:rgba(210,222,250,0.62);letter-spacing:-0.01em;}
  html.light #lobby .lbSub{color:rgba(30,50,90,0.6);}
  #lobby .lbGrid{display:grid;grid-template-columns:repeat(3,minmax(158px,1fr));gap:14px;width:min(94vw,720px);}
  #lobby .lbTile{position:relative;display:flex;flex-direction:column;gap:6px;text-align:left;cursor:pointer;
    background:rgba(150,180,255,0.09);border:0.5px solid rgba(200,220,255,0.14);border-radius:20px;padding:18px 16px 16px;
    box-shadow:0 8px 26px rgba(2,6,20,0.35),inset 0 .5px 0 0 rgba(200,220,255,.16);color:inherit;
    transition:transform .12s ease, background .12s ease, box-shadow .12s ease;}
  html.light #lobby .lbTile{background:rgba(255,255,255,0.62);border-color:rgba(30,60,140,0.10);box-shadow:0 8px 24px rgba(30,50,110,0.12);}
  #lobby .lbTile:hover{transform:translateY(-2px);background:rgba(150,180,255,0.16);box-shadow:0 12px 32px rgba(2,6,20,0.5),inset 0 .5px 0 0 rgba(200,220,255,.24);}
  #lobby .lbTile:active{transform:translateY(0);}
  #lobby .lbTile.primary{grid-column:1 / -1;flex-direction:row;align-items:center;gap:16px;padding:20px 22px;
    background:linear-gradient(120deg,rgba(10,132,255,0.95),rgba(90,90,255,0.9));border-color:transparent;box-shadow:0 12px 34px rgba(10,90,220,0.42);}
  #lobby .lbTile.primary:hover{background:linear-gradient(120deg,rgba(30,150,255,1),rgba(110,110,255,0.96));}
  #lobby .lbTile.primary .lbIco{font-size:30px;}
  #lobby .lbTile.primary .lbT{font-size:18px;color:#fff;}
  #lobby .lbTile.primary .lbD{color:rgba(255,255,255,0.82);}
  #lobby .lbTile.primary .lbGoArrow{margin-left:auto;font-size:22px;color:#fff;opacity:.9;}
  #lobby .lbIco{font-size:22px;line-height:1;}
  #lobby .lbT{font-size:15px;font-weight:650;letter-spacing:-0.01em;}
  #lobby .lbD{font-size:11.5px;color:rgba(210,222,250,0.55);line-height:1.4;}
  html.light #lobby .lbD{color:rgba(30,50,90,0.55);}
  #lobby .lbFoot{margin-top:22px;font-size:12px;color:rgba(210,222,250,0.45);display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:center;}
  html.light #lobby .lbFoot{color:rgba(30,50,90,0.5);}
  #lobby .lbPill{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:980px;background:rgba(150,180,255,0.10);cursor:pointer;color:inherit;}
  #lobby .lbPill:hover{background:rgba(150,180,255,0.2);}
  /* 공용 모달 */
  #lbModalWrap{position:fixed;inset:0;z-index:320;display:none;align-items:center;justify-content:center;padding:20px;
    background:rgba(4,7,16,0.6);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);}
  #lbModalWrap.open{display:flex;}
  #lbModal{width:min(94vw,560px);max-height:86vh;overflow:auto;background:var(--glass-pop,rgba(24,34,60,0.96));
    border-radius:24px;padding:24px 24px 20px;color:#eef2ff;box-shadow:0 20px 60px rgba(2,6,20,0.7),inset 0 .5px 0 0 rgba(200,220,255,.2);
    -webkit-user-select:none;user-select:none;}
  html.light #lbModal{background:rgba(255,255,255,0.98);color:#101a2e;box-shadow:0 20px 60px rgba(30,50,110,0.28);}
  #lbModal h2{margin:0 0 4px;font-size:20px;font-weight:650;letter-spacing:-0.02em;}
  #lbModal .lbMsub{margin:0 0 16px;font-size:13px;color:rgba(210,222,250,0.6);line-height:1.5;}
  html.light #lbModal .lbMsub{color:rgba(30,50,90,0.6);}
  #lbModal .lbClose{position:sticky;top:0;float:right;margin:-6px -6px 0 0;font-size:20px;cursor:pointer;
    background:none;border:none;color:inherit;opacity:.6;}
  #lbModal .lbClose:hover{opacity:1;}
  #lbModal .lbBtn{display:inline-block;margin-top:6px;background:var(--accent,#0A84FF);color:#fff;border:none;border-radius:980px;
    padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;}
  #lbModal .lbBtn.ghost{background:rgba(150,180,255,0.12);color:inherit;font-weight:500;}
  #lbModal .lbBtn:hover{filter:brightness(1.08);}
  #lbModal .lbRow{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;}
  /* 카테고리/카드 */
  .lbCards{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:6px;}
  .lbCard{background:rgba(150,180,255,0.08);border-radius:14px;padding:14px 12px;text-align:center;font-size:12.5px;
    border:0.5px solid rgba(200,220,255,0.12);}
  html.light .lbCard{background:rgba(30,60,140,0.05);border-color:rgba(30,60,140,0.08);}
  .lbCard .ci{font-size:26px;display:block;margin-bottom:6px;}
  .lbCard .cs{display:block;margin-top:3px;font-size:10.5px;color:rgba(210,222,250,0.5);}
  html.light .lbCard .cs{color:rgba(30,50,90,0.5);}
  .lbSoon{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:980px;font-size:9.5px;font-weight:700;
    background:rgba(255,212,38,0.16);color:#ffd426;vertical-align:middle;}
  /* 플랜 표 */
  .lbPlans{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px;}
  .lbPlan{background:rgba(150,180,255,0.07);border:0.5px solid rgba(200,220,255,0.14);border-radius:18px;padding:18px 16px;}
  html.light .lbPlan{background:rgba(30,60,140,0.04);border-color:rgba(30,60,140,0.1);}
  .lbPlan.pro{border-color:rgba(10,132,255,0.55);box-shadow:0 0 0 1px rgba(10,132,255,0.35) inset;}
  .lbPlan h3{margin:0 0 2px;font-size:16px;}
  .lbPlan .price{font-size:22px;font-weight:750;margin:4px 0 10px;letter-spacing:-0.02em;}
  .lbPlan .price small{font-size:12px;font-weight:500;color:rgba(210,222,250,0.55);}
  .lbPlan ul{margin:0;padding-left:16px;font-size:12.5px;line-height:1.7;color:rgba(220,230,250,0.85);}
  html.light .lbPlan ul{color:rgba(30,50,90,0.8);}
  .lbGuide{font-size:13px;line-height:1.65;}
  .lbGuide h4{margin:16px 0 6px;font-size:14px;color:var(--accent-text,#5eb1ff);}
  .lbGuide code{background:rgba(150,180,255,0.14);border-radius:6px;padding:1px 6px;font-family:var(--mono,ui-monospace,Consolas,monospace);font-size:12px;}
  .lbGuide .kv{display:grid;grid-template-columns:120px 1fr;gap:4px 10px;margin:4px 0;}
  .lbGuide .kv b{color:inherit;font-weight:600;}
  @media (max-width:560px){ #lobby .lbGrid{grid-template-columns:repeat(2,1fr);} .lbPlans{grid-template-columns:1fr;} }
  `;
  document.head.appendChild(style);

  // ---------- 로비 마크업 ----------
  const lobby = document.createElement('div');
  lobby.id = 'lobby';
  lobby.innerHTML = `
    <div class="lbHero">
      <div class="lbLogo">▦ WebCAD</div>
      <div class="lbSub">브라우저에서 바로 여는 2D·3D CAD / BIM 워크스페이스</div>
    </div>
    <div class="lbGrid">
      <div class="lbTile primary" data-act="work">
        <span class="lbIco">▦</span>
        <span><span class="lbT">작업하기</span><br><span class="lbD">새 도면을 시작하거나 저장된 작업을 이어서 편집합니다</span></span>
        <span class="lbGoArrow">→</span>
      </div>
      <div class="lbTile" data-act="assets"><span class="lbIco">🛍️</span><span class="lbT">에셋스토어</span><span class="lbD">블록·템플릿·심볼 라이브러리</span></div>
      <div class="lbTile" data-act="share"><span class="lbIco">🔗</span><span class="lbT">도면공유</span><span class="lbD">링크·계정으로 도면 공유</span></div>
      <div class="lbTile" data-act="plan"><span class="lbIco">⭐</span><span class="lbT">플랜구독</span><span class="lbD">무료 / 프로 플랜 비교</span></div>
      <div class="lbTile" data-act="guide"><span class="lbIco">📖</span><span class="lbT">사용법</span><span class="lbD">빠른 시작 & 명령어 안내</span></div>
      <div class="lbTile" data-act="login"><span class="lbIco">👤</span><span class="lbT" id="lbLoginT">로그인</span><span class="lbD" id="lbLoginD">계정으로 클라우드 저장·공유</span></div>
    </div>
    <div class="lbFoot">
      <span id="lbWho">게스트로 둘러보는 중</span>
      <span class="lbPill" data-act="guide">📖 사용법</span>
      <span class="lbPill" data-act="plan">⭐ 플랜</span>
    </div>`;
  document.body.appendChild(lobby);

  // ---------- 공용 모달 ----------
  let modalWrap = document.createElement('div');
  modalWrap.id = 'lbModalWrap';
  modalWrap.innerHTML = `<div id="lbModal"></div>`;
  document.body.appendChild(modalWrap);
  const modalEl = modalWrap.querySelector('#lbModal');
  modalWrap.addEventListener('click', (e) => { if (e.target === modalWrap) closeModal(); });
  function openModal(html) { modalEl.innerHTML = `<button class="lbClose" aria-label="닫기">✕</button>` + html; modalEl.querySelector('.lbClose').onclick = closeModal; modalWrap.classList.add('open'); }
  function closeModal() { modalWrap.classList.remove('open'); }

  // ---------- 로비 열기/닫기 ----------
  function showLobby() { lobby.classList.remove('hidden'); if (AUTH()) AUTH().hideLogin(); }
  function hideLobby() { lobby.classList.add('hidden'); }
  window.WEBCAD_LOBBY = { show: showLobby, hide: hideLobby };

  // ---------- 액션 ----------
  function enterWorkspace() {
    hideLobby();
    if (!session && authConfigured && AUTH()) AUTH().showLogin(); // 로그인 안 됐으면 게이트 노출
  }
  function doLogin() {
    if (session) { openAccount(); return; }        // 이미 로그인 → 계정 모달
    hideLobby();
    if (AUTH()) AUTH().showLogin();
    else openModal('<h2>로그인 미설정</h2><p class="lbMsub">이 배포에는 로그인 서버가 설정되어 있지 않아 게스트로만 사용할 수 있습니다.</p>');
  }
  function openAccount() {
    const name = uname();
    openModal(`<h2>내 계정</h2>
      <p class="lbMsub">현재 <b>${esc(name)}</b> 님으로 로그인되어 있습니다.</p>
      <div class="lbRow">
        <button class="lbBtn" data-go="work">작업 공간으로</button>
        <button class="lbBtn ghost" id="lbLogout">로그아웃</button>
      </div>`);
    modalEl.querySelector('[data-go="work"]').onclick = () => { closeModal(); enterWorkspace(); };
    modalEl.querySelector('#lbLogout').onclick = () => { if (confirm('로그아웃할까요? (작업물은 이 브라우저에 자동 저장되어 있습니다)')) AUTH() && AUTH().signOut(); };
  }
  function openAssets() {
    openModal(`<h2>에셋스토어 <span class="lbSoon">오픈 예정</span></h2>
      <p class="lbMsub">자주 쓰는 블록·심볼·도면 템플릿을 받아 바로 배치할 수 있는 라이브러리입니다. 카테고리를 준비 중이며, 지금은 작업 공간의 <b>블록 라이브러리</b>에서 내 블록을 저장·재사용할 수 있습니다.</p>
      <div class="lbCards">
        <div class="lbCard"><span class="ci">🏛️</span>건축<span class="cs">문·창·계단</span></div>
        <div class="lbCard"><span class="ci">🛋️</span>가구/집기<span class="cs">평면 심볼</span></div>
        <div class="lbCard"><span class="ci">🌳</span>조경<span class="cs">수목·포장</span></div>
        <div class="lbCard"><span class="ci">🔌</span>전기/설비<span class="cs">콘센트·조명</span></div>
        <div class="lbCard"><span class="ci">📐</span>템플릿<span class="cs">도곽·표제란</span></div>
        <div class="lbCard"><span class="ci">🧱</span>구조<span class="cs">기둥·보</span></div>
      </div>
      <div class="lbRow"><button class="lbBtn" data-go="work">작업 공간에서 블록 라이브러리 열기</button></div>`);
    modalEl.querySelector('[data-go="work"]').onclick = () => { closeModal(); enterWorkspace(); hintMenu('블록 라이브러리는 상단 [옵션] 메뉴에서 열 수 있습니다.'); };
  }
  function openShare() {
    openModal(`<h2>도면 공유</h2>
      <p class="lbMsub">두 가지 방법으로 도면을 공유할 수 있습니다.</p>
      <div class="lbCards" style="grid-template-columns:1fr 1fr;">
        <div class="lbCard" style="text-align:left;padding:16px;"><span class="ci">🔗</span><b>링크로 공유</b>
          <div class="cs" style="margin-top:6px;font-size:11.5px;color:inherit;opacity:.75;">서버 없이 도면 전체를 URL에 담아 전달 — 상대는 로그인 없이 열람</div></div>
        <div class="lbCard" style="text-align:left;padding:16px;"><span class="ci">👥</span><b>계정으로 공유</b>
          <div class="cs" style="margin-top:6px;font-size:11.5px;color:inherit;opacity:.75;">클라우드 저장 후 상대 아이디로 공유 — 실시간 공동편집 가능</div></div>
      </div>
      <div class="lbRow">
        <button class="lbBtn" id="lbShareLink">🔗 링크로 공유하기</button>
        <button class="lbBtn ghost" id="lbShareAcct">👥 계정 공유 (작업 공간)</button>
      </div>`);
    modalEl.querySelector('#lbShareLink').onclick = () => { closeModal(); enterWorkspace(); setTimeout(() => { const b = document.getElementById('miShare'); if (b) b.click(); }, 60); };
    modalEl.querySelector('#lbShareAcct').onclick = () => { closeModal(); enterWorkspace(); hintMenu('클라우드 저장 후 [파일] 메뉴 → 공유…에서 아이디로 공유하세요.'); };
  }
  function openPlan() {
    const pro = session ? '' : '<p class="lbMsub" style="margin-top:10px;">프로 플랜을 이용하려면 먼저 로그인하세요.</p>';
    openModal(`<h2>플랜 구독</h2>
      <p class="lbMsub">WebCAD는 로컬 작업은 언제나 무료입니다. 클라우드 저장·협업을 넓히려면 프로 플랜을 이용하세요.</p>
      <div class="lbPlans">
        <div class="lbPlan"><h3>무료</h3><div class="price">₩0</div>
          <ul><li>모든 2D·3D·BIM 도구</li><li>로컬 저장 무제한</li><li>클라우드 도면 5개</li><li>링크 공유</li></ul></div>
        <div class="lbPlan pro"><h3>프로 <span class="lbSoon">문의</span></h3><div class="price">₩— <small>/월</small></div>
          <ul><li>클라우드 도면 무제한</li><li>실시간 공동편집 우선</li><li>버전 기록 확장</li><li>우선 지원</li></ul></div>
      </div>${pro}
      <div class="lbRow"><button class="lbBtn" id="lbProAsk">프로 플랜 문의</button></div>`);
    modalEl.querySelector('#lbProAsk').onclick = () => { closeModal(); enterWorkspace(); hintMenu('프로 플랜 문의는 [옵션] 메뉴 → 피드백 보내기로 남겨주세요.'); };
  }
  function openGuide() {
    openModal(`<h2>사용법 — 빠른 시작</h2>
      <p class="lbMsub">명령행에 명령어를 입력하거나 왼쪽 도구를 눌러 작업합니다. 빈 곳에서 스페이스=직전 명령 반복.</p>
      <div class="lbGuide">
        <h4>기본 흐름</h4>
        <div class="kv"><b>그리기</b><span>선(<code>line</code>)·폴리라인(<code>pl</code>)·사각(<code>rec</code>)·원(<code>circle</code>)</span></div>
        <div class="kv"><b>편집</b><span>이동·복사·오프셋(<code>offset</code>)·모깎기(<code>fillet</code>)·자르기(<code>trim</code>)</span></div>
        <div class="kv"><b>스냅</b><span>하단 상태바에서 끝점·중간점·중심 등 켜고 끄기</span></div>
        <div class="kv"><b>저장</b><span>파일 → 저장(DXF) / 다른 이름으로(STL·OBJ 3D) / 링크 공유</span></div>
        <h4>3D · BIM</h4>
        <div class="kv"><b>3D 뷰</b><span>상단 [3D]·[4분할] 토글 — 우드래그 회전, 좌드래그 박스 선택</span></div>
        <div class="kv"><b>돌출</b><span><code>extrudecrv</code> 곡선→면(마우스로 높이 끌기), <code>extrudesrf</code> 면→두께</span></div>
        <div class="kv"><b>솔리드</b><span><code>box</code>·<code>cylinder</code>·<code>sphere</code>·<code>cone</code>, 불리언 <code>union</code>·<code>difference</code></span></div>
        <div class="kv"><b>변형</b><span><code>move3d</code>·<code>rotate3d</code>·<code>mirror3d</code>·<code>array3d</code>·<code>scale3d</code></span></div>
        <h4>도움말</h4>
        <div class="kv"><b>명령 목록</b><span>명령행에 <code>help</code> 입력 — 전체 명령·설명 표시</span></div>
      </div>
      <div class="lbRow"><button class="lbBtn" data-go="work">바로 작업 시작</button></div>`);
    modalEl.querySelector('[data-go="work"]').onclick = () => { closeModal(); enterWorkspace(); };
  }

  // 작업 공간 진입 후 메뉴 위치를 알려주는 짧은 안내(콘솔 로그가 있으면 사용)
  function hintMenu(msg) { try { const el = document.getElementById('cmdPrompt'); if (el) el.textContent = msg; } catch (e) {} }
  function uname() { return (session && session.user && (session.user.user_metadata?.username || (session.user.email || '').split('@')[0])) || '게스트'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const ACTIONS = { work: enterWorkspace, assets: openAssets, share: openShare, plan: openPlan, guide: openGuide, login: doLogin };
  lobby.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t && ACTIONS[t.dataset.act]) ACTIONS[t.dataset.act](); });

  // ---------- 세션 상태 반영 ----------
  function reflect() {
    const name = uname();
    const logged = !!session;
    document.getElementById('lbLoginT').textContent = logged ? esc(name) : '로그인';
    document.getElementById('lbLoginD').textContent = logged ? '내 계정 · 로그아웃' : '계정으로 클라우드 저장·공유';
    document.getElementById('lbWho').textContent = logged ? `${esc(name)} 님으로 로그인됨` : '게스트로 둘러보는 중';
  }
  window.addEventListener('webcad-auth', (ev) => { session = (ev.detail && ev.detail.session) || null; reflect(); });
  reflect();

  // ---------- 상단 로고 클릭 → 로비로 복귀 ----------
  function wireLogo() {
    const logo = document.querySelector('#topbar .title');
    if (!logo) { setTimeout(wireLogo, 300); return; }
    logo.style.cursor = 'pointer';
    logo.title = '로비로 돌아가기';
    logo.addEventListener('click', showLobby);
  }
  wireLogo();

  // 로비가 떠 있는 동안 로그인 게이트가 뒤에서 깜빡이지 않게: 로비는 항상 로드시 노출
  // (auth.js가 로그인 게이트를 열더라도 로비가 z-index로 덮음)
})();
