/* ============================================================
   WebCAD 슬라이드 패널 — 사용자 피드백 ④
   왼쪽 도구창(#toolbar)·오른쪽 상태창(#side)을 자동 숨김 슬라이드로.
   · 가장자리 팝업 버튼에 커서를 올리면 → 스르륵 펼쳐짐
   · 패널 위에 커서가 있는 동안 유지, 벗어나면 다시 숨음
   · 팝업 버튼 클릭 = 고정(항상 펼침) ↔ 해제 토글 (localStorage 기억)
   ============================================================ */
(() => {
'use strict';
const main = document.getElementById('main');
const left = document.getElementById('toolbar');
const right = document.getElementById('side');
if (!main || (!left && !right)) return;
const KEY = 'webcad_panels';
const pin = { l: false, r: false };
try { Object.assign(pin, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) {}

const css = document.createElement('style');
css.textContent = `
  #main{position:relative;}
  .rz{display:none !important;}                 /* 폭 조절 손잡이 → 접기/펼치기 버튼으로 대체 */
  #toolbar{position:absolute;left:0;top:0;bottom:0;z-index:26;margin:0;
    transform:translateX(-102%);transition:transform .22s ease;box-shadow:4px 0 18px rgba(0,0,0,.35);}
  #toolbar.pOpen{transform:none;}
  #side{position:absolute;right:0;top:0;bottom:0;z-index:26;margin:0;
    transform:translateX(102%);transition:transform .22s ease;box-shadow:-4px 0 18px rgba(0,0,0,.35);}
  #side.pOpen{transform:none;}
  .pTab{position:absolute;top:50%;margin-top:-34px;z-index:27;width:22px;height:68px;
    display:flex;align-items:center;justify-content:center;
    background:rgba(22,33,60,.92);border:1px solid rgba(120,140,200,.45);color:#cfe0ff;
    cursor:pointer;font-size:13px;user-select:none;touch-action:manipulation;
    transition:left .22s ease, right .22s ease, background .15s;}
  .pTab:hover{background:rgba(42,84,176,.85);}
  .pTab.pinned{color:#5ad1ff;border-color:#5ad1ff;}
  #pTabL{left:0;border-radius:0 10px 10px 0;border-left:none;}
  #pTabR{right:0;border-radius:10px 0 0 10px;border-right:none;}
`;
document.head.appendChild(css);

function mkTab(id, panel, sideKey) {
  if (!panel) return null;
  const tab = document.createElement('div');
  tab.id = id; tab.className = 'pTab';
  tab.title = '올리면 펼침 · 클릭하면 고정/해제';
  main.appendChild(tab);
  let closeTimer = null;
  const isL = sideKey === 'l';
  const refresh = () => {
    const open = panel.classList.contains('pOpen');
    tab.textContent = isL ? (open ? '◂' : '▸') : (open ? '▸' : '◂');
    tab.classList.toggle('pinned', pin[sideKey]);
    // 열리면 탭이 패널 가장자리에 붙어 따라간다
    const w = panel.getBoundingClientRect().width;
    if (isL) tab.style.left = open ? w + 'px' : '0';
    else tab.style.right = open ? w + 'px' : '0';
  };
  const setOpen = (o) => {
    panel.classList.toggle('pOpen', o);
    refresh();
    window.dispatchEvent(new Event('resize'));
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    if (pin[sideKey]) return;
    closeTimer = setTimeout(() => setOpen(false), 260);
  };
  const cancelClose = () => clearTimeout(closeTimer);
  tab.addEventListener('pointerenter', () => { cancelClose(); setOpen(true); });
  tab.addEventListener('pointerleave', scheduleClose);
  panel.addEventListener('pointerenter', cancelClose);
  panel.addEventListener('pointerleave', scheduleClose);
  tab.addEventListener('click', () => {              // 클릭 = 고정 토글 (터치는 이걸로 열고 닫는다)
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
