/* ============================================================
   WebCAD 커서 명령창 — 사용자 피드백 ⑥
   왼쪽 도구창(#toolbar)과 상단 명령 콘솔(#console)을 없애고,
   스페이스/엔터(또는 그냥 타이핑)를 누르면 마우스 커서 왼쪽에
   작은 명령창이 뜬다. 기존 #cmdInput DOM 을 통째로 옮겨 담으므로
   자동완성·직전 명령 반복·모든 명령 로직이 그대로 동작한다.
   명령 기록(logLine)은 상단 중앙의 짧은 토스트로 흘려보여 준다.
   ============================================================ */
(() => {
'use strict';
const cmdRow = document.getElementById('cmdInputRow');
const cmdInput = document.getElementById('cmdInput');
const cmdLog = document.getElementById('cmdLog');
if (!cmdRow || !cmdInput) return;

// ---------- 기존 크롬 제거 ----------
const css = document.createElement('style');
css.textContent = `
  #console { display: none !important; }        /* 상단 명령 콘솔 제거 (#toolbar 는 panels.js 가 슬라이드로) */
  #tgBottom { display: none !important; }
  /* 닫힘 = 투명+클릭 통과 (display:none 이면 안의 입력창이 포커스 불가라 '글자=명령'이 죽는다) */
  /* 네모난 흰 박스 — 검은 텍스트. '열리는 순간의 커서 위치'에 고정된다(따라다니지 않음 —
     아래로 뜨는 유사 명령어를 클릭할 수 있어야 하므로). 2026-07-20: 텍스트 한 줄 높이 · 폭 절반. */
  #cmdPop{position:fixed;z-index:70;display:flex;opacity:0;pointer-events:none;
    min-width:64px;max-width:min(150px,90vw);
    background:#ffffff;border:1px solid #b8bfcc;border-radius:3px;
    box-shadow:0 3px 10px rgba(0,0,0,.22);padding:1px 4px;}
  #cmdPop #cmdLabel{display:none;}                /* '명령:' 라벨 없이 입력만 */
  #cmdPop.open{opacity:1;pointer-events:auto;}
  #cmdPop #cmdInputRow{display:flex;background:none;border:none;padding:0;align-items:center;}
  #cmdPop .cmdInputWrap{flex:1 1 56px;min-width:0;max-width:120px;}
  #cmdPop #cmdLabel{color:#333;font-size:12px;}
  /* 텍스트 색은 테마와 무관하게 강제 — 흰 박스 안은 항상 진한 글자 (화이트모드 흰 글자 금지) */
  #cmdPop #cmdInput{background:#fff !important;color:#111 !important;-webkit-text-fill-color:#111;
    caret-color:#111;border:none;outline:none;font-size:12px;
    padding:0 2px;height:15px;line-height:15px;border-radius:0;box-shadow:none !important;
    font-family:var(--mono,monospace);}
  #cmdPop #cmdInput:focus{box-shadow:none !important;background:#fff !important;}
  /* 유사 명령어 목록은 입력 박스 '아래'로 — 박스가 고정이므로 그대로 클릭 가능 */
  #cmdPop #cmdSuggest{bottom:auto;top:calc(100% + 6px);}
  #cmdPop #cmdPrompt, #cmdPop #dimHint{color:#444;}
  /* 유사 명령어 목록 — 명령창과 같은 디자인(흰 박스·같은 테두리·radius 3px·12px 글자) */
  #cmdPop #cmdSuggest{background:#fff;color:#111;border:1px solid #b8bfcc;border-radius:3px;
    box-shadow:0 3px 10px rgba(0,0,0,.22);padding:3px;min-width:150px;font-size:12px;}
  #cmdPop .sugItem{color:#111;padding:4px 8px;border-radius:2px;font-size:12px;}
  #cmdPop .sugItem .sname{color:#0a54c8;}
  #cmdPop .sugItem .sko{color:#666;font-size:10.5px;}
  #cmdPop .sugItem.sel, #cmdPop .sugItem:hover{background:#e8f0ff;}
  /* ★일치 글자(.match) — 본체 CSS가 선택 행에 연백색(#dcebff)을 입혀 흰 박스에서 사라졌다.
     흰 박스 안은 항상 진한 파랑 (화이트모드 흰 글자 금지 규칙) */
  #cmdPop .sugItem .match{color:#0a54c8;}
  #cmdPop .sugItem.sel .match, #cmdPop .sugItem:hover .match{color:#0a54c8;}
  #cmdPop .sugItem.sel .sname, #cmdPop .sugItem:hover .sname{color:#0a54c8;}
  #cmdToast{position:fixed;left:50%;top:52px;transform:translateX(-50%);z-index:69;
    max-width:min(700px,92vw);background:rgba(15,22,40,.92);border:1px solid rgba(120,150,220,.35);
    border-radius:10px;padding:6px 14px;font:12.5px -apple-system,system-ui,sans-serif;color:#cfe0ff;
    pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
`;
document.head.appendChild(css);

// ---------- 플로팅 팝업 (기존 입력줄을 그대로 입양) ----------
const pop = document.createElement('div');
pop.id = 'cmdPop';
pop.appendChild(cmdRow);
document.body.appendChild(pop);
cmdInput.placeholder = '';                       // 입력 전 사용법 안내 텍스트 제거 — 빈 박스
let lastPtr = { x: innerWidth / 2, y: innerHeight / 2 };
const isOpen = () => pop.classList.contains('open');
function place() {
  // 커서의 '오른쪽'에 — 팝업 왼쪽 끝을 커서에 붙인다 (화면 밖이면 왼쪽으로)
  const r = pop.getBoundingClientRect();
  let x = lastPtr.x + 14;
  if (x + r.width > innerWidth - 8) x = Math.max(8, lastPtr.x - r.width - 14);
  const y = Math.max(8, Math.min(innerHeight - r.height - 8, lastPtr.y - r.height / 2));
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
}
// 열려 있는 동안엔 '고정' — 커서를 따라가면 입력 중 아래 유사 명령어를 클릭할 수 없다.
// lastPtr 만 계속 갱신해 두었다가, 다음에 '열리는 순간'의 커서 위치에 박스를 놓는다.
window.addEventListener('pointermove', (e) => {
  lastPtr = { x: e.clientX, y: e.clientY };
}, { passive: true });
window.addEventListener('pointerdown', (e) => { lastPtr = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });

function showPop() {
  if (isOpen()) return;
  place();
  pop.classList.add('open');
  try { cmdInput.focus({ preventScroll: true }); } catch (e) {}
}
function hidePop() { pop.classList.remove('open'); }

// ---------- 열기/닫기 규칙 ----------
const sketchOn = () => !!(window.WEBCAD_SKETCH && window.WEBCAD_SKETCH.SK.on);
const inOtherField = (t) => t && ((/INPUT|TEXTAREA|SELECT/.test(t.tagName) && t.id !== 'cmdInput')
  || (t.closest && t.closest('#aiPanel')));
// 스페이스/엔터 = 열기 (닫힌 상태에서 직전 명령이 몰래 실행되지 않게 캡처에서 가로챈다)
window.addEventListener('keydown', (e) => {
  if (sketchOn() || isOpen()) return;
  if (inOtherField(e.target)) return;
  if (document.body.classList.contains('authLocked')) return;
  const k = typeof e.key === 'string' ? e.key : '';
  if (k === ' ' || k === 'Enter') { e.preventDefault(); e.stopPropagation(); showPop(); }
}, true);
// 글자를 치면(전역 핸들러가 명령창에 넣어준다) 팝업이 따라 뜬다 — 타이핑 즉시 명령 시작
cmdInput.addEventListener('input', () => { if (cmdInput.value && !isOpen() && !sketchOn()) showPop(); });
// 명령을 실행(엔터/스페이스)하고 입력이 비면 닫는다 — 진행 안내는 토스트가 맡는다
cmdInput.addEventListener('keydown', (e) => {
  const k = typeof e.key === 'string' ? e.key : '';
  if (k === 'Enter' || k === ' ') setTimeout(() => { if (!cmdInput.value) hidePop(); }, 60);
  if (k === 'Escape') hidePop();
});
// 바깥 클릭(작도 지점 클릭 포함) = 닫기 — 숫자·좌표를 다시 치면 곧바로 다시 뜬다
document.addEventListener('pointerdown', (e) => {
  if (isOpen() && !pop.contains(e.target)) hidePop();
}, true);

// ---------- 명령 기록 토스트 (콘솔이 사라진 자리를 가볍게 대신한다) ----------
const toast = document.createElement('div');
toast.id = 'cmdToast';
document.body.appendChild(toast);
let toastTimer = null;
function showToast(text) {
  if (!text) return;
  toast.textContent = text;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3500);
}
if (cmdLog) {
  new MutationObserver(() => {
    const last = cmdLog.lastElementChild;
    if (last && last.textContent) showToast(last.textContent.trim());
  }).observe(cmdLog, { childList: true });
}

// 외부/테스트 훅
window.WEBCAD_CMDPOP = { show: showPop, hide: hidePop, isOpen, pop, place, setPtr: (x, y) => { lastPtr = { x, y }; } };
})();
