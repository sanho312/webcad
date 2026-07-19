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
  /* 얇은 세로 바 — 클릭으로만 펼침/접기 */
  .pTab{position:absolute;top:0;bottom:0;width:9px;z-index:27;
    display:flex;align-items:center;justify-content:center;
    background:rgba(58,72,112,.55);color:#9fb2d8;font-size:9px;
    cursor:pointer;user-select:none;touch-action:manipulation;
    transition:left .22s ease, right .22s ease, background .15s;}
  .pTab:hover{background:rgba(90,110,170,.7);}
  #pTabL{left:0;border-right:1px solid rgba(120,140,200,.35);}
  #pTabR{right:0;border-left:1px solid rgba(120,140,200,.35);}
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
    tab.textContent = isL ? (open ? '◂' : '▸') : (open ? '▸' : '◂');
    // 펼치면 바가 패널 가장자리에 붙어 따라간다
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
