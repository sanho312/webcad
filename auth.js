// ============================================================
//  WebCAD 로그인/회원가입 (이메일 인증번호 방식)
//  - 백엔드: Supabase Auth (auth-config.js 에 url/anonKey 설정 시 활성)
//  - 설정이 비어 있으면 게이트를 띄우지 않고 기존처럼 동작
//  - 데모 모드: 콘솔에서 localStorage.setItem('webcad_auth_demo','1') 후 새로고침
//    (서버 없이 UI 흐름 테스트용 — 인증번호가 화면에 표시됨)
// ============================================================
(() => {
  const cfg = window.WEBCAD_AUTH || {};
  const DEMO = !cfg.url && localStorage.getItem('webcad_auth_demo') === '1';
  if (!cfg.url && !DEMO) return; // 미설정 → 로그인 게이트 없음

  // ---------- 스타일 ----------
  const style = document.createElement('style');
  style.textContent = `
  #authGate{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;
    background:rgba(6,10,24,0.55);-webkit-backdrop-filter:saturate(180%) blur(28px);backdrop-filter:saturate(180%) blur(28px);}
  #authGate.hidden{display:none;}
  .authCard{width:min(92vw,360px);background:var(--glass-pop,rgba(26,37,64,.9));
    -webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);
    border-radius:28px;padding:28px 26px;box-shadow:0 12px 40px rgba(2,6,20,.6),inset 0 .5px 0 0 rgba(200,220,255,.24);
    color:var(--text,#f2f5ff);user-select:none;}
  .authCard h1{margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.02em;}
  .authCard .sub{margin:0 0 18px;font-size:13px;color:var(--muted,rgba(210,222,250,.62));line-height:1.5;}
  .authCard label{display:block;font-size:12px;color:var(--muted,rgba(210,222,250,.62));margin:10px 0 4px;}
  .authCard input{width:100%;box-sizing:border-box;background:rgba(150,180,255,.10);color:inherit;border:none;
    border-radius:11px;padding:10px 13px;font-size:14px;user-select:text;-webkit-user-select:text;
    box-shadow:inset 0 .5px 0 0 rgba(200,220,255,.18);}
  .authCard input:focus{outline:none;box-shadow:0 0 0 2px var(--accent,#0A84FF);}
  .authBtn{width:100%;margin-top:16px;background:var(--accent,#0A84FF);color:#fff;border:none;
    border-radius:980px;padding:11px;font-size:15px;font-weight:600;cursor:pointer;letter-spacing:-0.01em;}
  .authBtn:hover{background:var(--accent-hover,#3d9bff);}
  .authBtn:disabled{opacity:.55;cursor:default;}
  .authBtn.ghost{background:rgba(150,180,255,.10);font-weight:400;margin-top:8px;}
  .authErr{min-height:18px;margin-top:10px;font-size:12.5px;color:#ff6961;line-height:1.4;}
  .authLinks{margin-top:14px;display:flex;justify-content:space-between;font-size:12.5px;}
  .authLinks a{color:var(--accent-text,#5eb1ff);cursor:pointer;text-decoration:none;}
  .authLinks a:hover{text-decoration:underline;}
  .authDemo{margin-top:12px;padding:9px 11px;border-radius:11px;background:rgba(255,212,38,.12);
    color:#ffd426;font-size:12.5px;line-height:1.5;}
  #authCode{letter-spacing:8px;text-align:center;font-size:20px;font-family:ui-monospace,Consolas,monospace;}
  #userChipWrap{position:relative;display:inline-block;}
  `;
  document.head.appendChild(style);

  // ---------- 백엔드 클라이언트 ----------
  let sb = null;
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // 데모용 가짜 클라이언트: localStorage에 사용자 저장, 인증번호는 화면에 표시
  function mockClient() {
    const K_USERS = 'webcad_demo_users', K_SES = 'webcad_demo_session';
    const users = () => JSON.parse(localStorage.getItem(K_USERS) || '{}');
    const saveUsers = (u) => localStorage.setItem(K_USERS, JSON.stringify(u));
    let pending = null; // {email, code, kind, data}
    const listeners = [];
    const fire = () => listeners.forEach(f => f());
    const session = () => JSON.parse(localStorage.getItem(K_SES) || 'null');
    return {
      _demoCode: () => pending && pending.code,
      auth: {
        getSession: async () => ({ data: { session: session() } }),
        onAuthStateChange: (f) => { listeners.push(f); return { data: { subscription: { unsubscribe(){} } } }; },
        signUp: async ({ email, password, options }) => {
          const u = users();
          if (Object.values(u).some(x => x.email === email)) return { error: { message: 'User already registered' } };
          pending = { email, code: String(Math.floor(100000 + Math.random() * 900000)), kind: 'signup', data: { email, password, username: options?.data?.username } };
          return { data: {}, error: null };
        },
        resend: async ({ email }) => { if (pending && pending.email === email) pending.code = String(Math.floor(100000 + Math.random() * 900000)); return { error: null }; },
        verifyOtp: async ({ email, token, type }) => {
          if (!pending || pending.email !== email || pending.code !== token) return { error: { message: 'Token has expired or is invalid' } };
          if (type === 'signup') {
            const u = users(); u[pending.data.username] = pending.data; saveUsers(u);
            localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: pending.data.username } } }));
          } else { // recovery
            localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: (Object.values(users()).find(x => x.email === email) || {}).username } } }));
          }
          pending = null; fire();
          return { data: {}, error: null };
        },
        signInWithPassword: async ({ email, password }) => {
          const hit = Object.values(users()).find(x => x.email === email && x.password === password);
          if (!hit) return { error: { message: 'Invalid login credentials' } };
          localStorage.setItem(K_SES, JSON.stringify({ user: { email, user_metadata: { username: hit.username } } }));
          fire(); return { data: {}, error: null };
        },
        resetPasswordForEmail: async (email) => {
          if (!Object.values(users()).some(x => x.email === email)) return { error: null }; // 존재여부 노출 안 함
          pending = { email, code: String(Math.floor(100000 + Math.random() * 900000)), kind: 'recovery' };
          return { error: null };
        },
        updateUser: async ({ password }) => {
          const s = session(); if (!s) return { error: { message: 'not signed in' } };
          const u = users(); const k = Object.keys(u).find(k2 => u[k2].email === s.user.email);
          if (k) { u[k].password = password; saveUsers(u); }
          return { error: null };
        },
        signOut: async () => { localStorage.removeItem(K_SES); fire(); return { error: null }; },
      },
      rpc: async (fn, args) => {
        const u = users();
        if (fn === 'username_to_email') { const hit = u[args.u]; return { data: hit ? hit.email : null, error: null }; }
        if (fn === 'username_exists') return { data: !!u[args.u], error: null };
        return { data: null, error: null };
      },
    };
  }

  // ---------- 게이트 UI ----------
  const gate = document.createElement('div');
  gate.id = 'authGate'; gate.className = 'hidden';
  gate.innerHTML = `<div class="authCard" id="authCard"></div>`;
  document.body.appendChild(gate);
  const card = gate.querySelector('#authCard');

  const ERR_KO = (m) => {
    if (!m) return '';
    if (/Invalid login credentials/i.test(m)) return '아이디(이메일) 또는 비밀번호가 올바르지 않습니다.';
    if (/Email not confirmed/i.test(m)) return '이메일 인증이 완료되지 않은 계정입니다. 회원가입에서 같은 이메일로 인증번호를 다시 받아 완료해 주세요.';
    if (/already registered/i.test(m)) return '이미 가입된 이메일입니다. 로그인하거나 비밀번호 재설정을 이용하세요.';
    if (/expired or is invalid/i.test(m)) return '인증번호가 올바르지 않거나 만료되었습니다. (가장 최근에 온 메일의 번호를 사용하세요)';
    const sec = m.match(/after (\d+) seconds?/i);
    if (sec) return `보안을 위해 ${sec[1]}초 후에 다시 시도할 수 있습니다.`;
    if (/rate limit|security purposes|too many/i.test(m)) return '요청이 잠시 제한되었습니다. 10초쯤 후 다시 시도해 주세요.';
    if (/least 8|password/i.test(m)) return '비밀번호는 8자 이상이어야 합니다.';
    return m;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let view = 'login';
  let verifyCtx = null; // {email, kind:'signup'|'recovery'}
  function render() {
    const demoBadge = DEMO ? `<div class="authDemo">데모 모드 — 실제 이메일 대신 인증번호가 이 화면에 표시됩니다.<span id="demoCode"></span></div>` : '';
    if (view === 'login') card.innerHTML = `
      <h1>WebCAD 로그인</h1><p class="sub">도면 작업을 시작하려면 로그인하세요.</p>
      <label>아이디 또는 이메일</label><input id="aId" autocomplete="username">
      <label>비밀번호</label><input id="aPw" type="password" autocomplete="current-password">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">로그인</button>
      <div class="authLinks"><a id="toSignup">회원가입</a><a id="toReset">비밀번호 재설정</a></div>${demoBadge}`;
    if (view === 'signup') card.innerHTML = `
      <h1>회원가입</h1><p class="sub">가입하면 이메일로 인증번호가 전송됩니다.</p>
      <label>아이디 (3~20자: 영문/숫자/한글)</label><input id="aUser" autocomplete="username">
      <label>이메일</label><input id="aEmail" type="email" autocomplete="email">
      <label>비밀번호 (8자 이상)</label><input id="aPw" type="password" autocomplete="new-password">
      <label>비밀번호 확인</label><input id="aPw2" type="password" autocomplete="new-password">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">인증번호 받기</button>
      <button class="authBtn ghost" id="toLogin">로그인으로 돌아가기</button>${demoBadge}`;
    if (view === 'verify') card.innerHTML = `
      <h1>이메일 인증</h1><p class="sub"><b>${esc(verifyCtx.email)}</b> 로 보낸<br>인증번호를 입력하세요.</p>
      <input id="authCode" maxlength="10" inputmode="numeric" placeholder="······">
      ${verifyCtx.kind === 'recovery' ? '<label>새 비밀번호 (8자 이상)</label><input id="aPw" type="password" autocomplete="new-password">' : ''}
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">확인</button>
      <button class="authBtn ghost" id="aResend">인증번호 재전송</button>
      <button class="authBtn ghost" id="toLogin">취소</button>${demoBadge}`;
    if (view === 'reset') card.innerHTML = `
      <h1>비밀번호 재설정</h1><p class="sub">가입한 이메일로 인증번호를 보내드립니다.</p>
      <label>이메일</label><input id="aEmail" type="email" autocomplete="email">
      <div class="authErr" id="aErr"></div>
      <button class="authBtn" id="aGo">재설정 번호 받기</button>
      <button class="authBtn ghost" id="toLogin">로그인으로 돌아가기</button>${demoBadge}`;
    bind();
    updateDemoCode();
    const first = card.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
  }
  function updateDemoCode() {
    const el = card.querySelector('#demoCode');
    if (el && sb && sb._demoCode) el.textContent = sb._demoCode() ? ` 인증번호: ${sb._demoCode()}` : '';
  }
  const err = (m) => { const e = card.querySelector('#aErr'); if (e) e.textContent = ERR_KO(m); };
  const busy = (b) => { const g = card.querySelector('#aGo'); if (g) g.disabled = b; };

  function bind() {
    const q = (s) => card.querySelector(s);
    q('#toSignup')?.addEventListener('click', () => { view = 'signup'; render(); });
    q('#toReset')?.addEventListener('click', () => { view = 'reset'; render(); });
    q('#toLogin')?.addEventListener('click', () => { view = 'login'; verifyCtx = null; render(); });
    card.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); if (ev.key === 'Enter') q('#aGo')?.click();
    }));
    q('#aResend')?.addEventListener('click', async () => {
      err('');
      const btn = q('#aResend');
      let res;
      if (verifyCtx.kind === 'signup') res = await sb.auth.resend({ type: 'signup', email: verifyCtx.email });
      else res = await sb.auth.resetPasswordForEmail(verifyCtx.email);
      if (res && res.error) { err(res.error.message); return; }
      err('인증번호를 다시 보냈습니다. 메일함(스팸함 포함)을 확인하세요.'); updateDemoCode();
      // 재전송 쿨다운(서버 제한과 동일하게 잠시 비활성)
      if (btn) {
        let left = 12; btn.disabled = true; const orig = btn.textContent;
        const t = setInterval(() => {
          left--; btn.textContent = `인증번호 재전송 (${left}초)`;
          if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = orig; }
        }, 1000);
      }
    });
    q('#aGo')?.addEventListener('click', async () => {
      err(''); busy(true);
      try {
        if (view === 'login') {
          let id = q('#aId').value.trim(), pw = q('#aPw').value;
          if (!id || !pw) return err('아이디와 비밀번호를 입력하세요.');
          let email = id;
          if (!id.includes('@')) {
            const { data } = await sb.rpc('username_to_email', { u: id });
            if (!data) return err('아이디(이메일) 또는 비밀번호가 올바르지 않습니다.');
            email = data;
          }
          const { error } = await sb.auth.signInWithPassword({ email, password: pw });
          if (error) return err(error.message);
        }
        if (view === 'signup') {
          const un = q('#aUser').value.trim(), em = q('#aEmail').value.trim(), pw = q('#aPw').value, pw2 = q('#aPw2').value;
          if (!/^[A-Za-z0-9가-힣_]{3,20}$/.test(un)) return err('아이디는 3~20자의 영문/숫자/한글/_ 만 가능합니다.');
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('올바른 이메일을 입력하세요.');
          if (pw.length < 8) return err('비밀번호는 8자 이상이어야 합니다.');
          if (pw !== pw2) return err('비밀번호 확인이 일치하지 않습니다.');
          const { data: exists } = await sb.rpc('username_exists', { u: un });
          if (exists) return err('이미 사용 중인 아이디입니다.');
          const { error } = await sb.auth.signUp({ email: em, password: pw, options: { data: { username: un } } });
          if (error) {
            // 발송 제한에 걸려도 인증 화면으로 넘어가 잠시 후 '재전송'으로 이어갈 수 있게
            if (/rate limit|security purposes|after \d+ seconds|too many/i.test(error.message)) {
              verifyCtx = { email: em, kind: 'signup' }; view = 'verify'; render();
              err(ERR_KO(error.message) + ' 잠시 후 아래 "인증번호 재전송"을 눌러주세요.');
              return;
            }
            return err(error.message);
          }
          verifyCtx = { email: em, kind: 'signup' }; view = 'verify'; render();
        }
        if (view === 'verify') {
          const code = q('#authCode').value.trim();
          if (!/^\d{6,10}$/.test(code)) return err('이메일로 받은 숫자 인증번호를 입력하세요.');
          if (verifyCtx.kind === 'recovery') {
            const pw = q('#aPw').value;
            if (pw.length < 8) return err('새 비밀번호는 8자 이상이어야 합니다.');
            const { error } = await sb.auth.verifyOtp({ email: verifyCtx.email, token: code, type: 'recovery' });
            if (error) return err(error.message);
            const { error: e2 } = await sb.auth.updateUser({ password: pw });
            if (e2) return err(e2.message);
          } else {
            const { error } = await sb.auth.verifyOtp({ email: verifyCtx.email, token: code, type: 'signup' });
            if (error) return err(error.message);
          }
          verifyCtx = null;
        }
        if (view === 'reset') {
          const em = q('#aEmail').value.trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return err('올바른 이메일을 입력하세요.');
          const { error } = await sb.auth.resetPasswordForEmail(em);
          if (error) return err(error.message);
          verifyCtx = { email: em, kind: 'recovery' }; view = 'verify'; render();
        }
      } finally { busy(false); }
    });
  }

  // ---------- 세션 → 게이트/사용자 칩 ----------
  let chip = null;
  function showUser(session) {
    const name = session?.user?.user_metadata?.username || (session?.user?.email || '').split('@')[0];
    if (!chip) {
      chip = document.createElement('div'); chip.id = 'userChipWrap';
      chip.style.cssText = 'display:inline-flex;gap:6px;align-items:center;';
      chip.innerHTML = `<button class="tbtn" id="userChip" title="로그인된 계정">👤 <span id="userName"></span></button>
        <button class="tbtn" id="btnLogout" title="로그아웃">로그아웃</button>`;
      document.getElementById('topbar').appendChild(chip);
      chip.querySelector('#btnLogout').addEventListener('click', async () => {
        if (!confirm('로그아웃할까요? (작업물은 이 브라우저에 자동 저장되어 있습니다)')) return;
        await sb.auth.signOut(); location.reload();
      });
    }
    chip.querySelector('#userName').textContent = name;
    chip.style.display = session ? 'inline-flex' : 'none';
  }
  function setGate(open) {
    gate.classList.toggle('hidden', !open);
    document.body.classList.toggle('authLocked', open); // cad.js가 명령창 자동 포커스를 멈추도록
    if (open) { view = 'login'; render(); }
  }

  async function init() {
    if (cfg.url) {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      sb = window.supabase.createClient(cfg.url, cfg.anonKey);
    } else sb = mockClient();
    const { data: { session } } = await sb.auth.getSession();
    setGate(!session); showUser(session);
    sb.auth.onAuthStateChange(async (..._a) => {
      const { data: { session: s2 } } = await sb.auth.getSession();
      setGate(!s2); showUser(s2);
    });
  }
  init();
})();
