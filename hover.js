/* ============================================================
   WebCAD 펜슬 호버 — 사용자 피드백
   Apple Pencil 은 화면에 닿기 전 근접(호버)에서도 포인터 이벤트를 보낸다
   (iPadOS 16.4+, pointerType 'pen' + buttons 0). 이를 이용해:
   · 펜촉이 지금 어디를 가리키는지 커서 링으로 표시
   · 접촉 전에 스냅점을 미리 표시 (초록 사각 — 찍힐 곳을 먼저 안다)
   · 버튼·토글 위에서는 '대기 상태'(옅은 회색) — 누르기 전에 확인
   슬라이드 패널 탭(pTab)은 호버 포인터 이벤트가 pointerenter 를 그대로
   발생시키므로 자연스럽게 펼쳐진다.
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
  .penHover{background:rgba(190,197,210,.45) !important;outline:1px solid rgba(190,197,210,.6);}
  /* 호버 미지원 기기(M1 이하) 대체: 누르고 있는 동안 = 대기상태 회색.
     릴리즈로 실행, 손가락을 밀어 벗어나면 취소 — '누르기 전 확인'의 터치판 */
  button:active, select:active, .tbtn:active, .miniBtn:active, .pTab:active, .cp:active, label:active{
    background:rgba(190,197,210,.45) !important;outline:1px solid rgba(190,197,210,.6);}
`;
document.head.appendChild(css);
const dot = document.createElement('div'); dot.id = 'penDot'; document.body.appendChild(dot);
const snap = document.createElement('div'); snap.id = 'penSnap'; document.body.appendChild(snap);
let hoverEl = null, hideTimer = null;
// ---------- 진단 — 호버 이벤트가 이 기기에서 오는지 실측 (hovertest 명령) ----------
// 호버는 하드웨어 조건이 있다: M2 이후 iPad(Pro 2022+·Air M2·Pro M4) + Pencil 2/Pro + iPadOS 16.4+.
const stats = { hover: 0, contact: 0, touch: 0, mouse: 0 };
let warned = false, diagEl = null, diagTimer = null;
function maybeWarnNoHover() {
  // 펜 접촉은 여러 번 있는데 호버가 0 → 기기가 호버 미지원일 가능성이 높다 — 한 번만 안내
  if (warned || stats.hover > 0 || stats.contact < 6) return;
  warned = true;
  const n = document.createElement('div');
  n.style.cssText = 'position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:95;'
    + 'max-width:min(560px,92vw);background:rgba(15,22,40,.96);border:1px solid rgba(255,193,64,.55);'
    + 'border-radius:12px;padding:12px 16px;font:12.5px -apple-system,system-ui,sans-serif;color:#ffe3a3;'
    + 'box-shadow:0 8px 24px rgba(0,0,0,.5);line-height:1.6;';
  n.innerHTML = '펜슬 <b>호버 신호가 감지되지 않습니다.</b><br>'
    + '호버(닿기 전 인식)는 <b>M2 이후 iPad</b>(iPad Pro 2022↑ · Air M2 · Pro M4) + '
    + '<b>Apple Pencil 2세대/Pro</b> + iPadOS 16.4 이상에서만 하드웨어가 지원합니다.<br>'
    + '<span style="color:#c9b280">명령창에 hovertest 를 입력하면 실시간 진단을 볼 수 있습니다.</span>';
  const x = document.createElement('button');
  x.textContent = '닫기';
  x.style.cssText = 'margin-left:10px;background:none;border:1px solid rgba(255,193,64,.5);color:#ffe3a3;'
    + 'border-radius:8px;padding:3px 10px;cursor:pointer;font-size:12px;';
  x.addEventListener('click', () => n.remove());
  n.appendChild(x);
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 15000);
}
function diag() {
  if (diagEl) { diagEl.remove(); diagEl = null; clearInterval(diagTimer); return; }
  diagEl = document.createElement('div');
  diagEl.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:95;min-width:230px;'
    + 'background:rgba(15,22,40,.96);border:1px solid rgba(120,150,220,.5);border-radius:12px;'
    + 'padding:10px 14px;font:12px ui-monospace,Consolas,monospace;color:#cfe0ff;line-height:1.7;';
  document.body.appendChild(diagEl);
  const render = () => {
    diagEl.innerHTML = '<b>펜슬 호버 진단</b> — 펜을 화면에 <u>닿지 않게</u> 1cm 위에서 움직여 보세요<br>'
      + `호버 이벤트(pen·비접촉): <b style="color:${stats.hover ? '#7fe3a9' : '#ff9f8a'}">${stats.hover}</b><br>`
      + `펜 접촉: ${stats.contact} · 손가락: ${stats.touch} · 마우스: ${stats.mouse}<br>`
      + `<span style="color:#8fa4d4">${stats.hover ? '✔ 이 기기는 호버 지원 — 기능이 작동해야 합니다'
        : '호버 0 = 이벤트가 안 옴 (기기/펜슬/OS 미지원 가능성)'}</span><br>`
      + `<span style="color:#6d7ea8;font-size:10.5px">${navigator.userAgent.slice(0, 80)}</span>`
      + '<br><span style="color:#8fa4d4">(hovertest 다시 입력 = 닫기)</span>';
  };
  render();
  diagTimer = setInterval(render, 400);
}
function hideAll() {
  dot.style.display = 'none';
  snap.style.display = 'none';
  if (hoverEl) { hoverEl.classList.remove('penHover'); hoverEl = null; }
}
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') { stats.touch++; return; }
  if (e.pointerType !== 'pen') { stats.mouse++; return; }
  if (e.buttons !== 0) { stats.contact++; hideAll(); return; } // 접촉 중 = 그리기/조작 — 마커 숨김
  stats.hover++;
  dot.style.display = 'block';
  dot.style.left = e.clientX + 'px'; dot.style.top = e.clientY + 'px';
  // 스냅 미리보기 (평면 캔버스 위)
  const S = window.WEBCAD_SKETCH;
  const sp = S && S.hoverSnap ? S.hoverSnap(e.clientX, e.clientY) : null;
  if (sp) {
    snap.style.display = 'block';
    snap.style.left = sp.x + 'px'; snap.style.top = sp.y + 'px';
  } else snap.style.display = 'none';
  // 토글 대기 상태 — 펜촉 아래의 버튼류를 옅은 회색으로
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const btn = t && t.closest
    ? t.closest('button, select, .tbtn, .miniBtn, .pTab, .cp, .sugItem, input[type="range"], input[type="checkbox"], label')
    : null;
  if (btn !== hoverEl) {
    if (hoverEl) hoverEl.classList.remove('penHover');
    hoverEl = btn;
    if (btn) btn.classList.add('penHover');
  }
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideAll, 2500);               // 펜이 범위를 벗어나 이벤트가 끊기면 정리
}, { passive: true, capture: true });
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'pen') { stats.contact++; hideAll(); maybeWarnNoHover(); }
}, { passive: true, capture: true });
window.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') hideAll(); }, { passive: true, capture: true });
document.addEventListener('touchstart', () => {}, { passive: true }); // iOS Safari 에서 :active 를 살리는 관례
// 스케치 조준/드로잉 스냅 미리보기가 같은 마커를 빌려 쓴다 (호버 미지원 기기 대체)
function showDot(x, y) { dot.style.display = 'block'; dot.style.left = x + 'px'; dot.style.top = y + 'px'; }
function showSnap(x, y) { snap.style.display = 'block'; snap.style.left = x + 'px'; snap.style.top = y + 'px'; }
function hideSnap() { snap.style.display = 'none'; }
function hideDot() { dot.style.display = 'none'; }
window.WEBCAD_PENHOVER = { dot, snap, hide: hideAll, current: () => hoverEl, stats, diag,
  showDot, showSnap, hideSnap, hideDot };
})();
