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
`;
document.head.appendChild(css);
const dot = document.createElement('div'); dot.id = 'penDot'; document.body.appendChild(dot);
const snap = document.createElement('div'); snap.id = 'penSnap'; document.body.appendChild(snap);
let hoverEl = null, hideTimer = null;
function hideAll() {
  dot.style.display = 'none';
  snap.style.display = 'none';
  if (hoverEl) { hoverEl.classList.remove('penHover'); hoverEl = null; }
}
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'pen') return;
  if (e.buttons !== 0) { hideAll(); return; }          // 접촉 중 = 그리기/조작 — 마커 숨김
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
window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'pen') hideAll(); }, { passive: true, capture: true });
window.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') hideAll(); }, { passive: true, capture: true });
window.WEBCAD_PENHOVER = { dot, snap, hide: hideAll, current: () => hoverEl };
})();
