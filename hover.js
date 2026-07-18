/* ============================================================
   WebCAD 포인터 마커 유틸
   (하드웨어 펜슬 호버 기능은 2026-07-19 사용자 요청으로 롤백 —
    사용자 기기(M1 iPad)가 호버 미지원이라 실효가 없었다.)
   남은 것: 🎯 조준 모드·드로잉 중 스냅 미리보기(sketch.js)가 쓰는
   커서 링/스냅 마커 요소와, 버튼 눌림 대기상태(:active) 스타일.
   ============================================================ */
(() => {
'use strict';
const css = document.createElement('style');
css.textContent = `
  #penDot{position:fixed;z-index:80;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
    border:1.5px solid rgba(205,215,235,.95);box-shadow:0 0 4px rgba(0,0,0,.5);
    pointer-events:none;display:none;}
  #penDot::after{content:'';position:absolute;left:50%;top:50%;width:2px;height:2px;margin:-1px 0 0 -1px;
    border-radius:50%;background:rgba(205,215,235,.95);}
  #penSnap{position:fixed;z-index:80;width:12px;height:12px;margin:-6px 0 0 -6px;
    border:2px solid #3aa66a;background:rgba(58,166,106,.15);pointer-events:none;display:none;}
  /* 눌림 = 대기상태 회색. 릴리즈로 실행, 밀어서 벗어나면 취소 — '누르기 전 확인'의 터치판 */
  button:active, select:active, .tbtn:active, .miniBtn:active, .pTab:active, .cp:active, label:active{
    background:rgba(190,197,210,.45) !important;outline:1px solid rgba(190,197,210,.6);}
`;
document.head.appendChild(css);
const dot = document.createElement('div'); dot.id = 'penDot'; document.body.appendChild(dot);
const snap = document.createElement('div'); snap.id = 'penSnap'; document.body.appendChild(snap);
document.addEventListener('touchstart', () => {}, { passive: true }); // iOS Safari 에서 :active 를 살리는 관례
function showDot(x, y) { dot.style.display = 'block'; dot.style.left = x + 'px'; dot.style.top = y + 'px'; }
function showSnap(x, y) { snap.style.display = 'block'; snap.style.left = x + 'px'; snap.style.top = y + 'px'; }
function hideSnap() { snap.style.display = 'none'; }
function hideDot() { dot.style.display = 'none'; }
function hideAll() { hideDot(); hideSnap(); }
window.WEBCAD_PENHOVER = { dot, snap, hide: hideAll, showDot, showSnap, hideSnap, hideDot };
})();
