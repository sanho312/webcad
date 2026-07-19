/* ============================================================
   WebCAD 슬라이드 패널
   왼쪽 도구창(#toolbar)·오른쪽 상태창(#side)을 접이식으로.
   (2026-07-19 개편: 호버 자동 펼침 제거 — 사용자 기기(호버 미지원)에
    맞춰 '클릭으로만' 펼치고 접는다. 손잡이도 화살표 박스가 아니라
    기존 폭조절 바 느낌의 얇은 세로 바.)
   ============================================================ */
(() => {
'use strict';
const main = document.getElementById('main');
const left = document.getElementById('toolbar');
const right = document.getElementById('side');
if (!main || (!left && !right)) return;
const KEY = 'webcad_panels';
const pin = { l: false, r: false };                    // 펼침 상태 (기억)
try { Object.assign(pin, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

const css = document.createElement('style');
css.textContent = `
  #main{position:relative;}
  .rz{display:none !important;}                 /* 옛 폭 조절 손잡이 자리는 접기 바가 대신한다 */
  #toolbar{position:absolute;left:0;top:0;bottom:0;z-index:26;margin:0;
    transform:translateX(-102%);transition:transform .22s ease;box-shadow:4px 0 18px rgba(0,0,0,.35);}
  #toolbar.pOpen{transform:none;}
  #side{position:absolute;right:0;top:0;bottom:0;z-index:26;margin:0;
    transform:translateX(102%);transition:transform .22s ease;box-shadow:-4px 0 18px rgba(0,0,0,.35);}
  #side.pOpen{transform:none;}
  /* 기존 폭조절 핸들(.rz)과 같은 비주얼 — 투명 트랙 + 가운데 작은 세로 알약. 클릭으로만 펼침/접기 */
  .pTab{position:absolute;top:0;bottom:0;width:10px;z-index:27;background:transparent;
    cursor:pointer;user-select:none;touch-action:manipulation;
    transition:left .22s ease, right .22s ease;}
  .pTab::after{content:'';position:absolute;top:50%;transform:translateY(-50%);
    width:3px;height:44px;border-radius:2px;background:var(--line,rgba(120,140,180,.45));
    transition:background .15s ease,height .15s ease;}
  #pTabL{left:0;} #pTabL::after{left:3px;}
  #pTabR{right:0;} #pTabR::after{right:3px;}
  .pTab:hover::after{background:var(--accent,#0A84FF);height:72px;}
`;
document.head.appendChild(css);

function mkTab(id, panel, sideKey) {
  if (!panel) return null;
  const tab = document.createElement('div');
  tab.id = id; tab.className = 'pTab';
  tab.title = '클릭: 도구창 펼침/접기';
  main.appendChild(tab);
  const isL = sideKey === 'l';
  const refresh = () => {
    const open = panel.classList.contains('pOpen');
    // 펼치면 바가 패널 가장자리에 붙어 따라간다 (모양은 기존 .rz 알약 그대로)
    const w = panel.getBoundingClientRect().width;
    if (isL) tab.style.left = open ? w + 'px' : '0';
    else tab.style.right = open ? w + 'px' : '0';
  };
  const setOpen = (o) => {
    panel.classList.toggle('pOpen', o);
    refresh();
    window.dispatchEvent(new Event('resize'));
  };
  tab.addEventListener('click', () => {                // 클릭 = 토글 (호버로는 아무 일도 없다)
    pin[sideKey] = !pin[sideKey];
    try { localStorage.setItem(KEY, JSON.stringify(pin)); } catch (e) {}
    setOpen(pin[sideKey]);
  });
  setOpen(!!pin[sideKey]);
  return { tab, setOpen, refresh };
}
const L = mkTab('pTabL', left, 'l');
const R = mkTab('pTabR', right, 'r');
setTimeout(() => window.dispatchEvent(new Event('resize')), 50); // 패널이 흐름에서 빠진 새 레이아웃 반영
window.WEBCAD_PANELS = { pin, left: L, right: R };
})();
