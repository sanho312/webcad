/* ============================================================
   WebCAD — 브라우저 기반 2D CAD / DXF 편집기
   순수 JavaScript. 외부 의존성 없음.
   좌표계: 월드 좌표는 DXF 규약(Y 위쪽). 화면은 Y 아래쪽 → 변환 처리.
   ============================================================ */

(() => {
'use strict';

// ---------- DOM ----------
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const wrap = document.getElementById('canvasWrap');
const coordsEl = document.getElementById('coords');
const hintEl = document.getElementById('hint');
const statEl = document.getElementById('stat');

// ---------- 상태 ----------
const state = {
  entities: [],          // {id,type,layer,color, ...geom}
  layers: [],            // {name,color,visible}
  currentLayer: '0',
  currentColor: null,    // null = 레이어색(ByLayer), 아니면 '#rrggbb'
  tool: 'select',
  view: { x: 0, y: 0, scale: 1 },   // x,y = 화면 중앙이 가리키는 월드좌표
  levels: [{ name: '1F', elev: 0 }], // 층 목록 (BIM 다층)
  curLv: 0,                          // 현재 작업 층
  ghostLv: true,                     // 다른 층을 흐리게 표시(참조용)
  grid: { show: true, size: 10 },
  ortho: false,          // 직교 모드(F8): 기준점 대비 수평/수직 고정
  selection: new Set(),
  textHeight: 10,
  nextId: 1,
  blocks: {},            // 블록 정의: name -> { entities:[...상대좌표 도형] }
  views: {},             // 저장된 뷰: name -> {x,y,scale}
};

// 작도 중 임시 상태
let draft = null;       // 현재 그리는 중인 도형
let pts = [];           // 폴리라인 등 다중 클릭 점
let mouseWorld = { x: 0, y: 0 };
let mouseScreen = { x: 0, y: 0 };
let isPanning = false, panStart = null;
let dragSelect = null;  // 영역 선택 박스
let moveOp = null;      // 이동 작업
let cmdOp = null;       // 수정 명령(offset/copy/mirror/rotate/array) 상태 머신
let previewEnts = null; // 명령 실행 전 미리보기 도형들
let offsetDist = 10;    // 마지막 사용 오프셋 거리
let filletRadius = 0;   // 모깎기 반지름
let chamferDist = 10;   // 모따기 거리
let polygonSides = 6;   // 다각형 변 개수
let lengthenDelta = 10; // 길이조정 증감량(±)
let hatchSpacing = 5;   // 해치 간격
// ---------- 사용자 설정 (단위·객체스냅·단축키) — localStorage 유지 ----------
const SETTINGS_KEY = 'webcad_settings_v1';
let settings = {
  units: 'mm',
  osnapModes: { endpoint: true, midpoint: true, center: true, perp: true, nearest: true, intersection: true },
  polar: 0,      // 폴라 트래킹 각도(0=끄기, 15/30/45/90)
  dim: { txt: 0, dec: 2, suffix: false }, // 치수: 문자높이(0=그리기설정 따름)·소수자릿수·단위표시
  bim: { wallH: 2700, wallT: 200, slabT: 150, colH: 2700, doorW: 900, doorH: 2100, winW: 1500, winH: 1200, winSill: 900, roofRise: 1200, stairW: 1200, stairRiser: 180 }, // BIM 기본값(mm)
  aliases: {},   // 사용자 단축키: { 입력값: 도구명 }
};
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) { settings.units = s.units || 'mm'; Object.assign(settings.osnapModes, s.osnapModes || {}); settings.polar = s.polar || 0; settings.aliases = s.aliases || {}; Object.assign(settings.dim, s.dim || {}); Object.assign(settings.bim, s.bim || {}); }
  } catch (e) {}
})();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  if (window.WEBCAD_API && WEBCAD_API.onSettingsChange) WEBCAD_API.onSettingsChange(); // 클라우드 동기화 훅
}

let currentFileName = null; // 현재 작업 파일명 (null = 새 파일)
let currentFileLoc = null;  // 'pc'(실제 파일 핸들) | 'download' | null
let fileHandle = null;      // File System Access API 핸들 (크롬/엣지 — 같은 파일에 덮어쓰기 저장)
function setFileName(n, loc) {
  currentFileName = n || null;
  if (loc !== undefined) currentFileLoc = currentFileName ? loc : null;
  const el = document.getElementById('fileName');
  if (el) el.innerHTML = escapeHtml(currentFileName || '새 파일') +
    (currentFileName && currentFileLoc
      ? `<span class="floc">${currentFileLoc === 'pc' ? '— 내 PC (저장 시 덮어쓰기)' : '— 다운로드/파일 앱'}</span>` : '');
  document.title = (currentFileName ? currentFileName + ' — ' : '') + 'WebCAD — DXF 편집기';
  if (typeof renderDocTabs === 'function' && typeof docs !== 'undefined' && docs.length) renderDocTabs();
}
let lastCommand = '';   // 직전에 실행한 명령(스페이스/Enter로 반복)
let lastInputWasTouch = false; // 터치 입력 중에는 명령행 자동 포커스(키보드 팝업) 억제
let osnapEnabled = true;   // 객체 스냅(OSNAP) 사용 여부
let activeSnap = null;     // 현재 스냅된 점 {x,y,type}
let trackPt = null;        // 스냅 추적 기준점(마지막 획득 스냅)
let otrackAlign = null;    // 'x' | 'y' | 'xy' — 추적 정렬 활성

// ---------- 실행취소 스택 ----------
const undoStack = [], redoStack = [];
function snapshot() {
  return JSON.stringify({
    entities: state.entities, layers: state.layers,
    currentLayer: state.currentLayer, nextId: state.nextId, blocks: state.blocks,
  });
}
let apiRev = 0; // 변경 카운터 (클라우드 자동저장의 dirty 판단용)
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; apiRev++; if (typeof autosave === 'function') autosave(); }
function restore(snap) {
  apiRev++; // undo/redo도 모델 변경으로 집계 (3D 라이브 갱신·클라우드 미저장 표시)
  const d = JSON.parse(snap);
  state.entities = d.entities; state.layers = d.layers;
  state.currentLayer = d.currentLayer; state.nextId = d.nextId; state.blocks = d.blocks || {};
  state.selection.clear();
  renderLayers(); if (typeof refreshBlockList === 'function') refreshBlockList(); draw(); updateStat();
  if (typeof autosave === 'function') autosave();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

// ---------- 좌표 변환 ----------
function resize() {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = r.width * dpr; cv.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cv._w = r.width; cv._h = r.height;
  draw();
}
function worldToScreen(wx, wy) {
  return {
    x: (wx - state.view.x) * state.view.scale + cv._w / 2,
    y: -(wy - state.view.y) * state.view.scale + cv._h / 2,
  };
}
function screenToWorld(sx, sy) {
  return {
    x: (sx - cv._w / 2) / state.view.scale + state.view.x,
    y: -(sy - cv._h / 2) / state.view.scale + state.view.y,
  };
}

// ---------- 스냅 ----------
// 직교(Ortho) 모드 — 현재 작업의 기준점 대비 수평/수직으로 고정
function orthoBase() {
  if (pts.length) return pts[pts.length - 1];                       // 폴리라인: 직전 점
  if (draft && state.tool === 'line') return { x: draft.x1, y: draft.y1 }; // 선: 시작점
  if (moveOp) return moveOp.base;                                   // 이동/복사
  if (cmdOp && cmdOp.base) return cmdOp.base;                       // 수정 명령(복사 등)
  return null;
}
function applyOrtho(p, b) {
  const dx = p.x - b.x, dy = p.y - b.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: b.y } : { x: b.x, y: p.y };
}
// 커서 월드좌표 = 객체 스냅(OSNAP) 우선 → 없으면 그리드 스냅 + 직교 보정
function cursorPoint(raw) {
  activeSnap = findObjectSnap(raw);
  if (activeSnap) { trackPt = { x: activeSnap.x, y: activeSnap.y }; otrackAlign = null; return { x: activeSnap.x, y: activeSnap.y }; }
  // 객체 스냅 추적: 마지막 스냅점의 수평/수직선에 커서 정렬
  otrackAlign = null;
  if (osnapEnabled && trackPt) {
    const tolW = 8 / state.view.scale;
    const ax = Math.abs(raw.x - trackPt.x) <= tolW, ay = Math.abs(raw.y - trackPt.y) <= tolW;
    if (ax && ay) { otrackAlign = 'xy'; return { x: trackPt.x, y: trackPt.y }; }
    if (ax) { otrackAlign = 'x'; return { x: trackPt.x, y: raw.y }; }
    if (ay) { otrackAlign = 'y'; return { x: raw.x, y: trackPt.y }; }
  }
  let p = { x: raw.x, y: raw.y };
  const b = orthoBase();
  if (b) {
    if (state.ortho) p = applyOrtho(p, b);
    else if (settings.polar > 0) { // 폴라 트래킹: 기준점 대비 각도를 설정 단위로 스냅
      const dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy);
      if (d > 1e-9) {
        const step = settings.polar * Math.PI / 180;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        p = { x: b.x + d * Math.cos(a), y: b.y + d * Math.sin(a) };
      }
    }
  }
  return p;
}
function toggleOrtho() {
  state.ortho = !state.ortho;
  const b = document.getElementById('btnOrtho');
  if (b) b.classList.toggle('active', state.ortho);
  if (typeof hint === 'function') hint(state.ortho ? '직교 모드 ON — 수평·수직 고정 (F8)' : '직교 모드 OFF (F8)');
  draw();
}
function toggleOsnap() {
  osnapEnabled = !osnapEnabled;
  if (!osnapEnabled) activeSnap = null;
  const b = document.getElementById('btnOsnap');
  if (b) b.classList.toggle('active', osnapEnabled);
  if (typeof hint === 'function') hint(osnapEnabled ? '객체 스냅 ON — 끝점·중점·중심·근처 (F3)' : '객체 스냅 OFF (F3)');
  draw();
}

// ---------- 레이어 ----------
function getLayer(name) { return state.layers.find(l => l.name === name); }
function ensureLayer(name, color) {
  let l = getLayer(name);
  if (!l) { l = { name, color: color || '#ffffff', visible: true }; state.layers.push(l); }
  return l;
}
// 화이트 모드에서 밝은 잉크(흰색 등)는 안 보이므로 어둡게 매핑 (DXF 저장에는 영향 없음 — 원본 색 별도 사용)
function themedInk(c) {
  if (!document.documentElement.classList.contains('light')) return c;
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return c;
  const r = parseInt(c.slice(1, 3), 16) / 255, g = parseInt(c.slice(3, 5), 16) / 255, b = parseInt(c.slice(5, 7), 16) / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (L < 0.8) return c;
  if (c.toLowerCase() === '#ffffff') return '#1a1d29';
  const d = (v) => Math.round(v * 255 * 0.45).toString(16).padStart(2, '0');
  return '#' + d(r) + d(g) + d(b);
}
function entityColor(e) {
  const raw = e.color || ((getLayer(e.layer) || {}).color) || '#ffffff';
  return themedInk(raw);
}
// 선종류: 이름 → 월드 단위 dash 패턴. 화면 스케일 반영해 픽셀 배열 반환(null=실선)
const LINETYPES = {
  continuous: null,
  dashed: [6, 3], hidden: [4, 3], center: [12, 3, 3, 3], phantom: [16, 3, 3, 3, 3, 3], dot: [1, 3],
};
const LINETYPE_KO = { continuous: '실선', dashed: '파선', hidden: '숨은선', center: '중심선(일점쇄선)', phantom: '가상선(이점쇄선)', dot: '점선' };
function entityLineType(e) {
  const lt = e.linetype || (getLayer(e.layer) || {}).linetype || 'continuous';
  return LINETYPES[lt] === undefined ? 'continuous' : lt;
}
function entityDash(e) {
  const pat = LINETYPES[entityLineType(e)];
  if (!pat) return null;
  const s = state.view.scale, ltscale = state.ltscale || 1;
  return pat.map(v => Math.max(0.5, v * ltscale * s * 0.5));
}
function entityLineWeight(e) {
  const lw = (e.lineweight != null) ? e.lineweight : ((getLayer(e.layer) || {}).lineweight);
  if (lw == null || lw < 0) return 1.4;          // 기본
  return Math.max(0.5, lw / 100 * state.view.scale * 3.5); // mm → 화면 픽셀(대략)
}

// ---------- 도형 생성 ----------
function addEntity(e) {
  e.id = state.nextId++;
  e.layer = e.layer || state.currentLayer;
  if (state.currentColor) e.color = state.currentColor;
  e.lv = state.curLv || 0; // 생성 시점의 층에 귀속
  { // 3D 뷰에서 작업면을 올려놓고 그리면 그 높이에 생성 (레이캐스팅 교점의 z)
    const ov3 = typeof v3 !== 'undefined' && v3 && document.getElementById('bim3d');
    if (ov3 && ov3.style.display !== 'none' && v3.cplane != null && Math.abs(v3.cplane - lvElev()) > 0.5 && !e.bim)
      e.zo = v3.cplane - lvElev();
  }
  state.entities.push(e);
  return e;
}
// 현재 층 요소인가 (lv 없는 옛 도형 = 1층)
function onLv(e) { return (e.lv || 0) === (state.curLv || 0); }
function lvElev() { return (state.levels[state.curLv] || { elev: 0 }).elev; }

// ============================================================
//  렌더링
// ============================================================
function draw() {
  const W = cv._w, H = cv._h;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getCSS('--canvas-bg');
  ctx.fillRect(0, 0, W, H);

  if (state.grid.show) drawGrid();
  drawAxes();

  // 뷰포트 컬링: 화면 밖 도형은 그리지 않음 (대형 도면 성능)
  const vtl = screenToWorld(0, 0), vbr = screenToWorld(W, H);
  const vxmin = Math.min(vtl.x, vbr.x), vxmax = Math.max(vtl.x, vbr.x);
  const vymin = Math.min(vtl.y, vbr.y), vymax = Math.max(vtl.y, vbr.y);
  const cull = state.entities.length > 300;
  for (const pass of [0, 1]) // 0: 밑그림 이미지 먼저(항상 바닥), 1: 나머지
  for (const e of state.entities) {
    if ((e.type === 'IMAGE') !== (pass === 0)) continue;
    const l = getLayer(e.layer);
    if (l && !l.visible) continue;
    if (cull) { const bb = entityBBox(e); if (bb && (bb.xmax < vxmin || bb.xmin > vxmax || bb.ymax < vymin || bb.ymin > vymax)) continue; }
    if (!onLv(e)) { // 다른 층: 흐리게(참조) 또는 숨김
      if (state.ghostLv && e.type !== 'IMAGE') { ctx.save(); ctx.globalAlpha = 0.15; drawEntity(e, false); ctx.restore(); }
      continue;
    }
    if (e.type === 'MESH') { drawMeshOverlay(e); continue; } // 메시는 윗면 윤곽만
    if (e.bim && e.bim.kind !== 'opening') drawBimOverlay(e); // 벽 밴드는 도형선 아래
    drawEntity(e, state.selection.has(e.id));
    if (e.bim && e.bim.kind === 'opening') drawBimOverlay(e);  // 개구부는 도형선 위
  }

  // 작도 미리보기
  if (draft) drawEntity(draft, false, true);
  if (pts.length) drawDraftPolyline();
  if (previewEnts) for (const e of previewEnts) drawEntity({ layer: '0', ...e }, false, true);

  // 플롯 영역 지정 미리보기
  if (state.tool === '_plotregion' && cmdOp && cmdOp.name === 'plotrgn') {
    const a = worldToScreen(cmdOp.p1.x, cmdOp.p1.y), b = worldToScreen(mouseWorld.x, mouseWorld.y);
    ctx.save(); ctx.strokeStyle = '#ffd65d'; ctx.fillStyle = 'rgba(255,214,93,.10)'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore();
  }

  // STRETCH 걸침 영역 박스
  if (cmdOp && cmdOp.name === 'stretch' && (cmdOp.step === 'c2' || cmdOp.box)) {
    const c1 = cmdOp.c1, c2 = cmdOp.box ? { x: cmdOp.box.xmax, y: cmdOp.box.ymax } : mouseWorld;
    const p1 = cmdOp.box ? { x: cmdOp.box.xmin, y: cmdOp.box.ymin } : c1;
    if (c1) {
      const a = worldToScreen(p1.x, p1.y), b = worldToScreen(c2.x, c2.y);
      ctx.save(); ctx.strokeStyle = '#6ad28a'; ctx.fillStyle = 'rgba(106,210,138,.10)';
      ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
    }
  }

  // 영역 선택 박스
  if (dragSelect) {
    ctx.save();
    const crossing = dragSelect.x2 < dragSelect.x1; // 오→왼 = 크로싱(초록 점선), 왼→오 = 윈도우(파랑 실선)
    if (crossing) { ctx.strokeStyle = '#30d158'; ctx.fillStyle = 'rgba(48,209,88,.12)'; ctx.setLineDash([5, 4]); }
    else { ctx.strokeStyle = '#0A84FF'; ctx.fillStyle = 'rgba(41,151,255,.14)'; ctx.setLineDash([]); }
    ctx.lineWidth = 1;
    const a = worldToScreen(dragSelect.x1, dragSelect.y1);
    const b = worldToScreen(dragSelect.x2, dragSelect.y2);
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.restore();
  }

  // 커서 십자선
  drawCursor();
}

function drawGrid() {
  const W = cv._w, H = cv._h;
  let g = state.grid.size;
  // 화면에서 그리드 간격이 너무 촘촘하면 배수로 키움
  while (g * state.view.scale < 8) g *= 5;
  const tl = screenToWorld(0, 0), br = screenToWorld(W, H);
  const minX = Math.floor(tl.x / g) * g, maxX = Math.ceil(br.x / g) * g;
  const minY = Math.floor(br.y / g) * g, maxY = Math.ceil(tl.y / g) * g;
  ctx.save();
  ctx.lineWidth = 1;
  for (let x = minX; x <= maxX; x += g) {
    const s = worldToScreen(x, 0);
    ctx.strokeStyle = (Math.round(x / g) % 5 === 0) ? getCSS('--grid2') : getCSS('--grid');
    ctx.beginPath(); ctx.moveTo(s.x, 0); ctx.lineTo(s.x, H); ctx.stroke();
  }
  for (let y = minY; y <= maxY; y += g) {
    const s = worldToScreen(0, y);
    ctx.strokeStyle = (Math.round(y / g) % 5 === 0) ? getCSS('--grid2') : getCSS('--grid');
    ctx.beginPath(); ctx.moveTo(0, s.y); ctx.lineTo(W, s.y); ctx.stroke();
  }
  ctx.restore();
}

function drawAxes() {
  ctx.save();
  const o = worldToScreen(0, 0);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,80,80,.5)';  // X
  ctx.beginPath(); ctx.moveTo(0, o.y); ctx.lineTo(cv._w, o.y); ctx.stroke();
  ctx.strokeStyle = 'rgba(80,255,120,.5)'; // Y
  ctx.beginPath(); ctx.moveTo(o.x, 0); ctx.lineTo(o.x, cv._h); ctx.stroke();
  ctx.restore();
}

function drawCursor() {
  const s = worldToScreen(mouseWorld.x, mouseWorld.y);
  ctx.save();
  ctx.strokeStyle = document.documentElement.classList.contains('light') ? 'rgba(20,30,60,.4)' : 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(s.x, 0); ctx.lineTo(s.x, cv._h);
  ctx.moveTo(0, s.y); ctx.lineTo(cv._w, s.y);
  ctx.stroke();
  ctx.restore();
  if (otrackAlign && trackPt) { // 스냅 추적선(주황 점선)
    const tp = worldToScreen(trackPt.x, trackPt.y);
    ctx.save(); ctx.strokeStyle = 'rgba(255,170,60,.8)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(tp.x, tp.y); ctx.lineTo(s.x, s.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(tp.x - 4, tp.y); ctx.lineTo(tp.x + 4, tp.y); ctx.moveTo(tp.x, tp.y - 4); ctx.lineTo(tp.x, tp.y + 4); ctx.stroke();
    ctx.restore();
  }
  if (activeSnap) drawSnapMarker(s, activeSnap.type);
}

// OSNAP 표식: 끝점=□, 중점=△, 중심=○, 근처=✕
function drawSnapMarker(s, type) {
  ctx.save();
  ctx.strokeStyle = '#2ee6a6'; ctx.lineWidth = 1.8; ctx.setLineDash([]);
  const r = 7;
  if (type === 'endpoint') {
    ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
  } else if (type === 'midpoint') {
    ctx.beginPath(); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); ctx.closePath(); ctx.stroke();
  } else if (type === 'center') {
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
  } else if (type === 'perp') { // 수직: 직각 기호 ⊐
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.lineTo(s.x + r, s.y + r); // ㄴ
    ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x, s.y); ctx.lineTo(s.x, s.y + r);                 // 안쪽 직각 표시
    ctx.stroke();
  } else if (type === 'intersect') { // 교차: ✕
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
    ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
    ctx.stroke();
  } else { // nearest: 모래시계(⧗)
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
    ctx.lineTo(s.x + r, s.y + r); ctx.closePath();
    ctx.stroke();
  }
  ctx.fillStyle = '#2ee6a6'; ctx.font = '11px "Segoe UI",sans-serif'; ctx.textBaseline = 'bottom';
  ctx.fillText(SNAP_KO[type], s.x + r + 3, s.y - r);
  ctx.restore();
}

function drawEntity(e, selected, preview) {
  ctx.save();
  const lw = entityLineWeight(e);
  ctx.lineWidth = selected ? Math.max(2, lw) : lw;
  ctx.strokeStyle = selected ? '#0A84FF' : entityColor(e);
  ctx.fillStyle = ctx.strokeStyle;
  const dash = entityDash(e);
  if (preview) { ctx.globalAlpha = .8; ctx.setLineDash([5, 4]); }
  else if (dash && e.type !== 'TEXT' && e.type !== 'HATCH') ctx.setLineDash(dash);

  switch (e.type) {
    case 'LINE': {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      break;
    }
    case 'LWPOLYLINE': {
      ctx.beginPath();
      e.points.forEach((p, i) => {
        const s = worldToScreen(p[0], p[1]);
        i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y);
      });
      if (e.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'CIRCLE': {
      const c = worldToScreen(e.cx, e.cy);
      ctx.beginPath(); ctx.arc(c.x, c.y, e.r * state.view.scale, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case 'ARC': {
      const c = worldToScreen(e.cx, e.cy);
      // DXF 각도는 반시계, 화면은 Y가 뒤집혀 시계 → start/end 부호 변환
      const a1 = -e.endAngle * Math.PI / 180;
      const a2 = -e.startAngle * Math.PI / 180;
      ctx.beginPath(); ctx.arc(c.x, c.y, e.r * state.view.scale, a1, a2); ctx.stroke();
      break;
    }
    case 'TEXT': {
      const p = worldToScreen(e.x, e.y);
      const h = e.height * state.view.scale;
      ctx.font = `${h}px "Segoe UI",sans-serif`;
      ctx.textBaseline = 'alphabetic';
      if (e.rotation) { // 화면 Y가 뒤집혀 있으므로 회전 부호 반전
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-e.rotation * Math.PI / 180);
        ctx.fillText(e.text, 0, 0); ctx.restore();
      } else ctx.fillText(e.text, p.x, p.y);
      break;
    }
    case 'HATCH': {
      const b = e.boundary;
      const path = () => {
        ctx.beginPath();
        if (b.kind === 'circle') { const c = worldToScreen(b.cx, b.cy); ctx.arc(c.x, c.y, b.r * state.view.scale, 0, Math.PI * 2); }
        else { b.points.forEach((p, i) => { const s = worldToScreen(p[0], p[1]); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.closePath(); }
      };
      if (e.pattern === 'solid') { path(); const ga = ctx.globalAlpha; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = ga; }
      else {
        const hs = hatchSegments(e);
        ctx.beginPath();
        for (const s of hs.segs) { const A = worldToScreen(s[0], s[1]), B = worldToScreen(s[2], s[3]); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); }
        ctx.stroke();
        for (const dp of hs.dots) { const P = worldToScreen(dp[0], dp[1]); ctx.fillRect(P.x - 1.2, P.y - 1.2, 2.4, 2.4); }
      }
      if (selected && !preview) { path(); ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]); }
      break;
    }
    case 'IMAGE': {
      if (!e._img) {
        const im = new Image(); im.src = e.src;
        Object.defineProperty(e, '_img', { value: im, configurable: true, writable: true, enumerable: false });
        im.onload = () => draw();
      }
      if (e._img.complete && e._img.naturalWidth) {
        const tl = worldToScreen(e.x, e.y + e.h);
        const ga = ctx.globalAlpha; ctx.globalAlpha = preview ? 0.4 : 0.9;
        ctx.drawImage(e._img, tl.x, tl.y, e.w * state.view.scale, e.h * state.view.scale);
        ctx.globalAlpha = ga;
      }
      if (selected && !preview) {
        const tl = worldToScreen(e.x, e.y + e.h);
        ctx.setLineDash([4, 3]); ctx.strokeRect(tl.x, tl.y, e.w * state.view.scale, e.h * state.view.scale); ctx.setLineDash([]);
      }
      break;
    }
    case 'INSERT': {
      ctx.restore();
      for (const c of insertChildren(e)) drawEntity(c, false, preview); // 자식은 각자 색/선종류
      ctx.save(); ctx.strokeStyle = '#0A84FF';
      if (selected && !preview) { // 삽입점 X 마커 + 경계
        const p = worldToScreen(e.x, e.y);
        ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(p.x - 5, p.y); ctx.lineTo(p.x + 5, p.y); ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x, p.y + 5); ctx.stroke();
        const bb = insertBBox(e), a = worldToScreen(bb.xmin, bb.ymax), c2 = worldToScreen(bb.xmax, bb.ymin);
        ctx.setLineDash([4, 3]); ctx.strokeRect(a.x, a.y, c2.x - a.x, c2.y - a.y); ctx.setLineDash([]);
      }
      break;
    }
  }

  // 선택 시 그립 표시
  if (selected && !preview) {
    ctx.setLineDash([]); ctx.fillStyle = '#0A84FF';
    for (const g of entityGrips(e)) {
      const s = worldToScreen(g.x, g.y);
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    if (e.type === 'LWPOLYLINE') { // 세그먼트 중점: 속 빈 그립(클릭=정점 추가)
      ctx.strokeStyle = '#0A84FF'; ctx.lineWidth = 1.2;
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) {
        const s = worldToScreen((p[i][0] + p[(i + 1) % n][0]) / 2, (p[i][1] + p[(i + 1) % n][1]) / 2);
        ctx.strokeRect(s.x - 2.6, s.y - 2.6, 5.2, 5.2);
      }
    }
  }
  ctx.restore();
}

function drawDraftPolyline() {
  ctx.save();
  ctx.strokeStyle = '#0A84FF'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  pts.forEach((p, i) => { const s = worldToScreen(p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
  const m = worldToScreen(mouseWorld.x, mouseWorld.y);
  ctx.lineTo(m.x, m.y); ctx.stroke();
  ctx.restore();
}

function entityGrips(e) {
  switch (e.type) {
    case 'LINE': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case 'LWPOLYLINE': return e.points.map(p => ({ x: p[0], y: p[1] }));
    case 'CIRCLE': case 'ARC': return [{ x: e.cx, y: e.cy }];
    case 'TEXT': return [{ x: e.x, y: e.y }];
    case 'HATCH': return e.boundary.kind === 'circle' ? [{ x: e.boundary.cx, y: e.boundary.cy }] : e.boundary.points.map(p => ({ x: p[0], y: p[1] }));
    case 'INSERT': return [{ x: e.x, y: e.y }];
    case 'IMAGE': return [{ x: e.x, y: e.y }];
  }
  return [];
}

// ============================================================
//  히트 테스트(선택)
// ============================================================
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function isLocked(e) { const l = getLayer(e.layer); return !!(l && l.locked); }
function hitTest(w, tolWorld) {
  // 뒤에서부터(위에 그려진 것 우선). 잠긴 레이어는 선택 불가
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const e = state.entities[i];
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue;
    if (!onLv(e)) continue; // 다른 층은 선택 불가
    if (entityHit(e, w, tolWorld)) return e;
  }
  return null;
}
// 픽 전용: 화면 8px 허용오차로 스냅점·원시점 모두 검사(스냅된 도형도 잘 잡히도록)
function pick(w, rawW) {
  const tol = 8 / state.view.scale;
  return hitTest(rawW, tol) || hitTest(w, tol);
}
function entityHit(e, w, tol) {
  switch (e.type) {
    case 'LINE': return distToSeg(w.x, w.y, e.x1, e.y1, e.x2, e.y2) <= tol;
    case 'LWPOLYLINE': {
      for (let i = 0; i < e.points.length - 1; i++)
        if (distToSeg(w.x, w.y, e.points[i][0], e.points[i][1], e.points[i + 1][0], e.points[i + 1][1]) <= tol) return true;
      if (e.closed && e.points.length > 1) {
        const a = e.points[e.points.length - 1], b = e.points[0];
        if (distToSeg(w.x, w.y, a[0], a[1], b[0], b[1]) <= tol) return true;
      }
      return false;
    }
    case 'CIRCLE': return Math.abs(Math.hypot(w.x - e.cx, w.y - e.cy) - e.r) <= tol;
    case 'ARC': {
      const d = Math.abs(Math.hypot(w.x - e.cx, w.y - e.cy) - e.r);
      if (d > tol) return false;
      let ang = Math.atan2(w.y - e.cy, w.x - e.cx) * 180 / Math.PI;
      if (ang < 0) ang += 360;
      let s = e.startAngle, en = e.endAngle;
      if (en < s) en += 360;
      let a = ang; if (a < s) a += 360;
      return a >= s && a <= en;
    }
    case 'TEXT': {
      const w2 = e.height * 0.6 * e.text.length;
      return w.x >= e.x - tol && w.x <= e.x + w2 + tol && w.y >= e.y - tol && w.y <= e.y + e.height + tol;
    }
    case 'HATCH': return pointInBoundary(e.boundary, w.x, w.y); // 내부 클릭 = 선택
    case 'IMAGE': return w.x >= e.x && w.x <= e.x + e.w && w.y >= e.y && w.y <= e.y + e.h;
    case 'INSERT': {
      if (Math.hypot(w.x - e.x, w.y - e.y) <= tol) return true; // 삽입점
      for (const c of insertChildren(e)) if (entityHit(c, w, tol)) return true;
      return false;
    }
  }
  return false;
}
function entityInBox(e, x1, y1, x2, y2) {
  const xmin = Math.min(x1, x2), xmax = Math.max(x1, x2);
  const ymin = Math.min(y1, y2), ymax = Math.max(y1, y2);
  const inside = (x, y) => x >= xmin && x <= xmax && y >= ymin && y <= ymax;
  for (const g of entityGrips(e)) if (!inside(g.x, g.y)) return false;
  return entityGrips(e).length > 0;
}

// ---------- 윈도우/크로싱 선택용 경계 계산 ----------
function entityBBox(e) {
  switch (e.type) {
    case 'LINE': return { xmin: Math.min(e.x1, e.x2), xmax: Math.max(e.x1, e.x2), ymin: Math.min(e.y1, e.y2), ymax: Math.max(e.y1, e.y2) };
    case 'LWPOLYLINE': {
      const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1]);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
    }
    case 'CIRCLE': return { xmin: e.cx - e.r, xmax: e.cx + e.r, ymin: e.cy - e.r, ymax: e.cy + e.r };
    case 'ARC': {
      const pts = [ptOnArc(e, e.startAngle), ptOnArc(e, e.endAngle)];
      for (const a of [0, 90, 180, 270]) if (angleInArc(a, e.startAngle, e.endAngle)) pts.push(ptOnArc(e, a));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
    }
    case 'TEXT': { const w = (e.text ? e.text.length : 0) * e.height * 0.6; return { xmin: e.x, xmax: e.x + w, ymin: e.y, ymax: e.y + e.height }; }
    case 'HATCH': return boundaryBBox(e.boundary);
    case 'INSERT': return insertBBox(e);
    case 'IMAGE': return { xmin: e.x, ymin: e.y, xmax: e.x + e.w, ymax: e.y + e.h };
    case 'MESH': return meshBBox(e);
  }
  return null;
}
// 윈도우 선택: 객체 전체가 박스 안에
function entityFullyInBox(e, b) {
  const bb = entityBBox(e);
  return bb && bb.xmin >= b.xmin && bb.xmax <= b.xmax && bb.ymin >= b.ymin && bb.ymax <= b.ymax;
}
// 크로싱 선택: 객체가 박스에 걸치거나 들어옴
function entityCrossesBox(e, b) {
  if (e.type === 'HATCH') { const bb = entityBBox(e); return !(bb.xmax < b.xmin || bb.xmin > b.xmax || bb.ymax < b.ymin || bb.ymin > b.ymax); }
  const inB = (x, y) => x >= b.xmin && x <= b.xmax && y >= b.ymin && y <= b.ymax;
  const edges = [[b.xmin, b.ymin, b.xmax, b.ymin], [b.xmax, b.ymin, b.xmax, b.ymax], [b.xmax, b.ymax, b.xmin, b.ymax], [b.xmin, b.ymax, b.xmin, b.ymin]];
  const segHitsBox = (x1, y1, x2, y2) => {
    if (inB(x1, y1) || inB(x2, y2)) return true;
    for (const ed of edges) { const r = segSeg([x1, y1], [x2, y2], [ed[0], ed[1]], [ed[2], ed[3]]); if (r && r.t >= 0 && r.t <= 1 && r.u >= 0 && r.u <= 1) return true; }
    return false;
  };
  if (e.type === 'LINE' || e.type === 'LWPOLYLINE') {
    for (const sg of entitySegments(e)) if (segHitsBox(sg[0], sg[1], sg[2], sg[3])) return true;
    return false;
  }
  if (e.type === 'CIRCLE' || e.type === 'ARC') {
    for (const pt of entityEndpoints(e)) if (inB(pt.x, pt.y)) return true; // 호 끝점이 안에
    for (const ed of edges) {
      for (const h of segCircle([ed[0], ed[1]], [ed[2], ed[3]], e.cx, e.cy, e.r)) {
        if (h.t < 0 || h.t > 1) continue;
        if (e.type === 'ARC' && !angleInArc(ang(e.cx, e.cy, h.x, h.y), e.startAngle, e.endAngle)) continue;
        return true;
      }
    }
    return false;
  }
  if (e.type === 'TEXT') { const bb = entityBBox(e); return !(bb.xmax < b.xmin || bb.xmin > b.xmax || bb.ymax < b.ymin || bb.ymin > b.ymax); }
  return false;
}

// ============================================================
//  객체 스냅 (OSNAP) — 끝점 / 중점 / 중심 / 근처점
// ============================================================
function closestOnSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}
function entityEndpoints(e) {
  switch (e.type) {
    case 'LINE': return [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }];
    case 'LWPOLYLINE': return e.points.map(p => ({ x: p[0], y: p[1] }));
    case 'ARC': { const a = ptOnArc(e, e.startAngle), b = ptOnArc(e, e.endAngle); return [a, b]; }
    case 'TEXT': return [{ x: e.x, y: e.y }];
  }
  return [];
}
function entityMidpoints(e) {
  switch (e.type) {
    case 'LINE': return [{ x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 }];
    case 'LWPOLYLINE': {
      const out = [], p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) { const a = p[i], b = p[(i + 1) % n]; out.push({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }); }
      return out;
    }
    case 'ARC': { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; return [ptOnArc(e, (s + en) / 2)]; }
  }
  return [];
}
function nearestOnEntity(e, w) {
  switch (e.type) {
    case 'LINE': return closestOnSeg(w.x, w.y, e.x1, e.y1, e.x2, e.y2);
    case 'LWPOLYLINE': {
      let best = null, bd = Infinity, p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) { const c = closestOnSeg(w.x, w.y, p[i][0], p[i][1], p[(i + 1) % n][0], p[(i + 1) % n][1]); const d = Math.hypot(c.x - w.x, c.y - w.y); if (d < bd) { bd = d; best = c; } }
      return best;
    }
    case 'CIRCLE': { const a = Math.atan2(w.y - e.cy, w.x - e.cx); return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }
    case 'ARC': {
      let deg = ang(e.cx, e.cy, w.x, w.y);
      if (!angleInArc(deg, e.startAngle, e.endAngle)) { // 호 범위 밖이면 가까운 끝점
        const a = ptOnArc(e, e.startAngle), b = ptOnArc(e, e.endAngle);
        return Math.hypot(a.x - w.x, a.y - w.y) < Math.hypot(b.x - w.x, b.y - w.y) ? a : b;
      }
      return ptOnArc(e, deg);
    }
  }
  return null;
}
// 커서(mouseScreen) 근처의 최적 스냅점을 찾음. 우선순위: 끝점>중점>중심>근처
function entitySegments(e) {
  if (e.type === 'LINE') return [[e.x1, e.y1, e.x2, e.y2]];
  if (e.type === 'LWPOLYLINE') {
    const out = [], p = e.points, n = p.length, segN = e.closed ? n : n - 1;
    for (let i = 0; i < segN; i++) out.push([p[i][0], p[i][1], p[(i + 1) % n][0], p[(i + 1) % n][1]]);
    return out;
  }
  return [];
}
function perpFoot(bx, by, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  const t = ((bx - x1) * dx + (by - y1) * dy) / len2;
  return { x: x1 + t * dx, y: y1 + t * dy, t };
}
function findObjectSnap(raw) {
  if (!osnapEnabled) return null;
  const tol = 12;
  const skipSel = !!moveOp; // 이동 중에는 자기 자신에 스냅 방지
  let best = null;
  const consider = (x, y, type, prio) => {
    const s = worldToScreen(x, y);
    const d = Math.hypot(s.x - mouseScreen.x, s.y - mouseScreen.y);
    if (d <= tol && (!best || prio < best.prio || (prio === best.prio && d < best.d))) best = { x, y, type, prio, d };
  };
  const base = orthoBase(); // 수직점 계산 기준점(작도 시작점 등)
  // 그리는 중인 도형의 자기 점들에도 스냅 (폴리라인 닫기, 시작점 복귀 등)
  if (settings.osnapModes.endpoint) {
    for (const p of pts) consider(p.x, p.y, 'endpoint', 1);
    if (draft && draft.type === 'LINE') consider(draft.x1, draft.y1, 'endpoint', 1);
  }
  let perp = null, perpD = Infinity;
  const preTol = tol / state.view.scale * 1.5; // bbox 프리체크(대형 도면 성능)
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (!onLv(e)) continue; // 다른 층에는 스냅하지 않음
    if (skipSel && state.selection.has(e.id)) continue;
    if (state.entities.length > 300) {
      const bb = entityBBox(e);
      if (bb && (raw.x < bb.xmin - preTol || raw.x > bb.xmax + preTol || raw.y < bb.ymin - preTol || raw.y > bb.ymax + preTol)) continue;
    }
    if (settings.osnapModes.endpoint) for (const g of entityEndpoints(e)) consider(g.x, g.y, 'endpoint', 1);
    if (settings.osnapModes.midpoint) for (const m of entityMidpoints(e)) consider(m.x, m.y, 'midpoint', 2);
    if (settings.osnapModes.center && (e.type === 'CIRCLE' || e.type === 'ARC')) consider(e.cx, e.cy, 'center', 3);
    // 수직점(perpendicular): 기준점에서 도형으로 내린 수선의 발. 커서가 그 도형 위에 있을 때 제공
    if (base && settings.osnapModes.perp) {
      for (const sg of entitySegments(e)) {
        const np = closestOnSeg(raw.x, raw.y, sg[0], sg[1], sg[2], sg[3]);
        const sn = worldToScreen(np.x, np.y);
        const dCur = Math.hypot(sn.x - mouseScreen.x, sn.y - mouseScreen.y);
        if (dCur > tol) continue;
        const f = perpFoot(base.x, base.y, sg[0], sg[1], sg[2], sg[3]);
        if (f && f.t >= -1e-9 && f.t <= 1 + 1e-9 && dCur < perpD) { perpD = dCur; perp = { x: f.x, y: f.y }; }
      }
    }
    const np = settings.osnapModes.nearest ? nearestOnEntity(e, raw) : null;
    if (np) consider(np.x, np.y, 'nearest', 5);
  }
  // 교차점: 커서 근처 도형쌍의 실제 교차 계산 (근처 도형만 골라 저비용)
  if (settings.osnapModes.intersection) {
    const tolW = tol / state.view.scale, near = [];
    for (const e of state.entities) {
      if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(e.type)) continue;
      const l = getLayer(e.layer); if (l && !l.visible) continue;
      if (skipSel && state.selection.has(e.id)) continue;
      const bb = entityBBox(e); if (!bb) continue;
      if (raw.x < bb.xmin - tolW || raw.x > bb.xmax + tolW || raw.y < bb.ymin - tolW || raw.y > bb.ymax + tolW) continue;
      near.push(e); if (near.length > 12) break;
    }
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++)
      for (const pt of intersectEntities(near[i], near[j])) consider(pt[0], pt[1], 'intersect', 1);
  }
  // 우선순위: 끝점·중점·중심·교차 > 수직점 > 근처점
  if (best && best.prio <= 3) return best;
  if (perp) return { x: perp.x, y: perp.y, type: 'perp' };
  return best;
}
// 두 도형의 교차점 목록
function intersectEntities(A, B) {
  const out = [];
  const segsA = entitySegments(A), segsB = entitySegments(B);
  const isCirc = e => e.type === 'CIRCLE' || e.type === 'ARC';
  const onArc = (e, x, y) => e.type !== 'ARC' || angleInArc(ang(e.cx, e.cy, x, y), e.startAngle, e.endAngle);
  if (segsA.length && segsB.length) {
    for (const a of segsA) for (const b of segsB) {
      const r = segSeg([a[0], a[1]], [a[2], a[3]], [b[0], b[1]], [b[2], b[3]]);
      if (r && r.t >= -1e-9 && r.t <= 1 + 1e-9 && r.u >= -1e-9 && r.u <= 1 + 1e-9) out.push([r.x, r.y]);
    }
  } else if (segsA.length && isCirc(B)) {
    for (const a of segsA) for (const h of segCircle([a[0], a[1]], [a[2], a[3]], B.cx, B.cy, B.r))
      if (h.t >= -1e-9 && h.t <= 1 + 1e-9 && onArc(B, h.x, h.y)) out.push([h.x, h.y]);
  } else if (isCirc(A) && segsB.length) {
    return intersectEntities(B, A);
  } else if (isCirc(A) && isCirc(B)) {
    const d = Math.hypot(B.cx - A.cx, B.cy - A.cy);
    if (d > 1e-9 && d <= A.r + B.r && d >= Math.abs(A.r - B.r)) {
      const aa = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
      const hh = Math.sqrt(Math.max(0, A.r * A.r - aa * aa));
      const mx = A.cx + aa * (B.cx - A.cx) / d, my = A.cy + aa * (B.cy - A.cy) / d;
      const ox = -(B.cy - A.cy) / d * hh, oy = (B.cx - A.cx) / d * hh;
      for (const p of [[mx + ox, my + oy], [mx - ox, my - oy]])
        if (onArc(A, p[0], p[1]) && onArc(B, p[0], p[1])) out.push(p);
    }
  }
  return out;
}
const SNAP_KO = { endpoint: '끝점', midpoint: '중점', center: '중심', perp: '수직', nearest: '근처', intersect: '교차' };

// ============================================================
//  이동
// ============================================================
function translateEntity(e, dx, dy) {
  switch (e.type) {
    case 'LINE': e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; break;
    case 'LWPOLYLINE': e.points = e.points.map(p => [p[0] + dx, p[1] + dy]); break;
    case 'CIRCLE': case 'ARC': e.cx += dx; e.cy += dy; break;
    case 'TEXT': e.x += dx; e.y += dy; break;
    case 'HATCH': {
      const b = e.boundary;
      if (b.kind === 'circle') { b.cx += dx; b.cy += dy; }
      else b.points = b.points.map(p => [p[0] + dx, p[1] + dy]);
      hatchDirty(e); break;
    }
    case 'INSERT': e.x += dx; e.y += dy; break;
    case 'IMAGE': e.x += dx; e.y += dy; break;
  }
}

// ---------- 변환(transform) 헬퍼 : copy / mirror / rotate / array 공통 ----------
function cloneEntity(e) { const c = JSON.parse(JSON.stringify(e)); delete c.id; return c; }
function ptOnArc(e, deg) { const a = deg * Math.PI / 180; return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }

// ---------- 다각형/타원/면적 헬퍼 ----------
function polygonPoints(cx, cy, r, n, rot) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = rot + i * 2 * Math.PI / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
function ellipsePoints(cx, cy, rx, ry, n) {
  n = n || 64; const out = [];
  for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}
function polyArea(ptsArr) { // shoelace, [[x,y],...]
  let s = 0; const n = ptsArr.length;
  for (let i = 0; i < n; i++) { const a = ptsArr[i], b = ptsArr[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
function polyPerimeter(ptsArr, closed) {
  let s = 0; const n = ptsArr.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = ptsArr[i], b = ptsArr[(i + 1) % n]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
  return s;
}
function fmtNum(n) { const d = (settings.dim && settings.dim.dec != null) ? settings.dim.dec : 2; return (+n.toFixed(d)).toString(); }
// 치수 문자용: 값 + (옵션) 단위 접미
function dimVal(n) { return fmtNum(n) + ((settings.dim && settings.dim.suffix) ? settings.units : ''); }
// 치수 문자 높이: 치수 설정이 있으면 그 값, 없으면 그리기 설정의 문자 높이
function dimTH() { return (settings.dim && settings.dim.txt > 0) ? settings.dim.txt : state.textHeight; }

function T_translate(dx, dy) { return { type: 'translate', pt: (x, y) => [x + dx, y + dy] }; }
function T_rotate(cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { type: 'rotate', deg, pt: (x, y) => { const dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; } };
}
function T_mirror(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
  const axisDeg = Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    type: 'mirror', axisDeg,
    pt: (x, y) => { const t = ((x - ax) * dx + (y - ay) * dy) / len2; const px = ax + t * dx, py = ay + t * dy; return [2 * px - x, 2 * py - y]; }
  };
}
// 강체 변환(translate/rotate/mirror)을 도형에 적용. 반지름·문자높이는 보존.
function applyTransform(e, T) {
  switch (e.type) {
    case 'LINE': [e.x1, e.y1] = T.pt(e.x1, e.y1); [e.x2, e.y2] = T.pt(e.x2, e.y2); break;
    case 'LWPOLYLINE': e.points = e.points.map(p => T.pt(p[0], p[1])); break;
    case 'CIRCLE': [e.cx, e.cy] = T.pt(e.cx, e.cy); break;
    case 'ARC': {
      const ps = ptOnArc(e, e.startAngle), pe = ptOnArc(e, e.endAngle);
      [e.cx, e.cy] = T.pt(e.cx, e.cy);
      const ns = T.pt(ps.x, ps.y), nps = T.pt(pe.x, pe.y);
      if (T.type === 'mirror') { // 반사는 방향(반시계)을 뒤집으므로 시작/끝 교환
        e.startAngle = ang(e.cx, e.cy, nps[0], nps[1]);
        e.endAngle = ang(e.cx, e.cy, ns[0], ns[1]);
      } else {
        e.startAngle = ang(e.cx, e.cy, ns[0], ns[1]);
        e.endAngle = ang(e.cx, e.cy, nps[0], nps[1]);
      }
      break;
    }
    case 'TEXT': {
      [e.x, e.y] = T.pt(e.x, e.y);
      if (T.type === 'rotate') e.rotation = (e.rotation || 0) + T.deg;
      else if (T.type === 'mirror') e.rotation = 2 * T.axisDeg - (e.rotation || 0);
      break;
    }
    case 'HATCH': {
      const b = e.boundary;
      if (b.kind === 'circle') [b.cx, b.cy] = T.pt(b.cx, b.cy);
      else b.points = b.points.map(p => T.pt(p[0], p[1]));
      hatchDirty(e); break;
    }
    case 'INSERT': {
      [e.x, e.y] = T.pt(e.x, e.y);
      if (T.type === 'rotate') e.rot = (e.rot || 0) + T.deg;
      else if (T.type === 'mirror') { e.sx = -(e.sx != null ? e.sx : 1); e.rot = 2 * T.axisDeg - (e.rot || 0); } // 미러: X배율 반전 + 회전 반사
      break;
    }
  }
  return e;
}
function transformedClone(e, T) { return applyTransform(cloneEntity(e), T); }
function selectedEntities() { return [...state.selection].map(id => state.entities.find(x => x.id === id)).filter(Boolean); }

// ---------- 블록(INSERT) ----------
// INSERT 인스턴스의 자식 도형을 월드좌표로 전개(축척·회전 적용). 렌더·히트·내보내기 공용.
function insertChildren(e) {
  const def = state.blocks[e.name];
  if (!def) return [];
  const sx = e.sx != null ? e.sx : 1, sy = e.sy != null ? e.sy : 1, rot = e.rot || 0;
  const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const sc = Math.sqrt(Math.abs(sx * sy));
  const pt = (x, y) => { const px = x * sx, py = y * sy; return [px * ca - py * sa + e.x, px * sa + py * ca + e.y]; };
  const dirAngle = (deg) => { const t = deg * Math.PI / 180, vx = Math.cos(t) * sx, vy = Math.sin(t) * sy; return Math.atan2(vx * sa + vy * ca, vx * ca - vy * sa) * 180 / Math.PI; };
  const out = [];
  for (const src of def.entities) {
    const c = cloneEntity(src); c.layer = c.layer || e.layer;
    switch (c.type) {
      case 'LINE': [c.x1, c.y1] = pt(c.x1, c.y1); [c.x2, c.y2] = pt(c.x2, c.y2); break;
      case 'LWPOLYLINE': c.points = c.points.map(p => pt(p[0], p[1])); break;
      case 'CIRCLE': [c.cx, c.cy] = pt(c.cx, c.cy); c.r *= sc; break;
      case 'ARC': { [c.cx, c.cy] = pt(c.cx, c.cy); c.r *= sc; let s = dirAngle(c.startAngle), en = dirAngle(c.endAngle); if (sx * sy < 0) { const t = s; s = en; en = t; } c.startAngle = s; c.endAngle = en; break; }
      case 'TEXT': [c.x, c.y] = pt(c.x, c.y); c.height *= sc; c.rotation = (c.rotation || 0) + rot; break;
      case 'HATCH': { const b = c.boundary; if (b.kind === 'circle') { [b.cx, b.cy] = pt(b.cx, b.cy); b.r *= sc; } else b.points = b.points.map(p => pt(p[0], p[1])); c.spacing = (c.spacing || 5) * sc; break; }
    }
    out.push(c);
  }
  return out;
}
function insertBBox(e) {
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const c of insertChildren(e)) { const bb = entityBBox(c); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); mxx = Math.max(mxx, bb.xmax); mxy = Math.max(mxy, bb.ymax); } }
  if (!isFinite(mnx)) return { xmin: e.x, ymin: e.y, xmax: e.x, ymax: e.y };
  return { xmin: mnx, ymin: mny, xmax: mxx, ymax: mxy };
}

// ---------- 오프셋(간격복사) ----------
function lineLineIntersect(p1, d1, p2, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-9) return null; // 평행
  const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
  return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
function offsetEntity(e, dist, side) {
  switch (e.type) {
    case 'LINE': {
      const dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; // 왼쪽 법선
      const s = ((side.x - e.x1) * nx + (side.y - e.y1) * ny) >= 0 ? 1 : -1;
      const ox = s * dist * nx, oy = s * dist * ny;
      return { ...cloneEntity(e), x1: e.x1 + ox, y1: e.y1 + oy, x2: e.x2 + ox, y2: e.y2 + oy };
    }
    case 'CIRCLE': case 'ARC': {
      const d = Math.hypot(side.x - e.cx, side.y - e.cy);
      const nr = d > e.r ? e.r + dist : e.r - dist;
      if (nr <= 1e-6) return null;
      return { ...cloneEntity(e), r: nr };
    }
    case 'LWPOLYLINE': return offsetPolyline(e, dist, side);
  }
  return null; // TEXT 등은 오프셋 대상 아님
}
function offsetPolyline(e, dist, side) {
  const pts = e.points, n = pts.length, closed = e.closed;
  if (n < 2) return null;
  const segCount = closed ? n : n - 1;
  // 가장 가까운 세그먼트로 오프셋 방향(부호) 결정
  let best = Infinity, bestI = 0;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = distToSeg(side.x, side.y, a[0], a[1], b[0], b[1]);
    if (d < best) { best = d; bestI = i; }
  }
  const a0 = pts[bestI], b0 = pts[(bestI + 1) % n];
  const ldx = b0[0] - a0[0], ldy = b0[1] - a0[1], llen = Math.hypot(ldx, ldy) || 1;
  const nx0 = -ldy / llen, ny0 = ldx / llen;
  const sign = ((side.x - a0[0]) * nx0 + (side.y - a0[1]) * ny0) >= 0 ? 1 : -1;
  const off = sign * dist;
  // 각 세그먼트의 오프셋 직선(점+방향)
  const lines = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    lines.push({ p: [a[0] + off * nx, a[1] + off * ny], d: [dx, dy] });
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    let prevSeg, curSeg;
    if (closed) { prevSeg = (i - 1 + segCount) % segCount; curSeg = i % segCount; }
    else {
      if (i === 0) { const L = lines[0]; out.push([L.p[0], L.p[1]]); continue; }
      if (i === n - 1) { const L = lines[segCount - 1]; out.push([L.p[0] + L.d[0], L.p[1] + L.d[1]]); continue; }
      prevSeg = i - 1; curSeg = i;
    }
    const L1 = lines[prevSeg], L2 = lines[curSeg];
    const ip = lineLineIntersect(L1.p, L1.d, L2.p, L2.d);
    out.push(ip || [L2.p[0], L2.p[1]]);
  }
  return { ...cloneEntity(e), points: out };
}

// ============================================================
//  교차(intersection) 헬퍼  — trim / extend / fillet 공통
// ============================================================
function norm360(a) { return ((a % 360) + 360) % 360; }
function angleInArc(a, s, e) {
  a = norm360(a); s = norm360(s); e = norm360(e);
  if (s <= e) return a >= s - 1e-6 && a <= e + 1e-6;
  return a >= s - 1e-6 || a <= e + 1e-6;
}
// 선분 ab 와 선분 cd 의 교차. {t,u,x,y} (t: ab 매개변수, u: cd 매개변수). 평행이면 null.
function segSeg(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return { t, u, x: a[0] + t * rx, y: a[1] + t * ry };
}
// 선분 ab 와 원(cx,cy,r) 교차. [{t,x,y}...]
function segCircle(a, b, cx, cy, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - cx, fy = a[1] - cy;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < 0 || A < 1e-12) return [];
  disc = Math.sqrt(disc);
  const out = [];
  for (const t of [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) out.push({ t, x: a[0] + t * dx, y: a[1] + t * dy });
  return out;
}
// 다른 엔티티 o 가 선분 a→b 를 교차하는 t 값들(0..1)
function lineCutsFromEntity(a, b, o) {
  const ts = [];
  if (o.type === 'LINE') {
    const r = segSeg(a, b, [o.x1, o.y1], [o.x2, o.y2]);
    if (r && r.u >= -1e-9 && r.u <= 1 + 1e-9) ts.push(r.t);
  } else if (o.type === 'LWPOLYLINE') {
    const p = o.points, n = p.length, segN = o.closed ? n : n - 1;
    for (let i = 0; i < segN; i++) {
      const r = segSeg(a, b, p[i], p[(i + 1) % n]);
      if (r && r.u >= -1e-9 && r.u <= 1 + 1e-9) ts.push(r.t);
    }
  } else if (o.type === 'CIRCLE' || o.type === 'ARC') {
    for (const h of segCircle(a, b, o.cx, o.cy, o.r)) {
      if (o.type === 'ARC' && !angleInArc(ang(o.cx, o.cy, h.x, h.y), o.startAngle, o.endAngle)) continue;
      ts.push(h.t);
    }
  }
  return ts;
}

// ============================================================
//  TRIM (자르기)
// ============================================================
function trimLine(line, clickW, edges) {
  const a = [line.x1, line.y1], b = [line.x2, line.y2];
  const cuts = [];
  for (const o of (edges || state.entities)) {
    if (o === line) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    for (const t of lineCutsFromEntity(a, b, o)) if (t > 1e-4 && t < 1 - 1e-4) cuts.push(t);
  }
  if (!cuts.length) { logLine('  자를 경계(교차)가 없습니다.', 'warn'); return false; }
  cuts.sort((x, y) => x - y);
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy || 1;
  let tc = ((clickW.x - a[0]) * dx + (clickW.y - a[1]) * dy) / len2;
  tc = Math.max(0, Math.min(1, tc));
  const bounds = [0, ...cuts, 1];
  let lo = 0, hi = 1;
  for (let i = 0; i < bounds.length - 1; i++) if (tc >= bounds[i] && tc <= bounds[i + 1]) { lo = bounds[i]; hi = bounds[i + 1]; break; }
  const P = t => [a[0] + t * dx, a[1] + t * dy];
  if (lo <= 1e-4) { const p = P(hi); line.x1 = p[0]; line.y1 = p[1]; }
  else if (hi >= 1 - 1e-4) { const p = P(lo); line.x2 = p[0]; line.y2 = p[1]; }
  else { // 가운데 → 둘로 분할
    const pHi = P(hi), pLo = P(lo);
    const seg2 = cloneEntity(line); seg2.x1 = pHi[0]; seg2.y1 = pHi[1];
    line.x2 = pLo[0]; line.y2 = pLo[1];
    addEntity(seg2);
  }
  return true;
}
function trimCircleArc(e, clickW, edges) {
  const angs = [];
  for (const o of (edges || state.entities)) {
    if (o === e) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    let hits = [];
    if (o.type === 'LINE') hits = segCircle([o.x1, o.y1], [o.x2, o.y2], e.cx, e.cy, e.r).filter(h => h.t >= -1e-9 && h.t <= 1 + 1e-9);
    else if (o.type === 'LWPOLYLINE') { const p = o.points, n = p.length, sN = o.closed ? n : n - 1; for (let i = 0; i < sN; i++) hits = hits.concat(segCircle(p[i], p[(i + 1) % n], e.cx, e.cy, e.r).filter(h => h.t >= -1e-9 && h.t <= 1 + 1e-9)); }
    else if (o.type === 'CIRCLE' || o.type === 'ARC') { // 원-원 교차
      const d = Math.hypot(o.cx - e.cx, o.cy - e.cy);
      if (d > 1e-9 && d <= e.r + o.r && d >= Math.abs(e.r - o.r)) {
        const aa = (e.r * e.r - o.r * o.r + d * d) / (2 * d);
        const hh = Math.sqrt(Math.max(0, e.r * e.r - aa * aa));
        const mx = e.cx + aa * (o.cx - e.cx) / d, my = e.cy + aa * (o.cy - e.cy) / d;
        const ox = -(o.cy - e.cy) / d * hh, oy = (o.cx - e.cx) / d * hh;
        hits = [{ x: mx + ox, y: my + oy }, { x: mx - ox, y: my - oy }];
      }
    }
    for (const h of hits) {
      const ag = ang(e.cx, e.cy, h.x, h.y);
      if (e.type === 'ARC' && !angleInArc(ag, e.startAngle, e.endAngle)) continue;
      angs.push(ag);
    }
  }
  if (e.type === 'CIRCLE' && angs.length < 2) { logLine('  원을 자르려면 교차가 2개 이상 필요합니다.', 'warn'); return false; }
  if (e.type === 'ARC' && angs.length < 1) { logLine('  자를 경계가 없습니다.', 'warn'); return false; }
  const ca = ang(e.cx, e.cy, clickW.x, clickW.y);
  let bounds;
  if (e.type === 'CIRCLE') bounds = angs.map(norm360).sort((a, b) => a - b);
  else bounds = [norm360(e.startAngle), ...angs.map(norm360), norm360(e.endAngle)].sort((a, b) => a - b);
  // ca 를 포함하는 (lo,hi) CCW 구간 찾기
  const n = bounds.length;
  let found = null;
  for (let i = 0; i < n; i++) {
    let lo = bounds[i], hi = bounds[(i + 1) % n]; if (hi < lo) hi += 360;
    let c = ca < lo ? ca + 360 : ca;
    if (c >= lo && c <= hi) { found = { lo: norm360(lo), hi: norm360(bounds[(i + 1) % n]) }; break; }
  }
  if (!found) return false;
  e.type = 'ARC'; e.startAngle = found.hi; e.endAngle = found.lo; // 제거구간 [lo,hi] 의 보각
  return true;
}

// ============================================================
//  EXTEND (연장)
// ============================================================
function rayBoundaryHit(P0, dir, exclude) {
  const far = [P0[0] + dir[0] * 1e7, P0[1] + dir[1] * 1e7];
  let best = Infinity, bp = null;
  for (const o of state.entities) {
    if (o === exclude) continue; const l = getLayer(o.layer); if (l && !l.visible) continue;
    if (o.type === 'LINE') { const r = segSeg(P0, far, [o.x1, o.y1], [o.x2, o.y2]); if (r && r.t > 1e-6 && r.u >= -1e-9 && r.u <= 1 + 1e-9) { const d = r.t; if (d < best) { best = d; bp = [r.x, r.y]; } } }
    else if (o.type === 'LWPOLYLINE') { const p = o.points, n = p.length, sN = o.closed ? n : n - 1; for (let i = 0; i < sN; i++) { const r = segSeg(P0, far, p[i], p[(i + 1) % n]); if (r && r.t > 1e-6 && r.u >= 0 && r.u <= 1 && r.t < best) { best = r.t; bp = [r.x, r.y]; } } }
    else if (o.type === 'CIRCLE' || o.type === 'ARC') { for (const h of segCircle(P0, far, o.cx, o.cy, o.r)) { if (h.t <= 1e-6) continue; if (o.type === 'ARC' && !angleInArc(ang(o.cx, o.cy, h.x, h.y), o.startAngle, o.endAngle)) continue; if (h.t < best) { best = h.t; bp = [h.x, h.y]; } } }
  }
  return bp;
}
function extendLine(line, clickW) {
  const a = [line.x1, line.y1], b = [line.x2, line.y2];
  const da = Math.hypot(clickW.x - a[0], clickW.y - a[1]), db = Math.hypot(clickW.x - b[0], clickW.y - b[1]);
  const endA = da < db;
  const P0 = endA ? a : b, Po = endA ? b : a;
  let dir = [P0[0] - Po[0], P0[1] - Po[1]]; const dl = Math.hypot(dir[0], dir[1]) || 1; dir = [dir[0] / dl, dir[1] / dl];
  const hit = rayBoundaryHit(P0, dir, line);
  if (!hit) { logLine('  연장할 경계를 찾지 못했습니다.', 'warn'); return false; }
  if (endA) { line.x1 = hit[0]; line.y1 = hit[1]; } else { line.x2 = hit[0]; line.y2 = hit[1]; }
  return true;
}

// ============================================================
//  FILLET (모깎기)
// ============================================================
function lineInfIntersect(a, b, c, d) { // 무한 직선 교차점
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  return [a[0] + t * rx, a[1] + t * ry];
}
function doFillet(line1, line2, radius) {
  const a1 = [line1.x1, line1.y1], b1 = [line1.x2, line1.y2];
  const a2 = [line2.x1, line2.y1], b2 = [line2.x2, line2.y2];
  const C = lineInfIntersect(a1, b1, a2, b2);
  if (!C) { logLine('  두 선이 평행하여 모깎기할 수 없습니다.', 'warn'); return false; }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const far1 = dist(C, a1) > dist(C, b1) ? a1 : b1, near1 = far1 === a1 ? 'b' : 'a';
  const far2 = dist(C, a2) > dist(C, b2) ? a2 : b2, near2 = far2 === a2 ? 'b' : 'a';
  const setNear = (ln, key, p) => { if (key === 'a') { ln.x1 = p[0]; ln.y1 = p[1]; } else { ln.x2 = p[0]; ln.y2 = p[1]; } };
  let u1 = [far1[0] - C[0], far1[1] - C[1]]; let l1 = Math.hypot(u1[0], u1[1]) || 1; u1 = [u1[0] / l1, u1[1] / l1];
  let u2 = [far2[0] - C[0], far2[1] - C[1]]; let l2 = Math.hypot(u2[0], u2[1]) || 1; u2 = [u2[0] / l2, u2[1] / l2];
  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(dot);
  if (radius <= 0 || theta < 1e-4 || Math.abs(theta - Math.PI) < 1e-4) {
    setNear(line1, near1, C); setNear(line2, near2, C);
    return true;
  }
  const tanDist = radius / Math.tan(theta / 2);
  const t1 = [C[0] + u1[0] * tanDist, C[1] + u1[1] * tanDist];
  const t2 = [C[0] + u2[0] * tanDist, C[1] + u2[1] * tanDist];
  let bis = [u1[0] + u2[0], u1[1] + u2[1]]; const bl = Math.hypot(bis[0], bis[1]) || 1; bis = [bis[0] / bl, bis[1] / bl];
  const cen = [C[0] + bis[0] * radius / Math.sin(theta / 2), C[1] + bis[1] * radius / Math.sin(theta / 2)];
  setNear(line1, near1, t1); setNear(line2, near2, t2);
  let sa = ang(cen[0], cen[1], t1[0], t1[1]), ea = ang(cen[0], cen[1], t2[0], t2[1]);
  if (norm360(ea - sa) > 180) { const tmp = sa; sa = ea; ea = tmp; }
  addEntity({ type: 'ARC', layer: state.currentLayer, cx: cen[0], cy: cen[1], r: radius, startAngle: sa, endAngle: ea });
  return true;
}

// ============================================================
//  SCALE (배율)
// ============================================================
function scaleEntities(ents, base, f) {
  const sp = (x, y) => [base.x + (x - base.x) * f, base.y + (y - base.y) * f];
  const af = Math.abs(f); // 크기 속성은 부호 없는 배율(음수 반지름 등 방지)
  for (const e of ents) {
    switch (e.type) {
      case 'LINE': [e.x1, e.y1] = sp(e.x1, e.y1); [e.x2, e.y2] = sp(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points = e.points.map(p => sp(p[0], p[1])); break;
      case 'CIRCLE': case 'ARC': [e.cx, e.cy] = sp(e.cx, e.cy); e.r *= af; break;
      case 'TEXT': [e.x, e.y] = sp(e.x, e.y); e.height *= af; break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { [b.cx, b.cy] = sp(b.cx, b.cy); b.r *= af; }
        else b.points = b.points.map(p => sp(p[0], p[1]));
        e.spacing = (e.spacing || 5) * af; hatchDirty(e); break;
      }
      case 'INSERT': [e.x, e.y] = sp(e.x, e.y); e.sx = (e.sx != null ? e.sx : 1) * af; e.sy = (e.sy != null ? e.sy : 1) * af; break;
      case 'IMAGE': [e.x, e.y] = sp(e.x, e.y); e.w *= af; e.h *= af; break;
    }
  }
}

// ============================================================
//  STRETCH (신축)
// ============================================================
function stretchEntities(ents, box, dx, dy) {
  const inB = (x, y) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  for (const e of ents) {
    switch (e.type) {
      case 'LINE': if (inB(e.x1, e.y1)) { e.x1 += dx; e.y1 += dy; } if (inB(e.x2, e.y2)) { e.x2 += dx; e.y2 += dy; } break;
      case 'LWPOLYLINE': e.points = e.points.map(p => inB(p[0], p[1]) ? [p[0] + dx, p[1] + dy] : p); break;
      case 'CIRCLE': case 'ARC': if (inB(e.cx, e.cy)) { e.cx += dx; e.cy += dy; } break;
      case 'TEXT': if (inB(e.x, e.y)) { e.x += dx; e.y += dy; } break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { if (inB(b.cx, b.cy)) { b.cx += dx; b.cy += dy; hatchDirty(e); } }
        else { b.points = b.points.map(p => inB(p[0], p[1]) ? [p[0] + dx, p[1] + dy] : p); hatchDirty(e); }
        break;
      }
    }
  }
}
function entitiesTouchingBox(box) {
  const inB = (x, y) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  return state.entities.filter(e => {
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) return false;
    return entityGrips(e).some(g => inB(g.x, g.y));
  });
}

// ============================================================
//  마우스 / 입력
// ============================================================
cv.addEventListener('mousemove', (ev) => {
  const r = cv.getBoundingClientRect();
  mouseScreen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
  const raw = screenToWorld(mouseScreen.x, mouseScreen.y);
  mouseWorld = cursorPoint(raw);
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)} ${settings.units}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');

  if (isPanning && panStart) {
    const dx = (ev.clientX - panStart.sx) / state.view.scale;
    const dy = (ev.clientY - panStart.sy) / state.view.scale;
    state.view.x = panStart.vx - dx;
    state.view.y = panStart.vy + dy;
  }
  if (dragSelect) { dragSelect.x2 = raw.x; dragSelect.y2 = raw.y; }
  if (moveOp) {
    moveOp.dx = mouseWorld.x - moveOp.base.x; moveOp.dy = mouseWorld.y - moveOp.base.y;
    if (moveOp.grip) updateGripMove();
  }
  if (draft) updateDraft();
  if (cmdOp || state.tool === 'insert') updateCmdPreview();
  draw();
});

cv.addEventListener('mousedown', (ev) => {
  lastInputWasTouch = false;
  if (ev.button === 1 || (ev.button === 0 && ev.altKey) || (ev.button === 0 && state.tool === 'pan')) {  // 중간버튼/Alt/손 도구 = 팬
    isPanning = true;
    panStart = { sx: ev.clientX, sy: ev.clientY, vx: state.view.x, vy: state.view.y };
    ev.preventDefault(); return;
  }
  if (ev.button === 2) return; // 우클릭은 contextmenu에서 처리
  if (ev.button !== 0) return;
  handleClick(mouseWorld, screenToWorld(mouseScreen.x, mouseScreen.y), ev);
});

window.addEventListener('mouseup', (ev) => {
  if (isPanning) { isPanning = false; return; }
  if (dragSelect) finishDragSelect(ev);
  if (moveOp && state.tool === 'select') finishGripMoveMaybe();
});

// 우클릭/두 손가락 탭: 작도 중이면 완료/취소, 아니면 선택 도구로
function contextAction() {
  if (state.tool === 'trim' && cmdOp && cmdOp.name === 'trim') { trimSpaceAction(); return; } // 우클릭=Space
  if (pts.length) { finishPolyline(); }
  else if (draft) { cancelDraft(); }
  else { setTool('select'); }
}
cv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); contextAction(); });

// 더블클릭: 문자 편집 / 선택된 폴리라인의 정점 삭제
cv.addEventListener('dblclick', () => {
  if (state.tool !== 'select') return;
  const rW = screenToWorld(mouseScreen.x, mouseScreen.y), tol = 8 / state.view.scale;
  const hit = pick(mouseWorld, rW);
  if (hit && hit.type === 'TEXT') { // 문자 더블클릭 = 즉시 편집
    const nt = prompt('문자 내용:', hit.text);
    if (nt !== null && nt !== hit.text) { pushUndo(); hit.text = nt; logLine('  ✔ 문자 수정', 'ok'); renderProps(); draw(); }
    return;
  }
  if (!hit || hit.type !== 'LWPOLYLINE' || !state.selection.has(hit.id)) return;
  const g = nearGrip(hit, rW, tol) || nearGrip(hit, mouseWorld, tol);
  if (!g) return;
  const minPts = hit.closed ? 3 : 2;
  if (hit.points.length <= minPts) { logLine('  정점을 더 삭제할 수 없습니다.', 'warn'); return; }
  moveOp = null;
  pushUndo();
  hit.points.splice(g.index, 1);
  logLine('  ✔ 정점 삭제 (더블클릭)', 'ok');
  renderProps(); draw();
});

cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = screenToWorld(mouseScreen.x, mouseScreen.y);
  // 델타 크기에 비례한 부드러운 줌 (한 칸 ≈ ×1.06) — 트랙패드·고해상 휠 과민 반응 방지
  const factor = Math.pow(1.06, -(ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY) / 100);
  state.view.scale = Math.max(1e-4, Math.min(1e6, state.view.scale * factor));
  const after = screenToWorld(mouseScreen.x, mouseScreen.y);
  state.view.x += before.x - after.x;
  state.view.y += before.y - after.y;
  draw();
}, { passive: false });

// ============================================================
//  터치(모바일/태블릿) 입력
//  한 손가락 탭 = 클릭 · 한 손가락 드래그 = 화면 이동
//  두 손가락 = 확대/축소 + 이동 · 두 손가락 탭 = 완료/취소(우클릭)
// ============================================================
// 포인터 위치 갱신(마우스 이동과 동일한 미리보기 처리). 패닝/드래그선택 제외.
function setPointer(sx, sy) {
  mouseScreen = { x: sx, y: sy };
  const raw = screenToWorld(sx, sy);
  mouseWorld = cursorPoint(raw);
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)} ${settings.units}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');
  if (moveOp) { moveOp.dx = mouseWorld.x - moveOp.base.x; moveOp.dy = mouseWorld.y - moveOp.base.y; if (moveOp.grip) updateGripMove(); }
  if (draft) updateDraft();
  if (cmdOp || state.tool === 'insert') updateCmdPreview();
}
let touch = null;  // {mode:'tap'|'pan'|'pinch'|'twotap', ...}
function touchXY(t) { const r = cv.getBoundingClientRect(); return { x: t.clientX - r.left, y: t.clientY - r.top }; }
function touchMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
function touchDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

cv.addEventListener('touchstart', (ev) => {
  ev.preventDefault();
  lastInputWasTouch = true;
  if (ev.touches.length === 1) {
    const p = touchXY(ev.touches[0]);
    setPointer(p.x, p.y);
    touch = { mode: 'tap', sx: p.x, sy: p.y, sworld: screenToWorld(p.x, p.y), moved: 0, vx: state.view.x, vy: state.view.y };
    draw();
  } else if (ev.touches.length === 2) {
    const a = touchXY(ev.touches[0]), b = touchXY(ev.touches[1]);
    touch = { mode: 'pinch', startDist: touchDist(a, b) || 1, startScale: state.view.scale,
      mid: touchMid(a, b), vx: state.view.x, vy: state.view.y, moved: 0 };
  }
}, { passive: false });

cv.addEventListener('touchmove', (ev) => {
  ev.preventDefault();
  if (!touch) return;
  if (ev.touches.length === 1 && touch.mode !== 'pinch') {
    const p = touchXY(ev.touches[0]);
    touch.moved = Math.max(touch.moved, Math.hypot(p.x - touch.sx, p.y - touch.sy));
    // 한 손가락 드래그 = 화면 이동(팬). 선택은 탭으로, 박스 선택은 마우스/손도구로.
    if (touch.mode === 'tap' && touch.moved > 12) touch.mode = 'pan';
    if (touch.mode === 'pan') {
      const dx = (p.x - touch.sx) / state.view.scale;
      const dy = (p.y - touch.sy) / state.view.scale;
      state.view.x = touch.vx - dx;
      state.view.y = touch.vy + dy;
    }
    setPointer(p.x, p.y);
    draw();
  } else if (ev.touches.length === 2) {
    const a = touchXY(ev.touches[0]), b = touchXY(ev.touches[1]);
    const mid = touchMid(a, b), dist = touchDist(a, b);
    touch.moved = (touch.moved || 0) + Math.abs(dist - touch.startDist);
    // 중점 기준 확대/축소
    const before = screenToWorld(mid.x, mid.y);
    state.view.scale = Math.max(1e-4, Math.min(1e6, touch.startScale * (dist / touch.startDist)));
    const after = screenToWorld(mid.x, mid.y);
    state.view.x += before.x - after.x;
    state.view.y += before.y - after.y;
    // 중점 이동분만큼 팬
    if (touch.mid) {
      state.view.x -= (mid.x - touch.mid.x) / state.view.scale;
      state.view.y += (mid.y - touch.mid.y) / state.view.scale;
    }
    touch.mid = mid;
    draw();
  }
}, { passive: false });

cv.addEventListener('touchend', (ev) => {
  ev.preventDefault();
  if (!touch) return;
  if (touch.mode === 'tap' && touch.moved <= 12) {
    // 탭 = 클릭 (마우스 down+up 과 동일하게 정리)
    handleClick(mouseWorld, screenToWorld(mouseScreen.x, mouseScreen.y), { shiftKey: false });
    if (dragSelect) finishDragSelect({ shiftKey: false });
    if (moveOp && state.tool === 'select') finishGripMoveMaybe();
    // 치수 입력 가능 상태가 되면 이 탭(사용자 제스처) 안에서 즉시 포커스 → iOS 키보드 표시
    if (currentDimPrompt() && cmdInputEl) cmdInputEl.focus({ preventScroll: true });
  } else if (touch.mode === 'pinch' && touch.moved < 10 && ev.touches.length === 0) {
    // 두 손가락 가벼운 탭 = 우클릭(완료/취소)
    contextAction();
  }
  // 남은 손가락이 있으면 제스처 재설정
  if (ev.touches.length === 1) {
    const p = touchXY(ev.touches[0]);
    touch = { mode: 'pan', sx: p.x, sy: p.y, moved: 99, vx: state.view.x, vy: state.view.y };
  } else if (ev.touches.length === 0) {
    touch = null;
  }
}, { passive: false });

// 클릭 처리 (도구별)
function handleClick(w, rawW, ev) {
  if (state.tool === '_paste' && cmdOp && cmdOp.name === 'paste') { doPaste(w); return; }
  if (state.tool === '_plotregion') { // 플롯 영역 지정: 두 점
    if (!cmdOp || cmdOp.name !== 'plotrgn') { cmdOp = { name: 'plotrgn', p1: w }; setPrompt('플롯 영역: 반대 모서리를 클릭하세요.'); return; }
    const p1 = cmdOp.p1;
    plotRegion = { minX: Math.min(p1.x, w.x), minY: Math.min(p1.y, w.y), maxX: Math.max(p1.x, w.x), maxY: Math.max(p1.y, w.y) };
    cmdOp = null; const after = regionPickState && regionPickState.after; const prev = regionPickState ? regionPickState.prevTool : 'select';
    regionPickState = null; setTool(prev || 'select');
    logLine('  ✔ 플롯 영역 지정됨', 'info');
    if (after) after();
    return;
  }
  switch (state.tool) {
    case 'select': {
      const tol = 8 / state.view.scale;
      const hit = pick(w, rawW);
      if (hit) {
        // 그립(끝점 등) 클릭 → 그 점만 늘리기. 본체 클릭은 선택만(통째 이동 안 함)
        const wasSelected = state.selection.has(hit.id);
        const grip = nearGrip(hit, rawW, tol) || nearGrip(hit, w, tol);
        if (!ev.shiftKey && !wasSelected) { state.selection.clear(); }
        state.selection.add(hit.id);
        if (grip) { pushUndo(); moveOp = { gripEntity: hit, gripIndex: grip.index, base: w, dx: 0, dy: 0, grip: true }; }
        else if (wasSelected && hit.type === 'LWPOLYLINE') {
          // 선택된 폴리라인의 세그먼트 중점 그립 → 정점 삽입 후 드래그
          const mg = nearMidGrip(hit, rawW, tol) || nearMidGrip(hit, w, tol);
          if (mg) {
            pushUndo();
            hit.points.splice(mg.index + 1, 0, [w.x, w.y]);
            moveOp = { gripEntity: hit, gripIndex: mg.index + 1, base: w, dx: 0, dy: 0, grip: true };
            logLine('  ✔ 정점 추가 (드래그로 위치 조정)', 'ok');
          }
        }
        renderProps(); draw();
      } else {
        if (!ev.shiftKey) state.selection.clear();
        dragSelect = { x1: rawW.x, y1: rawW.y, x2: rawW.x, y2: rawW.y };
        renderProps(); draw();
      }
      break;
    }
    case 'line':
      if (!draft) { pushUndo(); draft = { type: 'LINE', x1: w.x, y1: w.y, x2: w.x, y2: w.y }; }
      else if (Math.hypot(w.x - draft.x1, w.y - draft.y1) > 1e-9) {
        draft.x2 = w.x; draft.y2 = w.y;
        commitDraft();                                   // 구간 확정
        pushUndo(); draft = { type: 'LINE', x1: w.x, y1: w.y, x2: w.x, y2: w.y }; // 끝점에서 이어 그리기
      }
      break;
    case 'pline':
      pts.push({ x: w.x, y: w.y });
      break;
    case 'rect':
      if (!draft) { pushUndo(); draft = { type: 'LWPOLYLINE', closed: true, points: [], _base: { x: w.x, y: w.y } }; }
      else { commitDraft(); }
      break;
    case 'circle':
      if (!draft) { pushUndo(); draft = { type: 'CIRCLE', cx: w.x, cy: w.y, r: 0 }; }
      else { commitDraft(); }
      break;
    case 'arc':
      handleArcClick(w);
      break;
    case 'text': {
      const t = prompt('문자 입력:', '');
      if (t) { pushUndo(); addEntity({ type: 'TEXT', x: w.x, y: w.y, height: state.textHeight, text: t, rotation: 0 }); updateStat(); }
      draw();
      break;
    }
    case 'move': {
      if (!moveOp) {
        // 이미 선택된 도형이 있으면 첫 클릭 = 기준점(빈 곳도 OK). 없으면 도형을 집어서 시작.
        if (!state.selection.size) { const hit = pick(w, rawW); if (hit) state.selection.add(hit.id); }
        if (state.selection.size) {
          pushUndo();
          moveOp = { entities: [...state.selection], base: w, dx: 0, dy: 0, twoClick: true };
          setPrompt('이동: 이동점을 클릭하거나 거리·좌표(@dx,dy / x,y / 거리)를 입력하세요.');
        }
      } else { // 두번째 클릭 = 이동 확정
        commitMove();
      }
      break;
    }
    case 'erase': {
      const hit = pick(w, rawW);
      if (hit) { pushUndo(); state.entities = state.entities.filter(e => e !== hit); state.selection.delete(hit.id); updateStat(); draw(); }
      break;
    }
    case 'offset': clickOffset(w, rawW); break;
    case 'copy': clickCopy(w, rawW); break;
    case 'mirror': clickMirror(w, rawW); break;
    case 'rotate': clickRotate(w, rawW); break;
    case 'array': clickArray(w, rawW); break;
    case 'trim': clickTrim(w, rawW); break;
    case 'extend': clickExtend(w, rawW); break;
    case 'fillet': clickFillet(w, rawW); break;
    case 'scale': clickScale(w, rawW); break;
    case 'stretch': clickStretch(w, rawW); break;
    case 'polygon': clickPolygon(w); break;
    case 'ellipse': clickEllipse(w); break;
    case 'chamfer': clickChamfer(w, rawW); break;
    case 'dim': clickDim(w); break;
    case 'dist': clickDist(w); break;
    case 'area': clickArea(w, rawW); break;
    case 'break': clickBreak(w, rawW); break;
    case 'lengthen': clickLengthen(w, rawW); break;
    case 'hatch': clickHatch(w, rawW); break;
    case 'insert': clickInsert(w); break;
    case 'matchprop': clickMatchprop(w, rawW); break;
    case 'dimrad': clickDimCircle(w, rawW, false); break;
    case 'dimdia': clickDimCircle(w, rawW, true); break;
    case 'dimang': clickDimAng(w, rawW); break;
    case 'divide': clickDivide(w, rawW); break;
    case 'measure': clickMeasure(w, rawW); break;
    case 'leader': clickLeader(w); break;
    case 'centerline': clickCenterline(w, rawW); break;
    case 'revcloud': clickRevcloud(w); break;
    case 'frame': clickFrame(w); break;
    case 'align': clickAlign(w, rawW); break;
    case 'xline': clickXline(w); break;
    case 'breakpt': clickBreakpt(w, rawW); break;
    case 'door': clickOpening(w, rawW, 'door'); break;
    case 'window': clickOpening(w, rawW, 'window'); break;
    case 'section': clickSection(w, false); break;
    case 'elevation': clickSection(w, true); break;
  }
  draw();
  // 명령 진행 중에는 명령행을 계속 활성 상태로 유지(치수 바로 입력). 터치는 키보드 팝업 방지로 제외.
  if (state.tool !== 'select' && cmdInputEl && !lastInputWasTouch) cmdInputEl.focus({ preventScroll: true });
}

// ====== 수정 명령: 선택 보장 헬퍼 ======
// 선택이 비어 있으면 클릭한 도형 하나를 잡고 false 반환(이번 클릭은 선택용으로 소비).
function ensureSelectionByClick(w, rawW) {
  if (state.selection.size) return true;
  const hit = pick(w, rawW);
  if (hit) { state.selection.add(hit.id); renderProps(); }
  return false;
}

// ====== OFFSET (간격복사) ======
function clickOffset(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'offset') cmdOp = { name: 'offset', step: 'select', target: null };
  if (cmdOp.step === 'select') {
    const hit = pick(w, rawW);
    if (hit) {
      if (hit.type === 'TEXT') { setPrompt('문자는 오프셋할 수 없습니다. 다른 도형을 선택하세요.'); return; }
      cmdOp.target = hit; cmdOp.step = 'side';
      state.selection.clear(); state.selection.add(hit.id); renderProps();
      setPrompt(`오프셋: 방향 쪽을 클릭하세요. (거리 ${offsetDist})`);
    }
  } else if (cmdOp.step === 'side') {
    const ne = offsetEntity(cmdOp.target, offsetDist, rawW);
    if (ne) { pushUndo(); addEntity(ne); logLine(`  ✔ 오프셋 거리 ${offsetDist}`, 'ok'); updateStat(); }
    cmdOp.step = 'select'; cmdOp.target = null;
    setPrompt(`오프셋: 도형을 선택하세요. (거리 ${offsetDist}, 숫자 입력으로 거리 변경)`);
  }
}

// ====== COPY (복사) ======
function clickCopy(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'copy') cmdOp = { name: 'copy', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    if (ensureSelectionByClick(w, rawW)) {} // 선택됨
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('복사: 기준점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'dest'; setPrompt('복사: 붙여넣을 위치를 클릭하세요. (반복 가능, Esc로 종료)'); return; }
  if (cmdOp.step === 'dest') {
    pushUndo();
    const T = T_translate(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 복사 ${ents.length}개`, 'ok');
    updateStat();
  }
}

// ====== MIRROR (대칭복사) ======
function clickMirror(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'mirror') cmdOp = { name: 'mirror', step: state.selection.size ? 'p1' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'p1'; setPrompt('대칭: 대칭축의 첫 점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('대칭: 대칭축의 두 번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') {
    pushUndo();
    const T = T_mirror(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y);
    const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 대칭복사 ${ents.length}개`, 'ok');
    updateStat();
    cmdOp = null; previewEnts = null;
    setTool('select');
  }
}

// ====== ROTATE (회전) ======
function clickRotate(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'rotate') cmdOp = { name: 'rotate', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('회전: 회전 중심(기준점)을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') {
    cmdOp.base = w; cmdOp.refAng = 0; cmdOp.step = 'angle';
    setPrompt('회전: 각도 지점을 클릭하거나 각도(°)를 입력하세요.');
    return;
  }
  if (cmdOp.step === 'angle') {
    const deg = ang(cmdOp.base.x, cmdOp.base.y, w.x, w.y);
    applyRotate(deg);
  }
}
function applyRotate(deg) {
  pushUndo();
  const T = T_rotate(cmdOp.base.x, cmdOp.base.y, deg);
  const ents = selectedEntities();
  for (const e of ents) applyTransform(e, T);
  logLine(`  ✔ 회전 ${(+deg).toFixed(1)}° (${ents.length}개)`, 'ok');
  cmdOp = null; previewEnts = null; renderProps(); updateStat();
  setTool('select');
}

// ====== ARRAY (배열) ======
function clickArray(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'array') {
    if (!state.selection.size) {
      const hit = pick(w, rawW);
      if (hit) { state.selection.add(hit.id); renderProps(); }
      if (!state.selection.size) { setPrompt('배열: 먼저 도형을 선택하세요.'); return; }
    }
    cmdOp = { name: 'array', step: 'dialog' };
    openArrayDialog();
    return;
  }
  if (cmdOp.step === 'center') { // 원형 배열 중심 클릭
    applyPolarArray(cmdOp.params, w);
    cmdOp = null; previewEnts = null; setTool('select');
  }
}
function applyRectArray(p) {
  pushUndo();
  const base = selectedEntities();
  for (let r = 0; r < p.rows; r++)
    for (let c = 0; c < p.cols; c++) {
      if (r === 0 && c === 0) continue;
      const T = T_translate(c * p.colSpace, r * p.rowSpace);
      for (const e of base) addEntity(transformedClone(e, T));
    }
  logLine(`  ✔ 직사각형 배열 ${p.rows}×${p.cols}`, 'ok');
  updateStat(); renderProps();
}
function applyPolarArray(p, center) {
  pushUndo();
  const base = selectedEntities();
  // 한 바퀴(360°)이거나 '끝각 제외'면 count로, 그 외 부채꼴은 count-1로 분할
  const full = Math.abs(Math.abs(p.total) - 360) < 0.01 || p.fill;
  const step = p.total / (full ? p.count : (p.count - 1 || 1));
  for (let k = 1; k < p.count; k++) {
    const T = T_rotate(center.x, center.y, step * k);
    for (const e of base) addEntity(transformedClone(e, T));
  }
  logLine(`  ✔ 원형 배열 ${p.count}개`, 'ok');
  updateStat(); renderProps();
}

// ====== TRIM (자르기) ======
function clickTrim(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'trim') cmdOp = { name: 'trim', phase: 'edges', edges: [] }; // 기본 = 기준선 선택
  // 기준선 선택 단계: 클릭 = 기준 객체 추가/해제(하이라이트)
  if (cmdOp.phase === 'edges') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  기준선: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
    const i = cmdOp.edges.indexOf(hit);
    if (i >= 0) { cmdOp.edges.splice(i, 1); state.selection.delete(hit.id); }
    else { cmdOp.edges.push(hit); state.selection.add(hit.id); }
    renderProps();
    setPrompt(`자르기(기준선): ${cmdOp.edges.length}개 선택됨. 계속 클릭하거나 Space로 확정하세요.`);
    return;
  }
  // 자르기 실행: bounds=null이면 모든 객체 기준(빠른), 아니면 선택한 기준선만
  const bounds = cmdOp.phase === 'cut' ? cmdOp.edges : null;
  const hit = pick(w, rawW);
  if (!hit) return;
  if (bounds && bounds.indexOf(hit) >= 0) { logLine('  기준선 자체는 자를 수 없습니다.', 'warn'); return; }
  if (hit.type === 'LINE') { pushUndo(); if (trimLine(hit, rawW, bounds)) { logLine('  ✔ 선 자름', 'ok'); updateStat(); } }
  else if (hit.type === 'CIRCLE' || hit.type === 'ARC') { pushUndo(); if (trimCircleArc(hit, rawW, bounds)) { logLine('  ✔ 원/호 자름', 'ok'); } }
  else logLine('  자르기는 선/원/호만 지원합니다.', 'warn');
  if (cmdOp.phase !== 'cut') { state.selection.clear(); renderProps(); } // 기준선 모드에선 하이라이트 유지
}
// Space/Enter/우클릭으로 자르기 모드 전환: 빠른 → 기준선 선택 → (확정) 자르기 → 빠른
function trimSpaceAction() {
  if (!cmdOp || cmdOp.name !== 'trim') cmdOp = { name: 'trim', phase: 'edges', edges: [] }; // 기본 = 기준선 선택
  if (cmdOp.phase === 'quick') {
    cmdOp.phase = 'edges'; cmdOp.edges = [];
    state.selection.clear(); renderProps();
    setPrompt('자르기(기준선): 기준이 될 객체들을 클릭하고 Space로 확정하세요.');
    logLine('  ▷ 기준선 선택 모드 (Space=확정)', 'info');
  } else if (cmdOp.phase === 'edges') {
    if (cmdOp.edges.length) {
      cmdOp.phase = 'cut';
      setPrompt(`자르기: 기준선 ${cmdOp.edges.length}개에 걸치는 부분을 클릭하세요. (Space=기준선 재선택)`);
      logLine(`  ▷ 자르기 시작 — 기준선 ${cmdOp.edges.length}개`, 'info');
    } else {
      cmdOp.phase = 'quick';
      setPrompt('자르기(빠른): 잘라낼 부분을 클릭하세요. 모든 객체가 기준. (Space=기준선 모드)');
      logLine('  ▷ 빠른 모드 (모든 객체 기준)', 'info');
    }
  } else { // cut → 기준선 다시 선택
    cmdOp.phase = 'edges'; cmdOp.edges = [];
    state.selection.clear(); renderProps();
    setPrompt('자르기(기준선): 기준이 될 객체들을 클릭하고 Space로 확정하세요.');
    logLine('  ▷ 기준선 재선택', 'info');
  }
  draw();
}

// ====== EXTEND (연장) ======
function clickExtend(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (hit.type !== 'LINE') { logLine('  연장은 선(LINE)만 지원합니다.', 'warn'); return; }
  pushUndo(); if (extendLine(hit, rawW)) logLine('  ✔ 선 연장', 'ok');
}

// ====== FILLET (모깎기) ======
function clickFillet(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'fillet') cmdOp = { name: 'fillet', step: 'l1', l1: null };
  const hit = pick(w, rawW);
  if (!hit || hit.type !== 'LINE') { logLine('  모깎기는 두 개의 선을 선택해야 합니다.', 'warn'); return; }
  if (cmdOp.step === 'l1') {
    cmdOp.l1 = hit; cmdOp.step = 'l2';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('모깎기: 두 번째 선을 클릭하세요.');
  } else {
    if (hit === cmdOp.l1) return;
    pushUndo();
    if (doFillet(cmdOp.l1, hit, filletRadius)) logLine(`  ✔ 모깎기 R=${filletRadius}`, 'ok');
    cmdOp = null; updateStat(); renderProps();
    setTool('select');
  }
}

// ====== SCALE (배율) ======
function clickScale(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'scale') cmdOp = { name: 'scale', step: state.selection.size ? 'base' : 'pick' };
  if (cmdOp.step === 'pick') {
    ensureSelectionByClick(w, rawW);
    if (state.selection.size) { cmdOp.step = 'base'; setPrompt('배율: 기준점을 클릭하세요.'); }
    return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'ref'; setPrompt('배율: 배율(숫자)을 입력하거나, 참조 길이의 끝점을 클릭하세요.'); return; }
  if (cmdOp.step === 'ref') { cmdOp.ref = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y); cmdOp.step = 'new'; setPrompt('배율: 새 길이의 끝점을 클릭하세요.'); return; }
  if (cmdOp.step === 'new') {
    const nd = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    applyScale(cmdOp.ref > 1e-9 ? nd / cmdOp.ref : 1);
  }
}
function applyScale(f) {
  if (!cmdOp || !cmdOp.base || !(f > 1e-9)) { logLine('  잘못된 배율입니다.', 'warn'); return; }
  pushUndo();
  scaleEntities(selectedEntities(), cmdOp.base, f);
  logLine(`  ✔ 배율 ×${(+f).toFixed(4).replace(/\.?0+$/, '')}`, 'ok');
  cmdOp = null; previewEnts = null; updateStat(); renderProps();
  setTool('select');
}

// ====== STRETCH (신축) ======
function clickStretch(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'stretch') cmdOp = { name: 'stretch', step: 'c1' };
  if (cmdOp.step === 'c1') { cmdOp.c1 = w; cmdOp.step = 'c2'; setPrompt('신축: 걸침 영역의 반대 모서리를 클릭하세요.'); return; }
  if (cmdOp.step === 'c2') {
    const box = { xmin: Math.min(cmdOp.c1.x, w.x), xmax: Math.max(cmdOp.c1.x, w.x), ymin: Math.min(cmdOp.c1.y, w.y), ymax: Math.max(cmdOp.c1.y, w.y) };
    cmdOp.box = box; cmdOp.ents = entitiesTouchingBox(box);
    if (!cmdOp.ents.length) { logLine('  영역 안에 신축할 점이 없습니다.', 'warn'); cmdOp = null; setTool('select'); return; }
    cmdOp.step = 'base'; setPrompt('신축: 기준점을 클릭하세요.'); return;
  }
  if (cmdOp.step === 'base') { cmdOp.base = w; cmdOp.step = 'dest'; setPrompt('신축: 이동점을 클릭하세요.'); return; }
  if (cmdOp.step === 'dest') {
    pushUndo();
    stretchEntities(cmdOp.ents, cmdOp.box, w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    logLine(`  ✔ 신축 (${cmdOp.ents.length}개 도형)`, 'ok');
    cmdOp = null; previewEnts = null; updateStat(); renderProps();
    setTool('select');
  }
}

// ====== POLYGON (정다각형) ======
function clickPolygon(w) {
  if (!draft) {
    pushUndo();
    draft = { type: 'LWPOLYLINE', closed: true, points: [], _poly: { cx: w.x, cy: w.y } };
    setPrompt(`다각형(${polygonSides}변): 반지름을 입력하거나 꼭짓점을 클릭하세요.`);
  } else {
    updateDraft();
    if (draft.points.length >= 3) { commitDraft(); logLine(`  ✔ ${polygonSides}각형`, 'ok'); }
  }
}

// ====== ELLIPSE (타원) ======
function clickEllipse(w) {
  if (!draft) {
    pushUndo();
    draft = { type: 'LWPOLYLINE', closed: true, points: [], _ell: { cx: w.x, cy: w.y } };
    setPrompt('타원: 코너점을 클릭하거나 rx,ry를 입력하세요.');
  } else {
    updateDraft();
    commitDraft(); logLine('  ✔ 타원', 'ok');
  }
}

// ====== CHAMFER (모따기) ======
function clickChamfer(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'chamfer') cmdOp = { name: 'chamfer', step: 'l1', l1: null };
  const hit = pick(w, rawW);
  if (!hit || hit.type !== 'LINE') { logLine('  모따기는 두 개의 선을 선택해야 합니다.', 'warn'); return; }
  if (cmdOp.step === 'l1') {
    cmdOp.l1 = hit; cmdOp.step = 'l2';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('모따기: 두 번째 선을 클릭하세요.');
  } else {
    if (hit === cmdOp.l1) return;
    pushUndo();
    if (doChamfer(cmdOp.l1, hit, chamferDist)) logLine(`  ✔ 모따기 d=${chamferDist}`, 'ok');
    cmdOp = null; updateStat(); renderProps();
    setTool('select');
  }
}
function doChamfer(l1, l2, d) {
  const a1 = [l1.x1, l1.y1], b1 = [l1.x2, l1.y2];
  const a2 = [l2.x1, l2.y1], b2 = [l2.x2, l2.y2];
  const C = lineInfIntersect(a1, b1, a2, b2);
  if (!C) { logLine('  두 선이 평행하여 모따기할 수 없습니다.', 'warn'); return false; }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const far1 = dist(C, a1) > dist(C, b1) ? a1 : b1, near1 = far1 === a1 ? 'b' : 'a';
  const far2 = dist(C, a2) > dist(C, b2) ? a2 : b2, near2 = far2 === a2 ? 'b' : 'a';
  const setNear = (ln, key, p) => { if (key === 'a') { ln.x1 = p[0]; ln.y1 = p[1]; } else { ln.x2 = p[0]; ln.y2 = p[1]; } };
  let u1 = [far1[0] - C[0], far1[1] - C[1]]; const n1 = Math.hypot(u1[0], u1[1]) || 1; u1 = [u1[0] / n1, u1[1] / n1];
  let u2 = [far2[0] - C[0], far2[1] - C[1]]; const n2 = Math.hypot(u2[0], u2[1]) || 1; u2 = [u2[0] / n2, u2[1] / n2];
  const t1 = [C[0] + u1[0] * d, C[1] + u1[1] * d];
  const t2 = [C[0] + u2[0] * d, C[1] + u2[1] * d];
  setNear(l1, near1, t1); setNear(l2, near2, t2);
  if (d > 1e-9) addEntity({ type: 'LINE', layer: state.currentLayer, x1: t1[0], y1: t1[1], x2: t2[0], y2: t2[1] });
  return true;
}

// ====== DIM (치수 기입 — 정렬 치수) ======
function clickDim(w) {
  if (!cmdOp || cmdOp.name !== 'dim') cmdOp = { name: 'dim', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('치수: 두 번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') { cmdOp.p2 = w; cmdOp.step = 'pos'; setPrompt('치수: 치수선 위치를 클릭하세요.'); return; }
  if (cmdOp.step === 'cont') { // 연속 치수: 직전 끝점에서 같은 오프셋으로 체인 기입
    const p1 = cmdOp.p1, p2 = w;
    const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
    if (L < 1e-9) return;
    const nx = -dy / L, ny = dx / L;
    const pos = { x: (p1.x + p2.x) / 2 + nx * cmdOp.h, y: (p1.y + p2.y) / 2 + ny * cmdOp.h };
    pushUndo();
    for (const e of computeDimension(p1, p2, pos)) addEntity(e);
    logLine(`  ✔ 치수 ${fmtNum(L)} (연속)`, 'ok');
    cmdOp = { name: 'dim', step: 'cont', p1: p2, h: cmdOp.h };
    previewEnts = null; updateStat(); return;
  }
  // pos: 치수선 위치 확정 → 연속 모드 진입
  pushUndo();
  for (const e of computeDimension(cmdOp.p1, cmdOp.p2, w)) addEntity(e);
  logLine(`  ✔ 치수 ${fmtNum(Math.hypot(cmdOp.p2.x - cmdOp.p1.x, cmdOp.p2.y - cmdOp.p1.y))}`, 'ok');
  const ddx = cmdOp.p2.x - cmdOp.p1.x, ddy = cmdOp.p2.y - cmdOp.p1.y, DL = Math.hypot(ddx, ddy) || 1;
  const h = (w.x - cmdOp.p1.x) * (-ddy / DL) + (w.y - cmdOp.p1.y) * (ddx / DL); // 부호 있는 오프셋
  cmdOp = { name: 'dim', step: 'cont', p1: cmdOp.p2, h };
  previewEnts = null;
  updateStat(); setPrompt('치수(연속): 다음 점을 클릭하면 이어서 기입됩니다. (Esc 종료)');
}
// 치수 그래픽(치수 레이어의 선·화살표·문자) 생성 — 미리보기/확정 공용
function computeDimension(p1, p2, pos) {
  ensureLayer('치수', '#5dff8f');
  const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy);
  if (L < 1e-9) return [];
  const ux = dx / L, uy = dy / L;
  let nx = -uy, ny = ux;
  let h = (pos.x - p1.x) * nx + (pos.y - p1.y) * ny;
  if (h < 0) { nx = -nx; ny = -ny; h = -h; }
  const th = dimTH(), ext = th * 0.4, gap = th * 0.25, s = Math.min(th * 0.6, L / 4);
  const ents = [];
  const ln = (x1, y1, x2, y2) => ents.push({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  const d1 = { x: p1.x + nx * h, y: p1.y + ny * h }, d2 = { x: p2.x + nx * h, y: p2.y + ny * h };
  ln(p1.x + nx * gap, p1.y + ny * gap, p1.x + nx * (h + ext), p1.y + ny * (h + ext)); // 치수보조선 1
  ln(p2.x + nx * gap, p2.y + ny * gap, p2.x + nx * (h + ext), p2.y + ny * (h + ext)); // 치수보조선 2
  ln(d1.x, d1.y, d2.x, d2.y);                                                        // 치수선
  // 화살표 (양끝 V)
  ln(d1.x, d1.y, d1.x + ux * s + nx * s * 0.35, d1.y + uy * s + ny * s * 0.35);
  ln(d1.x, d1.y, d1.x + ux * s - nx * s * 0.35, d1.y + uy * s - ny * s * 0.35);
  ln(d2.x, d2.y, d2.x - ux * s + nx * s * 0.35, d2.y - uy * s + ny * s * 0.35);
  ln(d2.x, d2.y, d2.x - ux * s - nx * s * 0.35, d2.y - uy * s - ny * s * 0.35);
  // 문자 (읽기 방향 유지: 90°~270°는 뒤집기)
  const txt = dimVal(L);
  let rot = Math.atan2(uy, ux) * 180 / Math.PI;
  let tux = ux, tuy = uy;
  const rn = ((rot % 360) + 360) % 360;
  if (rn > 90 && rn <= 270) { rot -= 180; tux = -ux; tuy = -uy; }
  const tw = txt.length * th * 0.6;
  const mid = { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 };
  ents.push({ type: 'TEXT', layer: '치수', x: mid.x - tux * tw / 2 + nx * gap, y: mid.y - tuy * tw / 2 + ny * gap, height: th, text: txt, rotation: rot });
  return ents;
}

// ====== DIMRAD / DIMDIA (반지름·지름 치수) ======
function clickDimCircle(w, rawW, dia) {
  const name = dia ? 'dimdia' : 'dimrad';
  if (!cmdOp || cmdOp.name !== name) cmdOp = { name, step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || (hit.type !== 'CIRCLE' && hit.type !== 'ARC')) { logLine('  원 또는 호를 클릭하세요.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'pos';
    setPrompt('치수: 문자 위치를 클릭하세요.'); return;
  }
  const e = cmdOp.target;
  pushUndo();
  ensureLayer('치수', '#5dff8f');
  const a = Math.atan2(w.y - e.cy, w.x - e.cx);
  const ex = e.cx + e.r * Math.cos(a), ey = e.cy + e.r * Math.sin(a); // 원 위의 점(화살표 위치)
  const sx = dia ? e.cx - e.r * Math.cos(a) : e.cx, sy = dia ? e.cy - e.r * Math.sin(a) : e.cy; // 지름은 반대편 가장자리부터
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  ln(sx, sy, w.x, w.y); // 지시선
  // 원 가장자리 화살표(V) — 지시선 방향
  const th = dimTH(), s = th * 0.5;
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  ln(ex, ey, ex - ux * s + nx * s * 0.35, ey - uy * s + ny * s * 0.35);
  ln(ex, ey, ex - ux * s - nx * s * 0.35, ey - uy * s - ny * s * 0.35);
  const txt = (dia ? '⌀' : 'R') + dimVal(dia ? e.r * 2 : e.r);
  addEntity({ type: 'TEXT', layer: '치수', x: w.x + th * 0.3, y: w.y - th * 0.3, height: th, text: txt, rotation: 0 });
  logLine(`  ✔ ${dia ? '지름' : '반지름'} 치수 ${txt}`, 'ok');
  cmdOp = { name, step: 'obj' }; updateStat();
  setPrompt('치수: 원/호를 클릭하세요. (연속 기입, Esc 종료)');
}

// ============================================================
//  BIM 1단계 — 2D 도형에 3D 속성(벽·슬래브·기둥·개구부) 부여
//  e.bim = {kind:'wall',h,t,base} | {kind:'slab',t,top} | {kind:'column',h,base}
//        | {kind:'opening',ot:'door'|'window',h,sill,t}
//  (클라우드/자동저장/실시간에 자동 포함. DXF에는 저장되지 않음)
// ============================================================
function bimAskNum(msg, def) {
  const v = prompt(msg, def);
  if (v === null) return null;
  const n = parseFloat(v);
  return (isFinite(n) && n > 0) ? n : null;
}
function cmdWallTag() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || e.type === 'LWPOLYLINE');
  if (!sel.length) { logLine('  벽: 선/폴리라인을 선택한 뒤 실행하세요.', 'warn'); return; }
  const h = bimAskNum('벽 높이 (mm):', settings.bim.wallH); if (h == null) return;
  const t = bimAskNum('벽 두께 (mm):', settings.bim.wallT); if (t == null) return;
  settings.bim.wallH = h; settings.bim.wallT = t; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'wall', h, t, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  logLine(`  ✔ 벽 지정 ${sel.length}개 (높이 ${h}, 두께 ${t}) — 평면에 두께 밴드로 표시`, 'ok');
  renderProps(); draw();
}
function cmdSlabTag() {
  const sel = selectedEntities().filter(e => (e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE');
  if (!sel.length) { logLine('  슬래브: 닫힌 폴리라인(또는 원)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const t = bimAskNum('슬래브 두께 (mm):', settings.bim.slabT); if (t == null) return;
  settings.bim.slabT = t; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'slab', t, top: (e.bim && e.bim.top != null) ? e.bim.top : lvElev() };
  logLine(`  ✔ 슬래브 지정 ${sel.length}개 (두께 ${t})`, 'ok');
  renderProps(); draw();
}
function cmdColumnTag() {
  const sel = selectedEntities().filter(e => e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed));
  if (!sel.length) { logLine('  기둥: 원 또는 닫힌 폴리라인을 선택한 뒤 실행하세요.', 'warn'); return; }
  const h = bimAskNum('기둥 높이 (mm):', settings.bim.colH); if (h == null) return;
  settings.bim.colH = h; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'column', h, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  logLine(`  ✔ 기둥 지정 ${sel.length}개 (높이 ${h})`, 'ok');
  renderProps(); draw();
}
function cmdBimClear() {
  const sel = selectedEntities().filter(e => e.bim);
  if (!sel.length) { logLine('  BIM 해제: BIM 속성이 있는 도형을 선택하세요.', 'warn'); return; }
  pushUndo();
  for (const e of sel) delete e.bim;
  logLine(`  ✔ BIM 속성 해제 ${sel.length}개`, 'ok');
  renderProps(); draw();
}
// 문/창: 벽 선 위 클릭 → 폭 입력 → 벽 방향의 개구부 세그먼트 생성
function clickOpening(w, rawW, ot) {
  const hit = pick(w, rawW);
  if (!hit || hit.type !== 'LINE' || !hit.bim || hit.bim.kind !== 'wall') {
    logLine(`  ${ot === 'door' ? '문' : '창'}: 먼저 wall 명령으로 벽 지정된 "선"을 클릭하세요.`, 'warn'); return;
  }
  const dx = hit.x2 - hit.x1, dy = hit.y2 - hit.y1, L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const ux = dx / L, uy = dy / L;
  let s = ((w.x - hit.x1) * ux + (w.y - hit.y1) * uy); // 클릭점의 벽 위 위치
  const defW = ot === 'door' ? settings.bim.doorW : settings.bim.winW;
  const wid = bimAskNum(`${ot === 'door' ? '문' : '창'} 폭 (mm):`, defW); if (wid == null) return;
  if (ot === 'door') settings.bim.doorW = wid; else settings.bim.winW = wid;
  saveSettings();
  s = Math.max(wid / 2, Math.min(L - wid / 2, s)); // 벽 밖으로 안 나가게
  const cx = hit.x1 + ux * s, cy = hit.y1 + uy * s;
  pushUndo();
  ensureLayer('개구부', '#ff9f0a');
  const bim = ot === 'door'
    ? { kind: 'opening', ot: 'door', h: settings.bim.doorH, sill: 0, t: hit.bim.t }
    : { kind: 'opening', ot: 'window', h: settings.bim.winH, sill: settings.bim.winSill, t: hit.bim.t };
  addEntity({ type: 'LINE', layer: '개구부',
    x1: cx - ux * wid / 2, y1: cy - uy * wid / 2, x2: cx + ux * wid / 2, y2: cy + uy * wid / 2, bim });
  logLine(`  ✔ ${ot === 'door' ? '문' : '창'} (폭 ${wid}) — 속성 패널에서 높이·씰 수정 가능`, 'ok');
  renderLayers(); updateStat(); draw();
}
// 평면 BIM 오버레이 (벽 두께 밴드 / 슬래브·기둥 채움 / 개구부 표식)
function drawBimOverlay(e) {
  if (!e.bim) return;
  const k = e.bim.kind, sc = state.view.scale;
  ctx.save();
  if (k === 'wall' && (e.type === 'LINE' || e.type === 'LWPOLYLINE')) {
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = entityColor(e);
    ctx.lineWidth = Math.max(1, e.bim.t * sc);
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    if (e.type === 'LINE') {
      const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    } else {
      e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      if (e.closed) ctx.closePath();
    }
    ctx.stroke();
  } else if (k === 'opening' && e.type === 'LINE') {
    // 벽 밴드를 끊는 표시: 배경색 밴드 + 주황 심볼
    const a = worldToScreen(e.x1, e.y1), b = worldToScreen(e.x2, e.y2);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = getCSS('--canvas-bg') || '#0a1020';
    ctx.lineWidth = Math.max(2, (e.bim.t || 200) * sc + 2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = '#ff9f0a'; ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1.5, (e.bim.ot === 'door' ? 3 : 2));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (e.bim.ot === 'window') { // 창: 이중선
      const dx = b.x - a.x, dy = b.y - a.y, L2 = Math.hypot(dx, dy) || 1;
      const nx = -dy / L2 * 3, ny = dx / L2 * 3;
      ctx.beginPath(); ctx.moveTo(a.x + nx, a.y + ny); ctx.lineTo(b.x + nx, b.y + ny);
      ctx.moveTo(a.x - nx, a.y - ny); ctx.lineTo(b.x - nx, b.y - ny); ctx.stroke();
    }
  } else if (k === 'slab' || k === 'roof') {
    ctx.globalAlpha = 0.06; ctx.fillStyle = entityColor(e);
    ctx.beginPath();
    if (e.type === 'CIRCLE') { const c = worldToScreen(e.cx, e.cy); ctx.arc(c.x, c.y, e.r * sc, 0, Math.PI * 2); }
    else { e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
    ctx.fill();
  } else if (k === 'stair' && e.type === 'LINE') {
    const b = e.bim, w = b.w || 1200;
    const a = worldToScreen(e.x1, e.y1), q = worldToScreen(e.x2, e.y2);
    const dx = q.x - a.x, dy = q.y - a.y, Ls = Math.hypot(dx, dy) || 1;
    const ux = dx / Ls, uy = dy / Ls, nx = -uy * w * sc / 2, ny = ux * w * sc / 2;
    ctx.strokeStyle = entityColor(e); ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); // 외곽
    ctx.moveTo(a.x + nx, a.y + ny); ctx.lineTo(q.x + nx, q.y + ny);
    ctx.lineTo(q.x - nx, q.y - ny); ctx.lineTo(a.x - nx, a.y - ny); ctx.closePath(); ctx.stroke();
    const n = Math.max(1, Math.ceil((b.h || 3000) / (b.riser || 180)));
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); // 디딤판 선
    for (let i = 1; i < n; i++) {
      const px = a.x + ux * Ls * i / n, py = a.y + uy * Ls * i / n;
      ctx.moveTo(px + nx, py + ny); ctx.lineTo(px - nx, py - ny);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.9; // 진행(UP) 화살표
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y);
    ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - ux * 10 - uy * 5, q.y - uy * 10 + ux * 5);
    ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - ux * 10 + uy * 5, q.y - uy * 10 - ux * 5);
    ctx.stroke();
    if (Ls > 40) {
      ctx.font = '10px -apple-system,system-ui,sans-serif'; ctx.fillStyle = entityColor(e);
      ctx.fillText('UP', q.x - ux * 18 + 4, q.y - uy * 18 - 4);
    }
  } else if (k === 'column') {
    ctx.globalAlpha = 0.22; ctx.fillStyle = entityColor(e);
    ctx.beginPath();
    if (e.type === 'CIRCLE') { const c = worldToScreen(e.cx, e.cy); ctx.arc(c.x, c.y, e.r * sc, 0, Math.PI * 2); }
    else { e.points.forEach((p, i) => { const q = worldToScreen(p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.closePath(); }
    ctx.fill();
  }
  ctx.restore();
}
// 가져온 메시의 평면(윗면) 윤곽 — 삼각형 에지를 위에서 본 투영으로 옅게
function drawMeshOverlay(e) {
  ctx.save();
  ctx.strokeStyle = entityColor(e); ctx.globalAlpha = state.selection.has(e.id) ? 0.85 : 0.3;
  ctx.lineWidth = state.selection.has(e.id) ? 1.5 : 0.6;
  ctx.beginPath();
  for (const t of e.tris) {
    for (let i = 0; i < 3; i++) {
      const a = worldToScreen(t[i][0], t[i][1]), b = worldToScreen(t[(i + 1) % 3][0], t[(i + 1) % 3][1]);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke(); ctx.restore();
}

// ============================================================
//  BIM 2단계 — 3D 뷰 (의존성 없는 자체 렌더러)
//  모든 BIM 요소는 수직 기둥체(prism): {poly:[[x,y]..], z0, z1, color, glass?}
// ============================================================
function bimSolids() {
  const solids = [];
  const walls = [], opens = [];
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (!e.bim) continue;
    if (e.bim.kind === 'wall') walls.push(e);
    else if (e.bim.kind === 'opening' && e.type === 'LINE') opens.push(e);
    else if (e.bim.kind === 'slab') {
      const poly = e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, 24) : e.points.map(p => [p[0], p[1]]);
      solids.push({ poly, z0: e.bim.top - e.bim.t, z1: e.bim.top, color: '#9aa2af', eid: e.id });
    } else if (e.bim.kind === 'roof' && e.type === 'LWPOLYLINE') {
      for (const s of roofSolids(e)) { s.eid = e.id; s.rf = true; solids.push(s); }
    } else if (e.bim.kind === 'stair' && e.type === 'LINE') {
      for (const s of stairSolids(e)) { s.eid = e.id; solids.push(s); }
    } else if (e.bim.kind === 'column') {
      const poly = e.type === 'CIRCLE' ? circlePoly(e.cx, e.cy, e.r, 16) : e.points.map(p => [p[0], p[1]]);
      solids.push({ poly, z0: e.bim.base || 0, z1: (e.bim.base || 0) + e.bim.h, color: '#8fa3c8', eid: e.id });
    }
  }
  for (const w of walls) {
    const t = w.bim.t, h = w.bim.h, base = w.bim.base || 0;
    // 꼭짓점 링 구성: LINE=2점 열린, 폴리라인=점열(닫힘 여부), 원=24각 닫힘
    let V, closedW;
    if (w.type === 'CIRCLE') { V = circlePoly(w.cx, w.cy, w.r, 24); closedW = true; }
    else if (w.type === 'LINE') { V = [[w.x1, w.y1], [w.x2, w.y2]]; closedW = false; }
    else { V = (w.points || []).map(p => [p[0], p[1]]); closedW = !!w.closed && V.length > 2; }
    const n = V.length; if (n < 2) continue;
    const nE = closedW ? n : n - 1;
    // 변별 단위 법선
    const eN = [];
    for (let k = 0; k < nE; k++) {
      const a = V[k], b = V[(k + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      eN.push([-(b[1] - a[1]) / L, (b[0] - a[0]) / L]);
    }
    // 꼭짓점별 마이터 오프셋 — 인접 변 오프셋 선의 교차 방향 (코너가 빈틈·단차 없이 맞물림)
    const mitO = [], mitI = [];
    for (let i = 0; i < n; i++) {
      const pe = closedW ? (i - 1 + n) % n : i - 1;
      const ce = i < nE ? i : nE - 1;
      let ox, oy;
      if (pe >= 0 && i < nE) {
        let mx = eN[pe][0] + eN[ce][0], my = eN[pe][1] + eN[ce][1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-6) { mx = eN[ce][0]; my = eN[ce][1]; }
        else { mx /= ml; my /= ml; }
        const cosH = Math.max(0.25, mx * eN[ce][0] + my * eN[ce][1]); // 예각 스파이크 제한
        ox = mx * (t / 2) / cosH; oy = my * (t / 2) / cosH;
      } else { ox = eN[ce][0] * t / 2; oy = eN[ce][1] * t / 2; } // 열린 끝: 수직 맞댐
      mitO.push([V[i][0] + ox, V[i][1] + oy]);
      mitI.push([V[i][0] - ox, V[i][1] - oy]);
    }
    for (let k = 0; k < nE; k++) {
      const x1 = V[k][0], y1 = V[k][1], k2 = (k + 1) % n;
      const x2 = V[k2][0], y2 = V[k2][1];
      const L = Math.hypot(x2 - x1, y2 - y1); if (L < 1e-6) continue;
      const ux = (x2 - x1) / L, uy = (y2 - y1) / L;
      // 이 세그먼트 위의 개구부(콜리니어) 수집 → 구간 분할
      const cuts = [];
      for (const o of opens) {
        const mx = (o.x1 + o.x2) / 2, my = (o.y1 + o.y2) / 2;
        const s = (mx - x1) * ux + (my - y1) * uy;
        const dPerp = Math.abs((mx - x1) * (-uy) + (my - y1) * ux);
        const ow = Math.hypot(o.x2 - o.x1, o.y2 - o.y1);
        const odir = Math.abs(((o.x2 - o.x1) / ow) * ux + ((o.y2 - o.y1) / ow) * uy);
        if (dPerp < t / 2 + 1 && odir > 0.99 && s > 0 && s < L)
          cuts.push({ s0: Math.max(0, s - ow / 2), s1: Math.min(L, s + ow / 2), o });
      }
      cuts.sort((a, b) => a.s0 - b.s0);
      const band = (s0, s1, z0, z1, color, glass, beid) => {
        if (s1 - s0 < 1e-6 || z1 - z0 < 1e-6) return;
        const ax = x1 + ux * s0, ay = y1 + uy * s0, bx = x1 + ux * s1, by = y1 + uy * s1;
        const nx = -uy * t / 2, ny = ux * t / 2;
        let A1 = [ax + nx, ay + ny], A2 = [ax - nx, ay - ny];
        let B1 = [bx + nx, by + ny], B2 = [bx - nx, by - ny];
        if (s0 <= 0.01) { A1 = mitO[k]; A2 = mitI[k]; }            // 세그 시작 = 마이터 코너
        if (s1 >= L - 0.01) { B1 = mitO[k2]; B2 = mitI[k2]; }      // 세그 끝 = 마이터 코너
        solids.push({ poly: [A1, B1, B2, A2], z0, z1, color, glass, eid: beid !== undefined ? beid : w.id, open: t <= 2 || glass });
      };
      let cur = 0;
      for (const c of cuts) {
        band(cur, c.s0, base, base + h, '#cfc7ba');            // 개구부 앞 벽체
        const sill = c.o.bim.sill || 0, oh = c.o.bim.h || 2100;
        if (sill > 0) band(c.s0, c.s1, base, base + sill, '#cfc7ba');            // 창 아래
        if (base + h > base + sill + oh) band(c.s0, c.s1, base + sill + oh, base + h, '#cfc7ba'); // 인방(상부)
        if (c.o.bim.ot === 'window') band(c.s0 + 10, c.s1 - 10, base + sill, base + sill + oh, '#7ec8ff', true, c.o.id); // 유리
        cur = c.s1;
      }
      band(cur, L, base, base + h, '#cfc7ba');
    }
  }
  return solids;
}
function circlePoly(cx, cy, r, n) {
  const p = [];
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
}

let v3 = null; // {yaw,pitch,zoom,cx,cy,cz,panX,panY,cv,ctx,faces}
function open3D() {
  const solids = bimSolids();
  if (!solids.length) logLine('  3D: 아직 BIM 요소가 없습니다 — 평면에서 그린 뒤 wall/slab/column으로 지정하면 여기 나타납니다.', 'info');
  let ov = document.getElementById('bim3d');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'bim3d';
    ov.style.cssText = 'position:absolute;inset:0;z-index:18;background:var(--bg);display:flex;flex-direction:column;';
    ov.innerHTML = `
      <canvas id="b3cv" style="flex:1 1 0;min-height:0;height:auto;width:100%;touch-action:none;cursor:default;"></canvas>
      <div id="cplaneBar" style="position:absolute;left:8px;bottom:8px;z-index:3;display:flex;gap:5px;align-items:center;
        background:var(--glass-chrome);-webkit-backdrop-filter:var(--glass);backdrop-filter:var(--glass);
        padding:5px 9px;border-radius:11px;box-shadow:var(--spec);"
        title="작업면(Construction Plane) 높이 — 3D에서 그리는 객체가 이 높이에 생성됩니다">
        <span style="font-size:11px;color:var(--muted);white-space:nowrap;">작업면 Z</span>
        <button class="miniBtn" id="cpMinus" style="min-width:22px;">−</button>
        <input id="cpZ" type="number" step="100" value="0" style="width:64px;font-size:12px;">
        <button class="miniBtn" id="cpPlus" style="min-width:22px;">＋</button>
        <input id="cpSlide" type="range" min="-1000" max="9000" step="100" value="0" style="width:110px;">
        <button class="miniBtn" id="cpReset" title="현재 층 레벨로">층</button>
      </div>`;
    document.getElementById('canvasWrap').appendChild(ov);
    const cv3 = ov.querySelector('#b3cv');
    v3 = { yaw: -0.6, pitch: 0.85, zoom: 1, panX: 0, panY: 0, cv: cv3, ctx: cv3.getContext('2d'), solids: [],
      quad: false, act: 1, views: [ // 사분할 뷰 (TL/TR/BL/BR) — 라이노식
        // fixed = 평행 투영 고정(회전 불가): 평면·입면은 도면에 넣을 수 있는 정투영 뷰
        { name: '평면', yaw: 0, pitch: Math.PI / 2, zoom: 1, panX: 0, panY: 0, fixed: true },
        { name: '아이소', yaw: -0.6, pitch: 0.85, zoom: 1, panX: 0, panY: 0 },
        { name: '정면', yaw: 0, pitch: 0, zoom: 1, panX: 0, panY: 0, fixed: true },
        { name: '우측면', yaw: -Math.PI / 2, pitch: 0, zoom: 1, panX: 0, panY: 0, fixed: true },
      ] };
    bind3D(ov, cv3);
  }
  ov.style.display = 'flex';
  v3.solids = solids;
  fit3D(); // 모델 중심·초기 줌 (솔리드 + 밑그림 도형 포함)
  v3.refitPending = !isFinite(v3.hasContent) || !v3.hasContent; // 빈 모델로 열림 → 첫 도형에 자동 맞춤
  v3.zoom = 1; v3.panX = 0; v3.panY = 0;
  for (const w of v3.views) { w.zoom = 1; w.panX = 0; w.panY = 0; }
  try { // 저장된 뷰 레이아웃 복원 (분할 여부·활성 뷰·뷰 방향·입면 종류)
    const ly = JSON.parse(localStorage.getItem('webcad_v3_layout2') || 'null');
    if (ly && Array.isArray(ly.views) && ly.views.length === 4) {
      ly.views.forEach((w, i) => {
        if (!isFinite(w.yaw)) return;
        v3.views[i].yaw = w.yaw; v3.views[i].pitch = w.pitch;
        if (w.name) v3.views[i].name = w.name;
        v3.views[i].fixed = !!w.fixed;
      });
      v3.quad = !!ly.quad;
      v3.act = (ly.act >= 0 && ly.act < 4) ? ly.act : 1;
    }
  } catch (_) {}
  loadVp(v3.act);
  if (!v3.fit || !isFinite(v3.fit)) v3.fit = 10000;
  size3D(); render3D();
  syncViewSeg(true);
  startLive3D();
  logLine(`  ✔ 3D 작업 뷰 — 요소 ${solids.length}개. 클릭으로 선택해 속성 패널에서 높이·두께를 수정하면 즉시 반영됩니다.`, 'ok');
  usage3d();
}
// 뷰 세그먼트(평면/3D) 표시 동기화
// 3D 화면 맞춤: 솔리드 + 비 BIM 도형 전체 bbox → 중심·스케일 재계산 (전체보기와 연동)
function fit3D() {
  let xmin = 1e18, xmax = -1e18, ymin = 1e18, ymax = -1e18, zmax = 0, has = 0;
  for (const s of v3.solids) {
    for (const [x, y] of s.poly) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    zmax = Math.max(zmax, s.zt ? Math.max(...s.zt) : (s.z1 || 0)); has++;
  }
  for (const e of state.entities) {
    if (e.bim) continue;
    if (!['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(e.type)) continue;
    try { const b = entityBBox(e); xmin = Math.min(xmin, b.xmin); xmax = Math.max(xmax, b.xmax); ymin = Math.min(ymin, b.ymin); ymax = Math.max(ymax, b.ymax); has++; } catch (_) { continue; }
    zmax = Math.max(zmax, e.zo || 0, e.z1 || 0, e.z2 || 0); // 공중에 띄운 도형·3D 선 높이 포함
    if (e.type === 'MESH') for (const t of e.tris) for (const p of t) zmax = Math.max(zmax, p[2]);
  }
  v3.hasContent = has > 0;
  if (!has) { v3.cx = 0; v3.cy = 0; v3.cz = 0; v3.fit = 10000; return; } // 빈 모델: 10m 기준
  v3.cx = (xmin + xmax) / 2; v3.cy = (ymin + ymax) / 2; v3.cz = zmax / 2;
  v3.fit = Math.max(xmax - xmin, ymax - ymin, zmax) || 1000;
  if (!isFinite(v3.fit)) v3.fit = 10000;
}
function syncViewSeg(is3d) {
  const p = document.getElementById('vwPlan'), d = document.getElementById('vw3d');
  if (!p || !d) return;
  p.style.background = is3d ? 'transparent' : 'var(--accent)'; p.style.color = is3d ? '' : '#fff';
  d.style.background = is3d ? 'var(--accent)' : 'transparent'; d.style.color = is3d ? '#fff' : '';
}
// 3D 열린 동안 모델 변경(속성 수정·삭제·undo) 감지 → 재빌드
let live3dTimer = null, live3dRev = -1, live3dSel = '';
function startLive3D() {
  stopLive3D();
  live3dRev = apiRev; live3dSel = [...state.selection].join(',');
  live3dTimer = setInterval(() => {
    const ov = document.getElementById('bim3d');
    if (!ov || ov.style.display === 'none') { stopLive3D(); return; }
    const selNow = [...state.selection].join(',');
    if (apiRev !== live3dRev || selNow !== live3dSel) {
      live3dRev = apiRev; live3dSel = selNow;
      v3.solids = bimSolids();
      if (v3.refitPending) { fit3D(); if (v3.hasContent) v3.refitPending = false; } // 빈 모델 → 첫 도형에 화면 맞춤
      render3D();
    }
  }, 300);
}
function stopLive3D() { if (live3dTimer) { clearInterval(live3dTimer); live3dTimer = null; } }
function usage3d() { if (window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage('view3d'); }
function size3D() {
  const cvs = v3.cv, r = cvs.getBoundingClientRect();
  cvs.width = Math.max(2, r.width * (devicePixelRatio || 1));
  cvs.height = Math.max(2, r.height * (devicePixelRatio || 1));
}
function proj3D(x, y, z) {
  const dx = x - v3.cx, dy = y - v3.cy, dz = z - v3.cz;
  const c = Math.cos(v3.yaw), s = Math.sin(v3.yaw);
  const x1 = dx * c - dy * s, y1 = dx * s + dy * c;
  const cp = Math.cos(v3.pitch), sp = Math.sin(v3.pitch);
  const sx = x1, sy = y1 * sp + dz * cp, depth = y1 * cp - dz * sp;
  const vp = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
  const k = Math.min(vp.w, vp.h) / (v3.fit * 1.4) * v3.zoom;
  return [vp.x + vp.w / 2 + (sx + v3.panX) * k, vp.y + vp.h / 2 - (sy + v3.panY) * k, depth];
}
// 화면 캔버스 px → 월드 (z=ze 평면 위의 점) — proj3D의 역변환
function unproj3D(px, py, ze) {
  const vp = v3.vp || { x: 0, y: 0, w: v3.cv.width, h: v3.cv.height };
  const k = Math.min(vp.w, vp.h) / (v3.fit * 1.4) * v3.zoom;
  const sp = Math.sin(v3.pitch), cp = Math.cos(v3.pitch);
  const sx = (px - vp.x - vp.w / 2) / k - v3.panX;
  const sy = (vp.y + vp.h / 2 - py) / k - v3.panY;
  const dz = ze - v3.cz;
  // 거의 수평 시점(정면·우측면): 바닥면과 시선이 평행 → 모델 중심을 지나는 수직면에 투영
  // (화면 가로 = 해당 방향의 평면 좌표, 깊이는 모델 중심 고정 — 입면 보면서 위치 잡기용)
  const x1 = sx, y1 = Math.abs(sp) < 0.2 ? 0 : (sy - dz * cp) / sp;
  const cs = Math.cos(v3.yaw), sn = Math.sin(v3.yaw);
  return [x1 * cs + y1 * sn + v3.cx, -x1 * sn + y1 * cs + v3.cy];
}
// ── 뷰포트 유틸 (사분할) ──
function vpRect(i) {
  const W = v3.cv.width, H = v3.cv.height;
  if (!v3.quad) return { x: 0, y: 0, w: W, h: H };
  const w2 = Math.floor(W / 2), h2 = Math.floor(H / 2);
  return [{ x: 0, y: 0, w: w2, h: h2 }, { x: w2, y: 0, w: W - w2, h: h2 },
          { x: 0, y: h2, w: w2, h: H - h2 }, { x: w2, y: h2, w: W - w2, h: H - h2 }][i];
}
function loadVp(i) { const w = v3.views[i]; v3.yaw = w.yaw; v3.pitch = w.pitch; v3.zoom = w.zoom; v3.panX = w.panX; v3.panY = w.panY; }
// 입면(파사드) 뷰 순환: 정면 → 우측면 → 좌측면 → 배면 (라벨 클릭)
const ELEV_ORDER = ['정면', '우측면', '좌측면', '배면'];
const ELEV_YAW = { '정면': 0, '우측면': -Math.PI / 2, '좌측면': Math.PI / 2, '배면': Math.PI };
function cycleElev(i) {
  const w = v3.views[i];
  if (!(w.name in ELEV_YAW)) return false;
  w.name = ELEV_ORDER[(ELEV_ORDER.indexOf(w.name) + 1) % ELEV_ORDER.length];
  w.yaw = ELEV_YAW[w.name]; w.pitch = 0;
  if (i === v3.act) loadVp(i);
  render3D(); saveV3Layout();
  logLine(`  ▷ 입면 뷰 전환: ${w.name}`, 'info');
  return true;
}
// 뷰 레이아웃(분할 여부·활성 뷰·각 뷰 방향·입면 종류) 저장/복원 — 줌·팬은 열 때마다 모델에 맞춤
function saveV3Layout() {
  try {
    localStorage.setItem('webcad_v3_layout2', JSON.stringify({
      quad: v3.quad, act: v3.act,
      views: v3.views.map(w => ({ name: w.name, yaw: w.yaw, pitch: w.pitch, fixed: !!w.fixed })),
    }));
  } catch (_) {}
}
function saveVp() { const w = v3.views[v3.act]; w.yaw = v3.yaw; w.pitch = v3.pitch; w.zoom = v3.zoom; w.panX = v3.panX; w.panY = v3.panY; }
function vpAt(px, py) {
  if (!v3.quad) return v3.act;
  return (px < v3.cv.width / 2 ? 0 : 1) + (py < v3.cv.height / 2 ? 0 : 2);
}
function render3D() {
  const c = v3.ctx, W = v3.cv.width, H = v3.cv.height;
  saveVp(); // 현재 조작 파라미터를 활성 뷰에 보존
  c.clearRect(0, 0, W, H);
  const dpr = devicePixelRatio || 1;
  v3.grip = null; v3.gum = null;
  const order = v3.quad ? [0, 1, 2, 3] : [v3.act];
  for (const i of order) {
    const r = vpRect(i);
    v3.vp = r; loadVp(i);
    c.save(); c.beginPath(); c.rect(r.x, r.y, r.w, r.h); c.clip();
    const res = renderScene(i === v3.act);
    c.restore();
    v3.views[i]._faces = res.faces; v3.views[i]._under = res.under;
    c.font = `600 ${12 * dpr}px -apple-system,system-ui,sans-serif`;
    c.fillStyle = i === v3.act ? '#0A84FF' : (getCSS('--muted') || '#8a93a6');
    c.fillText(v3.views[i].name + (v3.views[i].name in ELEV_YAW ? ' ▾' : ''), r.x + 8 * dpr, r.y + 16 * dpr);
    if (v3.quad) {
      c.strokeStyle = i === v3.act ? '#0A84FF' : (getCSS('--line') || 'rgba(120,140,180,.3)');
      c.lineWidth = i === v3.act ? 1.5 : 1;
      c.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }
  loadVp(v3.act); v3.vp = vpRect(v3.act);
  v3.faces = v3.views[v3.act]._faces; v3.under = v3.views[v3.act]._under;
  const qb = document.getElementById('vwQuad');
  if (qb) { qb.style.background = v3.quad ? 'var(--accent)' : 'transparent'; qb.style.color = v3.quad ? '#fff' : ''; }
  if (window.__BIM3D_DEBUG) {
    window.__BIM3D_STATS = { solids: v3.solids.length, faces: v3.faces.length };
    window.__BIM3D_TEST = { v3, render3D, pick3DAt, size3D, unproj3D, wall3DClick, vpAt, loadVp, vpRect };
  }
}
// 한 뷰포트의 장면 렌더 (v3.vp/yaw/pitch/zoom/pan 기준) — isActive면 그립/검볼/미리보기 포함
// ============================================================
//  소프트웨어 Z-버퍼 래스터라이저 — 은면 제거(hidden surface)
//  painter 정렬은 겹치는 면에서 뒤가 새어나옴 → 픽셀 깊이 비교로 해결
// ============================================================
// 조작 중 빠른 렌더 (painter 정렬) — 드래그가 끊기지 않도록
function paintFaces(c, faces, light) {
  faces.sort((a, b) => b.d - a.d);
  for (const f of faces) {
    const isSel = f.eid != null && state.selection.has(f.eid);
    c.beginPath(); f.pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    const rfGhost = f.rf && v3.roof === 'ghost';
    c.globalAlpha = f.glass ? 0.45 : rfGhost ? 0.22 : 1;
    c.fillStyle = isSel ? shadeColor('#0A84FF', 0.6 + 0.4 * f.shade) : shadeColor(f.color, f.shade); c.fill();
    c.globalAlpha = f.glass ? 0.6 : rfGhost ? 0.3 : 1;
    c.strokeStyle = isSel ? '#5eb1ff' : (light ? 'rgba(30,40,70,.35)' : 'rgba(10,16,32,.55)');
    c.lineWidth = isSel ? 2 : 1; c.stroke(); c.globalAlpha = 1;
  }
}
// 조작 감지: 움직이는 동안 빠른 모드, 멈추면(140ms) 정확한 Z-버퍼로 한 번 더 렌더
function markInteract() {
  if (!v3) return;
  v3.fast = true;
  clearTimeout(v3._settle);
  v3._settle = setTimeout(() => { v3.fast = false; render3D(); }, 140);
}
// 스캔라인 래스터: 각 행에서 삼각형과 교차하는 x-구간만 순회 (bbox 낭비 제거 → 얇은 삼각형에서 특히 빠름)
function zTri(data, zb, W, H, ox, oy, A, B, C, r, g, b) {
  const ax = A[0]-ox, ay = A[1]-oy, bx = B[0]-ox, by = B[1]-oy, cx = C[0]-ox, cy = C[1]-oy;
  const area = (by-cy)*(ax-cx) + (cx-bx)*(ay-cy);
  if (Math.abs(area) < 1e-9) return;
  const ia = 1/area;
  const minY = Math.max(0, Math.floor(Math.min(ay,by,cy)));
  const maxY = Math.min(H-1, Math.ceil(Math.max(ay,by,cy)));
  const E = [[ax,ay],[bx,by],[cx,cy]];
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    // 세 모서리와 수평선 py의 교차 x 수집
    let lo = Infinity, hi = -Infinity;
    for (let e = 0; e < 3; e++) {
      const p1 = E[e], p2 = E[(e+1)%3];
      const y1 = p1[1], y2 = p2[1];
      if ((py >= y1 && py < y2) || (py >= y2 && py < y1)) {
        const x = p1[0] + (p2[0]-p1[0]) * (py - y1) / (y2 - y1);
        if (x < lo) lo = x; if (x > hi) hi = x;
      }
    }
    if (lo > hi) continue;
    let xs = Math.max(0, Math.floor(lo)), xe = Math.min(W-1, Math.ceil(hi));
    const rowBase = y*W;
    for (let x = xs; x <= xe; x++) {
      const px = x + 0.5;
      const w0 = ((by-cy)*(px-cx) + (cx-bx)*(py-cy)) * ia;
      const w1 = ((cy-ay)*(px-cx) + (ax-cx)*(py-cy)) * ia;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const z = w0*A[2] + w1*B[2] + w2*C[2];
      const idx = rowBase + x;
      if (z < zb[idx]) { zb[idx] = z; const p = idx*4; data[p]=r; data[p+1]=g; data[p+2]=b; data[p+3]=255; }
    }
  }
}
function zLine(data, zb, W, H, ox, oy, A, B, r, g, b, eps) {
  const x0 = A[0]-ox, y0 = A[1]-oy, z0 = A[2], x1 = B[0]-ox, y1 = B[1]-oy, z1 = B[2];
  const dx = x1-x0, dy = y1-y0, steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let s = 0; s <= steps; s++) {
    const t = s/steps, x = Math.round(x0+dx*t), y = Math.round(y0+dy*t);
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const z = z0 + (z1-z0)*t, idx = y*W + x;
    if (z <= zb[idx] + eps) { const p = idx*4; data[p]=r; data[p+1]=g; data[p+2]=b; data[p+3]=255; }
  }
}
function rgbTriplet(hexOrRgb) {
  const m = hexOrRgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return [parseInt(hexOrRgb.slice(1,3),16), parseInt(hexOrRgb.slice(3,5),16), parseInt(hexOrRgb.slice(5,7),16)];
}
function zRasterFaces(c, faces, vp, light) {
  const W = vp.w|0, H = vp.h|0, ox = vp.x|0, oy = vp.y|0;
  if (W <= 0 || H <= 0 || !faces.length) return;
  const img = c.getImageData(ox, oy, W, H), data = img.data;
  const zb = (v3._zb && v3._zb.length === W*H) ? v3._zb : (v3._zb = new Float32Array(W*H));
  zb.fill(Infinity);
  const opaque = [], overlay = [];
  for (const f of faces) { (f.glass || (f.rf && v3.roof === 'ghost')) ? overlay.push(f) : opaque.push(f); }
  // 불투명 면: 채우기(깊이 기록). 화면 밖으로 완전히 벗어난 면은 건너뜀
  for (const f of opaque) {
    const P = f.pts;
    let pminX = Infinity, pmaxX = -Infinity, pminY = Infinity, pmaxY = -Infinity;
    for (const p of P) { const sx = p[0]-ox, sy = p[1]-oy; if (sx<pminX) pminX=sx; if (sx>pmaxX) pmaxX=sx; if (sy<pminY) pminY=sy; if (sy>pmaxY) pmaxY=sy; }
    if (pmaxX < 0 || pminX > W || pmaxY < 0 || pminY > H) continue; // 뷰포트 밖
    const isSel = f.eid != null && state.selection.has(f.eid);
    const [r, g, b] = rgbTriplet(isSel ? shadeColor('#0A84FF', 0.6 + 0.4*f.shade) : shadeColor(f.color, f.shade));
    f._r = r; f._g = g; f._b = b; f._sel = isSel; f._vis = true;
    for (let i = 1; i+1 < P.length; i++) zTri(data, zb, W, H, ox, oy, P[0], P[i], P[i+1], r, g, b);
  }
  // 모서리: 깊이 테스트로 가려진 에지는 숨김
  const eps = Math.max(1, v3.fit * 0.008);
  const [er, eg, eb] = light ? [70, 85, 120] : [12, 18, 36];
  for (const f of opaque) {
    if (!f._vis) continue; // 화면 밖 면의 모서리는 생략
    const P = f.pts, sel = f._sel;
    const R = sel ? 94 : er, G = sel ? 177 : eg, B = sel ? 255 : eb;
    for (let i = 0; i < P.length; i++) zLine(data, zb, W, H, ox, oy, P[i], P[(i+1)%P.length], R, G, B, eps);
  }
  c.putImageData(img, ox, oy);
  // 반투명(유리·지붕 고스트): 합성 위에 알파로
  overlay.sort((a, b) => b.d - a.d);
  for (const f of overlay) {
    c.beginPath(); f.pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])); c.closePath();
    c.globalAlpha = f.glass ? 0.42 : 0.22; c.fillStyle = shadeColor(f.color, f.shade); c.fill();
    c.globalAlpha = 1;
  }
}
function renderScene(isActive) {
  const c = v3.ctx;
  const faces = [];
  // 바닥 그리드 (z=0, 모델 주변)
  const g = Math.pow(10, Math.round(Math.log10(v3.fit / 8)));
  const gx0 = Math.floor((v3.cx - v3.fit) / g) * g, gx1 = v3.cx + v3.fit, gy0 = Math.floor((v3.cy - v3.fit) / g) * g, gy1 = v3.cy + v3.fit;
  c.strokeStyle = getCSS('--grid') || 'rgba(140,160,220,.1)'; c.lineWidth = 1;
  c.beginPath();
  for (let x = gx0; x <= gx1; x += g) { const a = proj3D(x, gy0, 0), b = proj3D(x, gy1, 0); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
  for (let y = gy0; y <= gy1; y += g) { const a = proj3D(gx0, y, 0), b = proj3D(gx1, y, 0); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
  c.stroke();
  // 평면 밑그림 — BIM 지정 안 된 일반 도형도 해당 층 레벨 높이에 라인워크로 표시 (평면↔3D 연속성)
  // 투영 경로를 캐시해 클릭 픽킹(pick3DAt)에서 재사용 (활성 뷰 것만 v3.under로 노출)
  const under = [];
  c.save();
  c.lineWidth = 1;
  for (const e of state.entities) {
    if (e.bim) continue; // BIM 요소는 아래에서 솔리드로 그려짐
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const z = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0); // zo = 검볼 Z로 띄운 3D 표시 높이
    let path = null, closed = false;
    if (e.type === 'LINE') { // 3D 선: 정점별 z
      path = [proj3D(e.x1, e.y1, e.z1 != null ? e.z1 : z), proj3D(e.x2, e.y2, e.z2 != null ? e.z2 : z)];
    } else if (e.type === 'LWPOLYLINE' && e.points && e.points.length) {
      path = e.points.map(p => proj3D(p[0], p[1], z)); closed = !!e.closed;
    } else if (e.type === 'CIRCLE') {
      path = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; path.push(proj3D(e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t), z)); }
    } else if (e.type === 'ARC') {
      let s0 = e.startAngle, e0 = e.endAngle; if (e0 < s0) e0 += 360;
      const steps = Math.max(8, Math.ceil((e0 - s0) / 10));
      path = []; for (let i = 0; i <= steps; i++) {
        const a = (s0 + (e0 - s0) * i / steps) * Math.PI / 180;
        path.push(proj3D(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), z));
      }
    } else continue; // TEXT/치수/해치 등은 3D 밑그림 생략
    under.push({ eid: e.id, path, closed });
    const isSel = state.selection.has(e.id);
    c.globalAlpha = isSel ? 0.95 : 0.5;
    c.strokeStyle = isSel ? '#0A84FF' : entityColor(e);
    c.lineWidth = isSel ? 2.5 : 1;
    c.beginPath();
    path.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]));
    if (closed) c.closePath();
    c.stroke();
  }
  c.restore();
  // 면 수집: 측면(모서리별 사각) + 상/하면
  const epsW = Math.max(1, v3.fit * 0.01); // 백페이스 판정용 월드 오프셋
  for (const s of v3.solids) {
    if (s.rf && v3.roof === 'hide') continue; // 지붕 숨김 모드
    const n = s.poly.length;
    const zt = s.zt || s.poly.map(() => s.z1);
    const top = s.poly.map((p, i) => proj3D(p[0], p[1], zt[i]));
    const bot = s.poly.map(p => proj3D(p[0], p[1], s.z0));
    const cull = !s.open; // 닫힌 솔리드만 백페이스 컬링 (서피스·유리는 양면 표시)
    let ccx = 0, ccy = 0; for (const p of s.poly) { ccx += p[0]; ccy += p[1]; } ccx /= n; ccy /= n;
    const midz = (s.z0 + (Math.max(...zt))) / 2;
    // 면이 카메라를 향하는가: 법선 방향으로 살짝 이동 시 깊이가 줄면(가까워지면) 정면
    const facesCam = (wx, wy, wz, nx, ny, nz) => proj3D(wx + nx * epsW, wy + ny * epsW, wz + nz * epsW)[2] < proj3D(wx, wy, wz)[2];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const quad = [bot[i], bot[j], top[j], top[i]];
      const ex = s.poly[j][0] - s.poly[i][0], ey = s.poly[j][1] - s.poly[i][1];
      const el = Math.hypot(ex, ey) || 1;
      let onx = ey / el, ony = -ex / el; // 바깥 방향 후보
      const mx = (s.poly[i][0] + s.poly[j][0]) / 2, my = (s.poly[i][1] + s.poly[j][1]) / 2;
      if ((mx - ccx) * onx + (my - ccy) * ony < 0) { onx = -onx; ony = -ony; } // 중심 반대쪽 = 바깥
      if (cull && !facesCam(mx, my, midz, onx, ony, 0)) continue; // 안쪽 면(카메라 반대) 제외
      const lightA = Math.abs(onx * 0.8 + ony * 0.35);
      faces.push({ pts: quad, d: (quad[0][2] + quad[1][2] + quad[2][2] + quad[3][2]) / 4, color: s.color, shade: 0.55 + 0.45 * lightA, glass: s.glass, eid: s.eid, rf: s.rf });
    }
    const tcz = Math.max(...zt);
    if (!cull || facesCam(ccx, ccy, tcz, 0, 0, 1))   // 상면 (위 향함)
      faces.push({ pts: top, d: top.reduce((a, p) => a + p[2], 0) / n, color: s.color, shade: 1.0, glass: s.glass, eid: s.eid, rf: s.rf });
    if (!cull || facesCam(ccx, ccy, s.z0, 0, 0, -1))  // 하면 (아래 향함)
      faces.push({ pts: bot, d: bot.reduce((a, p) => a + p[2], 0) / n, color: s.color, shade: 0.5, glass: s.glass, eid: s.eid, rf: s.rf });
  }
  // 가져온 3D 메시(STL/OBJ) — 삼각형별 법선 셰이딩
  for (const e of state.entities) {
    if (e.type !== 'MESH') continue;
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    for (const t of e.tris) {
      const P = t.map(p => proj3D(p[0], p[1], p[2]));
      const ux = t[1][0] - t[0][0], uy = t[1][1] - t[0][1], uz = t[1][2] - t[0][2];
      const vx = t[2][0] - t[0][0], vy = t[2][1] - t[0][1], vz = t[2][2] - t[0][2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const shade = 0.5 + 0.5 * Math.abs(nx * 0.5 + ny * 0.3 + nz * 0.8);
      faces.push({ pts: P, d: (P[0][2] + P[1][2] + P[2][2]) / 3, color: e.color || '#b9b2a6', shade, eid: e.id });
    }
  }
  const light = document.documentElement.classList.contains('light');
  if (v3.fast) paintFaces(c, faces, light);            // 조작 중: 빠른 painter (즉각 반응)
  else zRasterFaces(c, faces, v3.vp, light);           // 멈춤: 정확한 Z-버퍼 은면 제거
  // 높이 그립 — 벽/기둥 1개 선택 시 상단에 드래그 핸들 (활성 뷰에서만, 거의 수직 뷰에서는 숨김)
  if (isActive && state.selection.size === 1 && Math.abs(Math.cos(v3.pitch)) >= 0.15) {
    const sid = [...state.selection][0];
    const ent = state.entities.find(en => en.id === sid);
    if (ent && ent.bim && (ent.bim.kind === 'wall' || ent.bim.kind === 'column' || ent.bim.kind === 'stair')) {
      const parts = v3.solids.filter(s => s.eid === sid && !s.zt);
      if (parts.length) {
        const topS = parts.reduce((a, b) => (b.z1 > a.z1 ? b : a));
        const wx = topS.poly.reduce((a, p) => a + p[0], 0) / topS.poly.length;
        const wy = topS.poly.reduce((a, p) => a + p[1], 0) / topS.poly.length;
        const dzRef = v3.fit / 10;
        const p0 = proj3D(wx, wy, topS.z1);
        const pUp = proj3D(wx, wy, topS.z1 + dzRef);
        const pxPerMm = (p0[1] - pUp[1]) / dzRef; // 월드 +z 1mm당 화면 위쪽 픽셀 (뒤집힌 뷰에선 음수 — 부호 그대로 사용)
        if (Math.abs(pxPerMm) > 0.005) {
          v3.grip = { x: p0[0], y: p0[1], eid: sid, pxPerMm };
          const dpr = devicePixelRatio || 1;
          c.strokeStyle = '#0A84FF'; c.fillStyle = '#0A84FF'; c.lineWidth = 2 * dpr;
          c.beginPath(); c.moveTo(p0[0], p0[1]); c.lineTo(p0[0], p0[1] - 34 * dpr); c.stroke();
          c.beginPath(); c.moveTo(p0[0], p0[1] - 48 * dpr); c.lineTo(p0[0] - 7 * dpr, p0[1] - 34 * dpr); c.lineTo(p0[0] + 7 * dpr, p0[1] - 34 * dpr); c.closePath(); c.fill();
          c.beginPath(); c.arc(p0[0], p0[1], 5 * dpr, 0, Math.PI * 2); c.fill();
          c.font = `${12 * dpr}px -apple-system,system-ui,sans-serif`;
          c.fillStyle = light ? '#1a3a66' : '#8fc3ff';
          c.fillText(`h ${ent.bim.h}`, p0[0] + 11 * dpr, p0[1] - 18 * dpr);
        }
      }
    }
  }
  // 검볼 — 선택 1개의 이동 핸들 (활성 뷰에서만)
  if (isActive && state.selection.size === 1) {
    const sid = [...state.selection][0];
    const ent = state.entities.find(en => en.id === sid);
    if (ent && (ent.bim || ['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(ent.type))) {
      const bb = entityBBox(ent);
      let gx = (bb.xmin + bb.xmax) / 2, gy = (bb.ymin + bb.ymax) / 2;
      let gz = (state.levels[ent.lv || 0] || { elev: 0 }).elev + (ent.zo || 0);
      if (ent.type === 'LINE' && (ent.z1 != null || ent.z2 != null)) gz = ((ent.z1 || 0) + (ent.z2 || 0)) / 2; // 3D 선 중앙
      const parts = v3.solids.filter(s => s.eid === sid);
      if (parts.length) { let zm = 1e18, zM = -1e18; for (const s of parts) { zm = Math.min(zm, s.z0); zM = Math.max(zM, s.zt ? Math.max(...s.zt) : s.z1); } gz = (zm + zM) / 2; }
      const L = v3.fit / 7;
      // Z축: 모든 객체 — 일반 도형=3D 표시 높이(zo), 문·창=씰, 벽·기둥·계단=base, 슬래브=top, 지붕=처마
      const AXES = [['x', 1, 0, 0, '#ff453a'], ['y', 0, 1, 0, '#30d158'], ['z', 0, 0, 1, '#0A84FF']];
      const g0 = proj3D(gx, gy, gz);
      const dpr = devicePixelRatio || 1;
      v3.gum = { eid: sid, axes: [] };
      for (const [name, vx, vy, vz, color] of AXES) {
        const g1 = proj3D(gx + vx * L, gy + vy * L, gz + vz * L);
        const ddx = g1[0] - g0[0], ddy = g1[1] - g0[1], len = Math.hypot(ddx, ddy);
        if (len < 6) continue; // 화면과 거의 수직인 축은 생략
        const ux = ddx / len, uy = ddy / len;
        v3.gum.axes.push({ name, p0: [g0[0], g0[1]], p1: [g1[0], g1[1]], ux, uy, pxPerMm: len / L, vx, vy, vz });
        c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2.5 * dpr; c.globalAlpha = 0.95;
        c.beginPath(); c.moveTo(g0[0], g0[1]); c.lineTo(g1[0], g1[1]); c.stroke();
        c.beginPath();
        c.moveTo(g1[0], g1[1]);
        c.lineTo(g1[0] - ux * 9 * dpr - uy * 4.5 * dpr, g1[1] - uy * 9 * dpr + ux * 4.5 * dpr);
        c.lineTo(g1[0] - ux * 9 * dpr + uy * 4.5 * dpr, g1[1] - uy * 9 * dpr - ux * 4.5 * dpr);
        c.closePath(); c.fill();
        c.font = `${11 * dpr}px -apple-system,system-ui,sans-serif`;
        c.fillText(name.toUpperCase(), g1[0] + ux * 8 * dpr + 2, g1[1] + uy * 8 * dpr + 2);
      }
      c.beginPath(); c.fillStyle = '#ffd60a'; c.globalAlpha = 0.95; c.arc(g0[0], g0[1], 4 * dpr, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
  }
  // 작업면 시각화 — 층 레벨과 다르면 점선 사각형 + 높이 라벨 (모든 뷰포트)
  if (Math.abs(cplaneZ() - lvElev()) > 0.5) {
    const zc = cplaneZ(), dcp = devicePixelRatio || 1;
    const hx = v3.fit * 0.7, hy = v3.fit * 0.7;
    const cor = [[v3.cx - hx, v3.cy - hy], [v3.cx + hx, v3.cy - hy], [v3.cx + hx, v3.cy + hy], [v3.cx - hx, v3.cy + hy]].map(p => proj3D(p[0], p[1], zc));
    c.save();
    c.strokeStyle = '#bf5af2'; c.globalAlpha = 0.75; c.lineWidth = 1.2 * dcp; c.setLineDash([8 * dcp, 5 * dcp]);
    c.beginPath(); cor.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath(); c.stroke();
    c.setLineDash([]);
    c.font = `${11 * dcp}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#bf5af2';
    c.fillText(`작업면 z=${zc}`, cor[0][0] + 4, cor[0][1] - 4);
    c.restore();
  }
  // 작도 가선 — 평면의 draft/pts/previewEnts를 층 바닥면에 투영 (모든 뷰포트에 표시)
  if (draft || pts.length || previewEnts) {
    const zw = cplaneZ(), dg = devicePixelRatio || 1;
    const pathOf = (e) => {
      if (e.type === 'LINE') return { p: [proj3D(e.x1, e.y1, zw), proj3D(e.x2, e.y2, zw)], cl: false };
      if (e.type === 'LWPOLYLINE' && e.points && e.points.length) return { p: e.points.map(q => proj3D(q[0], q[1], zw)), cl: !!e.closed };
      if (e.type === 'CIRCLE') { const p = []; for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; p.push(proj3D(e.cx + e.r * Math.cos(t), e.cy + e.r * Math.sin(t), zw)); } return { p, cl: false }; }
      if (e.type === 'ARC') { let s0 = e.startAngle, e0 = e.endAngle; if (e0 < s0) e0 += 360; const st = Math.max(8, Math.ceil((e0 - s0) / 10)); const p = []; for (let i = 0; i <= st; i++) { const a = (s0 + (e0 - s0) * i / st) * Math.PI / 180; p.push(proj3D(e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a), zw)); } return { p, cl: false }; }
      return null;
    };
    const strokeGhost = (r) => {
      if (!r || r.p.length < 2) return;
      c.strokeStyle = '#ffd60a'; c.lineWidth = 1.5 * dg; c.globalAlpha = 0.9;
      c.setLineDash([6 * dg, 4 * dg]);
      c.beginPath(); r.p.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]));
      if (r.cl) c.closePath();
      c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
    };
    if (draft) strokeGhost(pathOf(draft));
    if (pts.length) {
      const pp = pts.map(q => proj3D(q.x, q.y, zw));
      if (v3.toolCur) pp.push(proj3D(v3.toolCur.x, v3.toolCur.y, zw));
      strokeGhost({ p: pp, cl: false });
    }
    if (previewEnts) for (const e of previewEnts) strokeGhost(pathOf(e));
  }
  // 스냅 마커 — 2D와 동일한 초록 표식 (끝점=사각, 중간점=삼각)
  if (v3.snapHit) {
    const sm = v3.snapHit, dpr3 = devicePixelRatio || 1;
    const sp3 = proj3D(sm.x, sm.y, sm.z != null ? sm.z : cplaneZ());
    const rr = 7 * dpr3;
    c.save();
    c.strokeStyle = '#2ee6a6'; c.lineWidth = 1.8 * dpr3; c.setLineDash([]);
    if (sm.kind === 'midpoint') {
      c.beginPath(); c.moveTo(sp3[0], sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr); c.lineTo(sp3[0] + rr, sp3[1] + rr); c.closePath(); c.stroke();
    } else if (sm.kind === 'center') {
      c.beginPath(); c.arc(sp3[0], sp3[1], rr, 0, Math.PI * 2); c.stroke();
    } else if (sm.kind === 'nearest') {
      c.beginPath();
      c.moveTo(sp3[0] - rr, sp3[1] - rr); c.lineTo(sp3[0] + rr, sp3[1] + rr);
      c.moveTo(sp3[0] + rr, sp3[1] - rr); c.lineTo(sp3[0] - rr, sp3[1] + rr);
      c.stroke();
    } else {
      c.strokeRect(sp3[0] - rr, sp3[1] - rr, 2 * rr, 2 * rr);
    }
    c.restore();
  }
  // 3D 선 러버밴드 — 시작점(실제 z)에서 커서(스냅 z/작업면)까지
  if (v3.line3d && v3.line3d.p1) {
    const p1 = v3.line3d.p1, dl = devicePixelRatio || 1;
    const a = proj3D(p1.x, p1.y, p1.z);
    c.fillStyle = '#ffd60a'; c.beginPath(); c.arc(a[0], a[1], 4 * dl, 0, Math.PI * 2); c.fill();
    if (v3.toolCur) {
      const tc = v3.toolCur;
      const b = proj3D(tc.x, tc.y, tc.z != null ? tc.z : cplaneZ());
      c.strokeStyle = '#ffd60a'; c.lineWidth = 1.5 * dl; c.setLineDash([6 * dl, 4 * dl]); c.globalAlpha = 0.9;
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
      c.setLineDash([]); c.globalAlpha = 1;
      c.font = `${11 * dl}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#ffd60a';
      c.fillText(`${Math.round(Math.hypot(tc.x - p1.x, tc.y - p1.y, (tc.z || 0) - p1.z))}`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
    }
  }
  // 3D 벽 그리기 미리보기 (모든 뷰포트에 표시)
  if (v3.wallMode && v3.wallP1) {
    const ze = cplaneZ(), dpr = devicePixelRatio || 1;
    const a = proj3D(v3.wallP1[0], v3.wallP1[1], ze);
    c.fillStyle = '#ff9f0a'; c.beginPath(); c.arc(a[0], a[1], 4 * dpr, 0, Math.PI * 2); c.fill();
    if (v3.wallCur && (v3.wallCur[0] !== v3.wallP1[0] || v3.wallCur[1] !== v3.wallP1[1])) {
      const b = proj3D(v3.wallCur[0], v3.wallCur[1], ze);
      c.strokeStyle = '#ff9f0a'; c.lineWidth = 2 * dpr; c.setLineDash([6 * dpr, 4 * dpr]);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
      c.font = `${11 * dpr}px -apple-system,system-ui,sans-serif`; c.fillStyle = '#ff9f0a';
      c.fillText(`${Math.round(Math.hypot(v3.wallCur[0] - v3.wallP1[0], v3.wallCur[1] - v3.wallP1[1]))}`, (a[0] + b[0]) / 2 + 6, (a[1] + b[1]) / 2 - 6);
    }
  }
  return { faces, under };
}
function shadeColor(hex, k) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * k), g = Math.round(parseInt(hex.slice(3, 5), 16) * k), b = Math.round(parseInt(hex.slice(5, 7), 16) * k);
  return `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
}
// 작업면(Construction Plane) z — 3D 작도의 레이캐스팅 교차 평면 (기본: 현재 층 레벨)
function cplaneZ() { return (v3 && v3.cplane != null) ? v3.cplane : lvElev(); }
function setCplane(z) {
  if (!v3) return;
  v3.cplane = isFinite(z) ? Math.round(z) : null;
  const zi = document.getElementById('cpZ'), sl = document.getElementById('cpSlide');
  if (zi) zi.value = cplaneZ();
  if (sl) sl.value = Math.max(sl.min | 0, Math.min(sl.max | 0, cplaneZ()));
  render3D();
}
// 3D 커서 — 평면(setTool)과 동일 규칙: select=기본, pan=손, 그 외 도구=십자
function cursor3D() {
  if (v3 && v3.wallMode) return 'crosshair';
  return (state.tool === 'select') ? 'default' : (state.tool === 'pan') ? 'grab' : 'crosshair';
}
// 검볼 이동 적용: X/Y=평면 이동, Z=BIM 기준 높이(base/top/eave) 이동
function gumMove(ent, ax, d) {
  if (ax.vz) {
    const b = ent.bim;
    if (!b) {
      if (ent.type === 'LINE' && (ent.z1 != null || ent.z2 != null)) { ent.z1 = (ent.z1 || 0) + d; ent.z2 = (ent.z2 || 0) + d; return; } // 3D 선: 양끝 동시 이동
      ent.zo = (ent.zo || 0) + d; return; // 일반 도형: 3D 표시 높이(층 레벨 + 오프셋)
    }
    if (b.kind === 'opening') b.sill = (b.sill || 0) + d; // 문·창: 씰 높이
    else if (b.kind === 'slab') b.top += d;
    else if (b.kind === 'roof') b.eave += d;
    else b.base = (b.base || 0) + d;
  } else translateEntity(ent, ax.vx * d, ax.vy * d);
}
function bind3D(ov, cv3) {
  let drag = null;
  cv3.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    { // 사분할: 클릭한 뷰포트를 활성화
      const rv = cv3.getBoundingClientRect();
      const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
      const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
      const vi = vpAt(pxv, pyv);
      if (vi !== v3.act) { v3.act = vi; loadVp(vi); render3D(); }
    }
    // 높이 그립 히트 → 리프트 드래그 (벽/기둥 높이 끌어올리기)
    if (v3.grip && e.button === 0 && !e.shiftKey) {
      const r = cv3.getBoundingClientRect();
      const kx = r.width ? cv3.width / r.width : 1, ky = r.height ? cv3.height / r.height : 1;
      const px = (e.clientX - r.left) * kx, py = (e.clientY - r.top) * ky;
      const dpr = devicePixelRatio || 1;
      if (Math.abs(px - v3.grip.x) <= 16 * dpr && py >= v3.grip.y - 54 * dpr && py <= v3.grip.y + 12 * dpr) {
        const ent = state.entities.find(en => en.id === v3.grip.eid);
        if (ent && ent.bim) {
          drag = { mode: 'lift', ent, h0: ent.bim.h, y0: e.clientY, py2cv: ky, pxPerMm: v3.grip.pxPerMm, pushed: false };
          try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
          cv3.style.cursor = 'ns-resize';
          return;
        }
      }
    }
    // 검볼 축 히트 → 이동 드래그(1mm 스냅) / 클릭 = 수치 입력
    if (v3.gum && e.button === 0 && !e.shiftKey) {
      const r2 = cv3.getBoundingClientRect();
      const kx2 = r2.width ? cv3.width / r2.width : 1, ky2 = r2.height ? cv3.height / r2.height : 1;
      const px2 = (e.clientX - r2.left) * kx2, py2 = (e.clientY - r2.top) * ky2;
      const tol2 = 10 * (devicePixelRatio || 1);
      // 원점 부근은 세 축이 겹치므로 "허용치 안 첫 번째"가 아니라 "가장 가까운 축"을 선택
      // (이전 로직은 Z 화살표 아래쪽을 잡아도 X/Y가 먼저 걸려 수평 이동되는 버그)
      let hitAx = null, hitD = tol2;
      for (const a of v3.gum.axes) {
        const ddx = a.p1[0] - a.p0[0], ddy = a.p1[1] - a.p0[1], L2 = ddx * ddx + ddy * ddy;
        const t = L2 ? Math.max(0, Math.min(1, ((px2 - a.p0[0]) * ddx + (py2 - a.p0[1]) * ddy) / L2)) : 0;
        const d = Math.hypot(px2 - (a.p0[0] + ddx * t), py2 - (a.p0[1] + ddy * t));
        if (d <= hitD) { hitD = d; hitAx = a; }
      }
      if (hitAx) {
        const ent = state.entities.find(en => en.id === v3.gum.eid);
        if (ent) {
          drag = { mode: 'gum', ent, ax: hitAx, x0: e.clientX, y0: e.clientY, kx: kx2, ky: ky2, applied: 0, pushed: false, moved: 0 };
          try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
          cv3.style.cursor = 'move';
          return;
        }
      }
    }
    // 벽 그리기 모드/평면 도구 활성: 좌클릭은 점 찍기 전용 (박스 선택 없음)
    if ((v3.wallMode || state.tool !== 'select') && e.button === 0 && !e.shiftKey) {
      drag = { mode: 'wallpt', x: e.clientX, y: e.clientY, moved: 0 };
      try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    // 입면 뷰 라벨 클릭 → 정면/우측면/좌측면/배면 순환 (작도 중엔 클릭을 가로채지 않음)
    if (e.button === 0 && state.tool === 'select' && !v3.wallMode) {
      const rl = cv3.getBoundingClientRect();
      const plx = (e.clientX - rl.left) * (rl.width ? cv3.width / rl.width : 1);
      const ply = (e.clientY - rl.top) * (rl.height ? cv3.height / rl.height : 1);
      const li = vpAt(plx, ply), lr = vpRect(li), dpr2 = devicePixelRatio || 1;
      if (plx <= lr.x + 90 * dpr2 && ply <= lr.y + 22 * dpr2 && cycleElev(li)) return;
    }
    // 평면과 동일한 규약: 좌드래그=박스 선택 · 우드래그=회전(고정 뷰는 이동) · Shift/휠버튼=화면 이동 · 터치=회전
    const isTouch = e.pointerType === 'touch';
    const fixedVp = !!v3.views[v3.act].fixed; // 평면·입면: 평행 투영 고정 — 회전 대신 이동
    const mode = (e.button === 1 || (e.shiftKey && e.button === 0)) ? 'pan'
      : (e.button === 2) ? (fixedVp ? 'pan' : 'orbit')
      : isTouch ? (fixedVp ? 'pan' : 'orbit') : 'box';
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, shift: e.shiftKey, mode };
    if (mode === 'box') {
      const rb = cv3.getBoundingClientRect();
      const kx = rb.width ? cv3.width / rb.width : 1, ky = rb.height ? cv3.height / rb.height : 1;
      drag.kx = kx; drag.ky = ky;
      drag.bx0 = (e.clientX - rb.left) * kx; drag.by0 = (e.clientY - rb.top) * ky;
      drag.bx1 = drag.bx0; drag.by1 = drag.by0;
    }
    try { cv3.setPointerCapture(e.pointerId); } catch (_) {}
    cv3.style.cursor = (mode === 'orbit' || mode === 'pan') ? 'grabbing' : cv3.style.cursor;
  });
  cv3.addEventListener('pointermove', (e) => {
    if (!drag && (v3.wallMode || state.tool !== 'select' || osnapEnabled)) { // 작도 가선 + 스냅 마커 (선택 도구에서도 마커 표시)
      const r3 = cv3.getBoundingClientRect();
      const px3 = (e.clientX - r3.left) * (r3.width ? cv3.width / r3.width : 1);
      const py3 = (e.clientY - r3.top) * (r3.height ? cv3.height / r3.height : 1);
      const vi3 = vpAt(px3, py3); // 사분할: 커서가 있는 뷰포트 기준으로 스냅·가선 계산
      if (vi3 !== v3.act) { v3.act = vi3; loadVp(vi3); v3.vp = vpRect(vi3); }
      const w = unproj3D(px3, py3, cplaneZ());
      if (w) {
        const sn = snap3D(px3, py3, null);
        v3.snapHit = sn || null; // 스냅 마커 표시용
        const cur = sn ? { x: sn.x, y: sn.y, z: sn.z != null ? sn.z : cplaneZ() }
                       : { x: Math.round(w[0]), y: Math.round(w[1]), z: cplaneZ() };
        v3.toolCur = cur;
        if (v3.wallMode && v3.wallP1) v3.wallCur = [Math.round(w[0] / 10) * 10, Math.round(w[1] / 10) * 10];
        mouseWorld = { x: cur.x, y: cur.y };  // 2D 파이프라인의 러버밴드 로직 재사용
        updateDraft();
        const co = document.getElementById('coords');
        if (co) co.textContent = `X: ${cur.x.toFixed(2)}  Y: ${cur.y.toFixed(2)}  Z: ${cur.z != null ? cur.z : cplaneZ()}`;
        const drawing = draft || pts.length || (v3.wallMode && v3.wallP1) || v3.line3d;
        const snapKey = v3.snapHit ? (v3.snapHit.x + ',' + v3.snapHit.y + ',' + v3.snapHit.z) : '';
        if (!drawing && snapKey === v3._lastSnapKey) return; // 단순 호버·스냅 변화 없음 → 재렌더 생략(정확 모드 호버 렉 방지)
        v3._lastSnapKey = snapKey;
        if (drawing) markInteract();  // 작도 중이면 빠른 모드(가선 부드럽게), 단순 호버는 정확 은면
        render3D();
      }
      return;
    }
    if (!drag) { if (v3.snapHit) { v3.snapHit = null; render3D(); } return; }
    markInteract(); // 실제 드래그(회전·이동·검볼·박스) 중 빠른 렌더 → 멈추면 정확 렌더
    if (drag.mode === 'gum') {
      const dxc = (e.clientX - drag.x0) * drag.kx, dyc = (e.clientY - drag.y0) * drag.ky;
      drag.moved = Math.max(drag.moved, Math.abs(dxc) + Math.abs(dyc));
      const s = dxc * drag.ax.ux + dyc * drag.ax.uy;   // 축 화면방향으로의 이동량(px)
      const want = Math.round(s / drag.ax.pxPerMm);     // 월드 mm (1mm 스냅)
      const delta = want - drag.applied;
      if (delta) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; }
        gumMove(drag.ent, drag.ax, delta);
        drag.applied = want;
        v3.solids = bimSolids(); render3D();
      }
      return;
    }
    if (drag.mode === 'lift') {
      const dyc = (e.clientY - drag.y0) * drag.py2cv;         // 화면 아래(+)로 이동한 캔버스 픽셀
      let nh = drag.h0 - dyc / drag.pxPerMm;                  // 위로 끌면 높이 증가
      nh = Math.max(100, Math.round(nh / 10) * 10);           // 10mm 스냅, 최소 100
      if (nh !== drag.ent.bim.h) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; } // 드래그 1회 = undo 1단계
        drag.ent.bim.h = nh;
        v3.solids = bimSolids(); render3D();
      }
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.mode === 'wallpt') return;
    if (drag.mode === 'box') { // 선택 박스 러버밴드
      drag.bx1 += dx * drag.kx; drag.by1 += dy * drag.ky;
      render3D();
      const c = v3.ctx, crossing = drag.bx1 < drag.bx0;
      c.save();
      c.strokeStyle = crossing ? '#30d158' : '#0A84FF';
      c.fillStyle = crossing ? 'rgba(48,209,88,.08)' : 'rgba(10,132,255,.08)';
      c.setLineDash(crossing ? [5, 4] : []);
      c.lineWidth = 1.5;
      const rx = Math.min(drag.bx0, drag.bx1), ry = Math.min(drag.by0, drag.by1);
      c.fillRect(rx, ry, Math.abs(drag.bx1 - drag.bx0), Math.abs(drag.by1 - drag.by0));
      c.strokeRect(rx, ry, Math.abs(drag.bx1 - drag.bx0), Math.abs(drag.by1 - drag.by0));
      c.restore();
      return;
    }
    if (drag.mode === 'orbit') {
      v3.yaw += dx * 0.008;                 // 드래그 방향 = 모델 회전 방향 (라이노식)
      v3.pitch += dy * 0.006;               // 각도 제한 없음 — 아래에서도 볼 수 있음
    } else {
      const k = Math.min(v3.cv.width, v3.cv.height) / (v3.fit * 1.4) * v3.zoom;
      v3.panX += dx * (devicePixelRatio || 1) / k;
      v3.panY -= dy * (devicePixelRatio || 1) / k;
    }
    render3D();
  });
  const end = (e) => {
    if (drag && drag.mode === 'gum') {
      if (drag.moved < 4 && e && e.type === 'pointerup') { // 축 클릭 = 수치 입력 (라이노식)
        const v = parseFloat(prompt(`${drag.ax.name.toUpperCase()}축 이동 거리 (mm, +방향/-방향):`, '0'));
        if (isFinite(v) && v) {
          if (!drag.pushed) { pushUndo(); drag.pushed = true; }
          gumMove(drag.ent, drag.ax, Math.round(v));
          v3.solids = bimSolids();
        }
      }
      if (drag.pushed) logLine(`  ✔ ${drag.ax.name.toUpperCase()}축 이동 완료`, 'ok');
      renderProps(); render3D();
    } else if (drag && drag.mode === 'lift') {
      if (drag.pushed) { renderProps(); logLine(`  ✔ 높이 조절: ${drag.h0} → ${drag.ent.bim.h}`, 'ok'); }
    } else if (drag && e && e.type === 'pointerup') {
      if (drag.mode === 'box' && drag.moved >= 4) applyBox3D(drag);
      else if (drag.moved < 4 && (e.button === 0 || e.pointerType === 'touch')) {
        if (v3.wallMode) wall3DClick(e);
        else if (state.tool === 'line') line3DClick(e); // 3D 선: 정점별 높이 지원
        else if (state.tool !== 'select') tool3DClick(e); // 나머지 평면 도구
        else pick3D(e, drag.shift);
      } else if (drag.mode === 'box') render3D(); // 박스 흔적 지우기
    }
    drag = null; cv3.style.cursor = cursor3D();
    saveV3Layout();
  };
  cv3.addEventListener('pointerup', end); cv3.addEventListener('pointercancel', end);
  cv3.addEventListener('wheel', (e) => {
    e.preventDefault();
    markInteract();
    { // 커서가 올라간 뷰포트에 줌 적용
      const rv = cv3.getBoundingClientRect();
      const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
      const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
      const vi = vpAt(pxv, pyv);
      if (vi !== v3.act) { v3.act = vi; loadVp(vi); }
    }
    // 델타 크기에 비례한 부드러운 줌 (한 칸 ≈ ×1.06)
    v3.zoom = Math.max(0.1, Math.min(20, v3.zoom * Math.pow(1.06, -(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY) / 100)));
    render3D();
  }, { passive: false });
  // 더블클릭: 사분할 ↔ 해당 뷰 최대화 (라이노식)
  cv3.addEventListener('dblclick', (e) => {
    const rv = cv3.getBoundingClientRect();
    const pxv = (e.clientX - rv.left) * (rv.width ? cv3.width / rv.width : 1);
    const pyv = (e.clientY - rv.top) * (rv.height ? cv3.height / rv.height : 1);
    if (v3.quad) { v3.act = vpAt(pxv, pyv); loadVp(v3.act); v3.quad = false; }
    else v3.quad = true;
    render3D(); saveV3Layout();
  });
  cv3.addEventListener('contextmenu', (e) => e.preventDefault());
  // 터치: 핀치 줌
  let pinch = null;
  cv3.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
  cv3.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      v3.zoom = Math.max(0.1, Math.min(20, v3.zoom * d / pinch)); pinch = d; markInteract(); render3D();
    }
  }, { passive: true });
  const setWallMode = (on) => {
    v3.wallMode = on; v3.wallP1 = null; v3.wallCur = null;
    cv3.style.cursor = cursor3D();
    if (on) logLine(`  ▷ 3D 벽 그리기: 바닥면(현재 층 레벨)을 클릭해 벽의 시작·끝점을 찍으세요 — 연속 그리기, Esc=종료`, 'info');
    render3D();
  };
  v3.setWallMode = setWallMode;
  { // 작업면 컨트롤
    const zi = ov.querySelector('#cpZ'), sl = ov.querySelector('#cpSlide');
    zi.value = cplaneZ(); sl.value = cplaneZ();
    zi.addEventListener('change', () => setCplane(parseFloat(zi.value)));
    sl.addEventListener('input', () => setCplane(parseFloat(sl.value)));
    ov.querySelector('#cpMinus').addEventListener('click', () => setCplane(cplaneZ() - 100));
    ov.querySelector('#cpPlus').addEventListener('click', () => setCplane(cplaneZ() + 100));
    ov.querySelector('#cpReset').addEventListener('click', () => { v3.cplane = null; setCplane(NaN); });
    zi.addEventListener('keydown', (e) => e.stopPropagation()); // 전역 단축키와 충돌 방지
  }
  window.addEventListener('resize', () => { if (ov.style.display !== 'none') { size3D(); render3D(); } });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || ov.style.display === 'none') return;
    e.stopPropagation(); // 전역 Escape 핸들러가 선택을 먼저 지워 2단계 판정이 깨지는 것 방지
    if (typeof boolPending !== 'undefined' && boolPending) { boolPending = null; logLine('  차집합 취소', 'info'); state.selection.clear(); renderProps(); render3D(); return; } // 차집합 2단계 취소
    if (v3.wallMode) { setWallMode(false); }                                          // 0차: 벽 그리기 종료
    else if (state.tool !== 'select') { setTool('select'); state.selection.clear(); renderProps(); render3D(); } // 0.5차: 도구 취소
    else if (state.selection.size) { state.selection.clear(); renderProps(); render3D(); } // 1차: 선택 해제
    // 평면 복귀는 상단 [평면|3D] 토글로만 — Esc로는 뷰를 바꾸지 않음
  }, true);
}
function close3D() {
  const ov = document.getElementById('bim3d');
  if (ov) ov.style.display = 'none';
  if (v3 && v3.wallMode && v3.setWallMode) v3.setWallMode(false);
  stopLive3D(); syncViewSeg(false); draw();
}
// 상단 뷰 세그먼트(평면/3D) — 항상 바인딩 (3D를 아직 안 열었어도 동작)
(function bindViewSeg() {
  const d = document.getElementById('vw3d'), p = document.getElementById('vwPlan');
  if (d) d.addEventListener('click', () => open3D());
  if (p) p.addEventListener('click', close3D);
  const q = document.getElementById('vwQuad');
  if (q) q.addEventListener('click', () => {
    const ov = document.getElementById('bim3d');
    if (!ov || ov.style.display === 'none') { open3D(); if (v3) { v3.quad = true; render3D(); saveV3Layout(); } }
    else { v3.quad = !v3.quad; render3D(); saveV3Layout(); }
  });
})();
// 3D 스냅: 클릭 지점 근처(화면 12px)의 끝점·중간점으로 흡착 (OSNAP 토글 존중)
function snap3D(px, py, w) {
  if (!osnapEnabled) return w;
  let best = null, bestD = 14 * (devicePixelRatio || 1);
  // 그리는 중인 자기 점들 (폴리라인 pts, 3D 선 시작, 벽 시작) — 닫기/복귀 스냅
  if (!settings.osnapModes || settings.osnapModes.endpoint !== false) {
    const selfPts = [];
    for (const p of pts) selfPts.push([p.x, p.y, cplaneZ()]);
    if (v3 && v3.line3d && v3.line3d.p1) selfPts.push([v3.line3d.p1.x, v3.line3d.p1.y, v3.line3d.p1.z]);
    if (v3 && v3.wallMode && v3.wallP1) selfPts.push([v3.wallP1[0], v3.wallP1[1], cplaneZ()]);
    for (const sp of selfPts) {
      const s = proj3D(sp[0], sp[1], sp[2]);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = { x: sp[0], y: sp[1], z: sp[2], kind: 'endpoint' }; }
    }
  }
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
    let cands = [];
    if (e.type === 'LINE') { // 3D 선: 정점별 z (z1/z2 없으면 평면 z)
      const za = e.z1 != null ? e.z1 : zb, zc = e.z2 != null ? e.z2 : zb;
      cands = [
        { x: e.x1, y: e.y1, z: za, kind: 'endpoint' },
        { x: e.x2, y: e.y2, z: zc, kind: 'endpoint' },
        { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, z: (za + zc) / 2, kind: 'midpoint' },
      ];
    } else {
      let eps = [], mps = [];
      try { eps = entityEndpoints(e); mps = entityMidpoints(e); } catch (_) { continue; }
      cands = eps.map(p => ({ x: p.x, y: p.y, z: zb, kind: 'endpoint' }))
        .concat(mps.map(p => ({ x: p.x, y: p.y, z: zb, kind: 'midpoint' })));
      if (e.type === 'CIRCLE' || e.type === 'ARC') cands.push({ x: e.cx, y: e.cy, z: zb, kind: 'center' }); // 중심 스냅
    }
    for (const p of cands) {
      if (!p || !isFinite(p.x)) continue;
      if (settings.osnapModes && settings.osnapModes[p.kind] === false) continue; // 2D와 동일한 종류별 토글 존중
      const s = proj3D(p.x, p.y, p.z);
      const d = Math.hypot(s[0] - px, s[1] - py);
      if (d < bestD) { bestD = d; best = { x: p.x, y: p.y, z: p.z, kind: p.kind }; }
    }
  }
  // 근접(nearest): 밑그림·3D선 세그먼트 위의 최근접점 (끝점류가 안 잡힐 때 변 위에 흡착)
  if (!best && (!settings.osnapModes || settings.osnapModes.nearest !== false)) {
    let nb = null, nd = 10 * (devicePixelRatio || 1);
    for (const e of state.entities) {
      const l = getLayer(e.layer); if (l && !l.visible) continue;
      const zb = (state.levels[e.lv || 0] || { elev: 0 }).elev + (e.zo || 0);
      let segs2 = [];
      if (e.type === 'LINE') segs2 = [[[e.x1, e.y1, e.z1 != null ? e.z1 : zb], [e.x2, e.y2, e.z2 != null ? e.z2 : zb]]];
      else if (e.type === 'LWPOLYLINE' && e.points) {
        for (let i = 0; i < e.points.length - (e.closed ? 0 : 1); i++) {
          const a = e.points[i], b = e.points[(i + 1) % e.points.length];
          segs2.push([[a[0], a[1], zb], [b[0], b[1], zb]]);
        }
      } else continue;
      for (const [A, B] of segs2) {
        const pa = proj3D(A[0], A[1], A[2]), pb = proj3D(B[0], B[1], B[2]);
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1], L2 = dx * dx + dy * dy;
        const tt = L2 ? Math.max(0, Math.min(1, ((px - pa[0]) * dx + (py - pa[1]) * dy) / L2)) : 0;
        const d = Math.hypot(px - (pa[0] + dx * tt), py - (pa[1] + dy * tt));
        if (d < nd) { nd = d; nb = { x: Math.round(A[0] + (B[0] - A[0]) * tt), y: Math.round(A[1] + (B[1] - A[1]) * tt), z: Math.round(A[2] + (B[2] - A[2]) * tt), kind: 'nearest' }; }
      }
    }
    if (nb) best = nb;
  }
  // 입체(BIM 솔리드) 모서리 꼭짓점 — 벽 상·하단 코너 등 3D 지오메트리에도 스냅
  if (!settings.osnapModes || settings.osnapModes.endpoint !== false) {
    for (const s of (v3.solids || [])) {
      const zt = s.zt || s.poly.map(() => s.z1);
      for (let i = 0; i < s.poly.length; i++) {
        for (const zz of [s.z0, zt[i]]) {
          const sp = proj3D(s.poly[i][0], s.poly[i][1], zz);
          const d = Math.hypot(sp[0] - px, sp[1] - py);
          if (d < bestD) { bestD = d; best = { x: s.poly[i][0], y: s.poly[i][1], z: zz, kind: 'endpoint' }; }
        }
      }
    }
  }
  return best || w;
}
// 3D 선: 클릭한 점의 실제 높이(스냅 z 또는 작업면 z)를 정점에 저장 — 서로 다른 높이의 꼭짓점 연결 가능
function line3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const u = unproj3D(px, py, cplaneZ());
  if (!u) return;
  const sn = snap3D(px, py, null);
  const pt = sn ? { x: sn.x, y: sn.y, z: sn.z != null ? sn.z : cplaneZ() }
               : { x: Math.round(u[0]), y: Math.round(u[1]), z: cplaneZ() };
  if (!v3.line3d) { v3.line3d = { p1: pt }; render3D(); return; }
  const p1 = v3.line3d.p1;
  if (Math.hypot(pt.x - p1.x, pt.y - p1.y) < 1 && Math.abs(pt.z - p1.z) < 1) return;
  pushUndo();
  const ln = addEntity({ type: 'LINE', x1: p1.x, y1: p1.y, x2: pt.x, y2: pt.y });
  const zb = lvElev();
  if (Math.abs(p1.z - zb) > 0.5 || Math.abs(pt.z - zb) > 0.5) { ln.z1 = p1.z; ln.z2 = pt.z; delete ln.zo; }
  v3.line3d = { p1: pt }; // 끝점에서 이어 그리기
  v3.solids = bimSolids();
  logLine(`  ✔ 3D 선 (${p1.x},${p1.y},${p1.z}) → (${pt.x},${pt.y},${pt.z}) · 길이 ${Math.round(Math.hypot(pt.x - p1.x, pt.y - p1.y, pt.z - p1.z))}`, 'ok');
  render3D();
}
// 평면 도구를 3D에서 사용: 클릭을 현재 층 바닥면으로 언프로젝션해 기존 도구 파이프라인(handleClick)에 전달
function tool3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const u = unproj3D(px, py, cplaneZ()); // 레이캐스팅: 뷰 광선 ∩ 작업면
  if (!u) return;
  const w = snap3D(px, py, { x: Math.round(u[0]), y: Math.round(u[1]) });
  // 스냅된 점이 다른 높이면 작업면을 그 높이로 이동 — 생성되는 도형이 스냅점 높이에 정확히 실림
  if (w.z != null && Math.abs(w.z - cplaneZ()) > 0.5) {
    setCplane(w.z);
    logLine(`  ▷ 작업면을 스냅점 높이 ${Math.round(w.z)}(으)로 이동 — 이 높이에 작도됩니다`, 'info');
  }
  handleClick(w, w, e);
  v3.solids = bimSolids(); render3D();
}
// 3D 벽 그리기: 클릭 → 층 바닥면에 언프로젝션 → 2점째에 벽(LINE+bim) 생성, 연속 체인
function wall3DClick(e) {
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  const w = unproj3D(px, py, cplaneZ());
  if (!w) return;
  const sn = snap3D(px, py, null);
  if (sn && sn.z != null && Math.abs(sn.z - cplaneZ()) > 0.5) { // 스냅점 높이로 작업면 이동 (벽 base 반영)
    setCplane(sn.z);
    logLine(`  ▷ 작업면을 스냅점 높이 ${Math.round(sn.z)}(으)로 이동 — 벽이 이 높이에서 시작됩니다`, 'info');
  }
  const pt = sn ? [sn.x, sn.y] : [Math.round(w[0] / 10) * 10, Math.round(w[1] / 10) * 10];
  if (!v3.wallP1) { v3.wallP1 = pt; v3.wallCur = pt; render3D(); return; }
  if (Math.hypot(pt[0] - v3.wallP1[0], pt[1] - v3.wallP1[1]) < 10) return; // 같은 점
  pushUndo();
  const ln = addEntity({ type: 'LINE', x1: v3.wallP1[0], y1: v3.wallP1[1], x2: pt[0], y2: pt[1] });
  ln.bim = { kind: 'wall', h: settings.bim.wallH, t: settings.bim.wallT, base: cplaneZ() };
  v3.wallP1 = pt; // 연속 그리기: 끝점이 다음 시작점
  v3.solids = bimSolids();
  logLine(`  ✔ 벽 생성 (${ln.x1},${ln.y1}) → (${ln.x2},${ln.y2}) · 길이 ${Math.round(Math.hypot(ln.x2 - ln.x1, ln.y2 - ln.y1))} — 평면에도 동시 반영`, 'ok');
  render3D();
}
// 3D 박스 선택 — 좌→우: 완전 포함(윈도우), 우→좌: 걸침(크로싱, 투영 bbox 겹침)
function applyBox3D(d) {
  const x0 = Math.min(d.bx0, d.bx1), x1 = Math.max(d.bx0, d.bx1);
  const y0 = Math.min(d.by0, d.by1), y1 = Math.max(d.by0, d.by1);
  if (x1 - x0 < 2 && y1 - y0 < 2) { render3D(); return; }
  const crossing = d.bx1 < d.bx0;
  const inBox = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  // 선분-사각형 교차 (양끝 밖이어도 박스를 가로지르면 참)
  const segHitsBox = (a, b) => {
    if (inBox(a) || inBox(b)) return true;
    const edges = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
    const cross2 = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    for (const [c1, c2] of edges) {
      const d1 = cross2(a, b, c1), d2 = cross2(a, b, c2), d3 = cross2(c1, c2, a), d4 = cross2(c1, c2, b);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
    return false;
  };
  const pts = new Map(), segs = new Map();
  const addP = (m, eid, v) => { let a = m.get(eid); if (!a) { a = []; m.set(eid, a); } a.push(v); };
  for (const f of (v3.faces || [])) if (f.eid != null) {
    for (let i = 0; i < f.pts.length; i++) { addP(pts, f.eid, f.pts[i]); addP(segs, f.eid, [f.pts[i], f.pts[(i + 1) % f.pts.length]]); }
  }
  for (const u of (v3.under || [])) {
    for (let i = 0; i < u.path.length; i++) {
      addP(pts, u.eid, u.path[i]);
      if (i < u.path.length - 1 || u.closed) addP(segs, u.eid, [u.path[i], u.path[(i + 1) % u.path.length]]);
    }
  }
  state.selection.clear();
  for (const [eid, arr] of pts) {
    if (crossing) { // 걸침: 실제로 점이 박스 안에 있거나 선분이 박스를 지나야 선택 (bbox 겹침 오선택 수정)
      if (arr.some(inBox) || (segs.get(eid) || []).some(([a, b]) => segHitsBox(a, b))) state.selection.add(eid);
    } else if (arr.every(inBox)) state.selection.add(eid);
  }
  renderProps(); render3D();
  logLine(`  ▷ 3D 박스 선택: ${state.selection.size}개 (${crossing ? '걸침' : '포함'})`, 'info');
}
// 3D 클릭 선택: 가장 앞(depth 최소) 면의 원본 엔티티
function pick3D(e, additive) {
  if (!v3 || !v3.faces) return;
  const r = v3.cv.getBoundingClientRect();
  const px = (e.clientX - r.left) * (r.width ? v3.cv.width / r.width : 1);
  const py = (e.clientY - r.top) * (r.height ? v3.cv.height / r.height : 1);
  pick3DAt(px, py, additive);
}
// 캔버스 픽셀 좌표로 선택 (테스트/내부용)
function pick3DAt(px, py, additive) {
  if (!v3 || !v3.faces) return;
  const inPoly = (pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  // 앞(depth 작은) 면부터
  let hit = [...v3.faces].sort((a, b) => a.d - b.d).find(f => f.eid != null && inPoly(f.pts));
  // 평면 밑그림(비 BIM 라인워크) 픽킹: 투영 경로와의 거리 + 깊이 비교(면보다 앞이면 밑그림 우선)
  if (v3.under && v3.under.length) {
    const tol = 8 * (devicePixelRatio || 1);
    let best = null, bestD = tol, bestDepth = Infinity;
    for (const u of v3.under) {
      const n = u.path.length;
      for (let i = 0; i < (u.closed ? n : n - 1); i++) {
        const a = u.path[i], b = u.path[(i + 1) % n];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2)) : 0;
        const d = Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
        if (d < bestD) { bestD = d; best = u; bestDepth = a[2] + (b[2] - a[2]) * t; }
      }
    }
    if (best && (!hit || bestDepth < hit.d)) hit = { eid: best.eid };
  }
  if (!additive) state.selection.clear();
  if (hit) {
    if (additive && state.selection.has(hit.eid)) state.selection.delete(hit.eid);
    else state.selection.add(hit.eid);
  }
  renderProps(); render3D();
}

// ============================================================
//  BIM 3·4단계 — 단면(section)/입면(elevation) 자동 추출
//  절단선(수직 평면) ∩ 기둥체 = 사각형이라는 성질을 이용해
//  새 문서 탭에 2D 단면/입면 도면을 생성한다.
// ============================================================
// 무한선(p1, 방향 u) ∩ 다각형 → 선 위 파라미터 s의 내부 구간들
function lineClipPoly(p1, u, poly) {
  const cross = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const rx = b[0] - a[0], ry = b[1] - a[1];
    // p1 + s*u = a + t*(b-a) 연립
    const det2 = u.x * (-ry) + rx * u.y;
    if (Math.abs(det2) < 1e-12) continue;
    const s = ((a[0] - p1.x) * (-ry) + rx * (a[1] - p1.y)) / det2;
    const t2 = (u.x * (a[1] - p1.y) - u.y * (a[0] - p1.x)) / det2;
    if (t2 >= 0 && t2 < 1) cross.push(s);
  }
  cross.sort((x, y) => x - y);
  const iv = [];
  for (let i = 0; i + 1 < cross.length; i += 2) iv.push([cross[i], cross[i + 1]]);
  return iv;
}
let secCount = 0, elevCount = 0;
function clickSection(w, isElev) {
  const name = isElev ? 'elevation' : 'section';
  if (!cmdOp || cmdOp.name !== name) cmdOp = { name, step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt((isElev ? '입면' : '단면') + ': 선의 끝 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'p2') {
    if (Math.hypot(w.x - cmdOp.p1.x, w.y - cmdOp.p1.y) < 1e-6) return;
    cmdOp.p2 = w; cmdOp.step = 'dir';
    setPrompt((isElev ? '입면' : '단면') + ': 바라볼 방향(선의 어느 쪽인지)을 클릭하세요.'); return;
  }
  // dir 단계
  const p1 = cmdOp.p1, p2 = cmdOp.p2;
  const L = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const u = { x: (p2.x - p1.x) / L, y: (p2.y - p1.y) / L };
  let nrm = { x: -u.y, y: u.x };
  const side = (w.x - p1.x) * nrm.x + (w.y - p1.y) * nrm.y;
  if (side < 0) nrm = { x: u.y, y: -u.x };
  const depth = bimAskNum('투영 깊이 (mm — 이 거리 안의 요소를 뒤 배경으로 표시):', 20000);
  if (depth == null) { cmdOp = { name, step: 'p1' }; return; }
  genSectionView(p1, u, nrm, L, depth, isElev);
  cmdOp = { name, step: 'p1' }; previewEnts = null;
  setPrompt((isElev ? '입면' : '단면') + ': 첫 점을 클릭하세요. (연속, Esc 종료)');
}
function genSectionView(p1, u, nrm, lineLen, depth, isElev) {
  const solids = bimSolids();
  if (!solids.length) { logLine('  BIM 요소가 없습니다 — 먼저 wall/slab/column을 지정하세요.', 'warn'); return; }
  const label = isElev ? `입면-${++elevCount}` : `단면-${++secCount}`;
  const cuts = [], projs = [];
  let smin = 1e18, smax = -1e18, zmin = 0, zmax = -1e18;
  for (const s of solids) {
    const dvals = s.poly.map(v => (v[0] - p1.x) * nrm.x + (v[1] - p1.y) * nrm.y);
    const svals = s.poly.map(v => (v[0] - p1.x) * u.x + (v[1] - p1.y) * u.y);
    const dmin = Math.min(...dvals), dmax = Math.max(...dvals);
    const sZ1 = s.zt ? Math.max(...s.zt) : s.z1;
    zmin = Math.min(zmin, s.z0); zmax = Math.max(zmax, sZ1);
    if (!isElev && dmin < -1e-6 && dmax > 1e-6) {
      // 절단됨: 선과 풋프린트의 교차 구간 → 사각형
      for (const [s0, s1] of lineClipPoly(p1, u, s.poly)) {
        if (s.zt) {
          // 경사 상단: 절단선 위 두 점의 상단 높이 → 사다리꼴
          const A = { x: p1.x + u.x * s0, y: p1.y + u.y * s0 }, B = { x: p1.x + u.x * s1, y: p1.y + u.y * s1 };
          cuts.push({ s0, s1, z0: s.z0, z1: null, zA: solidTopZ(s, A.x, A.y), zB: solidTopZ(s, B.x, B.y), glass: s.glass });
        } else cuts.push({ s0, s1, z0: s.z0, z1: s.z1, glass: s.glass });
        smin = Math.min(smin, s0); smax = Math.max(smax, s1);
      }
    } else if (dmin > 1e-6 && dmin <= depth) {
      // 앞쪽(바라보는 방향)에 있음 → 투영
      const ps0 = Math.min(...svals), ps1 = Math.max(...svals);
      if (s.zt) {
        // 경사 지붕 프로파일: 꼭짓점 (s, zt) 상부 외곽선
        const vps = s.poly.map((v, i) => [svals[i], s.zt[i]]).sort((a, b) => a[0] - b[0]);
        const env = []; // s별 최대 z (상부 포락선)
        for (const [sv, zv] of vps) {
          const last = env[env.length - 1];
          if (last && Math.abs(last[0] - sv) < 1) { last[1] = Math.max(last[1], zv); }
          else env.push([sv, zv]);
        }
        projs.push({ profile: env, s0: ps0, s1: ps1, z0: s.z0, glass: s.glass, d: dmin });
      } else projs.push({ s0: ps0, s1: ps1, z0: s.z0, z1: s.z1, glass: s.glass, d: dmin });
      smin = Math.min(smin, ps0); smax = Math.max(smax, ps1);
    }
  }
  if (!cuts.length && !projs.length) {
    logLine('  이 위치에서는 절단/투영되는 BIM 요소가 없습니다. 선 위치와 방향을 확인하세요.', 'warn'); return;
  }
  // ── 새 탭에 도면 생성 ──
  newDocTab();
  ensureLayer('투영', '#8a94a8');
  ensureLayer('절단', '#e8e2d6');
  ensureLayer('유리', '#7ec8ff');
  // 지반선 + 층 레벨선 (원본 도면의 층 정보)
  const srcLevels = (state.levels || []).slice();
  addEntity({ type: 'LINE', layer: '투영', linetype: 'center', x1: smin - 500, y1: 0, x2: smax + 500, y2: 0 });
  // 투영(먼 것부터 그려 순서 유지)
  projs.sort((a, b) => b.d - a.d);
  for (const p of projs) {
    if (p.profile) { // 경사 지붕: 바닥 + 상부 프로파일 폴리곤
      const pts = [[p.s0, p.z0], [p.s1, p.z0]];
      for (let i = p.profile.length - 1; i >= 0; i--) pts.push([p.profile[i][0], p.profile[i][1]]);
      addEntity({ type: 'LWPOLYLINE', layer: '투영', closed: true, points: pts });
    } else {
      addEntity({ type: 'LWPOLYLINE', layer: p.glass ? '유리' : '투영', closed: true,
        points: [[p.s0, p.z0], [p.s1, p.z0], [p.s1, p.z1], [p.s0, p.z1]] });
    }
  }
  // 절단(외곽 + 해치)
  for (const c of cuts) {
    const pts = c.z1 == null
      ? [[c.s0, c.z0], [c.s1, c.z0], [c.s1, c.zB], [c.s0, c.zA]]
      : [[c.s0, c.z0], [c.s1, c.z0], [c.s1, c.z1], [c.s0, c.z1]];
    addEntity({ type: 'LWPOLYLINE', layer: '절단', closed: true, points: pts, lineweight: 50 });
    if (!c.glass) addEntity({ type: 'HATCH', layer: '절단', pattern: 'ansi31',
      spacing: Math.max(60, (c.s1 - c.s0) / 3), boundary: { kind: 'poly', points: pts } });
  }
  // 층 레벨선 + 레벨 라벨
  for (const lvv of srcLevels) {
    if (lvv.elev !== 0) addEntity({ type: 'LINE', layer: '투영', linetype: 'dashed', x1: smin - 500, y1: lvv.elev, x2: smax + 500, y2: lvv.elev });
    addEntity({ type: 'TEXT', layer: '투영', x: smax + 600, y: lvv.elev - 100, height: 250,
      text: `${lvv.name}  ${lvv.elev >= 0 ? '+' : ''}${lvv.elev}`, rotation: 0 });
  }
  // 라벨
  addEntity({ type: 'TEXT', layer: '투영', x: smin, y: zmax + 400, height: 300, text: label + (isElev ? '' : ' (절단 해치 = 잘린 부분)'), rotation: 0 });
  setFileName(label, null);
  renderDocTabs(); renderLayers(); updateStat(); zoomFit();
  logLine(`  ✔ ${label} 생성 — 절단 ${cuts.length}개 · 투영 ${projs.length}개 (새 탭, 치수·수정·DXF 저장 가능)`, 'ok');
  if (window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage(isElev ? 'elevation' : 'section');
}

// ============================================================
//  층(Level) UI — 그리기 설정의 층 선택/추가, 고스트 토글
// ============================================================
function renderLevels() {
  const sel = document.getElementById('curLv');
  if (!sel) return;
  sel.innerHTML = state.levels.map((l, i) =>
    `<option value="${i}" ${i === state.curLv ? 'selected' : ''}>${escapeHtml(l.name)} (${l.elev})</option>`).join('');
  const g = document.getElementById('lvGhost');
  if (g) g.checked = !!state.ghostLv;
}
(function bindLevels() {
  const sel = document.getElementById('curLv');
  if (!sel) return;
  sel.addEventListener('change', () => {
    state.curLv = parseInt(sel.value, 10) || 0;
    state.selection.clear(); renderProps(); draw();
    logLine(`  ▷ 현재 층: ${state.levels[state.curLv].name} (레벨 ${state.levels[state.curLv].elev}) — 새 도형·BIM은 이 층에 생성됩니다`, 'info');
  });
  document.getElementById('lvAdd').addEventListener('click', () => {
    const last = state.levels[state.levels.length - 1];
    const name = prompt('새 층 이름:', `${state.levels.length + 1}F`);
    if (!name) return;
    const elev = parseFloat(prompt('레벨(바닥 높이, mm):', last.elev + 3000));
    if (!isFinite(elev)) return;
    state.levels.push({ name, elev });
    state.curLv = state.levels.length - 1;
    renderLevels(); state.selection.clear(); renderProps(); draw();
    logLine(`  ✔ 층 추가: ${name} (레벨 ${elev}) — 아래층이 흐리게 비칩니다(참조용)`, 'ok');
  });
  document.getElementById('lvGhost').addEventListener('change', (ev) => { state.ghostLv = ev.target.checked; draw(); });
})();
function cmdLevelInfo() {
  logLine('  층 목록: ' + state.levels.map((l, i) => `${i === state.curLv ? '▶' : ''}${l.name}(${l.elev})`).join(' · ') +
    ' — 그리기 설정 패널에서 전환/추가', 'info');
}

// ====== 도형 길이/면적 헬퍼 ======
function entityLength(e) {
  if (e.type === 'LINE') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (e.type === 'LWPOLYLINE') return polyPerimeter(e.points, !!e.closed);
  if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
  if (e.type === 'ARC') { const sw = norm360(e.endAngle - e.startAngle) || 360; return e.r * sw * Math.PI / 180; }
  return 0;
}
function entityArea2(e) {
  if (e.type === 'CIRCLE') return Math.PI * e.r * e.r;
  if (e.type === 'LWPOLYLINE' && e.closed) return polyArea(e.points);
  if (e.type === 'HATCH') { const b = e.boundary; return b.kind === 'circle' ? Math.PI * b.r * b.r : polyArea(b.points); }
  return 0;
}

// ====== ROOF — 지붕 지정 (사각 풋프린트: 박공/외쪽/평) ======
// ============================================================
//  솔리드 불리언 (합집합·차집합·교집합) — BSP 기반 CSG (외부 의존 없음)
//  Evan Wallace csg.js(MIT) 알고리즘을 삼각형 메시용으로 압축 구현
// ============================================================
const CSG_EPS = 1e-5;
function csgPlane(a, b, c) {
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
  const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
  const l = Math.hypot(nx,ny,nz) || 1; nx/=l; ny/=l; nz/=l;
  return { n:[nx,ny,nz], w:nx*a[0]+ny*a[1]+nz*a[2] };
}
function csgLerp(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
// 다각형: {v:[[x,y,z]...], plane}
function csgSplit(pl, poly, coF, coB, front, back) {
  const COP=0, FR=1, BK=2, SP=3;
  let polyType = 0; const types = [];
  for (const p of poly.v) {
    const t = pl.n[0]*p[0]+pl.n[1]*p[1]+pl.n[2]*p[2] - pl.w;
    const type = t < -CSG_EPS ? BK : t > CSG_EPS ? FR : COP;
    polyType |= type; types.push(type);
  }
  if (polyType === COP) { (pl.n[0]*poly.plane.n[0]+pl.n[1]*poly.plane.n[1]+pl.n[2]*poly.plane.n[2] > 0 ? coF : coB).push(poly); }
  else if (polyType === FR) front.push(poly);
  else if (polyType === BK) back.push(poly);
  else {
    const f=[], b=[], n=poly.v.length;
    for (let i=0;i<n;i++){
      const j=(i+1)%n, ti=types[i], tj=types[j], vi=poly.v[i], vj=poly.v[j];
      if (ti!==BK) f.push(vi);
      if (ti!==FR) b.push(vi);
      if ((ti|tj)===SP){
        const t=(pl.w - (pl.n[0]*vi[0]+pl.n[1]*vi[1]+pl.n[2]*vi[2])) / (pl.n[0]*(vj[0]-vi[0])+pl.n[1]*(vj[1]-vi[1])+pl.n[2]*(vj[2]-vi[2]));
        const m=csgLerp(vi,vj,t); f.push(m); b.push(m);
      }
    }
    if (f.length>=3) front.push({v:f, plane:poly.plane});
    if (b.length>=3) back.push({v:b, plane:poly.plane});
  }
}
function csgNode(polys) { const nd={plane:null, front:null, back:null, polys:[]}; if (polys) csgBuild(nd, polys); return nd; }
function csgBuild(nd, polys) {
  if (!polys.length) return;
  if (!nd.plane) nd.plane = polys[0].plane;
  const f=[], b=[];
  for (const p of polys) csgSplit(nd.plane, p, nd.polys, nd.polys, f, b);
  if (f.length){ if(!nd.front) nd.front=csgNode(); csgBuild(nd.front, f); }
  if (b.length){ if(!nd.back) nd.back=csgNode(); csgBuild(nd.back, b); }
}
function csgInvert(nd) {
  for (const p of nd.polys) { p.v.reverse(); p.plane={n:[-p.plane.n[0],-p.plane.n[1],-p.plane.n[2]], w:-p.plane.w}; }
  nd.plane={n:[-nd.plane.n[0],-nd.plane.n[1],-nd.plane.n[2]], w:-nd.plane.w};
  const t=nd.front; nd.front=nd.back; nd.back=t;
  if (nd.front) csgInvert(nd.front); if (nd.back) csgInvert(nd.back);
}
function csgClipPolys(nd, polys) {
  if (!nd.plane) return polys.slice();
  let f=[], b=[];
  for (const p of polys) csgSplit(nd.plane, p, f, b, f, b);
  if (nd.front) f=csgClipPolys(nd.front, f); else f=f;
  if (nd.back) b=csgClipPolys(nd.back, b); else b=[];
  return f.concat(b);
}
function csgClipTo(nd, other) { nd.polys=csgClipPolys(other, nd.polys); if (nd.front) csgClipTo(nd.front, other); if (nd.back) csgClipTo(nd.back, other); }
function csgAll(nd) { let r=nd.polys.slice(); if (nd.front) r=r.concat(csgAll(nd.front)); if (nd.back) r=r.concat(csgAll(nd.back)); return r; }
function csgOp(pa, pb, op) {
  const a=csgNode(pa.map(csgClonePoly)), b=csgNode(pb.map(csgClonePoly));
  if (op==='union') {
    csgClipTo(a,b); csgClipTo(b,a); csgInvert(b); csgClipTo(b,a); csgInvert(b);
    csgBuild(a, csgAll(b)); return csgAll(a);
  }
  if (op==='intersect') {
    csgInvert(a); csgClipTo(b,a); csgInvert(b); csgClipTo(a,b); csgClipTo(b,a);
    csgBuild(a, csgAll(b)); csgInvert(a); return csgAll(a);
  }
  // subtract (A - B)
  csgInvert(a); csgClipTo(a,b); csgClipTo(b,a); csgInvert(b); csgClipTo(b,a); csgInvert(b);
  csgBuild(a, csgAll(b)); csgInvert(a); return csgAll(a);
}
function csgClonePoly(p){ return {v:p.v.map(x=>x.slice()), plane:{n:p.plane.n.slice(), w:p.plane.w}}; }
function trisToPolys(tris){ const r=[]; for(const t of tris){ if(t.length<3) continue; r.push({v:t.map(p=>p.slice()), plane:csgPlane(t[0],t[1],t[2])}); } return r; }
function polysToTris(polys){ const r=[]; for(const p of polys){ for(let i=1;i+1<p.v.length;i++) r.push([p.v[0].slice(), p.v[i].slice(), p.v[i+1].slice()]); } return r; }
// 엔티티(솔리드/메시)를 삼각형 배열로
function entityToTris(e){
  if (e.type==='MESH') return e.tris.map(t=>t.map(p=>p.slice()));
  return solidsToTris(new Set([e.id]));
}
let boolPending = null; // 라이노식 차집합 2단계: {keepIds}
function isBoolable(e){ return e.type==='MESH' || (e.bim && ['wall','column','slab','stair','roof'].includes(e.bim.kind)); }
function boolRefresh(){ const ov = document.getElementById('bim3d'); if (ov && ov.style.display !== 'none') { v3.solids = bimSolids(); render3D(); } else { renderProps(); draw(); } }
// keepEnts를 union한 뒤 op(union/intersect/subtract)로 cutterEnts 적용 → 결과 메시
function runBoolean(op, keepEnts, cutterEnts){
  let acc = null;
  for (const e of keepEnts){ const p = trisToPolys(entityToTris(e)); if (p.length) acc = acc ? csgOp(acc, p, 'union') : p; }
  if (!acc || !acc.length){ logLine('  불리언: 베이스 입체에서 면을 얻지 못했습니다.', 'warn'); return; }
  for (const e of cutterEnts){ const p = trisToPolys(entityToTris(e)); if (p.length) acc = csgOp(acc, p, op); }
  const tris = polysToTris(acc);
  if (!tris.length){ logLine('  불리언 결과가 비었습니다 — 입체가 겹치는지 확인하세요.', 'warn'); return; }
  pushUndo();
  const ids = new Set(keepEnts.concat(cutterEnts).map(e=>e.id));
  state.entities = state.entities.filter(e=>!ids.has(e.id));
  const m = addEntity({ type:'MESH', tris, color:'#a7b0c4' });
  const koOp = op==='union' ? '합집합' : op==='intersect' ? '교집합' : '차집합';
  logLine('  ✔ ' + koOp + ' 완료 → 메시 ' + tris.length + '개 삼각형', 'ok');
  state.selection.clear(); state.selection.add(m.id); boolRefresh();
}
function cmdBoolean(op){
  const sel = selectedEntities().filter(isBoolable);
  if (op==='subtract'){ // 라이노 BooleanDifference: 남길 입체 선택 → 명령 → 잘라낼 입체 선택 → Enter
    if (!sel.length){ logLine('  차집합: 먼저 남길(베이스) 입체를 선택한 뒤 실행하세요.', 'warn'); return; }
    boolPending = { keepIds: sel.map(e=>e.id) };
    state.selection.clear();
    logLine('  ▷ 차집합: 이제 잘라낼(빼낼) 입체를 선택한 뒤 Enter (Esc=취소)', 'info');
    boolRefresh(); return;
  }
  if (sel.length < 2){ logLine('  ' + (op==='union'?'합집합':'교집합') + ': 입체 2개 이상을 선택하세요.', 'warn'); return; }
  runBoolean(op, [sel[0]], sel.slice(1)); // union/intersect는 순서 무관 (누적)
}
function boolFinish(){ // Enter 시 차집합 2단계 마무리
  const cutters = selectedEntities().filter(isBoolable);
  const keep = boolPending.keepIds.map(id => state.entities.find(e=>e.id===id)).filter(Boolean);
  boolPending = null;
  if (!keep.length){ logLine('  차집합 취소 — 베이스 입체가 없습니다.', 'warn'); boolRefresh(); return; }
  if (!cutters.length){ logLine('  차집합 취소 — 잘라낼 입체가 선택되지 않았습니다.', 'warn'); boolRefresh(); return; }
  runBoolean('subtract', keep, cutters);
}
// 3D 내보내기 — 모든 입체(bimSolids)를 삼각형화해 STL/OBJ 파일로 (mm 단위)
function solidsToTris(onlyIds) {
  const tris = [];
  for (const s of bimSolids()) {
    if (onlyIds && !onlyIds.has(s.eid)) continue; // 선택 객체만
    const n = s.poly.length;
    const zt = s.zt || s.poly.map(() => s.z1);
    const top = s.poly.map((p, i) => [p[0], p[1], zt[i]]);
    const bot = s.poly.map(p => [p[0], p[1], s.z0]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push([bot[i], bot[j], top[j]], [bot[i], top[j], top[i]]); // 측면
    }
    for (let i = 1; i < n - 1; i++) { // 상·하면 (팬 분할)
      tris.push([top[0], top[i], top[i + 1]]);
      tris.push([bot[0], bot[i + 1], bot[i]]);
    }
  }
  return tris;
}
function dl3d(text, name, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function cmdExportSTL(onlyIds, nameSuffix) {
  const tris = solidsToTris(onlyIds);
  if (!tris.length) { logLine('  내보낼 3D 입체가 없습니다 — 벽·기둥·extrudecrv 등으로 입체를 만든 뒤 실행하세요.', 'warn'); return; }
  const L = ['solid webcad'];
  for (const t of tris) {
    L.push(' facet normal 0 0 0', '  outer loop');
    for (const v of t) L.push('   vertex ' + v[0].toFixed(3) + ' ' + v[1].toFixed(3) + ' ' + v[2].toFixed(3));
    L.push('  endloop', ' endfacet');
  }
  L.push('endsolid webcad', '');
  dl3d(L.join(String.fromCharCode(10)), (nameSuffix || 'webcad-3d') + '.stl', 'model/stl');
  logLine('  ✔ STL 내보내기 — 삼각형 ' + tris.length + '개, mm 단위 (라이노·스케치업에서 가져오기 가능)', 'ok');
}
function cmdExportOBJ(onlyIds, nameSuffix) {
  const tris = solidsToTris(onlyIds);
  if (!tris.length) { logLine('  내보낼 3D 입체가 없습니다 — 벽·기둥·extrudecrv 등으로 입체를 만든 뒤 실행하세요.', 'warn'); return; }
  const V = ['# WebCAD OBJ (mm)'], F = [];
  let idx = 1;
  for (const t of tris) {
    for (const p of t) V.push('v ' + p[0].toFixed(3) + ' ' + p[1].toFixed(3) + ' ' + p[2].toFixed(3));
    F.push('f ' + idx + ' ' + (idx + 1) + ' ' + (idx + 2)); idx += 3;
  }
  dl3d(V.concat(F).join(String.fromCharCode(10)), (nameSuffix || 'webcad-3d') + '.obj', 'text/plain');
  logLine('  ✔ OBJ 내보내기 — 삼각형 ' + tris.length + '개, mm 단위', 'ok');
}
// 3D 작업 명령 세트(라이노식) — move3d/copy3d/box/cylinder/settop
function ask3(msg, def) {
  const s = prompt(msg, def); if (s == null) return null;
  const p = String(s).split(',').map(Number);
  return (p.length >= 2 && p.slice(0, 2).every(isFinite)) ? p : null;
}
function zShift3(e, dz) { if (dz) gumMove(e, { vz: 1 }, Math.round(dz)); }
function cmdMove3D(copy) {
  const sel = selectedEntities();
  if (!sel.length) { logLine(`  ${copy ? 'copy3d' : 'move3d'}: 객체를 선택한 뒤 실행하세요.`, 'warn'); return; }
  const v = ask3(`${copy ? '복사' : '이동'}량 dx,dy,dz (mm):`, '0,0,0'); if (!v) return;
  const dx = v[0] || 0, dy = v[1] || 0, dz = v[2] || 0;
  pushUndo();
  let targets = sel;
  if (copy) targets = sel.map(e => {
    const c = JSON.parse(JSON.stringify(e)); delete c.id;
    const zo = c.zo; const n = addEntity(c);
    if (zo != null) n.zo = zo; else delete n.zo;
    return n;
  });
  for (const e of targets) { translateEntity(e, dx, dy); zShift3(e, dz); }
  state.selection.clear(); targets.forEach(e => state.selection.add(e.id));
  logLine(`  ✔ ${copy ? 'Copy3D' : 'Move3D'} (${dx}, ${dy}, ${dz}) — ${targets.length}개`, 'ok');
  renderProps(); draw();
}
function cmdBox() {
  const a = ask3('상자 모서리1 x,y:', '0,0'); if (!a) return;
  const b = ask3('상자 모서리2 x,y:', '3000,3000'); if (!b) return;
  const h = bimAskNum('높이 (mm):', settings.bim.wallH); if (h == null) return;
  pushUndo();
  const e = addEntity({ type: 'LWPOLYLINE', closed: true, points: [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]] });
  e.bim = { kind: 'column', h, base: cplaneZ() }; delete e.zo;
  logLine(`  ✔ Box (${a[0]},${a[1]})~(${b[0]},${b[1]}) 높이 ${h} · 바닥 z=${cplaneZ()}`, 'ok');
  renderProps(); draw();
}
function cmdCylinder() {
  const c0 = ask3('원기둥 중심 x,y:', '0,0'); if (!c0) return;
  const r = bimAskNum('반지름 (mm):', 500); if (r == null) return;
  const h = bimAskNum('높이 (mm):', settings.bim.wallH); if (h == null) return;
  pushUndo();
  const e = addEntity({ type: 'CIRCLE', cx: c0[0], cy: c0[1], r });
  e.bim = { kind: 'column', h, base: cplaneZ() }; delete e.zo;
  logLine(`  ✔ Cylinder r=${r} 높이 ${h} · 바닥 z=${cplaneZ()}`, 'ok');
  renderProps(); draw();
}
function cmdSetTop() {
  const sel = selectedEntities().filter(e => e.bim && ['wall', 'column', 'stair'].includes(e.bim.kind));
  if (!sel.length) { logLine('  settop: 벽·기둥·계단(돌출체)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const z = bimAskNum('상단 높이 z (mm):', lvElev() + settings.bim.wallH); if (z == null) return;
  pushUndo();
  for (const e of sel) e.bim.h = Math.max(10, Math.round(z - (e.bim.base || 0)));
  logLine(`  ✔ SetTop: ${sel.length}개 상단을 z=${z}(으)로 정렬`, 'ok');
  renderProps(); draw();
}
// ExtrudeCrv(라이노식): 곡선을 수직 돌출 — 닫힌 곡선=솔리드, 열린 곡선=두께 없는 면(서피스)
function cmdExtrudeCrv() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'CIRCLE');
  if (!sel.length) { logLine('  extrudecrv: 돌출할 곡선(선·폴리라인·원)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const h = bimAskNum('돌출 높이 (mm):', settings.bim.wallH); if (h == null) return;
  const solidOpt = String(prompt('출력 — 1: 서피스(면만)  2: 솔리드(속 채움)', '1') || '1').trim() === '2';
  pushUndo();
  // 같은 모양의 안팎 이중 외곽선(스케일/오프셋 쌍) → 간격을 두께로 하는 벽체 서피스 (건물 벽체)
  if (sel.length === 2 && sel.every(e => e.type === 'LWPOLYLINE' && e.closed && e.points.length >= 3)) {
    const inPoly = (p, poly) => { let ins = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) ins = !ins;
      } return ins; };
    let outer = null, inner = null;
    if (sel[1].points.every(p => inPoly(p, sel[0].points))) { outer = sel[0]; inner = sel[1]; }
    else if (sel[0].points.every(p => inPoly(p, sel[1].points))) { outer = sel[1]; inner = sel[0]; }
    if (outer && inner && outer.points.length === inner.points.length) {
      const op = outer.points, n2 = op.length;
      const dists = [], mids = [];
      for (const p of inner.points) {
        let bd = Infinity, bx = 0, by = 0;
        for (let i = 0; i < n2; i++) {
          const a = op[i], b2 = op[(i + 1) % n2];
          const q = closestOnSeg(p[0], p[1], a[0], a[1], b2[0], b2[1]);
          const qx = q.x != null ? q.x : q[0], qy = q.y != null ? q.y : q[1];
          const d = Math.hypot(p[0] - qx, p[1] - qy);
          if (d < bd) { bd = d; bx = qx; by = qy; }
        }
        dists.push(bd); mids.push([(p[0] + bx) / 2, (p[1] + by) / 2]);
      }
      const t = Math.round(dists.reduce((a, b) => a + b, 0) / dists.length);
      const uniform = Math.max(...dists) - Math.min(...dists) < Math.max(2, t * 0.25); // 스케일 쌍은 간격 약간 비균일 허용
      if (t > 0.5 && uniform) {
        const base = lvElev() + (outer.zo || 0);
        const ids = new Set([outer.id, inner.id]);
        state.entities = state.entities.filter(e => !ids.has(e.id));
        const ln = addEntity({ type: 'LWPOLYLINE', closed: true, points: mids });
        ln.bim = { kind: 'wall', h, t, base }; delete ln.zo;
        state.selection.clear(); state.selection.add(ln.id);
        logLine(`  ✔ ExtrudeCrv: 이중 외곽선 → 두께 ${t} 벽체 서피스 (높이 ${h}, 바닥 z=${base})`, 'ok');
        renderProps(); draw();
        return;
      }
    }
  }
  let nOpen = 0, nClosed = 0, nSlant = 0;
  for (const e of sel) {
    let base = lvElev() + (e.zo || 0); // 공중에 띄운 곡선은 그 높이에서 돌출
    if (e.type === 'LINE' && (e.z1 != null || e.z2 != null)) { // 3D 선: 실제 곡선 높이에서 돌출
      base = Math.min(e.z1 || 0, e.z2 || 0);
      if ((e.z1 || 0) !== (e.z2 || 0)) nSlant++;
      delete e.z1; delete e.z2; // 수직 프리즘으로 전환 — 곡선 높이는 base로 이관
    }
    if (solidOpt && (e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed))) {
      e.bim = { kind: 'column', h, base }; nClosed++; // 솔리드 옵션: 캡 있는 기둥체
    } else { e.bim = { kind: 'wall', h, t: 0, base }; nOpen++; } // 기본: 두께 0의 진짜 서피스 (라이노 ExtrudeCrv)
    delete e.zo;
  }
  if (nSlant) logLine(`  ⚠ 기울어진 3D 선 ${nSlant}개는 낮은 끝 높이 기준으로 수직 돌출했습니다`, 'warn');
  logLine(`  ✔ ExtrudeCrv: 서피스 ${nOpen}개, 솔리드 ${nClosed}개 생성 — 서피스에 두께를 주려면 extrudesrf`, 'ok');
  renderProps(); draw();
}
// ExtrudeSrf(라이노식): 면(서피스)에 두께 부여 — 돌출된 면은 벽 두께, 닫힌 평면 곡선은 슬래브 두께
function cmdExtrudeSrf() {
  const sel = selectedEntities();
  const srf = sel.filter(e => e.bim && e.bim.kind === 'wall');
  const flat = sel.filter(e => !e.bim && ((e.type === 'LWPOLYLINE' && e.closed) || e.type === 'CIRCLE'));
  if (!srf.length && !flat.length) { logLine('  extrudesrf: 서피스(돌출된 면) 또는 닫힌 평면 곡선을 선택한 뒤 실행하세요.', 'warn'); return; }
  const t = bimAskNum('두께 (mm):', settings.bim.wallT); if (t == null) return;
  pushUndo();
  for (const e of srf) e.bim.t = t;
  for (const e of flat) { e.bim = { kind: 'slab', t, top: lvElev() + (e.zo || 0) + t }; delete e.zo; }
  logLine(`  ✔ ExtrudeSrf: ${srf.length + flat.length}개에 두께 ${t} 적용`, 'ok');
  renderProps(); draw();
}
// 계단: LINE = 진행선(시작=아래, 끝=위). 단수 n = ceil(h/최대단높이), 단별 수직 프리즘.
function cmdStairTag() {
  const sel = selectedEntities().filter(e => e.type === 'LINE');
  if (!sel.length) { logLine('  계단: 진행 방향 선(시작=아랫단, 끝=윗단)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const w = bimAskNum('계단 폭 (mm):', settings.bim.stairW); if (w == null) return;
  const h = bimAskNum('총 높이 (오르는 높이, mm):', 3000); if (h == null) return;
  const riser = bimAskNum('최대 단높이 (mm):', settings.bim.stairRiser); if (riser == null) return;
  settings.bim.stairW = w; settings.bim.stairRiser = riser; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'stair', w, h, riser, base: (e.bim && e.bim.base != null) ? e.bim.base : lvElev() };
  const n = Math.max(1, Math.ceil(h / riser));
  logLine(`  ✔ 계단 지정 ${sel.length}개 — ${n}단 (단높이 ${(h / n).toFixed(0)}, 폭 ${w}) · 선 방향이 올라가는 방향`, 'ok');
  renderProps(); draw();
}
function stairSolids(e) {
  const b = e.bim, base = b.base || 0, h = b.h || 0, w = b.w || 1200;
  const L = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  if (L < 1e-6 || h <= 0) return [];
  const n = Math.max(1, Math.ceil(h / (b.riser || 180)));
  const ux = (e.x2 - e.x1) / L, uy = (e.y2 - e.y1) / L;
  const nx = -uy * w / 2, ny = ux * w / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s0 = L * i / n, s1 = L * (i + 1) / n;
    const ax = e.x1 + ux * s0, ay = e.y1 + uy * s0, bx = e.x1 + ux * s1, by = e.y1 + uy * s1;
    out.push({ poly: [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], z0: base, z1: base + h * (i + 1) / n, color: '#b9b2a6' });
  }
  return out;
}
function cmdRoofTag() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' && e.closed);
  if (!sel.length) { logLine('  지붕: 닫힌 폴리라인(지붕 외곽)을 선택한 뒤 실행하세요.', 'warn'); return; }
  const tp = prompt('지붕 유형 — 1: 박공(gable)  2: 외쪽(shed)  3: 평(flat)', '1');
  if (tp === null) return;
  const rtype = tp.trim() === '2' ? 'shed' : tp.trim() === '3' ? 'flat' : 'gable';
  const eave = bimAskNum('처마 높이 (지붕이 시작되는 z, mm):', lvElev() + settings.bim.wallH); if (eave == null) return;
  const rise = rtype === 'flat'
    ? (bimAskNum('지붕 두께 (mm):', 300) || 300)
    : (bimAskNum(rtype === 'gable' ? '용마루 추가 높이 (처마 위로, mm):' : '높은 쪽 추가 높이 (mm):', settings.bim.roofRise) || settings.bim.roofRise);
  let dir = 'auto';
  if (rtype === 'shed') {
    const d = prompt('높은 쪽 방향 — 1: 북(+Y)  2: 남(-Y)  3: 동(+X)  4: 서(-X)', '1');
    dir = { '1': 'n', '2': 's', '3': 'e', '4': 'w' }[(d || '1').trim()] || 'n';
  } else if (rtype === 'gable') {
    const d = prompt('용마루 방향 — Enter: 자동(긴 변)  1: 가로(X)  2: 세로(Y)', '');
    dir = d && d.trim() === '1' ? 'x' : d && d.trim() === '2' ? 'y' : 'auto';
  }
  settings.bim.roofRise = rise; saveSettings();
  pushUndo();
  for (const e of sel) e.bim = { kind: 'roof', rtype, eave, rise, dir };
  logLine(`  ✔ 지붕 지정 ${sel.length}개 (${{ gable: '박공', shed: '외쪽', flat: '평' }[rtype]}, 처마 ${eave}${rtype === 'flat' ? '' : ', 상승 ' + rise})`, 'ok');
  renderProps(); draw();
}
// 지붕 → 경사 상단(zt) 솔리드 생성 (풋프린트의 bbox 사각 기준)
function roofSolids(e) {
  const b = e.bim;
  const xs = e.points.map(p => p[0]), ys = e.points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const col = '#b8695a';
  if (b.rtype === 'flat')
    return [{ poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0: b.eave, z1: b.eave + b.rise, color: col }];
  if (b.rtype === 'shed') {
    const P = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const hi = b.eave + b.rise, lo = b.eave;
    const ztOf = { n: [lo, lo, hi, hi], s: [hi, hi, lo, lo], e: [lo, hi, hi, lo], w: [hi, lo, lo, hi] }[b.dir] || [lo, lo, hi, hi];
    return [{ poly: P, z0: b.eave, z1: hi, zt: ztOf, color: col }];
  }
  // 박공: 용마루 = 긴 변 방향(또는 지정) 중앙선, 두 개의 경사 솔리드
  const alongX = b.dir === 'x' || (b.dir !== 'y' && (x1 - x0) >= (y1 - y0));
  const hi = b.eave + b.rise, lo = b.eave;
  if (alongX) {
    const ym = (y0 + y1) / 2;
    return [
      { poly: [[x0, y0], [x1, y0], [x1, ym], [x0, ym]], z0: lo, z1: hi, zt: [lo, lo, hi, hi], color: col },
      { poly: [[x0, ym], [x1, ym], [x1, y1], [x0, y1]], z0: lo, z1: hi, zt: [hi, hi, lo, lo], color: col },
    ];
  }
  const xm = (x0 + x1) / 2;
  return [
    { poly: [[x0, y0], [xm, y0], [xm, y1], [x0, y1]], z0: lo, z1: hi, zt: [lo, hi, hi, lo], color: col },
    { poly: [[xm, y0], [x1, y0], [x1, y1], [xm, y1]], z0: lo, z1: hi, zt: [hi, lo, lo, hi], color: col },
  ];
}
// 경사 상단 평면 z(x,y) — zt 솔리드용 (첫 세 꼭짓점으로 평면 결정)
function solidTopZ(s, x, y) {
  if (!s.zt) return s.z1;
  const [p0, p1, p2] = [s.poly[0], s.poly[1], s.poly[2]];
  const [z0v, z1v, z2v] = [s.zt[0], s.zt[1], s.zt[2]];
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = z1v - z0v;
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = z2v - z0v;
  // 법선 n = a × b, 평면: n·(P - p0) = 0
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  if (Math.abs(nz) < 1e-12) return s.zt[0];
  return z0v - (nx * (x - p0[0]) + ny * (y - p0[1])) / nz;
}

// ====== SUM — 선택 도형의 길이·면적 합계 ======
function cmdSum() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  합계: 먼저 도형을 선택하세요.', 'warn'); return; }
  let len = 0, area = 0, nL = 0, nA = 0;
  for (const e of sel) {
    const l = entityLength(e); if (l > 0) { len += l; nL++; }
    const a = entityArea2(e); if (a > 0) { area += a; nA++; }
  }
  const u = settings.units;
  logLine(`  Σ 합계 (${sel.length}개 선택): 길이 ${fmtNum(len)}${u} (${nL}개)` + (nA ? ` · 면적 ${fmtNum(area)}${u}² (${nA}개)` : ''), 'ok');
}

// ====== ISOLATE / UNISO — 선택 도형의 레이어만 표시 ======
function cmdIsolate() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  격리: 먼저 도형을 선택하세요.', 'warn'); return; }
  const keep = new Set(sel.map(e => e.layer || '0'));
  let hidden = 0;
  for (const l of state.layers) { const v = keep.has(l.name); if (l.visible && !v) hidden++; l.visible = v; }
  renderLayers(); draw();
  logLine(`  ✔ 레이어 격리: ${[...keep].join(', ')}만 표시 (${hidden}개 레이어 숨김) — uniso로 해제`, 'ok');
}
function cmdUniso() {
  for (const l of state.layers) l.visible = true;
  renderLayers(); draw();
  logLine('  ✔ 격리 해제: 모든 레이어 표시', 'ok');
}

// ====== XLINE — 구성선(아주 긴 보조선) ======
function clickXline(w) {
  if (!cmdOp || cmdOp.name !== 'xline') cmdOp = { name: 'xline', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('구성선: 방향 점을 클릭하세요. (수평/수직은 직교 F8 활용)'); return; }
  const p1 = cmdOp.p1, dx = w.x - p1.x, dy = w.y - p1.y, L = Math.hypot(dx, dy);
  if (L < 1e-9) return;
  const ux = dx / L, uy = dy / L, EXT = 100000; // 사실상 무한
  pushUndo();
  ensureLayer('보조선', '#5d9dff');
  addEntity({ type: 'LINE', layer: '보조선', x1: p1.x - ux * EXT, y1: p1.y - uy * EXT, x2: p1.x + ux * EXT, y2: p1.y + uy * EXT });
  logLine('  ✔ 구성선 (보조선 레이어 — 자르기 기준·스냅 대상)', 'ok');
  cmdOp = { name: 'xline', step: 'p1' }; previewEnts = null; updateStat(); renderLayers();
  setPrompt('구성선: 지나는 점을 클릭하세요. (연속, Esc 종료)');
}

// ====== BREAKPT — 한 점에서 끊기 ======
function clickBreakpt(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'breakpt') cmdOp = { name: 'breakpt', step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  한 점 끊기: 선/원/호만 지원합니다.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'p';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('한 점 끊기: 끊을 지점을 클릭하세요.'); return;
  }
  pushUndo();
  if (doBreak(cmdOp.target, w, w)) logLine('  ✔ 한 점에서 끊음 (두 도형으로 분리)', 'ok');
  cmdOp = { name: 'breakpt', step: 'obj' }; state.selection.clear(); renderProps(); updateStat();
  setPrompt('한 점 끊기: 대상을 클릭하세요. (연속, Esc 종료)');
}

// ====== ALIGN — 두 점 쌍으로 이동+회전(+배율) ======
function clickAlign(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'align') {
    if (!state.selection.size) {
      // 이 클릭은 도형 선택용으로 소비
      const hit = pick(w, rawW);
      if (hit) { state.selection.add(hit.id); renderProps(); cmdOp = { name: 'align', step: 's1' }; setPrompt('정렬: 원본 1번째 점을 클릭하세요.'); }
      else setPrompt('정렬: 먼저 도형을 선택하세요.');
      return;
    }
    // 이미 선택돼 있으면 이 클릭이 곧 원본 1번째 점
    cmdOp = { name: 'align', step: 's1' };
  }
  if (cmdOp.step === 's1') { cmdOp.s1 = w; cmdOp.step = 'd1'; setPrompt('정렬: 목표 1번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 'd1') { cmdOp.d1 = w; cmdOp.step = 's2'; setPrompt('정렬: 원본 2번째 점을 클릭하세요.'); return; }
  if (cmdOp.step === 's2') { cmdOp.s2 = w; cmdOp.step = 'd2'; setPrompt('정렬: 목표 2번째 점을 클릭하세요.'); return; }
  const s1 = cmdOp.s1, d1 = cmdOp.d1, s2 = cmdOp.s2, d2 = w;
  const v1x = s2.x - s1.x, v1y = s2.y - s1.y, v2x = d2.x - d1.x, v2y = d2.y - d1.y;
  const L1 = Math.hypot(v1x, v1y), L2 = Math.hypot(v2x, v2y);
  if (L1 < 1e-9 || L2 < 1e-9) { logLine('  정렬: 두 점이 같습니다.', 'warn'); cmdOp = null; setTool('select'); return; }
  const ang = (Math.atan2(v2y, v2x) - Math.atan2(v1y, v1x)) * 180 / Math.PI;
  const doScale = Math.abs(L2 / L1 - 1) > 1e-6 && confirm(`목표 간격에 맞춰 배율도 적용할까요? (×${(L2 / L1).toFixed(3)})`);
  pushUndo();
  const ents = selectedEntities();
  for (const e of ents) {
    translateEntity(e, d1.x - s1.x, d1.y - s1.y);
    applyTransform(e, T_rotate(d1.x, d1.y, ang));
  }
  if (doScale) scaleEntities(ents, d1, L2 / L1);
  logLine(`  ✔ 정렬 ${ents.length}개 (회전 ${ang.toFixed(2)}°${doScale ? `, 배율 ×${(L2 / L1).toFixed(3)}` : ''})`, 'ok');
  cmdOp = null; previewEnts = null; state.selection.clear(); renderProps(); updateStat();
  setTool('select');
}

// ====== FRAME — 도곽 + 표제란 ======
const FRAME_PAPERS = { a4: [297, 210], a3: [420, 297], a2: [594, 420], a1: [841, 594], letter: [279, 216] };
function clickFrame(w) {
  const paper = (prompt('용지 (a4 / a3 / a2 / a1 / letter):', 'a3') || '').trim().toLowerCase();
  if (!FRAME_PAPERS[paper]) { if (paper) logLine('  도곽: 알 수 없는 용지입니다.', 'warn'); setTool('select'); return; }
  const sc = parseFloat(prompt('축척 1:N (도면 단위 = mm):', '100'));
  if (!(sc > 0)) { setTool('select'); return; }
  pushUndo();
  ensureLayer('도곽', '#c0c0c0');
  const pp = FRAME_PAPERS[paper];
  const W = pp[0] * sc, H = pp[1] * sc, M = 10 * sc; // 여백 10mm
  const x0 = w.x, y0 = w.y;
  const rect = (x, y, ww, hh) => addEntity({ type: 'LWPOLYLINE', layer: '도곽', closed: true, points: [[x, y], [x + ww, y], [x + ww, y + hh], [x, y + hh]] });
  rect(x0, y0, W, H);
  rect(x0 + M, y0 + M, W - 2 * M, H - 2 * M);
  const tbW = 90 * sc, tbH = 24 * sc, rH = tbH / 3;
  const tx = x0 + W - M - tbW, ty = y0 + M;
  rect(tx, ty, tbW, tbH);
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '도곽', x1, y1, x2, y2 });
  ln(tx, ty + rH, tx + tbW, ty + rH); ln(tx, ty + rH * 2, tx + tbW, ty + rH * 2);
  ln(tx + 28 * sc, ty, tx + 28 * sc, ty + tbH);
  const th = 3.2 * sc, tpad = 2.2 * sc;
  const txt = (x, y, t) => addEntity({ type: 'TEXT', layer: '도곽', x, y, height: th, text: t, rotation: 0 });
  const today = new Date();
  const dstr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  txt(tx + tpad, ty + rH * 2 + (rH - th) / 2, '제목'); txt(tx + 28 * sc + tpad, ty + rH * 2 + (rH - th) / 2, '도면명 입력');
  txt(tx + tpad, ty + rH + (rH - th) / 2, '축척');     txt(tx + 28 * sc + tpad, ty + rH + (rH - th) / 2, '1 : ' + sc);
  txt(tx + tpad, ty + (rH - th) / 2, '날짜');          txt(tx + 28 * sc + tpad, ty + (rH - th) / 2, dstr);
  logLine(`  ✔ 도곽 ${paper.toUpperCase()} (1:${sc}) — '도면명 입력' 문자를 더블클릭해 수정하세요.`, 'ok');
  updateStat(); renderLayers(); zoomFit();
  setTool('select');
}

// ====== CENTERLINE (중심선) — 원/호 클릭 → 십자 중심선 ======
function clickCenterline(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || (hit.type !== 'CIRCLE' && hit.type !== 'ARC')) { logLine('  중심선: 원 또는 호를 클릭하세요.', 'warn'); return; }
  pushUndo();
  const lay = ensureLayer('중심선', '#ffd65d');
  if (!lay.linetype) lay.linetype = 'center'; // 일점쇄선
  const L = hit.r * 1.15 + dimTH() * 0.5; // 원 밖으로 살짝 연장
  addEntity({ type: 'LINE', layer: '중심선', x1: hit.cx - L, y1: hit.cy, x2: hit.cx + L, y2: hit.cy });
  addEntity({ type: 'LINE', layer: '중심선', x1: hit.cx, y1: hit.cy - L, x2: hit.cx, y2: hit.cy + L });
  logLine('  ✔ 중심선', 'ok'); renderLayers(); updateStat();
}

// ====== REVCLOUD (구름마크) — 두 코너 → 사각 둘레를 바깥으로 볼록한 호들로 ======
function clickRevcloud(w) {
  if (!cmdOp || cmdOp.name !== 'revcloud') cmdOp = { name: 'revcloud', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('구름마크: 반대 코너를 클릭하세요.'); return; }
  const ents = computeRevcloud(cmdOp.p1, w);
  if (!ents.length) { logLine('  영역이 너무 작습니다.', 'warn'); return; }
  pushUndo();
  for (const e of ents) addEntity(e);
  logLine(`  ✔ 구름마크 (호 ${ents.length}개)`, 'ok');
  cmdOp = { name: 'revcloud', step: 'p1' }; previewEnts = null; updateStat();
  setPrompt('구름마크: 첫 코너를 클릭하세요. (연속, Esc 종료)');
}
function computeRevcloud(p1, p2) {
  const xmin = Math.min(p1.x, p2.x), xmax = Math.max(p1.x, p2.x);
  const ymin = Math.min(p1.y, p2.y), ymax = Math.max(p1.y, p2.y);
  const wR = xmax - xmin, hR = ymax - ymin;
  if (wR < 1e-6 || hR < 1e-6) return [];
  const seg = Math.max(Math.min(wR, hR) / 2.5, Math.max(wR, hR) / 12); // 호 하나의 현 길이
  const ents = [];
  // 시계방향 순회(위→오른쪽→아래→왼쪽). 호는 끝→시작 각도로 만들어 바깥으로 볼록하게.
  const corners = [[xmin, ymax], [xmax, ymax], [xmax, ymin], [xmin, ymin], [xmin, ymax]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[i + 1];
    const elen = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(elen / seg)), s = elen / n;
    const ux = (bx - ax) / elen, uy = (by - ay) / elen;
    for (let k = 0; k < n; k++) {
      const sx = ax + ux * s * k, sy = ay + uy * s * k;
      const ex2 = ax + ux * s * (k + 1), ey2 = ay + uy * s * (k + 1);
      const cx = (sx + ex2) / 2, cy = (sy + ey2) / 2, r = s / 2;
      const aS = Math.atan2(sy - cy, sx - cx) * 180 / Math.PI;
      const aE = Math.atan2(ey2 - cy, ex2 - cx) * 180 / Math.PI;
      // CCW(start→end) 호는 진행방향 오른쪽으로 볼록 → 끝→시작 순서로 바깥(왼쪽) 볼록
      ents.push({ type: 'ARC', layer: state.currentLayer, cx, cy, r, startAngle: norm360(aE), endAngle: norm360(aS) });
    }
  }
  return ents;
}

// ====== LEADER (지시선) — 화살표 → 문자 위치 → 문구 ======
function clickLeader(w) {
  if (!cmdOp || cmdOp.name !== 'leader') cmdOp = { name: 'leader', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('지시선: 문자 위치를 클릭하세요.'); return; }
  const p1 = cmdOp.p1, p2 = w;
  const txt = prompt('지시 문구:', '');
  if (txt === null) { cmdOp = { name: 'leader', step: 'p1' }; setPrompt('지시선: 화살표 지점을 클릭하세요.'); return; }
  pushUndo();
  ensureLayer('치수', '#5dff8f');
  const th = dimTH(), dx = p2.x - p1.x, dy = p2.y - p1.y;
  const dir = dx >= 0 ? 1 : -1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const ln = (x1, y1, x2, y2) => addEntity({ type: 'LINE', layer: '치수', x1, y1, x2, y2 });
  ln(p1.x, p1.y, p2.x, p2.y);                       // 지시선
  const tail = th * 1.2;
  ln(p2.x, p2.y, p2.x + dir * tail, p2.y);           // 수평 꼬리
  const s = th * 0.5, nx = -uy, ny = ux;             // 화살표(V)
  ln(p1.x, p1.y, p1.x + ux * s + nx * s * 0.35, p1.y + uy * s + ny * s * 0.35);
  ln(p1.x, p1.y, p1.x + ux * s - nx * s * 0.35, p1.y + uy * s - ny * s * 0.35);
  if (txt.trim()) addEntity({ type: 'TEXT', layer: '치수',
    x: p2.x + dir * (tail + th * 0.25) - (dir < 0 ? txt.length * th * 0.6 : 0),
    y: p2.y - th * 0.35, height: th, text: txt, rotation: 0 });
  logLine('  ✔ 지시선', 'ok');
  cmdOp = { name: 'leader', step: 'p1' }; previewEnts = null;
  updateStat(); setPrompt('지시선: 화살표 지점을 클릭하세요. (연속, Esc 종료)');
}

// ====== DIMANGULAR (각도 치수) — 두 선 사이 각도 호 + 도수 ======
function clickDimAng(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'dimang') cmdOp = { name: 'dimang', step: 'l1' };
  if (cmdOp.step === 'l1' || cmdOp.step === 'l2') {
    const hit = pick(w, rawW);
    if (!hit || hit.type !== 'LINE') { logLine('  각도 치수: 두 개의 선을 클릭하세요.', 'warn'); return; }
    if (cmdOp.step === 'l1') { cmdOp.l1 = hit; cmdOp.step = 'l2'; state.selection.clear(); state.selection.add(hit.id); renderProps(); setPrompt('각도 치수: 두 번째 선을 클릭하세요.'); }
    else if (hit !== cmdOp.l1) { cmdOp.l2 = hit; cmdOp.step = 'pos'; state.selection.add(hit.id); renderProps(); setPrompt('각도 치수: 호 위치를 클릭하세요.'); }
    return;
  }
  const ents = computeAngularDim(cmdOp.l1, cmdOp.l2, w);
  if (!ents) { logLine('  두 선이 평행합니다.', 'warn'); return; }
  pushUndo();
  for (const e of ents.list) addEntity(e);
  logLine(`  ✔ 각도 치수 ${ents.deg}°`, 'ok');
  cmdOp = { name: 'dimang', step: 'l1' }; previewEnts = null;
  state.selection.clear(); renderProps(); updateStat();
  setPrompt('각도 치수: 첫 번째 선을 클릭하세요. (연속, Esc 종료)');
}
function computeAngularDim(l1, l2, pos) {
  const C = lineInfIntersect([l1.x1, l1.y1], [l1.x2, l1.y2], [l2.x1, l2.y1], [l2.x2, l2.y2]);
  if (!C) return null;
  const unit = (l) => { const dx = l.x2 - l.x1, dy = l.y2 - l.y1, L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L]; };
  let d1 = unit(l1), d2 = unit(l2);
  const v = [pos.x - C[0], pos.y - C[1]];
  if (d1[0] * v[0] + d1[1] * v[1] < 0) d1 = [-d1[0], -d1[1]]; // pos 쪽 사분면의 방향 선택
  if (d2[0] * v[0] + d2[1] * v[1] < 0) d2 = [-d2[0], -d2[1]];
  const r = Math.hypot(v[0], v[1]) || 1;
  let a1 = Math.atan2(d1[1], d1[0]) * 180 / Math.PI, a2 = Math.atan2(d2[1], d2[0]) * 180 / Math.PI;
  if (norm360(a2 - a1) > 180) { const t = a1; a1 = a2; a2 = t; } // CCW 짧은 쪽
  const sweep = norm360(a2 - a1);
  ensureLayer('치수', '#5dff8f');
  const list = [{ type: 'ARC', layer: '치수', cx: C[0], cy: C[1], r, startAngle: norm360(a1), endAngle: norm360(a2) }];
  const th = dimTH(), s = Math.min(th * 0.6, r * sweep * Math.PI / 180 / 4);
  const arrow = (deg, dir) => { // 호 끝 화살표(접선 방향)
    const a = deg * Math.PI / 180, px = C[0] + r * Math.cos(a), py = C[1] + r * Math.sin(a);
    const tx = -Math.sin(a) * dir, ty = Math.cos(a) * dir, nx2 = Math.cos(a), ny2 = Math.sin(a);
    list.push({ type: 'LINE', layer: '치수', x1: px, y1: py, x2: px + tx * s + nx2 * s * 0.35, y2: py + ty * s + ny2 * s * 0.35 });
    list.push({ type: 'LINE', layer: '치수', x1: px, y1: py, x2: px + tx * s - nx2 * s * 0.35, y2: py + ty * s - ny2 * s * 0.35 });
  };
  arrow(a1, 1); arrow(a2, -1);
  const mid = (a1 + sweep / 2) * Math.PI / 180;
  const deg = +sweep.toFixed(1);
  const txt = deg + '°';
  list.push({ type: 'TEXT', layer: '치수', x: C[0] + (r + th * 0.5) * Math.cos(mid) - txt.length * th * 0.3, y: C[1] + (r + th * 0.5) * Math.sin(mid), height: th, text: txt, rotation: 0 });
  return { list, deg };
}

// ====== DIVIDE / MEASURE (등분·일정간격 표식) ======
let divideCount = 4, measureStep = 10;
function pointsAlongEntity(e, opt) {
  const pts = [];
  const emitFracs = (fr) => fr.map(t => pointAtParam(e, t)).filter(Boolean);
  function pointAtParam(e, t) { // t: 0..1 (둘레 기준)
    if (e.type === 'LINE') return [e.x1 + (e.x2 - e.x1) * t, e.y1 + (e.y2 - e.y1) * t];
    if (e.type === 'CIRCLE') { const a = t * 2 * Math.PI; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
    if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; const a = (s + (en - s) * t) * Math.PI / 180; return [e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]; }
    if (e.type === 'LWPOLYLINE') {
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      let total = 0; const lens = [];
      for (let i = 0; i < segN; i++) { const L = Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); lens.push(L); total += L; }
      let d = t * total;
      for (let i = 0; i < segN; i++) { if (d <= lens[i] || i === segN - 1) { const u = lens[i] ? d / lens[i] : 0; return [p[i][0] + (p[(i + 1) % n][0] - p[i][0]) * u, p[i][1] + (p[(i + 1) % n][1] - p[i][1]) * u]; } d -= lens[i]; }
    }
    return null;
  }
  function totalLen(e) {
    if (e.type === 'LINE') return Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    if (e.type === 'CIRCLE') return 2 * Math.PI * e.r;
    if (e.type === 'ARC') { let s = e.startAngle, en = e.endAngle; if (en < s) en += 360; return (en - s) * Math.PI / 180 * e.r; }
    if (e.type === 'LWPOLYLINE') { const p = e.points, n = p.length, segN = e.closed ? n : n - 1; let L = 0; for (let i = 0; i < segN; i++) L += Math.hypot(p[(i + 1) % n][0] - p[i][0], p[(i + 1) % n][1] - p[i][1]); return L; }
    return 0;
  }
  if (opt.count) { // 등분: 내부 점(닫힌/원은 n개)
    const n = Math.max(2, opt.count);
    const closedLike = e.type === 'CIRCLE' || (e.type === 'LWPOLYLINE' && e.closed);
    const fr = [];
    if (closedLike) for (let i = 0; i < n; i++) fr.push(i / n);
    else for (let i = 1; i < n; i++) fr.push(i / n);
    return emitFracs(fr);
  }
  const L = totalLen(e); if (!L || !opt.step || opt.step <= 0) return [];
  const fr = []; for (let d = opt.step; d < L - 1e-9; d += opt.step) fr.push(d / L);
  return emitFracs(fr);
}
function placeMarks(e, opt, label) {
  const pts = pointsAlongEntity(e, opt);
  if (!pts.length) { logLine('  표식을 만들 수 없습니다(간격이 너무 크거나 지원 안 함).', 'warn'); return; }
  pushUndo();
  const s = state.textHeight * 0.35;
  for (const p of pts) { // ✕ 표식(작은 선 2개)
    addEntity({ type: 'LINE', layer: state.currentLayer, x1: p[0] - s, y1: p[1] - s, x2: p[0] + s, y2: p[1] + s });
    addEntity({ type: 'LINE', layer: state.currentLayer, x1: p[0] - s, y1: p[1] + s, x2: p[0] + s, y2: p[1] - s });
  }
  logLine(`  ✔ ${label}: 표식 ${pts.length}개`, 'ok');
  updateStat(); draw();
}
function clickDivide(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  등분: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
  placeMarks(hit, { count: divideCount }, `${divideCount}등분`);
}
function clickMeasure(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !['LINE', 'LWPOLYLINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  간격 표식: 선/폴리라인/원/호를 클릭하세요.', 'warn'); return; }
  placeMarks(hit, { step: measureStep }, `간격 ${measureStep}`);
}

// ====== DIST (거리 측정) ======
function clickDist(w) {
  if (!cmdOp || cmdOp.name !== 'dist') cmdOp = { name: 'dist', step: 'p1' };
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('거리: 두 번째 점을 클릭하세요.'); return; }
  const dx = w.x - cmdOp.p1.x, dy = w.y - cmdOp.p1.y;
  logLine(`  거리 = ${fmtNum(Math.hypot(dx, dy))} ${settings.units}   ΔX = ${fmtNum(dx)}   ΔY = ${fmtNum(dy)}   각도 = ${fmtNum(ang(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y))}°`, 'ok');
  cmdOp = { name: 'dist', step: 'p1' }; previewEnts = null;
  setPrompt('거리: 첫 점을 클릭하세요. (연속 측정, Esc 종료)');
}

// ====== AREA (면적) ======
function clickArea(w, rawW) {
  if (!pts.length) { // 첫 클릭이 닫힌 도형이면 그 면적
    const hit = pick(w, rawW);
    if (hit && hit.type === 'CIRCLE') {
      logLine(`  원 면적 = ${fmtNum(Math.PI * hit.r * hit.r)} ${settings.units}²   둘레 = ${fmtNum(2 * Math.PI * hit.r)} ${settings.units}`, 'ok'); return;
    }
    if (hit && hit.type === 'LWPOLYLINE' && hit.closed) {
      logLine(`  면적 = ${fmtNum(polyArea(hit.points))} ${settings.units}²   둘레 = ${fmtNum(polyPerimeter(hit.points, true))} ${settings.units}`, 'ok'); return;
    }
  }
  pts.push({ x: w.x, y: w.y });
  setPrompt(`면적: 점 ${pts.length}개 지정됨. 계속 클릭하거나 Enter로 계산하세요.`);
}
function finishArea() {
  if (pts.length >= 3) {
    const arr = pts.map(p => [p.x, p.y]);
    logLine(`  면적 = ${fmtNum(polyArea(arr))} ${settings.units}²   둘레 = ${fmtNum(polyPerimeter(arr, true))} ${settings.units}`, 'ok');
  } else logLine('  면적: 점이 3개 이상 필요합니다.', 'warn');
  pts = []; setPrompt('면적: 원/닫힌 폴리라인을 클릭하거나 점들을 찍고 Enter.'); draw();
}

// ====== EXPLODE (분해) / JOIN (결합) — 즉시 실행 명령 ======
function cmdExplode() {
  const sel = selectedEntities().filter(e => e.type === 'LWPOLYLINE' || e.type === 'INSERT');
  if (!sel.length) { logLine('  분해: 폴리라인 또는 블록을 먼저 선택하세요.', 'warn'); return; }
  pushUndo(); let made = 0;
  for (const e of sel) {
    if (e.type === 'INSERT') {
      for (const c of insertChildren(e)) { addEntity(c); made++; }
    } else {
      const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
      for (let i = 0; i < segN; i++) {
        const a = p[i], b = p[(i + 1) % n];
        const ne = { type: 'LINE', layer: e.layer, x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
        if (e.color) ne.color = e.color;
        addEntity(ne); made++;
      }
    }
    state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id);
  }
  logLine(`  ✔ 분해: ${sel.length}개 → 도형 ${made}개`, 'ok');
  updateStat(); renderProps(); draw();
}
function cmdJoin() {
  const sel = selectedEntities().filter(e => e.type === 'LINE' || (e.type === 'LWPOLYLINE' && !e.closed));
  if (sel.length < 2) { logLine('  결합: 선/열린 폴리라인을 2개 이상 선택하세요.', 'warn'); return; }
  const TOL = 1e-4;
  const eq = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= TOL;
  const pieces = sel.map(e => e.type === 'LINE' ? [[e.x1, e.y1], [e.x2, e.y2]] : e.points.map(p => [p[0], p[1]]));
  const used = new Array(pieces.length).fill(false);
  const chains = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue; used[i] = true;
    let chain = pieces[i].slice(); let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue; const pj = pieces[j];
        const h = chain[0], t = chain[chain.length - 1];
        if (eq(t, pj[0])) { chain = chain.concat(pj.slice(1)); used[j] = true; grew = true; }
        else if (eq(t, pj[pj.length - 1])) { chain = chain.concat(pj.slice(0, -1).reverse()); used[j] = true; grew = true; }
        else if (eq(h, pj[pj.length - 1])) { chain = pj.slice(0, -1).concat(chain); used[j] = true; grew = true; }
        else if (eq(h, pj[0])) { chain = pj.slice(1).reverse().concat(chain); used[j] = true; grew = true; }
      }
    }
    chains.push(chain);
  }
  if (chains.length === sel.length) { logLine('  결합: 끝점이 만나는 도형이 없습니다.', 'warn'); return; }
  pushUndo();
  const layer = sel[0].layer;
  for (const e of sel) { state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id); }
  let closedN = 0;
  for (const ch of chains) {
    let closed = false, arr = ch;
    if (ch.length > 2 && eq(ch[0], ch[ch.length - 1])) { closed = true; arr = ch.slice(0, -1); closedN++; }
    const ne = addEntity({ type: 'LWPOLYLINE', layer, closed, points: arr });
    state.selection.add(ne.id);
  }
  logLine(`  ✔ 결합: ${sel.length}개 → 폴리라인 ${chains.length}개${closedN ? ` (닫힘 ${closedN})` : ''}`, 'ok');
  updateStat(); renderProps(); draw();
}
// ====== BREAK (끊기) — 선/원/호의 두 점 사이 제거 ======
function clickBreak(w, rawW) {
  if (!cmdOp || cmdOp.name !== 'break') cmdOp = { name: 'break', step: 'obj' };
  if (cmdOp.step === 'obj') {
    const hit = pick(w, rawW);
    if (!hit || !['LINE', 'CIRCLE', 'ARC'].includes(hit.type)) { logLine('  끊기는 선/원/호만 지원합니다.', 'warn'); return; }
    cmdOp.target = hit; cmdOp.step = 'p1';
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('끊기: 첫 번째 끊기점을 클릭하세요.'); return;
  }
  if (cmdOp.step === 'p1') { cmdOp.p1 = w; cmdOp.step = 'p2'; setPrompt('끊기: 두 번째 끊기점을 클릭하세요.'); return; }
  pushUndo();
  if (doBreak(cmdOp.target, cmdOp.p1, w)) logLine('  ✔ 끊기', 'ok');
  cmdOp = null; state.selection.clear(); renderProps(); updateStat();
  setTool('select');
}
function doBreak(e, P1, P2) {
  if (e.type === 'LINE') {
    const x1 = e.x1, y1 = e.y1, dx = e.x2 - x1, dy = e.y2 - y1, L2 = dx * dx + dy * dy || 1;
    let t1 = ((P1.x - x1) * dx + (P1.y - y1) * dy) / L2;
    let t2 = ((P2.x - x1) * dx + (P2.y - y1) * dy) / L2;
    t1 = Math.max(0, Math.min(1, t1)); t2 = Math.max(0, Math.min(1, t2));
    if (t2 < t1) { const t = t1; t1 = t2; t2 = t; }
    const segs = [];
    if (t1 > 1e-6) segs.push([0, t1]);
    if (t2 < 1 - 1e-6) segs.push([t2, 1]);
    if (!segs.length) { state.entities = state.entities.filter(x => x !== e); return true; } // 전체 제거
    const P = t => ({ x: x1 + t * dx, y: y1 + t * dy });
    const a = P(segs[0][0]), b = P(segs[0][1]);
    e.x1 = a.x; e.y1 = a.y; e.x2 = b.x; e.y2 = b.y;
    if (segs.length === 2) {
      const c = P(segs[1][0]), d = P(segs[1][1]);
      const ne = { type: 'LINE', layer: e.layer, x1: c.x, y1: c.y, x2: d.x, y2: d.y };
      if (e.color) ne.color = e.color;
      addEntity(ne);
    }
    return true;
  }
  if (e.type === 'CIRCLE') { // 첫→둘 반시계 구간 제거 → 나머지 호
    const a1 = ang(e.cx, e.cy, P1.x, P1.y), a2 = ang(e.cx, e.cy, P2.x, P2.y);
    if (Math.abs(norm360(a2 - a1)) < 1e-6) { logLine('  두 점이 같습니다.', 'warn'); return false; }
    e.type = 'ARC'; e.startAngle = a2; e.endAngle = a1;
    return true;
  }
  if (e.type === 'ARC') {
    let s = e.startAngle, en = e.endAngle; if (en < s) en += 360;
    const span = en - s;
    const rel = a => Math.max(0, Math.min(span, norm360(a - s)));
    let r1 = rel(ang(e.cx, e.cy, P1.x, P1.y)), r2 = rel(ang(e.cx, e.cy, P2.x, P2.y));
    if (r2 < r1) { const t = r1; r1 = r2; r2 = t; }
    const segs = [];
    if (r1 > 0.01) segs.push([0, r1]);
    if (r2 < span - 0.01) segs.push([r2, span]);
    if (!segs.length) { state.entities = state.entities.filter(x => x !== e); return true; }
    e.startAngle = norm360(s + segs[0][0]); e.endAngle = norm360(s + segs[0][1]);
    if (segs.length === 2) {
      const ne = { type: 'ARC', layer: e.layer, cx: e.cx, cy: e.cy, r: e.r, startAngle: norm360(s + segs[1][0]), endAngle: norm360(s + segs[1][1]) };
      if (e.color) ne.color = e.color;
      addEntity(ne);
    }
    return true;
  }
  return false;
}

// ====== LENGTHEN (길이조정) — 클릭한 끝쪽을 ±delta 만큼 ======
// ====== 클립보드 복사/붙여넣기 (Ctrl+C / Ctrl+V, 탭 간 공유) ======
const CLIP_KEY = 'webcad_clipboard_v1';
function copySelection() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  복사할 도형을 먼저 선택하세요. (Ctrl+C)', 'warn'); return; }
  let mnx = Infinity, mny = Infinity;
  for (const e of sel) { const bb = entityBBox(e); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); } }
  if (!isFinite(mnx)) { mnx = 0; mny = 0; }
  const clip = { base: [mnx, mny], ents: sel.map(e => cloneEntity(e)),
    blocks: {} };
  for (const e of sel) if (e.type === 'INSERT' && state.blocks[e.name]) clip.blocks[e.name] = state.blocks[e.name]; // 블록 정의 동봉
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) {}
  logLine(`  ✔ 복사됨: ${sel.length}개 (Ctrl+V로 붙여넣기)`, 'ok');
}
function startPaste() {
  let clip = null;
  try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch (e) {}
  if (!clip || !clip.ents || !clip.ents.length) { logLine('  붙여넣을 내용이 없습니다.', 'warn'); return; }
  cmdOp = { name: 'paste', clip };
  state.tool = '_paste';
  document.querySelectorAll('.tool').forEach(el => el.classList.remove('active'));
  setPrompt(`붙여넣기: 위치를 클릭하세요. (${clip.ents.length}개, Esc 취소)`);
  draw();
}
function doPaste(w) {
  const clip = cmdOp.clip;
  pushUndo();
  for (const [nm, def] of Object.entries(clip.blocks || {})) if (!state.blocks[nm]) state.blocks[nm] = def; // 블록 정의 이식
  const dx = w.x - clip.base[0], dy = w.y - clip.base[1];
  state.selection.clear();
  for (const src of clip.ents) {
    const c = cloneEntity(src);
    translateEntity(c, dx, dy);
    const ne = addEntity(c); state.selection.add(ne.id);
  }
  logLine(`  ✔ 붙여넣기: ${clip.ents.length}개`, 'ok');
  updateStat(); renderProps(); refreshBlockList();
  cmdOp = null; previewEnts = null; setTool('select');
}

// ====== MATCHPROP (속성 일치) — 원본 선택 후 대상들에 속성 복사 ======
function clickMatchprop(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (!cmdOp || cmdOp.name !== 'matchprop') {
    cmdOp = { name: 'matchprop', src: hit };
    state.selection.clear(); state.selection.add(hit.id); renderProps();
    setPrompt('속성일치: 이제 속성을 적용할 대상들을 클릭하세요. (Esc 종료)');
    logLine('  속성 원본 선택됨', 'info'); return;
  }
  const s = cmdOp.src;
  if (hit === s) return;
  pushUndo();
  hit.layer = s.layer;
  if (s.color) hit.color = s.color; else delete hit.color;
  if (s.linetype) hit.linetype = s.linetype; else delete hit.linetype;
  if (s.lineweight != null) hit.lineweight = s.lineweight; else delete hit.lineweight;
  if (hit.type === 'TEXT' && s.type === 'TEXT') hit.height = s.height;                 // 문자: 높이도
  if (hit.type === 'HATCH' && s.type === 'HATCH') { hit.pattern = s.pattern; hit.spacing = s.spacing; hatchDirty(hit); } // 해치: 패턴
  logLine('  ✔ 속성 적용', 'ok');
  draw();
}

function clickLengthen(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit) return;
  if (hit.type !== 'LINE') { logLine('  길이조정은 선(LINE)만 지원합니다.', 'warn'); return; }
  const dx = hit.x2 - hit.x1, dy = hit.y2 - hit.y1, L = Math.hypot(dx, dy) || 1;
  if (L + lengthenDelta <= 1e-6) { logLine('  선 길이보다 크게 줄일 수 없습니다.', 'warn'); return; }
  pushUndo();
  const ux = dx / L, uy = dy / L;
  const d1 = Math.hypot(w.x - hit.x1, w.y - hit.y1), d2 = Math.hypot(w.x - hit.x2, w.y - hit.y2);
  if (d1 < d2) { hit.x1 -= ux * lengthenDelta; hit.y1 -= uy * lengthenDelta; }
  else { hit.x2 += ux * lengthenDelta; hit.y2 += uy * lengthenDelta; }
  logLine(`  ✔ 길이조정 ${lengthenDelta > 0 ? '+' : ''}${lengthenDelta} → 길이 ${fmtNum(L + lengthenDelta)}`, 'ok');
  draw();
}

// ====== HATCH (해치) — 단일 객체, 건축 패턴 8종 ======
const HATCH_PATTERNS = {
  ansi31: { ko: '사선(일반)' }, ansi37: { ko: '격자 사선' }, steel: { ko: '강재(이중 사선)' },
  grid: { ko: '격자(타일)' }, brick: { ko: '벽돌(조적)' }, concrete: { ko: '콘크리트' },
  dots: { ko: '점(모래·미장)' }, solid: { ko: '단색 채움' },
};
let hatchPattern = 'ansi31';

function boundaryBBox(b) {
  if (b.kind === 'circle') return { xmin: b.cx - b.r, xmax: b.cx + b.r, ymin: b.cy - b.r, ymax: b.cy + b.r };
  const xs = b.points.map(p => p[0]), ys = b.points.map(p => p[1]);
  return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
}
function pointInBoundary(b, x, y) {
  if (b.kind === 'circle') return Math.hypot(x - b.cx, y - b.cy) <= b.r;
  let inside = false; const p = b.points, n = p.length;
  for (let i = 0, j = n - 1; i < n; j = i++)
    if ((p[i][1] > y) !== (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  return inside;
}
// 한 방향 평행선 무리를 경계 내부로 잘라 세그먼트 생성
function clipFamily(b, sp, angleDeg, phase) {
  const a = angleDeg * Math.PI / 180, d = [Math.cos(a), Math.sin(a)], nv = [-d[1], d[0]];
  const bb = boundaryBBox(b);
  const corners = [[bb.xmin, bb.ymin], [bb.xmax, bb.ymin], [bb.xmax, bb.ymax], [bb.xmin, bb.ymax]];
  let cmin = Infinity, cmax = -Infinity;
  for (const c of corners) { const v = nv[0] * c[0] + nv[1] * c[1]; if (v < cmin) cmin = v; if (v > cmax) cmax = v; }
  const out = [];
  for (let c = cmin + sp * (phase === undefined ? 0.5 : phase); c < cmax; c += sp) {
    let hits = [];
    if (b.kind === 'circle') {
      const cc = nv[0] * b.cx + nv[1] * b.cy, dist = c - cc;
      if (Math.abs(dist) < b.r) {
        const half = Math.sqrt(b.r * b.r - dist * dist);
        const mx = b.cx + nv[0] * dist, my = b.cy + nv[1] * dist;
        hits = [[mx - d[0] * half, my - d[1] * half], [mx + d[0] * half, my + d[1] * half]];
      }
    } else {
      const p = b.points, n = p.length;
      for (let i = 0; i < n; i++) {
        const A = p[i], B = p[(i + 1) % n];
        const fa = nv[0] * A[0] + nv[1] * A[1] - c, fb = nv[0] * B[0] + nv[1] * B[1] - c;
        if ((fa > 0 && fb <= 0) || (fa <= 0 && fb > 0)) {
          const u = fa / (fa - fb);
          hits.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]);
        }
      }
      hits.sort((x, y) => (d[0] * x[0] + d[1] * x[1]) - (d[0] * y[0] + d[1] * y[1]));
    }
    for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i][0], hits[i][1], hits[i + 1][0], hits[i + 1][1]]);
  }
  return out;
}
// 패턴별 세그먼트/점 계산
function computePatternSegs(e) {
  const b = e.boundary, sp = e.spacing || 5, segs = [], dots = [];
  const add = (arr) => { for (const s of arr) segs.push(s); };
  switch (e.pattern) {
    case 'ansi37': add(clipFamily(b, sp, 45)); add(clipFamily(b, sp, 135)); break;
    case 'steel': add(clipFamily(b, sp, 45)); add(clipFamily(b, sp, 45, 0.75)); break;
    case 'grid': add(clipFamily(b, sp, 0)); add(clipFamily(b, sp, 90)); break;
    case 'brick': {
      add(clipFamily(b, sp, 0, 0));
      const bb = boundaryBBox(b); let row = 0;
      for (let y = Math.floor(bb.ymin / sp) * sp; y < bb.ymax; y += sp, row++) {
        const off = (row % 2) * sp;
        for (let x = Math.floor(bb.xmin / (2 * sp)) * 2 * sp + off; x < bb.xmax; x += 2 * sp)
          if (pointInBoundary(b, x, y) && pointInBoundary(b, x, y + sp) && pointInBoundary(b, x, y + sp / 2))
            segs.push([x, y, x, y + sp]);
      }
      break;
    }
    case 'concrete': {
      add(clipFamily(b, sp * 1.7, 45));
      const bb = boundaryBBox(b);
      for (let i = 0; bb.xmin + i * sp < bb.xmax; i++) for (let j = 0; bb.ymin + j * sp < bb.ymax; j++) {
        const h = Math.abs(Math.sin(i * 127.1 + j * 311.7) * 43758.5453) % 1; // 결정적 의사난수
        if (h < 0.45) continue;
        const x = bb.xmin + i * sp + (h * 7.919 % 1) * sp, y = bb.ymin + j * sp + (h * 104.729 % 1) * sp;
        if (pointInBoundary(b, x, y)) dots.push([x, y]);
      }
      break;
    }
    case 'dots': {
      const bb = boundaryBBox(b); let row = 0;
      for (let y = bb.ymin + sp / 2; y < bb.ymax; y += sp, row++)
        for (let x = bb.xmin + sp / 2 + (row % 2) * sp / 2; x < bb.xmax; x += sp)
          if (pointInBoundary(b, x, y)) dots.push([x, y]);
      break;
    }
    case 'solid': break;
    default: add(clipFamily(b, sp, 45)); // ansi31
  }
  return { segs, dots };
}
// 캐시(직렬화 제외) — 변형 시 hatchDirty()로 무효화
function hatchSegments(e) {
  if (!e._hc) Object.defineProperty(e, '_hc', { value: computePatternSegs(e), configurable: true, writable: true, enumerable: false });
  return e._hc;
}
function hatchDirty(e) { if (e._hc) delete e._hc; }

function clickHatch(w, rawW) {
  const hit = pick(w, rawW);
  if (!hit || !(hit.type === 'CIRCLE' || (hit.type === 'LWPOLYLINE' && hit.closed))) {
    logLine('  해치: 원 또는 닫힌 폴리라인(사각형·다각형)을 클릭하세요.', 'warn'); return;
  }
  pushUndo();
  const boundary = hit.type === 'CIRCLE'
    ? { kind: 'circle', cx: hit.cx, cy: hit.cy, r: hit.r }
    : { kind: 'poly', points: hit.points.map(p => [p[0], p[1]]) };
  const ne = addEntity({ type: 'HATCH', layer: state.currentLayer, pattern: hatchPattern, spacing: hatchSpacing, boundary });
  state.selection.clear(); state.selection.add(ne.id);
  logLine(`  ✔ 해치 1개 객체 (${HATCH_PATTERNS[hatchPattern].ko}, 간격 ${hatchSpacing})`, 'ok');
  updateStat(); renderProps(); draw();
}
// 내보내기용: HATCH → 선/점(짧은 선) 분해 목록
// 블록 정의 내부 엔티티에서 HATCH만 선으로 분해(정의는 로컬좌표라 hatchSegments 그대로 사용)
function exportHatchExpand(ents) {
  const out = [];
  for (const e of ents) {
    if (e.type !== 'HATCH') { out.push(e); continue; }
    const hs = e.pattern === 'solid' ? { segs: [], dots: [] } : hatchSegments(e);
    for (const s of hs.segs) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
    if (e.pattern === 'solid') { const b = e.boundary; out.push(b.kind === 'circle' ? { type: 'CIRCLE', layer: e.layer, cx: b.cx, cy: b.cy, r: b.r } : { type: 'LWPOLYLINE', layer: e.layer, closed: true, points: b.points }); }
  }
  return out;
}
// keepInserts=true: INSERT는 그대로(DXF 블록 저장용). false: 자식으로 전개(SVG/PNG/PDF용)
function exportEntities(keepInserts) {
  const out = [];
  const emit = (e) => {
    if (e.type === 'IMAGE') return; // 밑그림은 내보내기 제외
    if (e.type === 'INSERT') { if (keepInserts) out.push(e); else for (const c of insertChildren(e)) emit(c); return; }
    if (e.type !== 'HATCH') { out.push(e); return; }
    const hs = e.pattern === 'solid' ? { segs: [], dots: [] } : hatchSegments(e);
    for (const s of hs.segs) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: s[0], y1: s[1], x2: s[2], y2: s[3] });
    const t = (e.spacing || 5) * 0.06;
    for (const dp of hs.dots) out.push({ type: 'LINE', layer: e.layer, color: e.color, x1: dp[0] - t, y1: dp[1], x2: dp[0] + t, y2: dp[1] });
    if (e.pattern === 'solid') {
      const b = e.boundary;
      out.push(b.kind === 'circle'
        ? { type: 'CIRCLE', layer: e.layer, color: e.color, cx: b.cx, cy: b.cy, r: b.r }
        : { type: 'LWPOLYLINE', layer: e.layer, color: e.color, closed: true, points: b.points });
    }
  };
  for (const e of state.entities) emit(e);
  return out;
}

// BLOCK: 선택 도형으로 블록 정의(선택 기준점=선택 bbox 좌하단), 원본은 그 블록 인스턴스로 대체
let insertName = null;   // insert 도구가 삽입할 블록
let insertScale = 1, insertRot = 0;
function refreshBlockList() {
  const sec = document.getElementById('blockSection'), list = document.getElementById('blockList');
  if (!sec || !list) return;
  const names = Object.keys(state.blocks);
  sec.style.display = names.length ? '' : 'none';
  if (!insertName || !state.blocks[insertName]) insertName = names[0] || null;
  list.innerHTML = names.map(n => `<div class="layer${n === insertName ? ' active' : ''}" data-blk="${escapeHtml(n)}" style="flex-direction:row;align-items:center;">
    <span class="nm">▣ ${escapeHtml(n)}</span></div>`).join('');
  list.querySelectorAll('[data-blk]').forEach(el => el.addEventListener('click', () => {
    insertName = el.dataset.blk; refreshBlockList();
    if (state.tool !== 'insert') { setTool('insert'); lastCommand = 'insert'; }
  }));
}
function clickInsert(w) {
  const names = Object.keys(state.blocks);
  if (!names.length) { logLine('  삽입할 블록이 없습니다. 먼저 block 명령으로 블록을 만드세요.', 'warn'); setTool('select'); return; }
  if (!insertName || !state.blocks[insertName]) insertName = names[0];
  pushUndo();
  const ins = addEntity({ type: 'INSERT', layer: state.currentLayer, name: insertName, x: w.x, y: w.y, sx: insertScale, sy: insertScale, rot: insertRot });
  state.selection.clear(); state.selection.add(ins.id);
  logLine(`  ✔ 블록 "${insertName}" 삽입 (배율 ${insertScale}, 회전 ${insertRot}°)`, 'ok');
  updateStat(); renderProps(); draw(); // 도구 유지 → 연속 삽입
}
function cmdBlock() {
  const sel = selectedEntities().filter(e => e.type !== 'INSERT');
  if (!sel.length) { logLine('  블록: 먼저 도형을 선택하세요.', 'warn'); return; }
  let name = prompt('블록 이름:', 'Block' + (Object.keys(state.blocks).length + 1));
  if (!name) return; name = name.trim(); if (!name) return;
  if (state.blocks[name] && !confirm(`블록 "${name}"이 이미 있습니다. 덮어쓸까요?`)) return;
  // 기준점 = 선택 bbox 좌하단
  let mnx = Infinity, mny = Infinity;
  for (const e of sel) { const bb = entityBBox(e); if (bb) { mnx = Math.min(mnx, bb.xmin); mny = Math.min(mny, bb.ymin); } }
  if (!isFinite(mnx)) { mnx = 0; mny = 0; }
  pushUndo();
  const defEnts = sel.map(e => { const c = cloneEntity(e); translateEntity(c, -mnx, -mny); return c; }); // 블록 좌표계(기준점 원점)
  state.blocks[name] = { entities: defEnts };
  const layer = sel[0].layer;
  for (const e of sel) { state.entities = state.entities.filter(x => x !== e); state.selection.delete(e.id); }
  const ins = addEntity({ type: 'INSERT', layer, name, x: mnx, y: mny, sx: 1, sy: 1, rot: 0 });
  state.selection.add(ins.id);
  logLine(`  ✔ 블록 "${name}" 정의 (${sel.length}개 → 블록 1개)`, 'ok');
  updateStat(); renderProps(); refreshBlockList(); draw();
}
// 그리기 순서: 선택을 맨앞/맨뒤로
function reorderSel(front) {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  순서 변경: 도형을 먼저 선택하세요.', 'warn'); return; }
  pushUndo();
  state.entities = state.entities.filter(e => !state.selection.has(e.id));
  if (front) state.entities.push(...sel); else state.entities.unshift(...sel);
  logLine(`  ✔ ${sel.length}개 → ${front ? '맨 앞으로' : '맨 뒤로'}`, 'ok');
  draw();
}
// 유사 선택: 선택과 같은 종류+레이어 전부 선택
function selectSimilar() {
  const sel = selectedEntities();
  if (!sel.length) { logLine('  유사 선택: 기준 도형을 먼저 선택하세요.', 'warn'); return; }
  const keys = new Set(sel.map(e => e.type + '|' + e.layer));
  let n = 0;
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue;
    if (keys.has(e.type + '|' + e.layer) && !state.selection.has(e.id)) { state.selection.add(e.id); n++; }
  }
  logLine(`  ✔ 유사 선택: +${n}개 (총 ${state.selection.size}개)`, 'ok');
  renderProps(); draw();
}
// 도구 전환 없이 즉시 실행되는 명령들
const INSTANT_CMDS = {
  explode: cmdExplode,
  join: cmdJoin,
  block: cmdBlock,
  front: () => reorderSel(true),
  back: () => reorderSel(false),
  similar: selectSimilar,
  zoom: () => { zoomFit(); logLine('  ✔ 전체보기', 'info'); },
  zp: zoomPrev,
  undo: () => { undo(); logLine('  ✔ 실행취소', 'info'); },
  redo: () => { redo(); logLine('  ✔ 다시실행', 'info'); },
  isolate: cmdIsolate,
  uniso: cmdUniso,
  sum: cmdSum,
  help: openCmdHelp,
  wall: cmdWallTag,
  slab: cmdSlabTag,
  column: cmdColumnTag,
  stair: cmdStairTag,
  extrudecrv: cmdExtrudeCrv,
  extrudesrf: cmdExtrudeSrf,
  move3d: () => cmdMove3D(false),
  copy3d: () => cmdMove3D(true),
  box: cmdBox,
  cylinder: cmdCylinder,
  settop: cmdSetTop,
  union: () => cmdBoolean('union'),
  difference: () => cmdBoolean('subtract'),
  intersect3d: () => cmdBoolean('intersect'),
  exportstl: () => cmdExportSTL(),
  exportobj: () => cmdExportOBJ(),
  selectedexport: () => { // 선택한 객체만 STL/OBJ로
    if (!state.selection.size) { logLine('  selectedexport: 내보낼 객체를 먼저 선택하세요.', 'warn'); return; }
    const ids = new Set(state.selection);
    const f = String(prompt('형식 — 1: STL  2: OBJ', '1') || '1').trim();
    if (f === '2') cmdExportOBJ(ids, 'webcad-selected'); else cmdExportSTL(ids, 'webcad-selected');
  },
  bimclear: cmdBimClear,
  view3d: open3D,
  roofview: () => {
    if (!v3 || !document.getElementById('bim3d')) { logLine('  3D 뷰에서 사용하는 명령입니다.', 'warn'); return; }
    v3.roof = (!v3.roof || v3.roof === 'show') ? 'ghost' : v3.roof === 'ghost' ? 'hide' : 'show';
    render3D();
    logLine(`  ▷ 지붕 표시: ${v3.roof === 'ghost' ? '투명' : v3.roof === 'hide' ? '숨김' : '보임'}`, 'info');
  },
  level: cmdLevelInfo,
  roof: cmdRoofTag,
};

function nearGrip(e, w, tol) {
  const grips = entityGrips(e);
  for (let i = 0; i < grips.length; i++)
    if (Math.hypot(grips[i].x - w.x, grips[i].y - w.y) <= tol) return { index: i, p: grips[i] };
  return null;
}
// 폴리라인 세그먼트 중점 그립(정점 추가용)
function nearMidGrip(e, w, tol) {
  if (e.type !== 'LWPOLYLINE') return null;
  const p = e.points, n = p.length, segN = e.closed ? n : n - 1;
  for (let i = 0; i < segN; i++) {
    const mx = (p[i][0] + p[(i + 1) % n][0]) / 2, my = (p[i][1] + p[(i + 1) % n][1]) / 2;
    if (Math.hypot(mx - w.x, my - w.y) <= tol) return { index: i, x: mx, y: my };
  }
  return null;
}

// 드래프트 업데이트(미리보기)
function updateDraft() {
  if (!draft) return;
  const w = mouseWorld;
  switch (draft.type) {
    case 'LINE': draft.x2 = w.x; draft.y2 = w.y; break;
    case 'CIRCLE': draft.r = Math.hypot(w.x - draft.cx, w.y - draft.cy); break;
    case 'LWPOLYLINE':
      if (draft._base) {
        const b = draft._base;
        draft.points = [[b.x, b.y], [w.x, b.y], [w.x, w.y], [b.x, w.y]];
      } else if (draft._poly) {
        const c = draft._poly;
        const r = Math.hypot(w.x - c.cx, w.y - c.cy);
        const a0 = Math.atan2(w.y - c.cy, w.x - c.cx);
        draft.points = polygonPoints(c.cx, c.cy, r, polygonSides, a0);
      } else if (draft._ell) {
        const c = draft._ell;
        draft.points = ellipsePoints(c.cx, c.cy, Math.abs(w.x - c.cx) || 1e-6, Math.abs(w.y - c.cy) || 1e-6);
      }
      break;
  }
  if (moveOp && moveOp.grip) updateGripMove();
}

function updateGripMove() {
  // 그립 이동은 라이브로 적용하되 base 갱신
  const e = moveOp.gripEntity, i = moveOp.gripIndex, w = mouseWorld;
  switch (e.type) {
    case 'LINE': if (i === 0) { e.x1 = w.x; e.y1 = w.y; } else { e.x2 = w.x; e.y2 = w.y; } break;
    case 'LWPOLYLINE': e.points[i] = [w.x, w.y]; break;
    case 'CIRCLE': case 'ARC': { const dx = w.x - e.cx, dy = w.y - e.cy; e.cx = w.x; e.cy = w.y; break; }
    case 'TEXT': e.x = w.x; e.y = w.y; break;
  }
}

function commitDraft() {
  if (!draft) return;
  if (draft.type === 'CIRCLE' && draft.r < 1e-6) { cancelDraft(); return; }
  if (draft.type === 'LWPOLYLINE' && (!draft.points || draft.points.length < 2)) { cancelDraft(); return; }
  delete draft._base; delete draft._poly; delete draft._ell;
  addEntity(draft);
  draft = null;
  updateStat(); renderProps();
}
function cancelDraft() { draft = null; pts = []; draw(); }

// 폴리라인 완료
function finishPolyline() {
  if (pts.length >= 2) {
    pushUndo();
    addEntity({ type: 'LWPOLYLINE', closed: false, points: pts.map(p => [p.x, p.y]) });
    updateStat();
  }
  pts = []; draw();
}

// 호: 3클릭(중심 → 시작 → 끝)
let arcState = null;
function handleArcClick(w) {
  if (!arcState) { arcState = { cx: w.x, cy: w.y }; hint('호: 시작점을 클릭하세요.'); }
  else if (arcState.r === undefined) {
    arcState.r = Math.hypot(w.x - arcState.cx, w.y - arcState.cy);
    arcState.startAngle = ang(arcState.cx, arcState.cy, w.x, w.y);
    hint('호: 끝점을 클릭하세요.');
  } else {
    const endAngle = ang(arcState.cx, arcState.cy, w.x, w.y);
    pushUndo();
    addEntity({ type: 'ARC', cx: arcState.cx, cy: arcState.cy, r: arcState.r,
      startAngle: arcState.startAngle, endAngle });
    arcState = null; updateStat(); hint('호: 중심점을 클릭하세요.');
  }
}
function ang(cx, cy, x, y) { let a = Math.atan2(y - cy, x - cx) * 180 / Math.PI; return a < 0 ? a + 360 : a; }

// 이동 확정
function commitMove() {
  if (!moveOp) return;
  for (const id of moveOp.entities) {
    const e = state.entities.find(x => x.id === id);
    if (e) translateEntity(e, moveOp.dx, moveOp.dy);
  }
  moveOp = null; draw(); renderProps();
}
function finishGripMoveMaybe() {
  if (moveOp && moveOp.grip) { moveOp = null; renderProps(); return; }
  if (moveOp && !moveOp.twoClick && moveOp.entities) { commitMove(); }
}

function finishDragSelect(ev) {
  const { x1, y1, x2, y2 } = dragSelect;
  if (Math.hypot(x2 - x1, y2 - y1) * state.view.scale > 3) {  // 실제 드래그(3px 이상)일 때만
    if (!ev.shiftKey) state.selection.clear();
    const box = { xmin: Math.min(x1, x2), xmax: Math.max(x1, x2), ymin: Math.min(y1, y2), ymax: Math.max(y1, y2) };
    const crossing = x2 < x1; // 오른쪽→왼쪽 드래그 = 크로싱(걸치면 선택), 왼→오 = 윈도우(전체 포함)
    for (const e of state.entities) {
      const l = getLayer(e.layer); if (l && (!l.visible || l.locked)) continue; // 잠긴 레이어 제외
      if (!onLv(e)) continue;
      if (crossing ? entityCrossesBox(e, box) : entityFullyInBox(e, box)) state.selection.add(e.id);
    }
  }
  dragSelect = null; renderProps(); draw();
}

// 이동 미리보기를 위해 draw에서 moveOp 반영
const _origDrawEntity = drawEntity;
// (이동 중인 도형은 임시 오프셋으로 그림)
function drawWithMove() { /* 통합 draw에서 처리 */ }

// draw 함수에서 moveOp 오프셋 적용을 위해 래핑
const realDraw = draw;
// override entity drawing during move preview
(function patchMovePreview() {
  const origDraw = draw;
})();

// ============================================================
//  명령행 / 미리보기
// ============================================================
const cmdPromptEl = document.getElementById('cmdPrompt');
const cmdInputEl = document.getElementById('cmdInput');
const cmdLogEl = document.getElementById('cmdLog');
function setPrompt(t) { if (cmdPromptEl) cmdPromptEl.textContent = t; hint(t); }
// 명령 기록(로그) 한 줄 추가. cls: 'cmd' | 'ok' | 'warn' | 'info'
function logLine(text, cls) {
  if (!cmdLogEl) return;
  const d = document.createElement('div');
  d.className = 'logline' + (cls ? ' l-' + cls : '');
  d.textContent = text;
  cmdLogEl.appendChild(d);
  cmdLogEl.scrollTop = cmdLogEl.scrollHeight;
  while (cmdLogEl.children.length > 400) cmdLogEl.removeChild(cmdLogEl.firstChild);
}
const TOOL_KO = {
  select: '선택(SELECT)', pan: '화면 이동(PAN)', line: '선(LINE)', pline: '폴리라인(PLINE)', rect: '사각형(RECT)',
  circle: '원(CIRCLE)', arc: '호(ARC)', text: '문자(TEXT)', move: '이동(MOVE)', erase: '지우기(ERASE)',
  offset: '오프셋(OFFSET)', copy: '복사(COPY)', mirror: '대칭(MIRROR)', rotate: '회전(ROTATE)',
  array: '배열(ARRAY)', trim: '자르기(TRIM)', extend: '연장(EXTEND)', fillet: '모깎기(FILLET)',
  scale: '배율(SCALE)', stretch: '신축(STRETCH)',
  polygon: '다각형(POLYGON)', ellipse: '타원(ELLIPSE)', chamfer: '모따기(CHAMFER)',
  dim: '치수(DIM)', dist: '거리(DIST)', area: '면적(AREA)',
  explode: '분해(EXPLODE)', join: '결합(JOIN)', zoom: '줌(ZOOM)',
  break: '끊기(BREAK)', lengthen: '길이조정(LENGTHEN)', hatch: '해치(HATCH)',
  dimrad: '반지름 치수(DIMRADIUS)', dimdia: '지름 치수(DIMDIAMETER)',
  block: '블록 정의(BLOCK)', insert: '블록 삽입(INSERT)', matchprop: '속성 일치(MATCHPROP)',
  dimang: '각도 치수(DIMANGULAR)', divide: '등분(DIVIDE)', measure: '간격 표식(MEASURE)',
  leader: '지시선(LEADER)', front: '맨 앞으로(FRONT)', back: '맨 뒤로(BACK)', similar: '유사 선택(SIMILAR)',
};

const CMD_ALIASES = {
  line: 'line', l: 'line', pline: 'pline', pl: 'pline', polyline: 'pline',
  rect: 'rect', rectangle: 'rect', rec: 'rect', circle: 'circle', c: 'circle',
  arc: 'arc', a: 'arc', text: 'text', t: 'text', dtext: 'text', mtext: 'text',
  move: 'move', m: 'move', erase: 'erase', e: 'erase', del: 'erase', delete: 'erase',
  select: 'select', s: 'select',
  offset: 'offset', o: 'offset', copy: 'copy', co: 'copy', cp: 'copy',
  mirror: 'mirror', mi: 'mirror', rotate: 'rotate', ro: 'rotate',
  array: 'array', ar: 'array',
  trim: 'trim', tr: 'trim', extend: 'extend', ex: 'extend',
  fillet: 'fillet', f: 'fillet', scale: 'scale', sc: 'scale',
  stretch: 'stretch', st: 'stretch',
  polygon: 'polygon', pol: 'polygon', ellipse: 'ellipse', el: 'ellipse',
  chamfer: 'chamfer', cha: 'chamfer',
  explode: 'explode', x: 'explode', join: 'join', j: 'join',
  dist: 'dist', di: 'dist', area: 'area', aa: 'area',
  dim: 'dim', dli: 'dim', dal: 'dim', dimlinear: 'dim', dimaligned: 'dim',
  zoom: 'zoom', z: 'zoom', zp: 'zp', u: 'undo', undo: 'undo', redo: 'redo',
  pan: 'pan',
  break: 'break', br: 'break', lengthen: 'lengthen', len: 'lengthen',
  hatch: 'hatch', h: 'hatch',
  dimradius: 'dimrad', dimrad: 'dimrad', dra: 'dimrad',
  dimdiameter: 'dimdia', dimdia: 'dimdia', ddi: 'dimdia',
  block: 'block', b: 'block', insert: 'insert', i: 'insert',
  matchprop: 'matchprop', ma: 'matchprop', mp: 'matchprop',
  dimangular: 'dimang', dimang: 'dimang', dan: 'dimang',
  divide: 'divide', div: 'divide', measure: 'measure', me: 'measure',
  leader: 'leader', le: 'leader', ld: 'leader',
  front: 'front', fr: 'front', back: 'back', bk: 'back',
  similar: 'similar', ss: 'similar',
  centerline: 'centerline', cl: 'centerline',
  revcloud: 'revcloud', rc: 'revcloud',
  frame: 'frame', align: 'align', al: 'align',
  isolate: 'isolate', iso: 'isolate', uniso: 'uniso', unisolate: 'uniso',
  sum: 'sum', xline: 'xline', xl: 'xline',
  breakpt: 'breakpt', bp: 'breakpt',
  help: 'help', '?': 'help',
  wall: 'wall', slab: 'slab', column: 'column', col: 'column',
  door: 'door', window: 'window', win: 'window', bimclear: 'bimclear',
  '3d': 'view3d', view3d: 'view3d',
  roofview: 'roofview', rview: 'roofview',
  level: 'level', lv: 'level',
  roof: 'roof',
  stair: 'stair', '계단': 'stair',
  extrudecrv: 'extrudecrv', extcrv: 'extrudecrv',
  extrudesrf: 'extrudesrf', extsrf: 'extrudesrf',
  move3d: 'move3d', m3: 'move3d',
  copy3d: 'copy3d', c3: 'copy3d',
  box: 'box', cylinder: 'cylinder', cyl: 'cylinder',
  settop: 'settop',
  union: 'union', boolunion: 'union', 합집합: 'union',
  difference: 'difference', boolsub: 'difference', subtract: 'difference', 차집합: 'difference',
  intersect3d: 'intersect3d', boolint: 'intersect3d', 교집합: 'intersect3d',
  exportstl: 'exportstl', stl: 'exportstl',
  exportobj: 'exportobj', obj: 'exportobj',
  selectedexport: 'selectedexport', selexport: 'selectedexport', exportsel: 'selectedexport',
  section: 'section', sec: 'section',
  elevation: 'elevation', elev: 'elevation', ev: 'elevation',
};

function runCommandInput(raw) {
  const v = raw.trim().toLowerCase();
  if (!v) return; // 빈 Enter
  logLine('명령: ' + v, 'cmd');
  // 뷰 명령: vs 이름(저장) / vg 이름(이동) / vl(목록)
  let vm = raw.trim().match(/^vs\s+(.+)$/i);
  if (vm) { state.views[vm[1].trim()] = { ...state.view }; logLine(`  ✔ 뷰 저장: "${vm[1].trim()}"`, 'ok'); return; }
  vm = raw.trim().match(/^vg\s+(.+)$/i);
  if (vm) {
    const vv = state.views[vm[1].trim()];
    if (vv) { pushViewPrev(); state.view = { ...vv }; draw(); logLine(`  ✔ 뷰 이동: "${vm[1].trim()}"`, 'ok'); }
    else logLine(`  뷰 "${vm[1].trim()}"이 없습니다. (vl=목록)`, 'warn');
    return;
  }
  if (v === 'vl') { const ns = Object.keys(state.views); logLine('  저장된 뷰: ' + (ns.length ? ns.join(', ') : '(없음)') + '  — vs 이름=저장, vg 이름=이동', 'info'); return; }
  // 해치 도구 중 패턴명 입력 (예: brick, concrete)
  if (state.tool === 'hatch' && HATCH_PATTERNS[v]) {
    hatchPattern = v;
    setPrompt(`해치: 패턴 ${HATCH_PATTERNS[v].ko}, 간격 ${hatchSpacing}. 경계를 클릭하세요.`);
    logLine(`  해치 패턴 = ${HATCH_PATTERNS[v].ko}`, 'info'); return;
  }
  // 진행 중 작도 도구의 좌표/치수 입력을 우선 처리
  if (feedDrawInput(v)) return;
  // 숫자 입력 → 진행 중 명령의 수치 인자
  const num = parseFloat(v);
  if (!isNaN(num) && /^-?[\d.]+$/.test(v)) {
    if (state.tool === 'offset') { offsetDist = Math.abs(num) || offsetDist; setPrompt(`오프셋: 도형을 선택하세요. (거리 ${offsetDist})`); logLine(`  오프셋 거리 = ${offsetDist}`, 'info'); return; }
    if (state.tool === 'rotate' && cmdOp && cmdOp.step === 'angle') { logLine(`  회전 각도 = ${num}°`, 'info'); applyRotate(num); return; }
    if (state.tool === 'fillet') { filletRadius = Math.abs(num); setPrompt(`모깎기: 반지름 ${filletRadius}. 첫 번째 선을 클릭하세요.`); logLine(`  모깎기 반지름 = ${filletRadius}`, 'info'); return; }
    if (state.tool === 'chamfer') { chamferDist = Math.abs(num); setPrompt(`모따기: 거리 ${chamferDist}. 첫 번째 선을 클릭하세요.`); logLine(`  모따기 거리 = ${chamferDist}`, 'info'); return; }
    if (state.tool === 'lengthen') { lengthenDelta = num; setPrompt(`길이조정: ${num > 0 ? '+' : ''}${num}. 조정할 선의 끝쪽을 클릭하세요.`); logLine(`  증감 길이 = ${num > 0 ? '+' : ''}${num}`, 'info'); return; }
    if (state.tool === 'hatch') { hatchSpacing = Math.abs(num) || hatchSpacing; setPrompt(`해치: 간격 ${hatchSpacing}. 원/닫힌 폴리라인을 클릭하세요.`); logLine(`  해치 간격 = ${hatchSpacing}`, 'info'); return; }
    if (state.tool === 'divide') { divideCount = Math.max(2, Math.round(Math.abs(num))); setPrompt(`등분: ${divideCount}등분. 대상을 클릭하세요.`); logLine(`  등분 개수 = ${divideCount}`, 'info'); return; }
    if (state.tool === 'measure') { measureStep = Math.abs(num) || measureStep; setPrompt(`간격 표식: ${measureStep}. 대상을 클릭하세요.`); logLine(`  간격 = ${measureStep}`, 'info'); return; }
    if (state.tool === 'scale' && cmdOp && (cmdOp.step === 'ref' || cmdOp.step === 'factor')) { applyScale(num); return; }
    logLine('  (입력한 숫자를 받을 명령이 없습니다)', 'warn'); return;
  }
  const tool = settings.aliases[v] || CMD_ALIASES[v]; // 사용자 단축키 우선
  if (tool && INSTANT_CMDS[tool]) { // 즉시 실행 명령(분해·결합·줌·실행취소 등)
    INSTANT_CMDS[tool]();
    if (tool === 'explode' || tool === 'join') lastCommand = tool;
    return;
  }
  if (tool) { setTool(tool); if (tool !== 'select') lastCommand = tool; }
  else logLine(`  알 수 없는 명령: ${v}`, 'warn');
}

// 직전 명령 반복(스페이스/Enter)
function repeatLastCommand() {
  if (!lastCommand) { logLine('  반복할 명령이 없습니다.', 'warn'); return; }
  logLine(`명령: ${lastCommand}  (반복)`, 'cmd');
  if (INSTANT_CMDS[lastCommand]) { INSTANT_CMDS[lastCommand](); return; }
  setTool(lastCommand);
}
// 빈 칸에서 Enter/스페이스: 폴리라인 작도 중이면 종료, 아니면 직전 명령 반복
function emptyEnterAction() {
  if (typeof boolPending !== 'undefined' && boolPending) { boolFinish(); return; } // 차집합 2단계 완료
  if (state.tool === 'pline') {
    if (pts.length >= 2) { finishPolyline(); return; }
    pts = []; draw(); return;
  }
  if (state.tool === 'area' && pts.length) { finishArea(); return; } // 면적 계산 확정
  if (state.tool === 'trim') { trimSpaceAction(); return; }           // 자르기 모드 전환/확정
  if (draft) { cancelDraft(); return; }
  repeatLastCommand();
}

// ---------- 좌표/치수 입력 파서 ----------
// "x,y" → 절대점 | "@dx,dy" → 상대점 | "12" → 단일 수치
function parsePointOrNumber(v) {
  v = v.trim();
  let m = v.match(/^@\s*(-?[\d.]+)\s*<\s*(-?[\d.]+)$/); // 극좌표: @거리<각도
  if (m) { const dd = +m[1], aa = +m[2] * Math.PI / 180; return { kind: 'rel', dx: dd * Math.cos(aa), dy: dd * Math.sin(aa) }; }
  m = v.match(/^@\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/);
  if (m) return { kind: 'rel', dx: +m[1], dy: +m[2] };
  m = v.match(/^(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/);
  if (m) return { kind: 'abs', x: +m[1], y: +m[2] };
  if (/^-?[\d.]+$/.test(v)) return { kind: 'num', n: +v };
  return null;
}
// 진행 중 작도 도구에 좌표/치수 입력을 공급. 소비하면 true.
function feedDrawInput(v) {
  const p = parsePointOrNumber(v);
  if (!p) return false;
  switch (state.tool) {
    case 'line': return feedLine(p);
    case 'circle': return feedCircle(p);
    case 'rect': return feedRect(p);
    case 'pline': return feedPline(p);
    case 'arc': return feedArc(p);
    case 'move': return feedMove(p);
    case 'copy': return feedCopy(p);
    case 'polygon': return feedPolygon(p);
    case 'ellipse': return feedEllipse(p);
    case 'dim': return feedPointCmd(p, clickDim);
    case 'leader': return feedPointCmd(p, clickLeader);
    case 'revcloud': return feedPointCmd(p, clickRevcloud);
    case 'frame': return feedPointCmd(p, clickFrame);
    case 'align': return feedPointCmd(p, (w) => clickAlign(w, w));
    case 'xline': return feedPointCmd(p, clickXline);
    case 'breakpt': return feedPointCmd(p, (w) => clickBreakpt(w, w));
    case 'section': return feedPointCmd(p, (w) => clickSection(w, false));
    case 'elevation': return feedPointCmd(p, (w) => clickSection(w, true));
    case 'text': return feedPointCmd(p, (w) => { const t = prompt('문자 입력:', ''); if (t) { pushUndo(); addEntity({ type: 'TEXT', x: w.x, y: w.y, height: state.textHeight, text: t, rotation: 0 }); updateStat(); } });
    case 'dist': return feedPointCmd(p, clickDist);
    case 'area': return feedPointCmd(p, (w) => clickArea(w, w));
    case 'break': return feedPointCmd(p, (w) => clickBreak(w, w));
  }
  return false;
}
// 기준점(base) 대비 입력값 → 변위(dx,dy). 절대점/상대점/거리(커서 방향) 지원
function displacementFrom(base, p) {
  if (p.kind === 'rel') return { dx: p.dx, dy: p.dy };
  if (p.kind === 'abs') return { dx: p.x - base.x, dy: p.y - base.y };
  const c = screenToWorld(mouseScreen.x, mouseScreen.y);
  const vx = c.x - base.x, vy = c.y - base.y, l = Math.hypot(vx, vy) || 1;
  return { dx: vx / l * p.n, dy: vy / l * p.n };
}
function feedMove(p) {
  if (!moveOp || !moveOp.base) { logLine('  먼저 옮길 도형과 기준점을 지정하세요.', 'warn'); return true; }
  const d = displacementFrom(moveOp.base, p);
  moveOp.dx = d.dx; moveOp.dy = d.dy; commitMove();
  logLine(`  ✔ 이동 (${d.dx.toFixed(2)}, ${d.dy.toFixed(2)})`, 'ok'); draw(); return true;
}
function feedCopy(p) {
  if (!cmdOp || cmdOp.name !== 'copy') { logLine('  먼저 도형을 선택하고 복사 기준점을 지정하세요.', 'warn'); return true; }
  if (cmdOp.step === 'base') { // 기준점을 좌표로 지정
    if (p.kind === 'abs') { cmdOp.base = { x: p.x, y: p.y }; cmdOp.step = 'dest'; setPrompt('복사: 붙일 위치 입력/클릭 (반복 가능)'); return true; }
    logLine('  복사 기준점을 클릭하거나 x,y로 입력하세요.', 'warn'); return true;
  }
  if (cmdOp.step === 'dest') {
    const d = displacementFrom(cmdOp.base, p);
    pushUndo();
    const T = T_translate(d.dx, d.dy); const ents = selectedEntities();
    for (const e of ents) addEntity(transformedClone(e, T));
    logLine(`  ✔ 복사 ${ents.length}개 (${d.dx.toFixed(2)}, ${d.dy.toFixed(2)})`, 'ok');
    updateStat(); draw(); return true; // step 유지 → 반복 붙여넣기
  }
  return true;
}
// 점 기반 명령(dim/dist/area)에 x,y 좌표 입력 전달
function feedPointCmd(p, fn) {
  if (p.kind === 'abs') { fn({ x: p.x, y: p.y }); draw(); return true; }
  logLine('  이 명령은 점(x,y)으로 입력하세요.', 'warn'); return true;
}
function feedPolygon(p) {
  if (!draft) {
    if (p.kind === 'num') {
      polygonSides = Math.max(3, Math.round(Math.abs(p.n)));
      setPrompt(`다각형(${polygonSides}변): 중심을 클릭하거나 x,y로 입력하세요.`);
      logLine(`  변 개수 = ${polygonSides}`, 'info'); return true;
    }
    if (p.kind === 'abs') { clickPolygon({ x: p.x, y: p.y }); draw(); return true; }
    logLine('  변 개수(숫자) 또는 중심(x,y)을 입력하세요.', 'warn'); return true;
  }
  const c = draft._poly;
  let r, a0;
  if (p.kind === 'num') { r = Math.abs(p.n); a0 = Math.PI / 2; } // 꼭짓점 위쪽
  else if (p.kind === 'abs') { r = Math.hypot(p.x - c.cx, p.y - c.cy); a0 = Math.atan2(p.y - c.cy, p.x - c.cx); }
  else { r = Math.hypot(p.dx, p.dy); a0 = Math.atan2(p.dy, p.dx); }
  if (r < 1e-9) { logLine('  반지름이 0입니다.', 'warn'); return true; }
  draft.points = polygonPoints(c.cx, c.cy, r, polygonSides, a0);
  commitDraft(); logLine(`  ✔ ${polygonSides}각형 R=${fmtNum(r)}`, 'ok'); draw(); return true;
}
function feedEllipse(p) {
  if (!draft) {
    if (p.kind === 'abs') { clickEllipse({ x: p.x, y: p.y }); draw(); return true; }
    logLine('  먼저 중심점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  const c = draft._ell;
  let rx, ry;
  if (p.kind === 'num') rx = ry = Math.abs(p.n);
  else if (p.kind === 'abs') { rx = Math.abs(p.x); ry = Math.abs(p.y); }
  else { rx = Math.abs(p.dx); ry = Math.abs(p.dy); }
  if (rx < 1e-9 || ry < 1e-9) { logLine('  반지름이 0입니다.', 'warn'); return true; }
  draft.points = ellipsePoints(c.cx, c.cy, rx, ry);
  commitDraft(); logLine(`  ✔ 타원 ${fmtNum(rx)}×${fmtNum(ry)}`, 'ok'); draw(); return true;
}
function feedLine(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'LINE', x1: p.x, y1: p.y, x2: p.x, y2: p.y }; setPrompt('선: 끝점(x,y / @dx,dy / 길이) 입력 또는 클릭'); logLine(`  시작점 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 시작점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  let ex, ey;
  if (p.kind === 'abs') { ex = p.x; ey = p.y; }
  else if (p.kind === 'rel') { ex = draft.x1 + p.dx; ey = draft.y1 + p.dy; }
  else { const dx = mouseWorld.x - draft.x1, dy = mouseWorld.y - draft.y1, L = Math.hypot(dx, dy) || 1; ex = draft.x1 + dx / L * p.n; ey = draft.y1 + dy / L * p.n; }
  draft.x2 = ex; draft.y2 = ey; commitDraft(); logLine('  ✔ 선', 'ok');
  pushUndo(); draft = { type: 'LINE', x1: ex, y1: ey, x2: ex, y2: ey }; // 끝점에서 이어 그리기
  setPrompt('선: 다음 끝점 입력/클릭 (Enter·우클릭으로 종료)');
  draw(); return true;
}
function feedCircle(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'CIRCLE', cx: p.x, cy: p.y, r: 0 }; setPrompt('원: 반지름(숫자)을 입력하거나 점을 클릭하세요.'); logLine(`  중심 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 중심점을 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  let r;
  if (p.kind === 'num') r = Math.abs(p.n);
  else if (p.kind === 'abs') r = Math.hypot(p.x - draft.cx, p.y - draft.cy);
  else r = Math.hypot(p.dx, p.dy);
  draft.r = r; commitDraft(); logLine(`  ✔ 원 반지름 ${r}`, 'ok'); draw(); return true;
}
function feedRect(p) {
  if (!draft) {
    if (p.kind === 'abs') { pushUndo(); draft = { type: 'LWPOLYLINE', closed: true, _base: { x: p.x, y: p.y }, points: [[p.x, p.y], [p.x, p.y], [p.x, p.y], [p.x, p.y]] }; setPrompt('사각형: 크기 w,h (또는 한 변 길이)를 입력하거나 클릭'); logLine(`  첫 모서리 (${p.x}, ${p.y})`, 'info'); draw(); return true; }
    logLine('  먼저 첫 모서리를 지정하세요 (x,y 또는 클릭).', 'warn'); return true;
  }
  const b = draft._base; let ox, oy;
  if (p.kind === 'num') { ox = b.x + p.n; oy = b.y + p.n; }       // 정사각형
  else if (p.kind === 'abs') { ox = b.x + p.x; oy = b.y + p.y; }   // w,h 크기
  else { ox = b.x + p.dx; oy = b.y + p.dy; }
  draft.points = [[b.x, b.y], [ox, b.y], [ox, oy], [b.x, oy]]; commitDraft(); logLine('  ✔ 사각형', 'ok'); draw(); return true;
}
function feedPline(p) {
  let np;
  if (p.kind === 'abs') np = { x: p.x, y: p.y };
  else if (p.kind === 'rel') { const last = pts[pts.length - 1] || { x: 0, y: 0 }; np = { x: last.x + p.dx, y: last.y + p.dy }; }
  else { const last = pts[pts.length - 1]; if (!last) { logLine('  먼저 첫 점을 지정하세요.', 'warn'); return true; } const dx = mouseWorld.x - last.x, dy = mouseWorld.y - last.y, L = Math.hypot(dx, dy) || 1; np = { x: last.x + dx / L * p.n, y: last.y + dy / L * p.n }; }
  pts.push(np); draw(); return true;
}
function feedArc(p) {
  if (p.kind !== 'abs') { logLine('  호는 점(x,y)으로 입력하세요.', 'warn'); return true; }
  if (!arcState) { arcState = { cx: p.x, cy: p.y }; setPrompt('호: 시작점(x,y)을 입력하거나 클릭'); return true; }
  if (arcState.r === undefined) { arcState.r = Math.hypot(p.x - arcState.cx, p.y - arcState.cy); arcState.startAngle = ang(arcState.cx, arcState.cy, p.x, p.y); setPrompt('호: 끝점(x,y)을 입력하거나 클릭'); return true; }
  const ea = ang(arcState.cx, arcState.cy, p.x, p.y);
  pushUndo(); addEntity({ type: 'ARC', cx: arcState.cx, cy: arcState.cy, r: arcState.r, startAngle: arcState.startAngle, endAngle: ea });
  arcState = null; logLine('  ✔ 호', 'ok'); updateStat(); draw(); return true;
}

// 명령 실행 전 결과 미리보기(점선 고스트)
function updateCmdPreview() {
  previewEnts = null;
  if (state.tool === '_paste' && cmdOp && cmdOp.name === 'paste') { // 붙여넣기 고스트
    const clip = cmdOp.clip, dx = mouseWorld.x - clip.base[0], dy = mouseWorld.y - clip.base[1];
    previewEnts = clip.ents.map(src => { const c = cloneEntity(src); translateEntity(c, dx, dy); return c; });
    return;
  }
  if (state.tool === 'insert' && insertName && state.blocks[insertName]) { // 블록 삽입 고스트
    previewEnts = insertChildren({ type: 'INSERT', layer: state.currentLayer, name: insertName, x: mouseWorld.x, y: mouseWorld.y, sx: insertScale, sy: insertScale, rot: insertRot });
    return;
  }
  if (!cmdOp) return;
  const sel = selectedEntities();
  const w = mouseWorld;
  if (cmdOp.name === 'copy' && cmdOp.step === 'dest' && cmdOp.base) {
    const T = T_translate(w.x - cmdOp.base.x, w.y - cmdOp.base.y);
    previewEnts = sel.map(e => transformedClone(e, T));
  } else if (cmdOp.name === 'mirror' && cmdOp.step === 'p2' && cmdOp.p1) {
    const T = T_mirror(cmdOp.p1.x, cmdOp.p1.y, w.x, w.y);
    previewEnts = sel.map(e => transformedClone(e, T));
  } else if (cmdOp.name === 'rotate' && cmdOp.step === 'angle' && cmdOp.base) {
    const deg = ang(cmdOp.base.x, cmdOp.base.y, w.x, w.y);
    const T = T_rotate(cmdOp.base.x, cmdOp.base.y, deg);
    previewEnts = sel.map(e => transformedClone(e, T));
    setPrompt(`회전: ${deg.toFixed(1)}° (클릭 또는 각도 입력)`);
  } else if (cmdOp.name === 'offset' && cmdOp.step === 'side' && cmdOp.target) {
    const ne = offsetEntity(cmdOp.target, offsetDist, screenToWorld(mouseScreen.x, mouseScreen.y));
    if (ne) previewEnts = [ne];
  } else if (cmdOp.name === 'scale' && cmdOp.step === 'new' && cmdOp.base && cmdOp.ref > 1e-9) {
    const f = Math.hypot(w.x - cmdOp.base.x, w.y - cmdOp.base.y) / cmdOp.ref;
    previewEnts = sel.map(e => cloneEntity(e));
    scaleEntities(previewEnts, cmdOp.base, f);
    setPrompt(`배율: ×${f.toFixed(3)} (클릭 또는 숫자 입력)`);
  } else if (cmdOp.name === 'stretch' && cmdOp.step === 'dest' && cmdOp.base && cmdOp.ents) {
    previewEnts = cmdOp.ents.map(e => cloneEntity(e));
    stretchEntities(previewEnts, cmdOp.box, w.x - cmdOp.base.x, w.y - cmdOp.base.y);
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'pos' && cmdOp.p1 && cmdOp.p2) {
    previewEnts = computeDimension(cmdOp.p1, cmdOp.p2, w);
  } else if (cmdOp.name === 'dimang' && cmdOp.step === 'pos' && cmdOp.l1 && cmdOp.l2) {
    const r2 = computeAngularDim(cmdOp.l1, cmdOp.l2, w);
    if (r2) previewEnts = r2.list;
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'cont' && cmdOp.p1) {
    const p1 = cmdOp.p1, dx = w.x - p1.x, dy = w.y - p1.y, L = Math.hypot(dx, dy);
    if (L > 1e-9) previewEnts = computeDimension(p1, w, { x: (p1.x + w.x) / 2 + (-dy / L) * cmdOp.h, y: (p1.y + w.y) / 2 + (dx / L) * cmdOp.h });
  } else if (cmdOp.name === 'dim' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
  } else if (cmdOp.name === 'leader' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
  } else if (cmdOp.name === 'dist' && cmdOp.step === 'p2' && cmdOp.p1) {
    previewEnts = [{ type: 'LINE', x1: cmdOp.p1.x, y1: cmdOp.p1.y, x2: w.x, y2: w.y }];
    setPrompt(`거리: ${fmtNum(Math.hypot(w.x - cmdOp.p1.x, w.y - cmdOp.p1.y))} (두 번째 점 클릭)`);
  }
}

// ============================================================
//  배열(ARRAY) 대화상자
// ============================================================
function openArrayDialog() {
  const dlg = document.getElementById('arrayDlg');
  dlg.style.display = 'flex';
  setPrompt('배열: 옵션을 설정하세요.');
}
function closeArrayDialog() { document.getElementById('arrayDlg').style.display = 'none'; }
(function bindArrayDialog() {
  const dlg = document.getElementById('arrayDlg');
  if (!dlg) return;
  dlg.querySelectorAll('input[name=arrMode]').forEach(r =>
    r.addEventListener('change', () => {
      const polar = dlg.querySelector('input[name=arrMode]:checked').value === 'polar';
      dlg.querySelector('#arrRect').style.display = polar ? 'none' : 'block';
      dlg.querySelector('#arrPolar').style.display = polar ? 'block' : 'none';
    }));
  document.getElementById('arrCancel').addEventListener('click', () => { closeArrayDialog(); cmdOp = null; setTool('select'); });
  document.getElementById('arrOk').addEventListener('click', () => {
    const mode = dlg.querySelector('input[name=arrMode]:checked').value;
    if (mode === 'rect') {
      const p = {
        rows: Math.max(1, parseInt(dlg.querySelector('#arrRows').value) || 1),
        cols: Math.max(1, parseInt(dlg.querySelector('#arrCols').value) || 1),
        rowSpace: parseFloat(dlg.querySelector('#arrRowSp').value) || 0,
        colSpace: parseFloat(dlg.querySelector('#arrColSp').value) || 0,
      };
      closeArrayDialog(); applyRectArray(p); cmdOp = null; setTool('select');
    } else {
      const p = {
        count: Math.max(2, parseInt(dlg.querySelector('#arrCount').value) || 2),
        total: parseFloat(dlg.querySelector('#arrAngle').value) || 360,
        fill: dlg.querySelector('#arrFill').checked,
      };
      closeArrayDialog();
      cmdOp = { name: 'array', step: 'center', params: p };
      setPrompt('원형 배열: 중심점을 클릭하세요.');
    }
  });
})();

// ============================================================
//  도구 / UI
// ============================================================
function setTool(t) {
  state.tool = t;
  if (t !== 'select' && t !== 'pan' && window.WEBCAD_API && WEBCAD_API.onUsage) WEBCAD_API.onUsage('tool:' + t);
  draft = null; pts = []; arcState = null; moveOp = null; dragSelect = null;
  cmdOp = null; previewEnts = null; trackPt = null; otrackAlign = null;
  document.querySelectorAll('.tool').forEach(el => el.classList.toggle('active', el.dataset.tool === t));
  cv.style.cursor = (t === 'select') ? 'default' : (t === 'pan') ? 'grab' : 'crosshair';
  const b3c = document.getElementById('b3cv'); if (b3c) b3c.style.cursor = typeof cursor3D === 'function' ? cursor3D() : cv.style.cursor; // 3D 캔버스도 동일 규칙
  if (typeof v3 !== 'undefined' && v3) v3.line3d = null; // 도구 변경 시 3D 선 체인 종료
  const hints = {
    select: '선택 도구입니다. 도형을 클릭하거나 빈 영역을 드래그(왼→오 윈도우 / 오→왼 크로싱)하세요.',
    pan: '화면 이동(손 도구): 빈 화면을 드래그하면 화면이 이동합니다. 선택하려면 "선택" 도구로 바꾸세요.',
    line: '선: 점을 연속 클릭하면 이어서 그려집니다. 우클릭·Enter·Esc로 종료. (x,y / @dx,dy / 길이 입력 가능)',
    pline: '폴리라인: 점 연속 클릭(또는 x,y 입력), 빈 Enter로 완료.',
    rect: '사각형: 첫 모서리 클릭/입력 후 크기 w,h(또는 한 변 길이) 입력 가능.',
    circle: '원: 중심 클릭/입력(x,y) 후 반지름 숫자를 명령행에 입력하세요.',
    arc: '호: 중심→시작→끝 클릭(또는 각 점을 x,y로 입력).',
    text: '문자: 위치를 클릭하면 입력창이 열립니다.',
    move: '이동: (도형 선택)→기준점→이동점 클릭. 또는 @dx,dy · x,y · 거리 입력.',
    erase: '지우기: 지울 도형을 클릭하세요.',
    offset: `오프셋: 도형을 선택하세요. (거리 ${offsetDist}, 숫자 입력으로 변경)`,
    copy: '복사: (도형 선택)→기준점 후, 붙일 위치 클릭 또는 @dx,dy · x,y · 거리 입력(반복).',
    mirror: '대칭: 도형을 선택하고 대칭축 두 점을 클릭하세요.',
    rotate: '회전: 도형을 선택하고 중심 지정 후, 각도(°) 입력 또는 클릭.',
    array: '배열: 도형을 선택하면 배열 설정 창이 열립니다.',
    trim: '자르기: 기준 객체들을 클릭하고 Space로 확정 → 걸치는 부분 클릭. (기준 없이 바로 Space=빠른 모드)',
    extend: '연장: 늘릴 선의 끝쪽을 클릭하면 가장 가까운 경계까지 연장됩니다.',
    fillet: `모깎기: 반지름 ${filletRadius}. 첫 번째 선 → 두 번째 선을 클릭하세요. (숫자로 반지름 변경)`,
    scale: '배율: 도형을 선택하고 기준점 → 배율(숫자) 또는 참조 두 점을 지정하세요.',
    stretch: '신축: 걸침 영역의 두 모서리를 클릭하고, 기준점 → 이동점을 지정하세요.',
    polygon: `다각형: 변 개수(숫자, 현재 ${polygonSides}) 입력 → 중심 → 반지름/꼭짓점.`,
    ellipse: '타원: 중심 클릭 후 코너 클릭 또는 rx,ry 입력.',
    chamfer: `모따기: 거리 ${chamferDist}. 첫 선 → 둘째 선 클릭. (숫자로 거리 변경)`,
    dim: '치수: 첫 점 → 둘째 점 → 치수선 위치 클릭. (치수 레이어에 생성, 연속 기입)',
    dist: '거리 측정: 두 점을 클릭하세요. (결과는 명령 기록에 표시)',
    area: '면적: 원/닫힌 폴리라인을 클릭하거나, 점들을 찍고 Enter로 계산.',
    insert: '블록 삽입: 삽입 위치를 클릭하세요. (레이어 패널 아래 목록에서 블록 선택)',
    matchprop: '속성 일치: 원본 도형을 클릭 → 속성을 적용할 대상들을 클릭. (레이어·색·선종류·선굵기 복사)',
    dimang: '각도 치수: 첫 선 → 둘째 선 → 호 위치 클릭.',
    leader: '지시선: 화살표 지점 → 문자 위치 클릭 → 문구 입력.',
    divide: `등분: 개수(숫자, 현재 ${divideCount}) 입력 후 선/폴리라인/원/호 클릭 → ✕ 표식 생성.`,
    measure: `간격 표식: 간격(숫자, 현재 ${measureStep}) 입력 후 대상 클릭 → 시작점부터 일정간격 ✕ 표식.`,
    dimrad: '반지름 치수: 원/호 클릭 → 문자 위치 클릭. (R값, 연속 기입)',
    dimdia: '지름 치수: 원/호 클릭 → 문자 위치 클릭. (⌀값, 연속 기입)',
    break: '끊기: 선/원/호 선택 → 끊기점 두 개 클릭. (사이 구간 제거)',
    lengthen: `길이조정: 증감량 ${lengthenDelta > 0 ? '+' : ''}${lengthenDelta}. 선의 조정할 끝쪽을 클릭하세요. (음수=줄이기)`,
    hatch: `해치: ${HATCH_PATTERNS[hatchPattern].ko}, 간격 ${hatchSpacing}. 경계 클릭. (숫자=간격, 패턴명 입력: ansi31·ansi37·steel·grid·brick·concrete·dots·solid)`,
    centerline: '중심선: 원/호를 클릭하면 십자 중심선이 그려집니다. (중심선 레이어, 일점쇄선)',
    revcloud: '구름마크: 영역의 첫 코너 → 반대 코너를 클릭하세요. (도면 검토 표시)',
    frame: '도곽: 배치할 좌하단 지점을 클릭하세요. (이후 용지·축척 입력)',
    align: '정렬: (도형 선택) → 원본1점 → 목표1점 → 원본2점 → 목표2점. 이동+회전(+배율).',
    xline: '구성선: 지나는 점 → 방향 점을 클릭하면 아주 긴 보조선이 그려집니다.',
    breakpt: '한 점 끊기: 선/원/호 클릭 → 끊을 지점을 클릭하면 그 점에서 둘로 나뉩니다.',
    door: '문: 벽(wall 지정된 선)에서 문 중심 위치를 클릭하세요. (이후 폭 입력)',
    section: '단면: 절단선의 첫 점을 클릭하세요. (선 → 바라볼 방향 순)',
    elevation: '입면: 기준선의 첫 점을 클릭하세요. (건물 바깥에 긋고 → 건물 쪽 클릭)',
    window: '창: 벽(wall 지정된 선)에서 창 중심 위치를 클릭하세요. (이후 폭 입력)',
  };
  setPrompt(hints[t] || '');
  if (t !== 'select') {
    logLine('▶ ' + (TOOL_KO[t] || t), 'cmd');
    // 도구 활성 즉시 치수 입력이 가능한 명령(offset·fillet 등)은 터치에서도 바로 포커스(키보드 표시).
    // 그 외에는 터치 시 키보드 팝업 방지를 위해 포커스 생략.
    const dimNow = typeof currentDimPrompt === 'function' && currentDimPrompt();
    if (cmdInputEl && (dimNow || !lastInputWasTouch)) cmdInputEl.focus({ preventScroll: true });
  }
  draw();
}
function hint(t) { hintEl.textContent = t; hintEl.style.display = t ? 'block' : 'none'; }

document.querySelectorAll('.tool').forEach(el =>
  el.addEventListener('click', () => {
    const t = el.dataset.tool;
    if (INSTANT_CMDS[t]) { logLine('▶ ' + (TOOL_KO[t] || t), 'cmd'); INSTANT_CMDS[t](); lastCommand = t; return; } // 분해·결합 등 즉시 실행
    setTool(t); if (t !== 'select') lastCommand = t;
  }));

// 레이어 목록 렌더
function renderLayers() {
  const list = document.getElementById('layerList');
  list.innerHTML = '';
  for (const l of state.layers) {
    const div = document.createElement('div');
    div.className = 'layer' + (l.name === state.currentLayer ? ' active' : '');
    const ltOpts = Object.keys(LINETYPES).map(k => `<option value="${k}" ${(l.linetype || 'continuous') === k ? 'selected' : ''}>${LINETYPE_KO[k]}</option>`).join('');
    div.innerHTML =
      `<div class="lrow1">
        <span class="sw" style="background:${l.color}"></span>
        <span class="nm">${escapeHtml(l.name)}</span>
        <span class="lk" title="잠금(수정 불가)">${l.locked ? '🔒' : '🔓'}</span>
        <span class="eye">${l.visible ? '👁' : '🚫'}</span>
       </div>
       <div class="lrow2" onclick="event.stopPropagation()">
        <select class="llt" title="선종류">${ltOpts}</select>
        <select class="llw" title="선굵기(mm)">
          ${[['', '기본'], ['0', '가는'], ['25', '0.25'], ['50', '0.50'], ['70', '0.70'], ['100', '1.00'], ['200', '2.00']]
            .map(([v, t]) => `<option value="${v}" ${String(l.lineweight ?? '') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
       </div>`;
    div.addEventListener('contextmenu', (e) => { // 우클릭: 선택한 객체를 이 레이어로 이동 (라이노식)
      e.preventDefault(); e.stopPropagation();
      const sel = [...state.selection].map(id => state.entities.find(en => en.id === id)).filter(Boolean);
      if (!sel.length) { logLine('  레이어 이동: 먼저 객체를 선택한 뒤 대상 레이어를 우클릭하세요.', 'warn'); return; }
      if (!confirm(`선택한 개체 ${sel.length}개를 '${l.name}' 레이어로 바꾸겠습니까?`)) return;
      pushUndo();
      for (const en of sel) en.layer = l.name;
      logLine(`  ✔ 선택 ${sel.length}개 객체를 '${l.name}' 레이어로 이동`, 'ok');
      renderProps(); renderLayers(); draw();
      if (typeof v3 !== 'undefined' && v3 && document.getElementById('bim3d') && document.getElementById('bim3d').style.display !== 'none') { v3.solids = bimSolids(); render3D(); }
    });
    div.querySelector('.sw').addEventListener('click', (e) => {
      e.stopPropagation();
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = rgbHex(l.color);
      inp.addEventListener('input', () => { l.color = inp.value; renderLayers(); draw(); });
      inp.click();
    });
    div.querySelector('.eye').addEventListener('click', (e) => {
      e.stopPropagation(); l.visible = !l.visible; renderLayers(); draw();
    });
    div.querySelector('.lk').addEventListener('click', (e) => {
      e.stopPropagation(); l.locked = !l.locked;
      if (l.locked) { state.entities.forEach(en => { if (en.layer === l.name) state.selection.delete(en.id); }); renderProps(); }
      renderLayers(); draw();
    });
    div.querySelector('.llt').addEventListener('change', (e) => { e.stopPropagation(); l.linetype = e.target.value; draw(); });
    div.querySelector('.llw').addEventListener('change', (e) => { e.stopPropagation(); l.lineweight = e.target.value === '' ? undefined : parseInt(e.target.value, 10); draw(); });
    div.querySelector('.nm').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const nn = prompt('레이어 이름:', l.name);
      if (nn && nn !== l.name && !getLayer(nn)) {
        state.entities.forEach(en => { if (en.layer === l.name) en.layer = nn; });
        if (state.currentLayer === l.name) state.currentLayer = nn;
        l.name = nn; renderLayers(); draw();
      }
    });
    div.addEventListener('click', () => { state.currentLayer = l.name; renderLayers(); });
    list.appendChild(div);
  }
}

document.getElementById('btnAllVis').addEventListener('click', () => { state.layers.forEach(l => { l.visible = true; l.locked = false; }); renderLayers(); draw(); });
document.getElementById('blkScale').addEventListener('change', e => { insertScale = parseFloat(e.target.value) || 1; });
document.getElementById('blkRot').addEventListener('change', e => { insertRot = parseFloat(e.target.value) || 0; });
document.getElementById('btnAddLayer').addEventListener('click', () => {
  let i = state.layers.length, name;
  do { name = 'Layer' + i++; } while (getLayer(name));
  const colors = ['#ff5d5d', '#5dff8f', '#5d9dff', '#ffd65d', '#d65dff', '#5dffff'];
  ensureLayer(name, colors[state.layers.length % colors.length]);
  state.currentLayer = name; renderLayers();
});
document.getElementById('btnDelLayer').addEventListener('click', () => {
  if (state.currentLayer === '0') { alert("기본 레이어 '0'은 삭제할 수 없습니다."); return; }
  if (state.entities.some(e => e.layer === state.currentLayer)) {
    if (!confirm('이 레이어의 도형도 함께 삭제됩니다. 계속할까요?')) return;
    pushUndo();
    state.entities = state.entities.filter(e => e.layer !== state.currentLayer);
  }
  state.layers = state.layers.filter(l => l.name !== state.currentLayer);
  state.currentLayer = '0'; renderLayers(); draw(); updateStat();
});

// 속성 패널
function renderProps() {
  const body = document.getElementById('propsBody');
  const sel = [...state.selection].map(id => state.entities.find(e => e.id === id)).filter(Boolean);
  if (!sel.length) { body.innerHTML = '<div class="empty">선택된 도형이 없습니다.</div>'; return; }
  if (sel.length > 1) {
    body.innerHTML =
      `<div class="row"><label>선택</label><span>${sel.length}개 도형</span></div>
       <div class="row"><label>레이어</label><select id="mLayer"><option value="">— 변경 —</option>${state.layers.map(l => `<option>${escapeHtml(l.name)}</option>`).join('')}</select></div>
       <div class="row"><label>색상</label><input type="color" id="mColor" value="#ffffff"><button class="miniBtn" id="mColApply">적용</button><button class="miniBtn" id="mColClear">레이어색</button></div>
       <div class="row"><label>선종류</label><select id="mLt"><option value="">— 변경 —</option>${Object.keys(LINETYPES).map(k => `<option value="${k}">${LINETYPE_KO[k]}</option>`).join('')}</select></div>
       <div style="display:flex;gap:6px;margin-top:6px;">
         <button class="miniBtn" id="pFront">맨 앞</button><button class="miniBtn" id="pBack">맨 뒤</button>
         <button class="miniBtn" id="pSim">유사 선택</button>
       </div>
       <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
         <button class="miniBtn" id="pBimWall">벽 지정</button><button class="miniBtn" id="pBimSlab">슬래브</button>
         <button class="miniBtn" id="pBimCol">기둥</button><button class="miniBtn" id="pBimClr">BIM 해제</button>
       </div>
       <button class="miniBtn" id="pDel" style="margin-top:6px;">선택 삭제</button>`;
    const apply = fn => { pushUndo(); sel.forEach(fn); renderProps(); draw(); };
    document.getElementById('pFront').addEventListener('click', () => reorderSel(true));
    document.getElementById('pBack').addEventListener('click', () => reorderSel(false));
    document.getElementById('pSim').addEventListener('click', selectSimilar);
    document.getElementById('mLayer').addEventListener('change', ev => { if (ev.target.value) apply(e => e.layer = ev.target.value); });
    document.getElementById('mColApply').addEventListener('click', () => apply(e => e.color = document.getElementById('mColor').value));
    document.getElementById('mColClear').addEventListener('click', () => apply(e => delete e.color));
    document.getElementById('mLt').addEventListener('change', ev => { if (ev.target.value) apply(e => { if (ev.target.value === 'continuous') delete e.linetype; else e.linetype = ev.target.value; }); });
    document.getElementById('pDel').addEventListener('click', deleteSelection);
    document.getElementById('pBimWall').addEventListener('click', cmdWallTag);
    document.getElementById('pBimSlab').addEventListener('click', cmdSlabTag);
    document.getElementById('pBimCol').addEventListener('click', cmdColumnTag);
    document.getElementById('pBimClr').addEventListener('click', cmdBimClear);
    return;
  }
  const e = sel[0];
  let rows = `<div class="row"><label>종류</label><span>${typeKo(e.type)}</span></div>`;
  rows += `<div class="row"><label>레이어</label><select id="pLayer">${
    state.layers.map(l => `<option ${l.name === e.layer ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')
  }</select></div>`;
  const geomRows = {
    LINE: [['x1', 'x1'], ['y1', 'y1'], ['x2', 'x2'], ['y2', 'y2']],
    CIRCLE: [['cx', '중심X'], ['cy', '중심Y'], ['r', '반지름']],
    ARC: [['cx', '중심X'], ['cy', '중심Y'], ['r', '반지름'], ['startAngle', '시작각'], ['endAngle', '끝각']],
    TEXT: [['x', 'X'], ['y', 'Y'], ['height', '높이'], ['rotation', '회전']],
    HATCH: [['spacing', '간격']],
    IMAGE: [['x', 'X'], ['y', 'Y'], ['w', '폭'], ['h', '높이']],
  };
  if (geomRows[e.type]) for (const [k, lab] of geomRows[e.type])
    rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-k="${k}" value="${e[k]}"></div>`;
  if (e.type === 'LINE' && (e.z1 != null || e.z2 != null))
    rows += `<div class="row"><label>Z1(3D)</label><input type="number" step="any" data-k="z1" value="${e.z1 || 0}"></div>
             <div class="row"><label>Z2(3D)</label><input type="number" step="any" data-k="z2" value="${e.z2 || 0}"></div>`;
  if (e.type === 'TEXT')
    rows += `<div class="row"><label>내용</label><input type="text" data-k="text" value="${escapeHtml(e.text)}"></div>`;
  if (e.type === 'HATCH')
    rows += `<div class="row"><label>패턴</label><select id="pHatch">${Object.keys(HATCH_PATTERNS).map(k =>
      `<option value="${k}" ${e.pattern === k ? 'selected' : ''}>${HATCH_PATTERNS[k].ko}</option>`).join('')}</select></div>`;
  rows += `<div class="row"><label>색상</label><input type="color" id="pColor" value="${rgbHex(entityColor(e))}">
    <button class="miniBtn" id="pColClear">레이어색</button></div>`;
  // BIM 속성
  const BIM_FIELDS = {
    wall: [['h', '벽 높이'], ['t', '벽 두께'], ['base', '하단(base)']],
    slab: [['t', '두께'], ['top', '상단(top)']],
    column: [['h', '높이'], ['base', '하단(base)']],
    opening: [['h', '개구 높이'], ['sill', '씰 높이']],
    stair: [['w', '폭'], ['h', '총높이'], ['riser', '단높이(최대)'], ['base', '하단(base)']],
    roof: [['eave', '처마 높이(z)'], ['rise', '상승 높이']],
  };
  if (e.bim) {
    const kindKo = { wall: '벽', slab: '슬래브', column: '기둥', stair: '계단', roof: '지붕', opening: (e.bim.ot === 'door' ? '문' : '창') }[e.bim.kind];
    rows += `<div class="row" style="margin-top:8px;"><label style="color:var(--accent-text);">BIM</label><span style="font-weight:590;">${kindKo}</span></div>`;
    for (const [k, lab] of (BIM_FIELDS[e.bim.kind] || []))
      rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-bk="${k}" value="${e.bim[k] != null ? e.bim[k] : 0}"></div>`;
    rows += `<button class="miniBtn" id="pBimClr1" style="margin-top:2px;">BIM 해제</button>`;
  } else if (['LINE', 'LWPOLYLINE', 'CIRCLE'].includes(e.type)) {
    rows += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
      <button class="miniBtn" id="pBimWall1">벽 지정</button><button class="miniBtn" id="pBimSlab1">슬래브</button>
      <button class="miniBtn" id="pBimCol1">기둥</button></div>`;
  }
  rows += `<div style="display:flex;gap:6px;margin-top:6px;">
    <button class="miniBtn" id="pFront1">맨 앞</button><button class="miniBtn" id="pBack1">맨 뒤</button>
    <button class="miniBtn" id="pSim1">유사 선택</button></div>`;
  rows += `<button class="miniBtn" id="pDel" style="margin-top:6px;">삭제</button>`;
  body.innerHTML = rows;
  document.getElementById('pFront1').addEventListener('click', () => reorderSel(true));
  document.getElementById('pBack1').addEventListener('click', () => reorderSel(false));
  body.querySelectorAll('input[data-bk]').forEach(inp => inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isFinite(v)) return;
    pushUndo(); e.bim[inp.dataset.bk] = v; draw();
  }));
  document.getElementById('pBimClr1')?.addEventListener('click', cmdBimClear);
  document.getElementById('pBimWall1')?.addEventListener('click', cmdWallTag);
  document.getElementById('pBimSlab1')?.addEventListener('click', cmdSlabTag);
  document.getElementById('pBimCol1')?.addEventListener('click', cmdColumnTag);
  document.getElementById('pSim1').addEventListener('click', selectSimilar);

  body.querySelectorAll('input[data-k]').forEach(inp =>
    inp.addEventListener('change', () => {
      pushUndo();
      const k = inp.dataset.k;
      e[k] = (inp.type === 'number') ? parseFloat(inp.value) : inp.value;
      if (e.type === 'HATCH') hatchDirty(e);
      draw();
    }));
  const pHatch = document.getElementById('pHatch');
  if (pHatch) pHatch.addEventListener('change', () => { pushUndo(); e.pattern = pHatch.value; hatchDirty(e); draw(); logLine(`  해치 패턴 → ${HATCH_PATTERNS[e.pattern].ko}`, 'info'); });
  document.getElementById('pLayer').addEventListener('change', (ev) => { pushUndo(); e.layer = ev.target.value; draw(); });
  document.getElementById('pColor').addEventListener('input', (ev) => { pushUndo(); e.color = ev.target.value; draw(); });
  document.getElementById('pColClear').addEventListener('click', () => { pushUndo(); delete e.color; renderProps(); draw(); });
  document.getElementById('pDel').addEventListener('click', deleteSelection);
}

function deleteSelection() {
  if (!state.selection.size) return;
  pushUndo();
  state.entities = state.entities.filter(e => !state.selection.has(e.id));
  state.selection.clear(); renderProps(); updateStat(); draw();
}

function typeKo(t) { return ({ LINE: '선', LWPOLYLINE: '폴리라인', CIRCLE: '원', ARC: '호', TEXT: '문자', HATCH: '해치', INSERT: '블록', IMAGE: '밑그림 이미지' })[t] || t; }
function updateStat() { statEl.textContent = `도형 ${state.entities.length}개 · 레이어 ${state.layers.length}개`; }

// ============================================================
//  뷰 조작
// ============================================================
// robust=true이면 극단 이상치(드물게 도면에서 멀리 떨어진 잔여 도형)를 제외하고 맞춤 — 불러오기 직후 사용
// 이전 뷰 스택 (zp)
const viewPrevStack = [];
function pushViewPrev() { viewPrevStack.push({ ...state.view }); if (viewPrevStack.length > 24) viewPrevStack.shift(); }
function zoomPrev() {
  const v = viewPrevStack.pop();
  if (!v) { logLine('  이전 뷰가 없습니다.', 'warn'); return; }
  state.view = v; draw(); logLine('  ✔ 이전 뷰', 'info');
}
function zoomFit(robust) {
  { const ov3 = document.getElementById('bim3d');
    if (ov3 && ov3.style.display !== 'none' && v3) { // 3D 열림: 3D 화면 맞춤
      v3.solids = bimSolids(); fit3D();
      v3.zoom = 1; v3.panX = 0; v3.panY = 0;
      for (const w of v3.views) { w.zoom = 1; w.panX = 0; w.panY = 0; }
      loadVp(v3.act); render3D();
      // return 하지 않음 — 평면 뷰도 함께 맞춰야 (3D 중 문서 열기 등에서) 복귀 시 화면이 맞음
    } }
  pushViewPrev();
  if (!state.entities.length) { state.view = { x: 0, y: 0, scale: 4 }; draw(); return; }
  const xs = [], ys = [];
  const ext = (x, y) => { if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); } };
  for (const e of state.entities) {
    switch (e.type) {
      case 'LINE': ext(e.x1, e.y1); ext(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points.forEach(p => ext(p[0], p[1])); break;
      case 'CIRCLE': case 'ARC': ext(e.cx - e.r, e.cy - e.r); ext(e.cx + e.r, e.cy + e.r); break;
      case 'TEXT': ext(e.x, e.y); ext(e.x + e.text.length * e.height * .6, e.y + e.height); break;
      case 'HATCH': { const bb = boundaryBBox(e.boundary); ext(bb.xmin, bb.ymin); ext(bb.xmax, bb.ymax); break; }
      case 'IMAGE': ext(e.x, e.y); ext(e.x + e.w, e.y + e.h); break;
      case 'INSERT': { const bb = insertBBox(e); ext(bb.xmin, bb.ymin); ext(bb.xmax, bb.ymax); break; }
    }
  }
  if (!xs.length) { state.view = { x: 0, y: 0, scale: 4 }; draw(); return; }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  let minX = xs[0], maxX = xs[xs.length - 1], minY = ys[0], maxY = ys[ys.length - 1];
  if (robust && xs.length >= 50) {
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor((arr.length - 1) * p)))];
    const rx0 = q(xs, 0.01), rx1 = q(xs, 0.99), ry0 = q(ys, 0.01), ry1 = q(ys, 0.99);
    if (rx1 > rx0 && ry1 > ry0) { minX = rx0; maxX = rx1; minY = ry0; maxY = ry1; }
  }
  const w = maxX - minX || 1, h = maxY - minY || 1;
  const pad = 1.2;
  if (cv._w > 2 && cv._h > 2) // 창이 0 크기일 때 scale이 0/∞로 깨지는 것 방지
    state.view.scale = Math.min(cv._w / (w * pad), cv._h / (h * pad));
  state.view.x = (minX + maxX) / 2;
  state.view.y = (minY + maxY) / 2;
  draw();
}

// ============================================================
//  키보드
// ============================================================
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'F8') { ev.preventDefault(); toggleOrtho(); return; }  // 직교 모드(입력창 포커스 중에도 동작)
  if (ev.key === 'F3') { ev.preventDefault(); toggleOsnap(); return; }  // 객체 스냅
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  // 글자를 치면 곧장 명령창으로 — Space/Enter 없이 즉시 명령 입력 가능
  if (cmdInputEl && ev.key.length === 1 && ev.key !== ' ' && !ev.ctrlKey && !ev.metaKey && !ev.altKey
      && !document.body.classList.contains('authLocked')) {
    cmdInputEl.focus({ preventScroll: true }); return; // 이 키 입력은 그대로 명령창에 들어감
  }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
  if (ev.ctrlKey && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDXF(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); state.entities.forEach(e => { if (onLv(e)) state.selection.add(e.id); }); renderProps(); draw(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copySelection(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'v') { ev.preventDefault(); startPaste(); return; }
  switch (ev.key) {
    case 'Escape': if (typeof boolPending !== 'undefined' && boolPending) { boolPending = null; logLine('  차집합 취소', 'info'); } setTool('select'); state.selection.clear(); renderProps(); draw(); break;
    case 'Enter': if (state.tool === 'pline') finishPolyline(); break;
    case 'Delete': case 'Backspace': deleteSelection(); break;
    case 'l': case 'L': setTool('line'); break;
    case 'p': case 'P': setTool('pline'); break;
    case 'r': case 'R': setTool('rect'); break;
    case 'c': case 'C': setTool('circle'); break;
    case 'a': case 'A': setTool('arc'); break;
    case 't': case 'T': setTool('text'); break;
    case 'm': case 'M': setTool('move'); break;
    case 'f': case 'F': zoomFit(); break;
  }
});

// ============================================================
//  버튼 바인딩
// ============================================================
// 파일 드롭다운 메뉴
(function () {
  const btn = document.getElementById('btnFile');
  const menu = document.getElementById('fileMenu');
  const toggle = (open) => menu.classList.toggle('open', open === undefined ? !menu.classList.contains('open') : open);
  // pointerdown으로 토글 — 포커스 이동/클릭 합성 실패와 무관하게 항상 동작
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); }); // 같은 탭의 click이 문서 닫힘/재토글을 일으키지 않게
  document.addEventListener('pointerdown', () => toggle(false));
  document.addEventListener('click', () => toggle(false));
  menu.addEventListener('pointerdown', (e) => e.stopPropagation()); // 항목 클릭 전에 닫히지 않게
  menu.addEventListener('click', (e) => e.stopPropagation());
  const close = () => toggle(false);
  document.getElementById('miNew').addEventListener('click', () => { close(); doNew(); });
  document.getElementById('miOpen').addEventListener('click', () => { close(); openFile(); });
  document.getElementById('miSave').addEventListener('click', () => { close(); saveDXF(); });
  document.getElementById('miSaveAs').addEventListener('click', () => { close(); openSaveAs(); });
  document.getElementById('miShare').addEventListener('click', () => { close(); shareLink(); });
  document.getElementById('miImage').addEventListener('click', () => { close(); document.getElementById('imgInput').click(); });
})();
// 밑그림 이미지 삽입: 축소 인코딩 → '밑그림' 레이어(기본 잠금)에 배치 → 위에 트레이싱
document.getElementById('imgInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600, k = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const src = c.toDataURL('image/jpeg', 0.72);
      // 뷰 중앙에 화면폭 60% 크기로 배치
      const wWorld = (cv._w / state.view.scale) * 0.6;
      const hWorld = wWorld * c.height / c.width;
      const x = state.view.x - wWorld / 2, y = state.view.y - hWorld / 2;
      const lay = ensureLayer('밑그림', '#8a8a94');
      if (lay.locked === undefined) lay.locked = true; // 기본 잠금 → 위에 바로 트레이싱
      pushUndo();
      addEntity({ type: 'IMAGE', layer: '밑그림', x, y, w: wWorld, h: hWorld, src });
      logLine(`  ✔ 밑그림 삽입 (${c.width}×${c.height}) — '밑그림' 레이어 🔒 잠금 상태`, 'ok');
      renderLayers(); updateStat(); draw();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
  ev.target.value = '';
});
// 옵션 드롭다운 + 설정 대화상자 (단축키/객체스냅/단위)
(function () {
  const btn = document.getElementById('btnOpts');
  const menu = document.getElementById('optMenu');
  const toggle = (open) => menu.classList.toggle('open', open === undefined ? !menu.classList.contains('open') : open);
  // pointerdown으로 토글 — 포커스 이동/클릭 합성 실패와 무관하게 항상 동작
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); });
  document.addEventListener('pointerdown', () => toggle(false));
  document.addEventListener('click', () => toggle(false));
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => e.stopPropagation());
  const dlg = document.getElementById('optionsDlg');
  function openOptions(sec) {
    toggle(false);
    // 현재값 채우기
    document.getElementById('optUnits').value = settings.units;
    document.getElementById('optPolar').value = String(settings.polar || 0);
    document.getElementById('optDimTxt').value = settings.dim.txt || 0;
    document.getElementById('optDimDec').value = String(settings.dim.dec != null ? settings.dim.dec : 2);
    document.getElementById('optDimSuffix').checked = !!settings.dim.suffix;
    for (const k of ['endpoint', 'midpoint', 'center', 'perp', 'nearest', 'intersection'])
      document.getElementById('os_' + k).checked = !!settings.osnapModes[k];
    // 단축키 목록 (도구명 → 현재 사용자 별칭 역조회)
    const rev = {}; for (const [a, t] of Object.entries(settings.aliases)) if (!rev[t]) rev[t] = a;
    document.getElementById('aliasList').innerHTML = COMMAND_LIST.map(c => {
      const tool = CMD_ALIASES[c.name] || c.name;
      return `<span class="aname">${escapeHtml(c.ko)} (${c.name})</span><input data-tool="${tool}" value="${escapeHtml(rev[tool] || '')}" placeholder="예: qq">`;
    }).join('');
    dlg.style.display = 'flex';
    const el = document.getElementById(sec); if (el) el.scrollIntoView({ block: 'start' });
  }
  document.getElementById('moPlot').addEventListener('click', () => { toggle(false); openPlot(); });
  document.getElementById('moShortcut').addEventListener('click', () => openOptions('secShortcut'));
  document.getElementById('moOsnap').addEventListener('click', () => openOptions('secOsnap'));
  document.getElementById('moUnits').addEventListener('click', () => openOptions('secUnits'));
  document.getElementById('moDim').addEventListener('click', () => openOptions('secDim'));
  document.getElementById('optCancel').addEventListener('click', () => dlg.style.display = 'none');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });
  document.getElementById('optSave').addEventListener('click', () => {
    settings.units = document.getElementById('optUnits').value;
    settings.polar = parseInt(document.getElementById('optPolar').value, 10) || 0;
    settings.dim.txt = Math.max(0, parseFloat(document.getElementById('optDimTxt').value) || 0);
    settings.dim.dec = parseInt(document.getElementById('optDimDec').value, 10);
    settings.dim.suffix = document.getElementById('optDimSuffix').checked;
    for (const k of ['endpoint', 'midpoint', 'center', 'perp', 'nearest', 'intersection'])
      settings.osnapModes[k] = document.getElementById('os_' + k).checked;
    const aliases = {};
    document.querySelectorAll('#aliasList input').forEach(inp => {
      const a = inp.value.trim().toLowerCase();
      if (a) aliases[a] = inp.dataset.tool;
    });
    settings.aliases = aliases;
    saveSettings();
    dlg.style.display = 'none';
    logLine(`  ✔ 옵션 저장 (단위 ${settings.units}, 단축키 ${Object.keys(aliases).length}개)`, 'ok');
    draw();
  });
})();
// ---------- 인쇄 / 플롯 ----------
let plotRegion = null; // {minX,minY,maxX,maxY} — 창 지정 시
function openPlot() { document.getElementById('plotDlg').style.display = 'flex'; }
function closePlot() { document.getElementById('plotDlg').style.display = 'none'; }
(function () {
  const dlg = document.getElementById('plotDlg');
  document.getElementById('plCancel').addEventListener('click', closePlot);
  dlg.addEventListener('click', e => { if (e.target === dlg) closePlot(); });
  document.getElementById('plOk').addEventListener('click', () => {
    const region = document.getElementById('plRegion').value;
    if (region === 'win' && !plotRegion) { // 영역 미지정 → 창 드래그 요청
      closePlot();
      startRegionPick(() => { document.getElementById('plotDlg').style.display = 'flex'; });
      return;
    }
    doPlot();
  });
})();
function startRegionPick(after) {
  const prevTool = state.tool;
  cmdOp = null; dragSelect = null;
  state.tool = '_plotregion';
  setPrompt('플롯 영역: 인쇄할 사각형 영역의 두 모서리를 클릭하세요.');
  regionPickState = { after, prevTool };
  cv.style.cursor = 'crosshair'; draw();
}
let regionPickState = null;
function doPlot() {
  const paper = document.getElementById('plPaper').value;
  const landscape = document.getElementById('plOrient').value === 'land';
  const scaleDenom = parseInt(document.getElementById('plScale').value, 10) || 0;
  const useRegion = document.getElementById('plRegion').value === 'win' && plotRegion;
  const title = document.getElementById('plTitleBlock').checked ? {
    title: document.getElementById('plTitle').value || (currentFileName || '무제'),
    file: currentFileName || '(미저장)',
    scale: scaleDenom ? '1:' + scaleDenom : 'FIT',
    date: new Date().toISOString().slice(0, 10),
  } : null;
  closePlot();
  const opt = { paper, landscape, scaleDenom, region: useRegion ? plotRegion : null, title, units: settings.units };
  const pdf = buildPDF(opt);
  const base = (currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'plot');
  logLine(`  ✔ 플롯 PDF (${paper.toUpperCase()} ${landscape ? '가로' : '세로'}, ${scaleDenom ? '1:' + scaleDenom : '맞춤'})`, 'ok');
  saveBlob(new Blob([pdf], { type: 'application/pdf' }), base + '_plot.pdf');
}

function doNew() {
  if (state.entities.length && !confirm('현재 도면을 지우고 새로 시작할까요?')) return;
  if (typeof clearLocal === 'function') clearLocal();
  fileHandle = null; setFileName(null, null);
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange(); // 클라우드 연결 해제
  newDrawing();
}
document.getElementById('fileInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  if (ext === 'stl') {
    reader.onload = () => { if (loadMesh(parseSTL(reader.result), f.name)) { fileHandle = null; } ev.target.value = ''; };
    reader.readAsArrayBuffer(f);
  } else if (ext === 'obj') {
    reader.onload = () => { if (loadMesh(parseOBJ(reader.result), f.name)) { fileHandle = null; } ev.target.value = ''; };
    reader.readAsText(f);
  } else {
    reader.onload = () => { if (loadDXF(reader.result)) { fileHandle = null; setFileName(f.name, null); } ev.target.value = ''; };
    reader.readAsText(f);
  }
});
// 다른 이름으로 저장 대화상자
function openSaveAs() {
  const inp = document.getElementById('saveName');
  if (inp) inp.value = currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'drawing';
  document.getElementById('saveAsDlg').style.display = 'flex';
}
function closeSaveAs() { document.getElementById('saveAsDlg').style.display = 'none'; }
(function () {
  const dlg = document.getElementById('saveAsDlg');
  document.getElementById('saveAsCancel').addEventListener('click', closeSaveAs);
  document.getElementById('saveAsOk').addEventListener('click', () => {
    const fmt = dlg.querySelector('input[name=saveFmt]:checked').value;
    const name = (document.getElementById('saveName').value || 'drawing').replace(/\.[^.]+$/, '');
    closeSaveAs();
    if (fmt === 'dxf') { saveAsDXF(name); }
    else if (fmt === 'svg') saveBlob(new Blob([buildSVG()], { type: 'image/svg+xml' }), name + '.svg');
    else if (fmt === 'pdf') saveBlob(new Blob([buildPDF()], { type: 'application/pdf' }), name + '.pdf');
    else if (fmt === 'png') savePNG(name + '.png');
    else if (fmt === 'stl' || fmt === 'obj') {
      const selOnly = document.getElementById('saveSelOnly') && document.getElementById('saveSelOnly').checked;
      const ids = (selOnly && state.selection.size) ? new Set(state.selection) : null;
      if (selOnly && !ids) { logLine('  선택한 객체만 저장하려면 먼저 객체를 선택하세요.', 'warn'); return; }
      if (fmt === 'stl') cmdExportSTL(ids, name); else cmdExportOBJ(ids, name);
    }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSaveAs(); });
})();
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
document.getElementById('btnGrid').addEventListener('click', (e) => { state.grid.show = !state.grid.show; e.currentTarget.classList.toggle('active', state.grid.show); draw(); });
document.getElementById('btnZoomFit').addEventListener('click', () => zoomFit());
document.getElementById('btnOrtho').addEventListener('click', toggleOrtho);
document.getElementById('btnOsnap').addEventListener('click', toggleOsnap);
// 토글 버튼 초기 상태 반영 (그리드 표시 ON, 직교 OFF, 객체스냅 ON)
document.getElementById('btnGrid').classList.toggle('active', state.grid.show);
document.getElementById('btnOrtho').classList.toggle('active', state.ortho);
document.getElementById('btnOsnap').classList.toggle('active', osnapEnabled);

// iOS 등 요소 전체화면 미지원 시: "홈 화면에 추가" 안내 모달
function showHomeScreenHelp() {
  if (document.getElementById('homeHelp')) return;
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  const o = document.createElement('div');
  o.id = 'homeHelp';
  o.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:20px;';
  o.innerHTML =
    '<div style="background:rgba(26,37,64,0.90);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-radius:18px;max-width:360px;padding:24px;color:#f5f5f7;box-shadow:0 8px 30px rgba(0,0,0,0.55);font-family:-apple-system,\'SF Pro Text\',\'Segoe UI\',sans-serif;letter-spacing:-0.01em;">' +
    '<h2 style="margin:0 0 10px;font-size:19px;font-weight:600;letter-spacing:-0.02em;">전체화면으로 쓰는 법</h2>' +
    '<p style="margin:0 0 12px;font-size:13px;color:rgba(235,235,245,0.6);line-height:1.6;">이 브라우저 탭은 전체화면 API를 지원하지 않습니다. 아래처럼 <b style="color:#f5f5f7;">홈 화면에 앱으로 추가</b>하면 주소창·툴바 없이 전체화면으로 실행됩니다.</p>' +
    '<ol style="margin:0 0 4px;padding-left:20px;font-size:13px;line-height:1.9;">' +
    (isiOS
      ? '<li>Safari 하단(또는 상단)의 <b>공유 버튼 <span style="display:inline-block;border:1px solid #6a6a75;border-radius:4px;padding:0 5px;">⬆️</span></b> 탭</li><li>목록에서 <b>"홈 화면에 추가"</b> 선택</li><li>오른쪽 위 <b>"추가"</b> 탭</li><li>홈 화면의 <b>WebCAD 아이콘</b>으로 실행 → 전체화면</li>'
      : '<li>브라우저 메뉴(⋮) 열기</li><li><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b> 선택</li><li>추가된 아이콘으로 실행 → 전체화면</li>') +
    '</ol>' +
    '<div style="text-align:right;margin-top:16px;"><button id="homeHelpClose" style="background:#0071e3;color:#fff;border:none;border-radius:8px;padding:8px 17px;font-size:14px;cursor:pointer;">확인</button></div>' +
    '</div>';
  document.body.appendChild(o);
  const close = () => o.remove();
  o.addEventListener('click', (e) => { if (e.target === o) close(); });
  o.querySelector('#homeHelpClose').addEventListener('click', close);
}

// 전체화면 토글 — 모바일/태블릿에서 주소창·브라우저 UI 숨김 (Fullscreen API + 벤더 프리픽스)
(function () {
  const btn = document.getElementById('btnFull');
  if (!btn) return;
  const el = document.documentElement;
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  function enter() {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fn) {
      try { const p = fn.call(el); if (p && p.catch) p.catch(() => showHomeScreenHelp()); }
      catch (e) { showHomeScreenHelp(); }
    } else showHomeScreenHelp();
  }
  function exit() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (fn) fn.call(document);
  }
  btn.addEventListener('click', () => { fsEl() ? exit() : enter(); });
  function sync() {
    const on = !!fsEl();
    btn.textContent = on ? '⛶ 창모드' : '⛶ 전체화면';
    btn.classList.toggle('active', on);
    setTimeout(resize, 120); // 전환 후 캔버스 크기 재계산
  }
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(e => document.addEventListener(e, sync));
})();

document.getElementById('curColor').addEventListener('input', (e) => {
  state.currentColor = e.target.value;
  document.getElementById('curColorTxt').textContent = '고정색';
});
document.getElementById('curColorTxt').addEventListener('click', () => {
  state.currentColor = null;
  document.getElementById('curColorTxt').textContent = '레이어색 사용';
});
document.getElementById('textHeight').addEventListener('change', (e) => state.textHeight = parseFloat(e.target.value) || 10);
document.getElementById('gridSize').addEventListener('change', (e) => { state.grid.size = parseFloat(e.target.value) || 10; draw(); });

// ============================================================
//  명령어 자동완성 (라이노식 미리보기 + 클릭 선택)
// ============================================================
// ============================================================
//  명령어 도움말 (❓ 명령어 버튼 / help / ?)
// ============================================================
const CMD_HELP = [
  { c: '그리기', items: [
    ['line', '선', '점을 연속 클릭해 이어 그림. 좌표(x,y / @dx,dy / @거리<각도) 입력 가능'],
    ['pline', '폴리라인', '여러 점을 하나의 연결선으로. 빈 Enter로 완료'],
    ['rect', '사각형', '두 코너 클릭(또는 크기 w,h 입력) — 닫힌 폴리라인'],
    ['circle', '원', '중심 클릭 → 반지름 입력(또는 클릭)'],
    ['arc', '호', '시작 → 끝 → 통과점 3점'],
    ['polygon', '정다각형', '변 개수 입력 → 중심 → 반지름'],
    ['ellipse', '타원', '중심 → 코너 클릭 또는 rx,ry 입력'],
    ['text', '문자', '위치 클릭 → 내용 입력. 기존 문자는 더블클릭으로 수정'],
    ['hatch', '해치', '패턴명/간격 입력 후 경계(원·닫힌 폴리라인) 클릭. 8종 패턴'],
    ['block', '블록 정의', '선택한 도형들을 하나의 블록으로 묶음 (즉시 실행)'],
    ['insert', '블록 삽입', '우측 블록 목록에서 선택 후 배치 (배율·회전 지정)'],
    ['xline', '구성선', '두 점 → 사실상 무한한 보조선 (기준선·자르기 기준)'],
    ['frame', '도곽', '배치점 → 용지·축척 입력 → 외곽+테두리+표제란 자동 생성'],
    ['revcloud', '구름마크', '두 코너 → 검토 표시용 구름 모양 (연속 기입)'],
    ['centerline', '중심선', '원/호 클릭 → 십자 중심선 (일점쇄선 레이어)'],
    ['leader', '지시선', '화살표 지점 → 문자 위치 → 문구 입력'],
  ]},
  { c: '편집', items: [
    ['move', '이동', '선택 → 기준점 → 이동점 (좌표·거리 입력 가능)'],
    ['copy', '복사', '선택 → 기준점 → 붙일 위치 반복 클릭'],
    ['erase', '지우기', '클릭한 도형 삭제 (= Delete 키)'],
    ['offset', '오프셋', '거리 입력 → 도형 클릭 → 방향 클릭 (평행 복사)'],
    ['mirror', '대칭', '선택 → 대칭축 두 점 클릭'],
    ['rotate', '회전', '선택 → 중심 클릭 → 각도 입력/클릭'],
    ['scale', '배율', '선택 → 기준점 → 배율 숫자(또는 참조 두 점)'],
    ['array', '배열', '선택 → 설정창 (직사각 행·열 / 원형 개수·각도)'],
    ['stretch', '신축', '걸침 영역 두 코너 → 기준점 → 이동점 (걸친 끝점만 이동)'],
    ['align', '정렬', '선택 → 원본 2점 → 목표 2점 (이동+회전, 배율 선택)'],
    ['trim', '자르기', '기준선들 클릭 → Space → 잘라낼 부분 클릭 (바로 Space=빠른 모드)'],
    ['extend', '연장', '늘릴 선의 끝쪽 클릭 → 가까운 경계까지 연장'],
    ['fillet', '모깎기', '반지름 입력 → 두 선 클릭 (0이면 직각 코너)'],
    ['chamfer', '모따기', '거리 입력 → 두 선 클릭'],
    ['break', '끊기', '대상 → 두 점 클릭 → 사이 구간 제거'],
    ['breakpt', '한 점 끊기', '대상 → 한 점 클릭 → 그 지점에서 둘로 분리'],
    ['lengthen', '길이조정', '증감량(±) 입력 → 선의 끝쪽 클릭'],
    ['explode', '분해', '폴리라인·블록을 낱개 도형으로 (즉시 실행)'],
    ['join', '결합', '맞닿은 선들을 폴리라인으로 (즉시 실행)'],
    ['matchprop', '속성 일치', '원본 클릭 → 대상들 클릭 (레이어·색·선종류 복사)'],
    ['front', '맨 앞으로', '선택 도형의 그리기 순서를 맨 앞으로 (즉시 실행)'],
    ['back', '맨 뒤로', '선택 도형을 맨 뒤로 (즉시 실행)'],
    ['similar', '유사 선택', '같은 종류+레이어 도형 전부 선택 (즉시 실행)'],
  ]},
  { c: '치수·주석', items: [
    ['dim', '선형 치수', '두 점 → 치수선 위치 → 이후 클릭만으로 연속(체인) 기입'],
    ['dimrad', '반지름 치수', '원/호 클릭 → 문자 위치 (R값)'],
    ['dimdia', '지름 치수', '원/호 클릭 → 문자 위치 (⌀값)'],
    ['dimang', '각도 치수', '두 선 클릭 → 호 위치 (사이 각도)'],
  ]},
  { c: '측정·정보', items: [
    ['dist', '거리', '두 점 클릭 → 거리·ΔX·ΔY·각도 표시'],
    ['area', '면적', '도형 클릭 또는 점 지정 후 Enter → 면적·둘레'],
    ['sum', '합계', '선택 도형들의 총 길이·총 면적 (자재 산출, 즉시 실행)'],
    ['divide', '등분', '개수 입력 → 대상 클릭 → 등분점 ✕ 표식'],
    ['measure', '간격 표식', '간격 입력 → 대상 클릭 → 일정 간격 ✕ 표식'],
  ]},
  { c: '화면·표시', items: [
    ['zoom', '전체보기', '모든 도형이 보이도록 화면 맞춤 (즉시 실행)'],
    ['zp', '이전 뷰', '직전 화면으로 되돌아가기 (즉시 실행)'],
    ['pan', '화면 이동', '드래그로 화면 이동 (마우스 휠 드래그와 동일)'],
    ['vs 이름', '뷰 저장', '현재 화면을 이름으로 저장 (예: vs 평면)'],
    ['vg 이름', '뷰 이동', '저장한 화면으로 이동'],
    ['vl', '뷰 목록', '저장된 뷰 이름들 표시'],
    ['isolate', '레이어 격리', '선택 도형의 레이어만 표시, 나머지 숨김 (즉시 실행)'],
    ['uniso', '격리 해제', '모든 레이어 표시 (즉시 실행)'],
  ]},
  { c: 'BIM (2D→3D)', items: [
    ['wall', '벽 지정', '선/폴리라인 선택 후 실행 → 높이·두께 입력. 평면에 두께 밴드 표시'],
    ['slab', '슬래브 지정', '닫힌 폴리라인/원 선택 후 → 두께 입력 (바닥판)'],
    ['column', '기둥 지정', '원/닫힌 폴리라인 선택 후 → 높이 입력'],
    ['door', '문 배치', '벽 선을 클릭한 위치에 문 개구부 생성 (폭 입력)'],
    ['window', '창 배치', '벽 선을 클릭한 위치에 창 개구부 생성 (폭·씰 기본값)'],
    ['bimclear', 'BIM 해제', '선택 도형의 BIM 속성 제거'],
    ['3d', '3D 작업 뷰', '상단 [평면|3D] 토글과 동일 — 클릭=선택, 그립 드래그=높이, Del=삭제, Esc=선택해제/평면 복귀. BIM 미지정 도형은 층 바닥에 밑그림으로 표시, 지붕:보임/투명/숨김 토글'],
    ['section', '단면 추출', '절단선 두 점 → 방향 클릭 → 새 탭에 단면도 자동 생성(절단 해치+후방 투영)'],
    ['elevation', '입면 추출', '건물 밖에 기준선 → 건물 쪽 클릭 → 새 탭에 입면도 자동 생성'],
    ['level', '층(다층)', '그리기 설정 패널에서 층 전환/추가 — 새 도형은 현재 층에 생성, 다른 층은 흐리게 표시, BIM 높이 자동 반영'],
    ['roof', '지붕 지정', '닫힌 폴리라인 선택 후 → 박공/외쪽/평 + 처마 높이 + 상승 높이 — 3D 경사면·단면 사다리꼴 자동'],
    ['move3d', '3D 이동', '선택 후 dx,dy,dz 입력 — z는 base·씰·표시높이 등 종류별로 이동'],
    ['copy3d', '3D 복사', '선택 후 dx,dy,dz — 복제본을 3D로 이동'],
    ['box', '상자', '모서리 2점 + 높이 — 작업면 위에 솔리드 상자'],
    ['cylinder', '원기둥', '중심·반지름·높이 — 작업면 위에 원기둥'],
    ['stl', '3D 저장(STL)', '모든 입체를 STL 파일로 — 라이노·스케치업·3D프린터에서 열기'],
    ['obj', '3D 저장(OBJ)', '모든 입체를 OBJ 파일로 내보내기'],
    ['selectedexport', '선택 3D 저장', '선택한 객체만 STL/OBJ로 내보내기 (형식 선택)'],
    ['settop', '상단 정렬', '벽·기둥·계단 선택 후 상단 z 입력 — 높이가 그 z에 맞게 조정'],
    ['union', '합집합(불리언)', '입체 2개+ 선택 → 하나로 합침 (결과 메시)'],
    ['difference', '차집합(불리언)', '남길 입체 선택 → difference → 잘라낼 입체 선택 → Enter (라이노식)'],
    ['intersect3d', '교집합(불리언)', '입체 2개+ 선택 → 겹치는 부분만 남김'],
    ['extrudecrv', '곡선 돌출(라이노)', '곡선 선택 후 높이 입력 — 닫힌 곡선=솔리드, 열린 곡선=면. 2D·3D 어디서든'],
    ['extrudesrf', '면 두께(라이노)', '돌출된 면·닫힌 곡선 선택 후 두께 입력 — 면을 솔리드로'],
    ['stair', '계단 지정', '진행 방향 선(시작=아랫단) 선택 후 → 폭·총높이·최대 단높이 — 평면 디딤판+UP화살표, 3D 단형, 단면 계단 프로파일 자동'],
  ]},
  { c: '기타', items: [
    ['undo', '실행취소', 'Ctrl+Z와 동일'],
    ['redo', '다시실행', 'Ctrl+Y와 동일'],
    ['select', '선택 도구', '클릭/박스 선택으로 복귀 (= Esc)'],
    ['help', '명령어 목록', '이 창 열기 (? 도 가능)'],
  ]},
  { c: '키보드', items: [
    ['Space/Enter', '확정·반복', '입력 확정 / 빈 칸에서 직전 명령 반복'],
    ['Esc', '취소', '명령 취소, 선택 해제'],
    ['Delete', '삭제', '선택 도형 삭제'],
    ['Ctrl+Z / Y', '취소/복구', '실행취소 / 다시실행'],
    ['Ctrl+S', '저장', '클라우드 도면이면 클라우드로, 아니면 DXF 저장'],
    ['Ctrl+A / C / V', '전체·복사·붙여넣기', '전체 선택 / 복사 / 고스트 미리보기 배치'],
    ['F3 / F8', '스냅/직교', '객체 스냅 켬끔 / 직교 모드 켬끔'],
    ['문자 더블클릭', '문자 수정', '문자 내용 바로 편집'],
  ]},
];
function openCmdHelp() {
  const dlg = document.getElementById('helpDlg');
  if (!dlg) return;
  renderCmdHelp('');
  const s = document.getElementById('helpSearch');
  s.value = '';
  dlg.style.display = 'flex';
  setTimeout(() => s.focus(), 50);
}
function renderCmdHelp(q) {
  // 별칭 역조회: 도구명 → 짧은 별칭들
  const rev = {};
  for (const [a, t] of Object.entries(CMD_ALIASES)) { if (a === t) continue; (rev[t] = rev[t] || []).push(a); }
  q = (q || '').trim().toLowerCase();
  const html = CMD_HELP.map(sec => {
    const rows = sec.items.filter(([n, ko, d]) => {
      if (!q) return true;
      const al = (rev[n] || []).join(' ');
      return (n + ' ' + ko + ' ' + d + ' ' + al).toLowerCase().includes(q);
    }).map(([n, ko, d]) => {
      const al = (rev[n] || []).join(', ');
      return `<div style="display:grid;grid-template-columns:105px 62px 1fr;gap:8px;padding:4px 6px;border-radius:7px;align-items:baseline;" class="helpRow">
        <span style="font-family:var(--mono);color:var(--accent-text);">${escapeHtml(n)}</span>
        <span style="font-family:var(--mono);color:var(--muted);font-size:11px;">${escapeHtml(al)}</span>
        <span><b style="font-weight:590;">${escapeHtml(ko)}</b> — <span style="color:var(--muted);">${escapeHtml(d)}</span></span>
      </div>`;
    }).join('');
    if (!rows) return '';
    return `<div style="margin:8px 0 2px;font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--accent-text);text-transform:uppercase;">${sec.c}</div>` + rows;
  }).join('');
  document.getElementById('helpList').innerHTML = html || '<div style="color:var(--muted);padding:12px;">검색 결과가 없습니다.</div>';
}
(function bindCmdHelp() {
  const dlg = document.getElementById('helpDlg');
  if (!dlg) return;
  document.getElementById('btnCmdHelp').addEventListener('click', openCmdHelp);
  document.getElementById('helpClose').addEventListener('click', () => dlg.style.display = 'none');
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) dlg.style.display = 'none'; e.stopPropagation(); });
  document.getElementById('helpSearch').addEventListener('input', (e) => renderCmdHelp(e.target.value));
  document.getElementById('helpSearch').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') dlg.style.display = 'none'; });
})();

const COMMAND_LIST = [
  { name: 'centerline', ko: '중심선' }, { name: 'revcloud', ko: '구름마크' },
  { name: 'frame', ko: '도곽(표제란)' }, { name: 'align', ko: '정렬' },
  { name: 'isolate', ko: '레이어 격리' }, { name: 'uniso', ko: '격리 해제' },
  { name: 'sum', ko: '길이·면적 합계' }, { name: 'xline', ko: '구성선' },
  { name: 'breakpt', ko: '한 점 끊기' },
  { name: 'help', ko: '명령어 목록(?)' },
  { name: 'wall', ko: 'BIM 벽 지정' }, { name: 'slab', ko: 'BIM 슬래브' },
  { name: 'column', ko: 'BIM 기둥' }, { name: 'door', ko: 'BIM 문' },
  { name: 'window', ko: 'BIM 창' }, { name: 'bimclear', ko: 'BIM 해제' },
  { name: '3d', ko: '3D 뷰' },
  { name: 'section', ko: '단면 추출' }, { name: 'elevation', ko: '입면 추출' },
  { name: 'level', ko: '층 정보' }, { name: 'roof', ko: 'BIM 지붕' }, { name: 'stair', ko: 'BIM 계단' },
  { name: 'extrudecrv', ko: '곡선 돌출' }, { name: 'extrudesrf', ko: '면 두께' },
  { name: 'move3d', ko: '3D 이동' }, { name: 'copy3d', ko: '3D 복사' },
  { name: 'box', ko: '상자' }, { name: 'cylinder', ko: '원기둥' }, { name: 'settop', ko: '상단 정렬' },
  { name: 'stl', ko: '3D 저장 STL' }, { name: 'obj', ko: '3D 저장 OBJ' }, { name: 'selectedexport', ko: '선택 3D 저장' },
  { name: 'union', ko: '합집합' }, { name: 'difference', ko: '차집합' }, { name: 'intersect3d', ko: '교집합' },
  { name: 'line', ko: '선' }, { name: 'polyline', ko: '폴리라인' }, { name: 'rectangle', ko: '사각형' },
  { name: 'circle', ko: '원' }, { name: 'arc', ko: '호' }, { name: 'text', ko: '문자' },
  { name: 'move', ko: '이동' }, { name: 'erase', ko: '지우기' }, { name: 'select', ko: '선택' },
  { name: 'pan', ko: '화면 이동' }, { name: 'offset', ko: '오프셋' }, { name: 'copy', ko: '복사' },
  { name: 'mirror', ko: '대칭' }, { name: 'rotate', ko: '회전' }, { name: 'array', ko: '배열' },
  { name: 'trim', ko: '자르기' }, { name: 'extend', ko: '연장' }, { name: 'fillet', ko: '모깎기' },
  { name: 'scale', ko: '배율' }, { name: 'stretch', ko: '신축' },
  { name: 'polygon', ko: '다각형' }, { name: 'ellipse', ko: '타원' }, { name: 'chamfer', ko: '모따기' },
  { name: 'explode', ko: '분해' }, { name: 'join', ko: '결합' }, { name: 'dim', ko: '치수 기입' },
  { name: 'dist', ko: '거리 측정' }, { name: 'area', ko: '면적' }, { name: 'zoom', ko: '전체보기' },
  { name: 'undo', ko: '실행취소' }, { name: 'redo', ko: '다시실행' },
  { name: 'break', ko: '끊기' }, { name: 'lengthen', ko: '길이조정' }, { name: 'hatch', ko: '해치' },
  { name: 'dimradius', ko: '반지름 치수' }, { name: 'dimdiameter', ko: '지름 치수' },
  { name: 'block', ko: '블록 정의' }, { name: 'insert', ko: '블록 삽입' }, { name: 'matchprop', ko: '속성 일치' },
  { name: 'dimangular', ko: '각도 치수' }, { name: 'divide', ko: '등분' }, { name: 'measure', ko: '간격 표식' },
  { name: 'leader', ko: '지시선' }, { name: 'front', ko: '맨 앞으로' }, { name: 'back', ko: '맨 뒤로' }, { name: 'similar', ko: '유사 선택' },
];
const sugEl = document.getElementById('cmdSuggest');
let sugMatches = [], sugIndex = -1;
function computeMatches(text) {
  const t = text.trim().toLowerCase();
  if (!t || /^[-@\d.]/.test(t)) return []; // 빈칸/좌표·숫자 입력이면 제안 안 함
  const starts = [], contains = [];
  for (const c of COMMAND_LIST) {
    const n = c.name;
    if (n.startsWith(t)) starts.push(c);
    else if (n.includes(t)) contains.push(c);
  }
  return starts.concat(contains).slice(0, 10);
}
function renderSuggest(text) {
  if (!sugEl) return;
  sugMatches = computeMatches(text);
  if (!sugMatches.length) { hideSuggest(); return; }
  const t = text.trim().toLowerCase();
  sugIndex = 0;
  sugEl.innerHTML = sugMatches.map((c, i) => {
    const n = c.name, idx = n.toLowerCase().indexOf(t);
    const disp = idx < 0 ? escapeHtml(n)
      : escapeHtml(n.slice(0, idx)) + '<span class="match">' + escapeHtml(n.slice(idx, idx + t.length)) + '</span>' + escapeHtml(n.slice(idx + t.length));
    return `<div class="sugItem${i === 0 ? ' sel' : ''}" data-name="${n}"><span class="sname">${disp}</span><span class="sko">${escapeHtml(c.ko)}</span></div>`;
  }).join('');
  sugEl.classList.add('open');
  sugEl.querySelectorAll('.sugItem').forEach(el =>
    el.addEventListener('mousedown', (e) => { e.preventDefault(); selectSuggestion(el.dataset.name); }));
}
function hideSuggest() { if (sugEl) { sugEl.classList.remove('open'); sugEl.innerHTML = ''; } sugMatches = []; sugIndex = -1; }
function moveSuggest(d) {
  if (!sugMatches.length) return;
  sugIndex = (sugIndex + d + sugMatches.length) % sugMatches.length;
  const items = sugEl.querySelectorAll('.sugItem');
  items.forEach((el, i) => el.classList.toggle('sel', i === sugIndex));
  if (items[sugIndex]) items[sugIndex].scrollIntoView({ block: 'nearest' });
}
function selectSuggestion(name) { cmdInputEl.value = ''; hideSuggest(); runCommandInput(name); }

// 명령행 입력 — Enter/스페이스 = 확정(자동완성 선택), 빈 칸이면 직전 명령 반복
// 데스크톱(터치 없음)에서는 명령창을 항상 활성화 — 클릭/명령 후에도 바로 타이핑 가능
// (터치 기기는 가상 키보드가 계속 떠버리므로 제외; 기존 치수-프롬프트 자동 포커스만 사용)
const ALWAYS_FOCUS_CMD = (navigator.maxTouchPoints || 0) === 0;
if (cmdInputEl && ALWAYS_FOCUS_CMD) {
  const refocus = () => setTimeout(() => {
    if (document.body.classList.contains('authLocked')) return; // 로그인 게이트 열림
    if (document.querySelector('.dropdown.open')) return;       // 메뉴가 열려 있으면 간섭하지 않음
    // 다른 입력요소(레이어명·옵션·다이얼로그 등)가 포커스를 가져갔으면 뺏지 않음
    const a = document.activeElement;
    if (!a || a === document.body || a.tagName === 'BUTTON' || a.tagName === 'CANVAS')
      cmdInputEl.focus({ preventScroll: true });
  }, 0);
  cmdInputEl.addEventListener('blur', refocus);
  window.addEventListener('mouseup', refocus);
  setTimeout(() => cmdInputEl.focus({ preventScroll: true }), 0);
}
if (cmdInputEl) {
  cmdInputEl.addEventListener('input', () => renderSuggest(cmdInputEl.value));
  cmdInputEl.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  cmdInputEl.addEventListener('keydown', (ev) => {
    // F8(직교)/F3(객체스냅)은 전역 핸들러가 처리 — 여기서 가로채지 않고 통과
    if (ev.key === 'F8' || ev.key === 'F3') return;
    // 입력창이 항상 포커스되므로, 앱 전역 단축키를 여기서도 처리
    if (ev.ctrlKey) {
      const k = ev.key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); ev.stopPropagation(); undo(); return; }
      if (k === 'y') { ev.preventDefault(); ev.stopPropagation(); redo(); return; }
      if (k === 's') { ev.preventDefault(); ev.stopPropagation(); saveDXF(); return; }
      if (cmdInputEl.value === '') { // 텍스트 편집과 겹치지 않을 때만
        if (k === 'a') { ev.preventDefault(); ev.stopPropagation(); state.entities.forEach(e => { if (onLv(e)) state.selection.add(e.id); }); renderProps(); draw(); return; }
        if (k === 'c') { ev.preventDefault(); ev.stopPropagation(); copySelection(); return; }
        if (k === 'v') { ev.preventDefault(); ev.stopPropagation(); startPaste(); return; }
      }
    }
    if (ev.key === 'Delete' && cmdInputEl.value === '') { // 빈 입력창에서 Delete = 선택 삭제
      ev.preventDefault(); ev.stopPropagation(); deleteSelection(); return;
    }
    if (sugMatches.length && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault(); ev.stopPropagation(); moveSuggest(ev.key === 'ArrowDown' ? 1 : -1); return;
    }
    if (sugMatches.length && ev.key === 'Tab') {
      ev.preventDefault(); ev.stopPropagation();
      cmdInputEl.value = sugMatches[sugIndex < 0 ? 0 : sugIndex].name; renderSuggest(cmdInputEl.value); return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault(); ev.stopPropagation();
      if (sugMatches.length && sugIndex >= 0) { selectSuggestion(sugMatches[sugIndex].name); return; }
      const v = cmdInputEl.value; cmdInputEl.value = ''; hideSuggest();
      if (v.trim() === '') emptyEnterAction(); else runCommandInput(v);
      return;
    }
    if (ev.key === 'Escape') {
      if (sugMatches.length) { hideSuggest(); }
      else { cmdInputEl.value = ''; cmdInputEl.blur(); setTool('select'); state.selection.clear(); renderProps(); draw(); }
    }
    ev.stopPropagation();
  });
}
// 입력 필드 밖에서 스페이스바 = (작도 중이면 종료) 직전 명령 반복(CAD 관습)
window.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
    ev.preventDefault(); emptyEnterAction();
  }
});

// ============================================================
//  DXF 쓰기 (R12 ASCII — 호환성 우선)
// ============================================================
function dxfColorIndex(hex) {
  // 간단 매핑: 자주 쓰는 AutoCAD 색번호로 근사
  const map = {
    '#ff0000': 1, '#ffff00': 2, '#00ff00': 3, '#00ffff': 4,
    '#0000ff': 5, '#ff00ff': 6, '#ffffff': 7, '#808080': 8,
  };
  hex = rgbHex(hex).toLowerCase();
  if (map[hex]) return map[hex];
  return 7; // 기본 흰/검
}
function buildDXFText() {
  const L = [];
  const g = (code, val) => { L.push(code); L.push(val); };
  let handle = 0x100;                                  // 엔티티/테이블 핸들
  const H = () => (handle++).toString(16).toUpperCase();

  // HEADER — AC1021(R2007)부터 DXF는 UTF-8 → 한글 레이어명 깨짐 방지
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1021');
  g(9, '$INSUNITS'); g(70, ({ mm: 4, cm: 5, m: 6, in: 1 })[settings.units] || 4); // 단위 설정 반영
  g(9, '$HANDSEED'); g(5, 'FFFF');
  g(0, 'ENDSEC');

  // TABLES
  g(0, 'SECTION'); g(2, 'TABLES');
  // LTYPE 테이블(사용 선종류 정의)
  const LTDEF = { dashed: [6, -3], hidden: [4, -3], center: [12, -3, 3, -3], phantom: [16, -3, 3, -3, 3, -3], dot: [0, -3] };
  const usedLts = new Set(['continuous']);
  for (const l of state.layers) if (l.linetype && LTDEF[l.linetype]) usedLts.add(l.linetype);
  for (const e of state.entities) if (e.linetype && LTDEF[e.linetype]) usedLts.add(e.linetype);
  g(0, 'TABLE'); g(2, 'LTYPE'); g(5, H()); g(100, 'AcDbSymbolTable'); g(70, usedLts.size);
  g(0, 'LTYPE'); g(5, H()); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLinetypeTableRecord'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  for (const lt of usedLts) { if (lt === 'continuous') continue; const pat = LTDEF[lt]; const total = pat.reduce((s, v) => s + Math.abs(v), 0);
    g(0, 'LTYPE'); g(5, H()); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLinetypeTableRecord'); g(2, lt.toUpperCase()); g(70, 0); g(3, lt); g(72, 65); g(73, pat.length); g(40, total);
    for (const v of pat) g(49, v); }
  g(0, 'ENDTAB');
  // LAYER 테이블
  g(0, 'TABLE'); g(2, 'LAYER'); g(5, H()); g(100, 'AcDbSymbolTable'); g(70, state.layers.length);
  for (const l of state.layers) {
    g(0, 'LAYER'); g(5, H()); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLayerTableRecord');
    g(2, l.name); g(70, l.visible ? 0 : 1);
    g(62, (l.visible ? 1 : -1) * dxfColorIndex(l.color));
    g(6, (l.linetype && LTDEF[l.linetype]) ? l.linetype.toUpperCase() : 'CONTINUOUS');
    if (l.lineweight != null && l.lineweight >= 0) g(370, l.lineweight);
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // BLOCKS (정의된 블록 + INSERT가 참조하는 것)
  g(0, 'SECTION'); g(2, 'BLOCKS');
  for (const [nm, def] of Object.entries(state.blocks || {})) {
    g(0, 'BLOCK'); g(5, H()); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin');
    g(2, nm); g(70, 0); g(10, 0); g(20, 0); g(30, 0); g(3, nm); g(1, '');
    for (const ce of exportHatchExpand(def.entities)) writeEntity(g, ce, H);
    g(0, 'ENDBLK'); g(5, H()); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  }
  g(0, 'ENDSEC');

  // ENTITIES
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of exportEntities(true)) writeEntity(g, e, H); // INSERT 보존, HATCH는 선으로 분해
  g(0, 'ENDSEC');
  g(0, 'EOF');

  // 코드/값 쌍을 줄로
  let out = '';
  for (let i = 0; i < L.length; i += 2) {
    out += String(L[i]).padStart(3, ' ') + '\n' + L[i + 1] + '\n';
  }
  return out;
}
// DXF 저장 — 모바일은 공유시트(파일 앱 저장), 데스크톱은 다운로드
// 공통 저장: 모바일은 공유시트(파일 앱), 데스크톱은 다운로드
async function saveBlob(blob, fname) {
  const ua = navigator.userAgent || '';
  const isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if ((isiOS || isCoarse) && navigator.share) {
    try {
      const file = new File([blob], fname, { type: blob.type });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fname });
        logLine('  ✔ ' + fname + ' 공유/저장 완료', 'ok');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 사용자가 취소
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  logLine('  ✔ ' + fname + ' 저장', 'ok');
}
const DXF_PICKER_TYPES = [{ description: 'DXF 도면', accept: { 'application/dxf': ['.dxf'] } }];
// ---------- 링크 공유 (서버 불필요, 도면을 압축해 URL에 담음) ----------
function b64ToUrl(b64) { return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function urlToB64(u) { u = u.replace(/-/g, '+').replace(/_/g, '/'); while (u.length % 4) u += '='; return u; }
async function shareEncode(str) {
  if (window.CompressionStream) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return 'g' + b64ToUrl(btoa(bin));
  }
  return 'r' + b64ToUrl(btoa(unescape(encodeURIComponent(str)))); // 폴백(비압축)
}
async function shareDecode(enc) {
  const mode = enc[0], bin = atob(urlToB64(enc.slice(1)));
  if (mode === 'r') return decodeURIComponent(escape(bin));
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
function drawingPayload() {
  return JSON.stringify({ v: 1, entities: state.entities, layers: state.layers, currentLayer: state.currentLayer, blocks: state.blocks, nextId: state.nextId, view: state.view, fileName: currentFileName });
}
async function shareLink() {
  if (!state.entities.length) { logLine('  공유할 도형이 없습니다.', 'warn'); return; }
  const enc = await shareEncode(drawingPayload());
  const url = location.origin + location.pathname + '#d=' + enc;
  if (url.length > 30000) { logLine(`  ⚠ 도면이 커서 링크가 매우 깁니다(${url.length}자). 일부 앱에서 잘릴 수 있어요. DXF 저장 후 공유를 권장합니다.`, 'warn'); }
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch (e) {}
  logLine(`  ✔ 공유 링크 생성 (${(url.length / 1024).toFixed(1)}KB)${copied ? ' — 클립보드에 복사됨' : ''}`, 'ok');
  showShareResult(url, copied);
}
async function loadFromHash() {
  const m = location.hash.match(/^#d=(.+)$/);
  if (!m) return false;
  try {
    const data = JSON.parse(await shareDecode(m[1]));
    if (!data.entities) return false;
    restoreLocal(data);
    setFileName(data.fileName || null, null);
    zoomFit(true);
    logLine(`공유 링크에서 도면을 불러왔습니다 (도형 ${data.entities.length}개).`, 'info');
    history.replaceState(null, '', location.pathname); // 주소창 정리(작업 시작)
    return true;
  } catch (err) { console.error(err); return false; }
}
function showShareResult(url, copied) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);';
  o.innerHTML = `<div style="background:rgba(26,37,64,0.90);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-radius:18px;max-width:520px;width:90%;padding:24px;color:#f5f5f7;box-shadow:0 8px 30px rgba(0,0,0,0.55);font-family:-apple-system,'SF Pro Text','Segoe UI',sans-serif;letter-spacing:-0.01em;">
    <h2 style="margin:0 0 10px;font-size:19px;font-weight:600;letter-spacing:-0.02em;">🔗 공유 링크</h2>
    <p style="margin:0 0 10px;font-size:13px;color:rgba(235,235,245,0.6);line-height:1.5;">${copied ? '클립보드에 복사되었습니다. ' : ''}이 링크를 열면 지금 도면이 그대로 보입니다(서버 없이 URL에 저장됨).</p>
    <textarea readonly style="width:100%;height:90px;background:#1a2540;color:#f5f5f7;border:none;border-radius:8px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:12px;">${url}</textarea>
    <div style="text-align:right;margin-top:14px;"><button id="shCopy" style="background:rgba(255,255,255,0.09);color:#fff;border:none;border-radius:8px;padding:8px 15px;cursor:pointer;margin-right:6px;font-size:14px;">복사</button><button id="shClose" style="background:#0071e3;color:#fff;border:none;border-radius:8px;padding:8px 17px;cursor:pointer;font-size:14px;">닫기</button></div>
  </div>`;
  document.body.appendChild(o);
  const ta = o.querySelector('textarea');
  o.querySelector('#shCopy').onclick = () => { ta.select(); try { navigator.clipboard.writeText(url); } catch (e) { document.execCommand('copy'); } };
  const close = () => o.remove();
  o.querySelector('#shClose').onclick = close;
  o.addEventListener('click', e => { if (e.target === o) close(); });
}

async function saveDXF() {
  const text = buildDXFText();
  // 1) 실제 파일 핸들이 있으면 그 파일에 조용히 덮어쓰기 (CAD의 저장과 동일)
  if (fileHandle) {
    try {
      const w = await fileHandle.createWritable(); await w.write(text); await w.close();
      logLine(`  ✔ ${currentFileName} 저장(덮어쓰기)`, 'ok'); autosave(); return;
    } catch (err) { if (err && err.name === 'AbortError') return; fileHandle = null; /* 아래 폴백 */ }
  }
  const base = currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'drawing';
  // 2) 크롬/엣지: OS 저장 대화상자로 실제 위치 선택
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: base + '.dxf', types: DXF_PICKER_TYPES });
      const w = await h.createWritable(); await w.write(text); await w.close();
      fileHandle = h; setFileName(h.name, 'pc');
      logLine(`  ✔ ${h.name} 저장 (선택한 위치)`, 'ok'); return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  // 3) 폴백: 다운로드/공유
  const fname = base + '.dxf';
  setFileName(fname, 'download');
  await saveBlob(new Blob([text], { type: 'application/dxf' }), fname);
}
async function saveAsDXF(name) {
  const text = buildDXFText();
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name + '.dxf', types: DXF_PICKER_TYPES });
      const w = await h.createWritable(); await w.write(text); await w.close();
      fileHandle = h; setFileName(h.name, 'pc');
      logLine(`  ✔ ${h.name} 저장 (선택한 위치)`, 'ok'); return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  fileHandle = null; setFileName(name + '.dxf', 'download');
  saveBlob(new Blob([text], { type: 'application/dxf' }), name + '.dxf');
}
// 열기: 지원 시 OS 파일 선택기(핸들 확보 → 덮어쓰기 저장 가능), 아니면 기존 input
async function openFile() {
  // 확장자 분기가 필요해 항상 파일 입력(<input accept>)을 사용 — DXF·STL·OBJ 모두 지원
  document.getElementById('fileInput').click();
}

// ---------- 도면 경계(내보내기 공통) ----------
function drawingBBox() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y) => { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; };
  for (const e of state.entities) { const bb = entityBBox(e); if (bb) { ext(bb.xmin, bb.ymin); ext(bb.xmax, bb.ymax); } }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  return { minX, minY, maxX, maxY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}

// ============================================================
//  SVG 내보내기 (벡터, 한글 문자 안전)
// ============================================================
function buildSVG() {
  const b = drawingBBox(), m = Math.max(b.w, b.h) * 0.05 + 5; // 여백
  const W = b.w + 2 * m, H = b.h + 2 * m;
  const X = x => (x - b.minX + m).toFixed(3);
  const Y = y => (b.maxY - y + m).toFixed(3); // SVG는 Y가 아래로 → 뒤집기
  const sw = (Math.max(b.w, b.h) / 600).toFixed(3); // 선 두께
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}" width="${W.toFixed(1)}" height="${H.toFixed(1)}">`];
  out.push(`<rect width="100%" height="100%" fill="white"/>`);
  out.push(`<g fill="none" stroke-width="${sw}">`);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    const c = entityColor(e) === '#ffffff' ? '#000000' : entityColor(e); // 흰색은 흰배경에서 검정으로
    switch (e.type) {
      case 'LINE': out.push(`<line x1="${X(e.x1)}" y1="${Y(e.y1)}" x2="${X(e.x2)}" y2="${Y(e.y2)}" stroke="${c}"/>`); break;
      case 'LWPOLYLINE': {
        const pts = e.points.map(p => `${X(p[0])},${Y(p[1])}`).join(' ');
        out.push(`<${e.closed ? 'polygon' : 'polyline'} points="${pts}" stroke="${c}"/>`); break;
      }
      case 'CIRCLE': out.push(`<circle cx="${X(e.cx)}" cy="${Y(e.cy)}" r="${e.r.toFixed(3)}" stroke="${c}"/>`); break;
      case 'ARC': {
        const a0 = e.startAngle * Math.PI / 180, a1 = e.endAngle * Math.PI / 180;
        const sx = e.cx + e.r * Math.cos(a0), sy = e.cy + e.r * Math.sin(a0);
        const ex = e.cx + e.r * Math.cos(a1), ey = e.cy + e.r * Math.sin(a1);
        let sweepDeg = e.endAngle - e.startAngle; sweepDeg = ((sweepDeg % 360) + 360) % 360;
        const large = sweepDeg > 180 ? 1 : 0;
        // 화면 Y뒤집힘 → sweep 플래그 0(반시계가 화면상 시계가 됨)
        out.push(`<path d="M ${X(sx)} ${Y(sy)} A ${e.r.toFixed(3)} ${e.r.toFixed(3)} 0 ${large} 0 ${X(ex)} ${Y(ey)}" stroke="${c}"/>`); break;
      }
      case 'TEXT': {
        const t = escapeHtml(e.text);
        out.push(`<text x="${X(e.x)}" y="${Y(e.y)}" font-size="${e.height.toFixed(3)}" fill="${c}" stroke="none" font-family="sans-serif">${t}</text>`); break;
      }
    }
  }
  out.push('</g></svg>');
  return out.join('\n');
}

// ============================================================
//  PNG 내보내기 (오프스크린 렌더, 한글 안전)
// ============================================================
function savePNG(fname) {
  const b = drawingBBox();
  const margin = Math.max(b.w, b.h) * 0.05 + 5;
  const scale = Math.min(2000 / (b.w + 2 * margin), 2000 / (b.h + 2 * margin)); // 최대 2000px
  const W = Math.ceil((b.w + 2 * margin) * scale), Hh = Math.ceil((b.h + 2 * margin) * scale);
  const oc = document.createElement('canvas'); oc.width = W; oc.height = Hh;
  const o = oc.getContext('2d');
  o.fillStyle = '#ffffff'; o.fillRect(0, 0, W, Hh);
  const X = x => (x - b.minX + margin) * scale;
  const Y = y => (b.maxY - y + margin) * scale;
  o.lineWidth = Math.max(1, (Math.max(b.w, b.h) / 600) * scale);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    let c = entityColor(e); if (c === '#ffffff') c = '#000000';
    o.strokeStyle = c; o.fillStyle = c;
    o.beginPath();
    switch (e.type) {
      case 'LINE': o.moveTo(X(e.x1), Y(e.y1)); o.lineTo(X(e.x2), Y(e.y2)); o.stroke(); break;
      case 'LWPOLYLINE': e.points.forEach((p, i) => i ? o.lineTo(X(p[0]), Y(p[1])) : o.moveTo(X(p[0]), Y(p[1]))); if (e.closed) o.closePath(); o.stroke(); break;
      case 'CIRCLE': o.arc(X(e.cx), Y(e.cy), e.r * scale, 0, Math.PI * 2); o.stroke(); break;
      case 'ARC': o.arc(X(e.cx), Y(e.cy), e.r * scale, -e.endAngle * Math.PI / 180, -e.startAngle * Math.PI / 180); o.stroke(); break;
      case 'TEXT': o.font = `${e.height * scale}px sans-serif`; o.textBaseline = 'alphabetic'; o.fillText(e.text, X(e.x), Y(e.y)); break;
    }
  }
  oc.toBlob(blob => { if (blob) saveBlob(blob, fname); }, 'image/png');
}

// ============================================================
//  PDF 내보내기 (벡터 단일 페이지)
// ============================================================
const PAPER_SIZES = { // pt (1mm=2.8346pt)
  a4: [841.89, 595.28], a3: [1190.55, 841.89], a2: [1683.78, 1190.55], a1: [2383.94, 1683.78], letter: [792, 612],
};
// opt: { paper:'a3', landscape:true, scaleDenom:100(=1:100, 0=자동맞춤), region:{minX..}|null, title:{...}|null, units:'mm' }
function buildPDF(opt) {
  opt = opt || {};
  const MM = 2.83464567; // mm → pt
  const size = PAPER_SIZES[opt.paper || 'a3'] || PAPER_SIZES.a3;
  let PW = size[0], PH = size[1];
  if (opt.landscape === false) { PW = size[1]; PH = size[0]; }        // 기본 가로
  const margin = 15 * MM;
  const b = opt.region ? { minX: opt.region.minX, minY: opt.region.minY, w: opt.region.maxX - opt.region.minX, h: opt.region.maxY - opt.region.minY, maxX: opt.region.maxX, maxY: opt.region.maxY } : drawingBBox();
  const availW = PW - 2 * margin, availH = PH - 2 * margin - (opt.title ? 12 * MM : 0);
  // 축척: scaleDenom>0 이면 1:denom 고정, 아니면 용지에 맞춤
  const unitToMM = ({ mm: 1, cm: 10, m: 1000, in: 25.4 })[opt.units || settings.units] || 1;
  let sc; // 도면단위 → pt
  if (opt.scaleDenom > 0) sc = (unitToMM * MM) / opt.scaleDenom;      // 1 도면단위 = unitToMM mm, 축척 적용
  else sc = Math.min(availW / b.w, availH / b.h);                     // 자동 맞춤
  // 그림을 인쇄영역 중앙에 배치
  const drawW = b.w * sc, drawH = b.h * sc;
  const offX = margin + (availW - drawW) / 2, offY = margin + (opt.title ? 12 * MM : 0) + (availH - drawH) / 2;
  const X = x => (offX + (x - b.minX) * sc);
  const Y = y => (offY + (y - b.minY) * sc);
  const num = n => (Math.round(n * 1000) / 1000).toFixed(3);
  const K = 0.5522847498;
  const ops = [];
  ops.push('0.7 w');
  const setColor = (hex) => { hex = rgbHex(hex === '#ffffff' ? '#000000' : hex); const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, bl = parseInt(hex.slice(5, 7), 16) / 255; ops.push(`${num(r)} ${num(g)} ${num(bl)} RG`); ops.push(`${num(r)} ${num(g)} ${num(bl)} rg`); };
  const circlePath = (cx, cy, r) => {
    const x = X(cx), y = Y(cy), rr = r * sc;
    ops.push(`${num(x + rr)} ${num(y)} m`);
    ops.push(`${num(x + rr)} ${num(y + rr * K)} ${num(x + rr * K)} ${num(y + rr)} ${num(x)} ${num(y + rr)} c`);
    ops.push(`${num(x - rr * K)} ${num(y + rr)} ${num(x - rr)} ${num(y + rr * K)} ${num(x - rr)} ${num(y)} c`);
    ops.push(`${num(x - rr)} ${num(y - rr * K)} ${num(x - rr * K)} ${num(y - rr)} ${num(x)} ${num(y - rr)} c`);
    ops.push(`${num(x + rr * K)} ${num(y - rr)} ${num(x + rr)} ${num(y - rr * K)} ${num(x + rr)} ${num(y)} c`);
    ops.push('S');
  };
  const arcPath = (e) => {
    let s = e.startAngle, en = e.endAngle; if (en < s) en += 360;
    const steps = Math.max(2, Math.ceil((en - s) / 30));
    for (let i = 0; i <= steps; i++) {
      const a = (s + (en - s) * i / steps) * Math.PI / 180;
      const px = X(e.cx + e.r * Math.cos(a)), py = Y(e.cy + e.r * Math.sin(a));
      ops.push(`${num(px)} ${num(py)} ${i ? 'l' : 'm'}`);
    }
    ops.push('S');
  };
  // 인쇄영역으로 클리핑(축척 고정 시 용지 밖 잘림)
  ops.push('q');
  ops.push(`${num(margin)} ${num(margin)} ${num(availW)} ${num(PH - 2 * margin)} re W n`);
  for (const e of exportEntities()) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    setColor(entityColor(e));
    switch (e.type) {
      case 'LINE': ops.push(`${num(X(e.x1))} ${num(Y(e.y1))} m ${num(X(e.x2))} ${num(Y(e.y2))} l S`); break;
      case 'LWPOLYLINE': e.points.forEach((p, i) => ops.push(`${num(X(p[0]))} ${num(Y(p[1]))} ${i ? 'l' : 'm'}`)); if (e.closed) ops.push('h'); ops.push('S'); break;
      case 'CIRCLE': circlePath(e.cx, e.cy, e.r); break;
      case 'ARC': arcPath(e); break;
      case 'TEXT': { const txt = String(e.text).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); ops.push(`BT /F1 ${num(e.height * sc)} Tf ${num(X(e.x))} ${num(Y(e.y))} Td (${txt}) Tj ET`); break; }
    }
  }
  ops.push('Q');
  // 제목블록(하단 테두리 + 정보)
  if (opt.title) {
    const t = opt.title, bx = margin, by = margin, bw = PW - 2 * margin, bh = 11 * MM;
    ops.push('0 0 0 RG 0.8 w');
    ops.push(`${num(bx)} ${num(by)} ${num(bw)} ${num(bh)} re S`);
    ops.push(`${num(bx + bw * 0.7)} ${num(by)} m ${num(bx + bw * 0.7)} ${num(by + bh)} l S`);
    ops.push(`${num(bx)} ${num(by + bh / 2)} m ${num(bx + bw * 0.7)} ${num(by + bh / 2)} l S`);
    const asc = s => String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const txt = (x, y, s, sz) => ops.push(`BT /F1 ${num(sz)} Tf ${num(x)} ${num(y)} Td (${asc(s)}) Tj ET`);
    txt(bx + 4 * MM, by + bh * 0.62, 'TITLE: ' + (t.title || ''), 9);
    txt(bx + 4 * MM, by + bh * 0.2, 'FILE: ' + (t.file || ''), 7);
    txt(bx + bw * 0.7 + 4 * MM, by + bh * 0.62, 'SCALE: ' + (t.scale || ''), 9);
    txt(bx + bw * 0.7 + 4 * MM, by + bh * 0.2, 'DATE: ' + (t.date || ''), 7);
  }
  const content = ops.join('\n');
  // PDF 객체 조립 (오프셋 정확히 계산)
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PW)} ${num(PH)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
function writeEntity(g, e, H) {
  // AC1021(R2007) 구조: 핸들(5) + AcDbEntity + 서브클래스 마커
  const head = (type, sub) => { g(0, type); g(5, H()); g(100, 'AcDbEntity'); g(8, e.layer); if (e.color) g(62, dxfColorIndex(e.color));
    if (e.linetype && e.linetype !== 'continuous') g(6, e.linetype.toUpperCase());
    if (e.lineweight != null && e.lineweight >= 0) g(370, e.lineweight); g(100, sub); };
  switch (e.type) {
    case 'LINE':
      head('LINE', 'AcDbLine');
      g(10, e.x1); g(20, e.y1); g(30, 0);
      g(11, e.x2); g(21, e.y2); g(31, 0);
      break;
    case 'LWPOLYLINE':
      head('LWPOLYLINE', 'AcDbPolyline');
      g(90, e.points.length); g(70, e.closed ? 1 : 0);
      for (const p of e.points) { g(10, p[0]); g(20, p[1]); }
      break;
    case 'CIRCLE':
      head('CIRCLE', 'AcDbCircle');
      g(10, e.cx); g(20, e.cy); g(30, 0); g(40, e.r);
      break;
    case 'ARC':
      head('ARC', 'AcDbCircle');
      g(10, e.cx); g(20, e.cy); g(30, 0); g(40, e.r);
      g(100, 'AcDbArc'); g(50, e.startAngle); g(51, e.endAngle);
      break;
    case 'TEXT':
      head('TEXT', 'AcDbText');
      g(10, e.x); g(20, e.y); g(30, 0); g(40, e.height);
      g(1, e.text); g(50, e.rotation || 0);
      break;
    case 'INSERT':
      head('INSERT', 'AcDbBlockReference');
      g(2, e.name); g(10, e.x); g(20, e.y); g(30, 0);
      g(41, e.sx != null ? e.sx : 1); g(42, e.sy != null ? e.sy : 1); g(43, 1);
      g(50, e.rot || 0);
      break;
  }
}

// ============================================================
//  DXF 읽기 (R12~ 일반 엔티티 파서)
// ============================================================
// ============================================================
//  3D 메시 가져오기 — STL(ASCII/바이너리)·OBJ → MESH 엔티티(삼각형 집합)
// ============================================================
function parseSTL(buf) {
  const tris = [];
  const bytes = new Uint8Array(buf);
  // ASCII 판별: 선두가 'solid'이고 'facet'이 텍스트로 존재
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 256); i++) head += String.fromCharCode(bytes[i]);
  const looksAscii = /^\s*solid/i.test(head) && head.toLowerCase().indexOf('facet') !== -1;
  if (looksAscii) {
    const txt = new TextDecoder().decode(buf);
    const nums = txt.match(/vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g) || [];
    for (let i = 0; i + 2 < nums.length; i += 3) {
      const v = j => { const m = nums[i + j].trim().split(/\s+/); return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]; };
      tris.push([v(0), v(1), v(2)]);
    }
    if (tris.length) return tris;
  }
  // 바이너리 STL: 80바이트 헤더 + uint32 개수 + 삼각형당 50바이트
  if (buf.byteLength >= 84) {
    const dv = new DataView(buf);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 <= buf.byteLength) {
      let off = 84;
      for (let k = 0; k < n; k++) {
        off += 12; // 법선 스킵
        const rd = () => { const x = dv.getFloat32(off, true), y = dv.getFloat32(off + 4, true), z = dv.getFloat32(off + 8, true); off += 12; return [x, y, z]; };
        tris.push([rd(), rd(), rd()]);
        off += 2; // 속성 바이트
      }
    }
  }
  return tris;
}
function parseOBJ(text) {
  const V = [], tris = [];
  const lines = text.split(/\r?\n/);
  for (const ln of lines) {
    const t = ln.trim();
    if (t[0] === 'v' && t[1] === ' ') {
      const p = t.split(/\s+/); V.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
    } else if (t[0] === 'f' && t[1] === ' ') {
      const idx = t.slice(2).trim().split(/\s+/).map(tok => {
        const i = parseInt(tok.split('/')[0], 10); return i < 0 ? V.length + i : i - 1;
      });
      for (let i = 1; i + 1 < idx.length; i++) { // 팬 삼각화
        const a = V[idx[0]], b = V[idx[i]], c = V[idx[i + 1]];
        if (a && b && c) tris.push([a, b, c]);
      }
    }
  }
  return tris;
}
function loadMesh(tris, name) {
  if (!tris || !tris.length) { logLine('  ' + (name || '메시') + ': 유효한 삼각형이 없습니다.', 'warn'); return false; }
  pushUndo();
  const e = addEntity({ type: 'MESH', tris, name: name || 'mesh', color: '#b9b2a6' });
  logLine('  ✔ 3D 메시 가져오기: ' + tris.length + '개 삼각형 (' + (name || '') + ') — 3D 뷰에서 확인', 'ok');
  state.selection.clear(); state.selection.add(e.id);
  const ov = document.getElementById('bim3d');
  if (ov && ov.style.display !== 'none' && typeof fit3D === 'function') { v3.solids = bimSolids(); fit3D(); v3.zoom = 1; v3.panX = 0; v3.panY = 0; loadVp(v3.act); render3D(); }
  else { renderProps(); draw(); }
  return true;
}
function meshBBox(e) {
  let xm = 1e18, xM = -1e18, ym = 1e18, yM = -1e18;
  for (const t of e.tris) for (const p of t) { xm = Math.min(xm, p[0]); xM = Math.max(xM, p[0]); ym = Math.min(ym, p[1]); yM = Math.max(yM, p[1]); }
  return { xmin: xm, xmax: xM, ymin: ym, ymax: yM };
}
function loadDXF(text) {
  try {
    const pairs = parseDXFPairs(text);
    const result = parseDXFEntities(pairs);
    pushUndo();
    state.entities = result.entities;
    state.layers = result.layers.length ? result.layers : [{ name: '0', color: '#ffffff', visible: true }];
    if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
    state.currentLayer = '0';
    state.blocks = result.blocks || {}; insertName = null;
    state.nextId = state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    state.selection.clear();
    renderLayers(); refreshBlockList(); updateStat(); zoomFit(true);
    hint(`DXF 불러오기 완료: 도형 ${state.entities.length}개`);
    return true;
  } catch (err) {
    alert('DXF 파일을 읽는 중 오류가 발생했습니다:\n' + err.message);
    console.error(err);
    return false;
  }
}
function parseDXFPairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (isNaN(code)) { i -= 1; continue; } // 어긋난 경우 한 줄 보정
    pairs.push([code, lines[i + 1]]);
  }
  return pairs;
}
function aci2hex(n) {
  const t = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0' };
  return t[Math.abs(n)] || '#ffffff';
}
function parseDXFEntities(pairs) {
  const entities = [], layers = [];
  const blocks = {}; // 블록 정의: name -> { bx, by, entities: [] }
  const usedBlocks = new Set(); // INSERT로 유지된 블록 이름

  function num(d, code, def = 0) { const v = d[code]; return v === undefined ? def : parseFloat(Array.isArray(v) ? v[0] : v); }
  function baseOf(d) {
    const layer = (d[8] !== undefined ? (Array.isArray(d[8]) ? d[8][0] : d[8]) : '0').trim();
    const base = { layer };
    if (d[62] !== undefined) {
      const n = parseInt(Array.isArray(d[62]) ? d[62][0] : d[62], 10);
      if (n !== 256 && n !== 0) base.color = aci2hex(n); // 256=ByLayer, 0=ByBlock → 기본색
    }
    if (d[6] !== undefined) { const lt = String(Array.isArray(d[6]) ? d[6][0] : d[6]).trim().toLowerCase(); if (LINETYPES[lt] !== undefined && lt !== 'continuous' && lt !== 'bylayer') base.linetype = lt; }
    if (d[370] !== undefined) { const lw = parseInt(Array.isArray(d[370]) ? d[370][0] : d[370], 10); if (lw >= 0) base.lineweight = lw; }
    return base;
  }
  function buildEntity(t, d, verts) {
    const base = baseOf(d);
    switch (t) {
      case 'LINE': return { ...base, type: 'LINE', x1: num(d, 10), y1: num(d, 20), x2: num(d, 11), y2: num(d, 21) };
      case 'LWPOLYLINE': {
        const pts = verts.filter(p => p[1] !== undefined);
        if (pts.length < 2) return null;
        return { ...base, type: 'LWPOLYLINE', closed: (num(d, 70) & 1) === 1, points: pts };
      }
      case 'CIRCLE': {
        let cx = num(d, 10), cy = num(d, 20);
        if (num(d, 230, 1) < 0) cx = -cx; // 음수 Z 돌출 → OCS가 X축 반전 저장됨
        return { ...base, type: 'CIRCLE', cx, cy, r: num(d, 40) };
      }
      case 'ARC': {
        let cx = num(d, 10), cy = num(d, 20), sa = num(d, 50), ea = num(d, 51);
        if (num(d, 230, 1) < 0) { cx = -cx; const ns = 180 - ea, ne = 180 - sa; sa = ns; ea = ne; } // OCS X축 반전: 좌표·각도 미러 + 진행방향 반전
        return { ...base, type: 'ARC', cx, cy, r: num(d, 40), startAngle: sa, endAngle: ea };
      }
      case 'TEXT': case 'MTEXT': case 'ATTRIB': {
        let parts = [];
        if (d[3] !== undefined) parts.push(...(Array.isArray(d[3]) ? d[3] : [d[3]])); // MTEXT 연속 텍스트
        if (d[1] !== undefined) parts.push(...(Array.isArray(d[1]) ? d[1] : [d[1]]));
        let txt = parts.join('')
          .replace(/\\P/gi, ' ')                 // MTEXT 줄바꿈 → 공백
          .replace(/\\[A-Za-z][^;]*;/g, '')      // 서식 코드 제거
          .replace(/[{}]/g, '')
          .replace(/%%c/gi, '⌀').replace(/%%d/gi, '°').replace(/%%p/gi, '±');
        if (!txt.trim()) return null;
        return { ...base, type: 'TEXT', x: num(d, 10), y: num(d, 20), height: num(d, 40, 10), text: txt, rotation: num(d, 50) };
      }
      case 'ELLIPSE': {
        const cx = num(d, 10), cy = num(d, 20), mx = num(d, 11), my = num(d, 21);
        const ratio = num(d, 40, 1), t0 = num(d, 41, 0), t1 = num(d, 42, Math.PI * 2);
        const nx = -my * ratio, ny = mx * ratio; // 단축 벡터
        const full = Math.abs((t1 - t0) - Math.PI * 2) < 1e-6;
        const N = 48, pts = [];
        for (let k = 0; k <= (full ? N - 1 : N); k++) {
          const t = t0 + (t1 - t0) * k / N;
          pts.push([cx + Math.cos(t) * mx + Math.sin(t) * nx, cy + Math.cos(t) * my + Math.sin(t) * ny]);
        }
        return { ...base, type: 'LWPOLYLINE', closed: full, points: pts };
      }
      case 'SPLINE': {
        const arr = c => d[c] === undefined ? [] : (Array.isArray(d[c]) ? d[c] : [d[c]]).map(parseFloat);
        const fx = arr(11), fy = arr(12).length ? arr(12) : arr(21); // 일부 파일은 21 사용
        const cxs = arr(10), cys = arr(20);
        let pts = [];
        if (fx.length >= 2 && fy.length >= 2) pts = fx.map((x, i) => [x, fy[i]]);       // 맞춤점 통과
        else if (cxs.length >= 2) pts = cxs.map((x, i) => [x, cys[i]]);                  // 제어점 근사
        if (pts.length < 2) return null;
        const closed = (num(d, 70) & 1) === 1;
        return { ...base, type: 'LWPOLYLINE', closed, points: pts };
      }
      case 'SOLID': {
        const pts = [[num(d, 10), num(d, 20)], [num(d, 11), num(d, 21)]];
        if (d[13] !== undefined) { pts.push([num(d, 13), num(d, 23)]); pts.push([num(d, 12), num(d, 22)]); }
        else if (d[12] !== undefined) pts.push([num(d, 12), num(d, 22)]);
        if (pts.length < 3) return null;
        return { ...base, type: 'HATCH', pattern: 'solid', spacing: 5, boundary: { kind: 'poly', points: pts } };
      }
      case 'HATCH': {
        const arr = c => d[c] === undefined ? [] : (Array.isArray(d[c]) ? d[c] : [d[c]]).map(parseFloat);
        let xs = arr(10), ys = arr(20);
        const seedN = num(d, 98, 0);                       // 마지막 N쌍은 시드점 → 제외
        if (seedN > 0) { xs = xs.slice(0, xs.length - seedN); ys = ys.slice(0, ys.length - seedN); }
        const v93 = arr(93);                               // 폴리라인 경계 정점 수(첫 루프만 사용)
        const nv = v93.length ? Math.min(v93[0], xs.length) : xs.length;
        const pts = [];
        for (let k = 0; k < nv; k++) if (isFinite(xs[k]) && isFinite(ys[k])) pts.push([xs[k], ys[k]]);
        if (pts.length < 3) return null;
        const pname = (d[2] !== undefined ? String(Array.isArray(d[2]) ? d[2][0] : d[2]) : '').trim().toUpperCase();
        const solid = num(d, 70) === 1 || pname === 'SOLID';
        const PMAP = { ANSI31: 'ansi31', ANSI37: 'ansi37', ANSI32: 'steel', 'AR-CONC': 'concrete', 'AR-SAND': 'dots', DOTS: 'dots', 'AR-B816': 'brick', BRICK: 'brick', NET: 'grid', GRID: 'grid' };
        const scale = num(d, 41, 1);
        return { ...base, type: 'HATCH', pattern: solid ? 'solid' : (PMAP[pname] || 'ansi31'),
          spacing: Math.max(0.5, Math.min(1000, 3.175 * scale)), boundary: { kind: 'poly', points: pts } };
      }
      case 'POINT': {
        const x = num(d, 10), y = num(d, 20), s = 1;
        return { ...base, type: 'LINE', x1: x - s, y1: y, x2: x + s, y2: y };
      }
    }
    return null;
  }
  function buildPoly(d, pts) {
    if (pts.length < 2) return null;
    return { ...baseOf(d), type: 'LWPOLYLINE', closed: (num(d, 70) & 1) === 1, points: pts };
  }
  // 블록 엔티티를 INSERT 위치/스케일/회전에 맞게 변환한 사본 생성.
  // sx/sy 부호로 미러링도 처리(호는 반사 시 방향이 뒤집히므로 각도 재계산 + start/end 교환).
  function xformEntity(src, tp, sx, sy, rot) {
    const e = JSON.parse(JSON.stringify(src));
    const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const sc = Math.sqrt(Math.abs(sx * sy)); // 반지름/문자 크기 배율(미러여도 양수)
    // 블록 좌표계 방향각(도)을 스케일+회전 적용 후 방향각(도)으로 변환
    const dirAngle = (deg) => {
      const t = deg * Math.PI / 180, vx = Math.cos(t) * sx, vy = Math.sin(t) * sy;
      return Math.atan2(vx * sa + vy * ca, vx * ca - vy * sa) * 180 / Math.PI;
    };
    switch (e.type) {
      case 'LINE': [e.x1, e.y1] = tp(e.x1, e.y1); [e.x2, e.y2] = tp(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points = e.points.map(p => tp(p[0], p[1])); break;
      case 'CIRCLE': [e.cx, e.cy] = tp(e.cx, e.cy); e.r *= sc; break;
      case 'ARC': {
        [e.cx, e.cy] = tp(e.cx, e.cy); e.r *= sc;
        let s = dirAngle(e.startAngle), en = dirAngle(e.endAngle);
        if (sx * sy < 0) { const t = s; s = en; en = t; } // 반사 → 호 진행방향 반전
        e.startAngle = s; e.endAngle = en;
        break;
      }
      case 'TEXT': [e.x, e.y] = tp(e.x, e.y); e.height *= sc; e.rotation = (e.rotation || 0) + rot; break;
      case 'HATCH': {
        const b = e.boundary;
        if (b.kind === 'circle') { [b.cx, b.cy] = tp(b.cx, b.cy); b.r *= sc; }
        else b.points = b.points.map(p => tp(p[0], p[1]));
        e.spacing = (e.spacing || 5) * sc;
        break;
      }
    }
    return e;
  }
  function expandInsert(d, out) {
    const name = (d[2] !== undefined ? String(Array.isArray(d[2]) ? d[2][0] : d[2]) : '').trim();
    const blk = blocks[name];
    if (!blk) return;
    const ix = num(d, 10), iy = num(d, 20), sx = num(d, 41, 1), sy = num(d, 42, 1), rot = num(d, 50, 0);
    const a = rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const tp = (x, y) => { const px = (x - blk.bx) * sx, py = (y - blk.by) * sy; return [px * ca - py * sa + ix, px * sa + py * ca + iy]; };
    for (const src of blk.entities) out.push(xformEntity(src, tp, sx, sy, rot));
  }
  // 엔티티 스트림 파서 — ENTITIES/블록 정의 양쪽에서 공용. ENDSEC 또는 ENDBLK에서 멈춤.
  function parseEntityStream(p, start, out) {
    let j = start;
    const stop = v => v === 'ENDSEC' || v === 'ENDBLK';
    while (j < p.length && !(p[j][0] === 0 && stop(p[j][1].trim()))) {
      if (p[j][0] !== 0) { j++; continue; }
      const t = p[j][1].trim();
      j++;
      const data = {}, verts = [];
      while (j < p.length && p[j][0] !== 0) {
        const [c, v] = p[j];
        if (t === 'LWPOLYLINE' && c === 10) verts.push([parseFloat(v), undefined]);
        else if (t === 'LWPOLYLINE' && c === 20) { if (verts.length) verts[verts.length - 1][1] = parseFloat(v); }
        else (data[c] === undefined) ? data[c] = v : (Array.isArray(data[c]) ? data[c].push(v) : data[c] = [data[c], v]);
        j++;
      }
      if (t === 'POLYLINE') {
        // 구형 POLYLINE: 뒤따르는 VERTEX들을 모아 LWPOLYLINE으로 변환
        const pts = [];
        while (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'VERTEX') {
          j++;
          const vd = {};
          while (j < p.length && p[j][0] !== 0) { const [c, v] = p[j]; vd[c] = v; j++; }
          pts.push([num(vd, 10), num(vd, 20)]);
        }
        if (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'SEQEND') { j++; while (j < p.length && p[j][0] !== 0) j++; }
        const e = buildPoly(data, pts);
        if (e) out.push(e);
        continue;
      }
      if (t === 'INSERT') {
        const nm = (data[2] !== undefined ? String(Array.isArray(data[2]) ? data[2][0] : data[2]) : '').trim();
        if (blocks[nm]) { // 정의가 있으면 INSERT 엔티티로 유지(블록 보존)
          usedBlocks.add(nm);
          out.push({ ...baseOf(data), type: 'INSERT', name: nm, x: num(data, 10), y: num(data, 20),
            sx: num(data, 41, 1), sy: num(data, 42, 1), rot: num(data, 50, 0) });
        } else expandInsert(data, out); // 없으면 전개(빈 블록 방지)
        continue;
      }
      if (t === 'DIMENSION') {
        // 치수는 렌더링된 기하가 담긴 익명 블록(*D..)을 참조 → 그대로 전개(WCS 좌표)
        const bn = (data[2] !== undefined ? String(Array.isArray(data[2]) ? data[2][0] : data[2]) : '').trim();
        const blk = blocks[bn];
        if (blk) for (const src of blk.entities) out.push(JSON.parse(JSON.stringify(src)));
        continue;
      }
      const e = buildEntity(t, data, verts);
      if (e) out.push(e);
    }
    return j;
  }
  function parseLayers(p, start, out) {
    let j = start;
    while (j < p.length && !(p[j][0] === 0 && p[j][1].trim() === 'ENDSEC')) {
      if (p[j][0] === 0 && p[j][1].trim() === 'LAYER') {
        const lay = { name: '0', color: '#ffffff', visible: true };
        j++;
        while (j < p.length && p[j][0] !== 0) {
          const [c, v] = p[j];
          if (c === 2) lay.name = v.trim();
          else if (c === 62) { const n = parseInt(v, 10); lay.visible = n >= 0; lay.color = aci2hex(n); }
          else if (c === 6) { const lt = v.trim().toLowerCase(); if (LINETYPES[lt] !== undefined && lt !== 'continuous') lay.linetype = lt; }
          else if (c === 370) { const lw = parseInt(v, 10); if (lw >= 0) lay.lineweight = lw; }
          j++;
        }
        if (!out.find(l => l.name === lay.name)) out.push(lay);
      } else j++;
    }
    return j;
  }
  function parseBlocks(p, start) {
    let j = start;
    while (j < p.length && !(p[j][0] === 0 && p[j][1].trim() === 'ENDSEC')) {
      if (p[j][0] === 0 && p[j][1].trim() === 'BLOCK') {
        j++;
        const bd = {};
        while (j < p.length && p[j][0] !== 0) { const [c, v] = p[j]; bd[c] = v; j++; }
        const name = (bd[2] !== undefined ? String(bd[2]) : '').trim();
        const ents = [];
        j = parseEntityStream(p, j, ents); // ENDBLK에서 멈춤
        blocks[name] = { bx: num(bd, 10), by: num(bd, 20), entities: ents };
        if (j < p.length && p[j][0] === 0 && p[j][1].trim() === 'ENDBLK') { j++; while (j < p.length && p[j][0] !== 0) j++; }
      } else j++;
    }
    return j;
  }

  // 섹션 단위로 진행 (BLOCKS는 ENTITIES보다 먼저 나오므로 INSERT 전개 시 참조 가능)
  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val.trim() === 'SECTION') {
      const sec = pairs[i + 1] && pairs[i + 1][0] === 2 ? pairs[i + 1][1].trim() : '';
      if (sec === 'TABLES') { i = parseLayers(pairs, i + 2, layers); continue; }
      if (sec === 'BLOCKS') { i = parseBlocks(pairs, i + 2); continue; }
      if (sec === 'ENTITIES') { i = parseEntityStream(pairs, i + 2, entities); continue; }
    }
    i++;
  }
  let id = 1;
  for (const e of entities) e.id = id++;
  // 유지된 INSERT가 참조하는 블록 정의를 WebCAD 형식(기준점=원점)으로 변환
  const outBlocks = {};
  for (const nm of usedBlocks) {
    const bd = blocks[nm]; if (!bd) continue;
    outBlocks[nm] = { entities: bd.entities.map(src => { const c = JSON.parse(JSON.stringify(src)); delete c.id; translateEntity(c, -bd.bx, -bd.by); return c; }) };
  }
  return { entities, layers, blocks: outBlocks };
}

// ============================================================
//  유틸
// ============================================================
function getCSS(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function rgbHex(c) {
  if (!c) return '#ffffff';
  if (c[0] === '#') {
    if (c.length === 4) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return c;
  }
  const m = c.match(/\d+/g); if (!m) return '#ffffff';
  return '#' + m.slice(0, 3).map(n => (+n).toString(16).padStart(2, '0')).join('');
}

// ============================================================
//  초기화 + 이동 미리보기 포함 최종 draw 패치
// ============================================================
// moveOp 미리보기를 위해 draw를 확장
const baseDraw = draw;
draw = function () {
  // 이동 미리보기: 선택 도형 임시 이동
  let undoMove = null;
  if (moveOp && (moveOp.dx || moveOp.dy) && moveOp.entities) {
    undoMove = [];
    for (const id of moveOp.entities) {
      const e = state.entities.find(x => x.id === id);
      if (e) { undoMove.push(e); translateEntity(e, moveOp.dx, moveOp.dy); }
    }
  }
  baseDraw();
  if (undoMove) for (const e of undoMove) translateEntity(e, -moveOp.dx, -moveOp.dy);
  updateDimHint();
};

// 현재 상태에서 치수/수치 입력이 가능하면 그 라벨을, 아니면 null
function currentDimPrompt() {
  const t = state.tool;
  if (t === 'offset') return '간격 거리 입력';
  if (t === 'fillet') return '반지름 입력';
  if (t === 'circle' && draft) return '반지름 입력';
  if (t === 'line' && draft) return '길이·좌표 입력';
  if (t === 'rect' && draft) return '크기(w,h) 입력';
  if (t === 'pline' && pts.length) return '다음 점·길이 입력';
  if (t === 'arc' && arcState) return '다음 점 입력';
  if (t === 'rotate' && cmdOp && cmdOp.step === 'angle') return '각도(°) 입력';
  if (t === 'scale' && cmdOp && (cmdOp.step === 'ref' || cmdOp.step === 'new')) return '배율 입력';
  if (t === 'move' && moveOp && moveOp.base) return '이동 거리 입력';
  if (t === 'copy' && cmdOp && cmdOp.step === 'dest') return '이동 거리 입력';
  if (t === 'chamfer') return '모따기 거리 입력';
  if (t === 'polygon') return draft ? '반지름 입력' : '변 개수 입력';
  if (t === 'ellipse' && draft) return '반지름 rx,ry 입력';
  if (t === 'lengthen') return '증감 길이(±) 입력';
  if (t === 'hatch') return '해치 간격 입력';
  if (t === 'divide') return '등분 개수 입력';
  if (t === 'measure') return '간격 입력';
  return null;
}
let _lastDimLabel = '__init__';
function updateDimHint() {
  const label = currentDimPrompt();
  if (label === _lastDimLabel) return; // 변화 없으면 스킵
  _lastDimLabel = label;
  const el = document.getElementById('dimHint');
  if (!el || !cmdInputEl) return;
  if (label) {
    el.textContent = '⌨ ' + label; el.classList.add('on'); cmdInputEl.classList.add('dim');
    // 치수 입력 가능 → 명령창을 자동 활성화(포커스). setTimeout으로 클릭 기본동작 뒤에 확정.
    setTimeout(() => { if (currentDimPrompt() && document.activeElement !== cmdInputEl) cmdInputEl.focus({ preventScroll: true }); }, 0);
  } else { el.classList.remove('on'); el.textContent = ''; cmdInputEl.classList.remove('dim'); }
}

// ============================================================
//  다중 문서 탭 — 각 탭 = 독립 도면(엔티티·레이어·블록·뷰·undo·파일명)
// ============================================================
let docs = [], curDoc = 0;
function captureDoc() {
  return {
    entities: state.entities, layers: state.layers, currentLayer: state.currentLayer,
    nextId: state.nextId, blocks: state.blocks, view: { ...state.view }, views: state.views,
    levels: state.levels, curLv: state.curLv, ghostLv: state.ghostLv,
    fileName: currentFileName, fileLoc: currentFileLoc, fileHandle,
    undo: undoStack.slice(), redo: redoStack.slice(),
  };
}
function applyDoc(d) {
  state.entities = d.entities || [];
  state.layers = (d.layers && d.layers.length) ? d.layers : [{ name: '0', color: '#ffffff', visible: true }];
  if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
  state.currentLayer = d.currentLayer && getLayer(d.currentLayer) ? d.currentLayer : '0';
  state.nextId = d.nextId || (state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  state.blocks = d.blocks || {}; insertName = null;
  state.views = d.views || {};
  state.levels = (d.levels && d.levels.length) ? d.levels : [{ name: '1F', elev: 0 }];
  state.curLv = Math.min(d.curLv || 0, state.levels.length - 1);
  state.ghostLv = d.ghostLv !== false;
  renderLevels();
  viewPrevStack.length = 0;
  if (d.view) state.view = { ...d.view };
  fileHandle = d.fileHandle || null;
  currentFileName = d.fileName || null; currentFileLoc = d.fileLoc || null;
  undoStack.length = 0; if (d.undo) undoStack.push(...d.undo);
  redoStack.length = 0; if (d.redo) redoStack.push(...d.redo);
  state.selection.clear(); cmdOp = null; draft = null; pts = []; previewEnts = null; moveOp = null;
  setFileName(currentFileName, currentFileLoc);
  renderLayers(); renderProps(); updateStat(); refreshBlockList(); draw();
}
function switchDoc(i) {
  if (i === curDoc || !docs[i]) { renderDocTabs(); return; }
  docs[curDoc] = captureDoc();
  curDoc = i;
  applyDoc(docs[i]);
  renderDocTabs();
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange();
  logLine(`▷ 탭 전환: ${currentFileName || '새 파일'}`, 'info');
}
function newDocTab() {
  docs[curDoc] = captureDoc();
  docs.push({});
  curDoc = docs.length - 1;
  applyDoc({}); // 빈 도면
  if (window.WEBCAD_API && WEBCAD_API.onDocChange) WEBCAD_API.onDocChange();
  state.layers = [
    { name: '0', color: '#ffffff', visible: true },
    { name: '치수', color: '#5dff8f', visible: true },
    { name: '보조선', color: '#5d9dff', visible: true },
  ];
  state.view = { x: 0, y: 0, scale: 4 };
  renderLayers(); draw();
  renderDocTabs();
  logLine('▷ 새 탭', 'info');
}
function closeDocTab(i) {
  const d = docs[i] && i !== curDoc ? docs[i] : (i === curDoc ? captureDoc() : docs[i]);
  if (d && d.entities && d.entities.length && !confirm(`"${d.fileName || '새 파일'}" 탭을 닫을까요? (저장 안 된 내용은 사라집니다)`)) return;
  if (docs.length <= 1) { doNew(); renderDocTabs(); return; } // 마지막 탭 = 내용만 초기화
  docs.splice(i, 1);
  if (curDoc === i) { curDoc = Math.max(0, i - 1); applyDoc(docs[curDoc]); }
  else if (curDoc > i) curDoc--;
  renderDocTabs();
}
function renderDocTabs() {
  const bar = document.getElementById('docTabs');
  if (!bar) return;
  let untitled = 0;
  bar.innerHTML = docs.map((d, i) => {
    const isCur = i === curDoc;
    const nm = (isCur ? currentFileName : d.fileName) || ('새 파일' + (++untitled > 1 ? ' ' + untitled : ''));
    return `<div class="dtab${isCur ? ' active' : ''}" data-doc="${i}" title="${escapeHtml(nm)}">
      <span class="dname">${escapeHtml(nm)}</span><span class="dclose" data-close="${i}" title="탭 닫기">×</span></div>`;
  }).join('') + `<button class="dtabNew" id="dtabNew" title="새 탭">+</button>`;
  bar.querySelectorAll('.dtab').forEach(el => el.addEventListener('click', (ev) => {
    if (ev.target.dataset.close !== undefined) return;
    switchDoc(+el.dataset.doc);
  }));
  bar.querySelectorAll('.dclose').forEach(el => el.addEventListener('click', (ev) => {
    ev.stopPropagation(); closeDocTab(+el.dataset.close);
  }));
  document.getElementById('dtabNew').addEventListener('click', newDocTab);
}

function newDrawing() {
  state.entities = [];
  state.levels = [{ name: '1F', elev: 0 }]; state.curLv = 0; state.ghostLv = true;
  if (typeof renderLevels === 'function') try { renderLevels(); } catch (e) {}
  state.layers = [
    { name: '0', color: '#ffffff', visible: true },
    { name: '치수', color: '#5dff8f', visible: true },
    { name: '보조선', color: '#5d9dff', visible: true },
  ];
  state.currentLayer = '0';
  state.selection.clear();
  state.nextId = 1;
  state.blocks = {}; insertName = null;
  undoStack.length = 0; redoStack.length = 0;
  state.view = { x: 0, y: 0, scale: 4 };
  renderLayers(); renderProps(); updateStat(); refreshBlockList(); setTool('select'); draw();
  logLine('새 도면을 시작했습니다. 명령행에 명령을 입력하거나 도구를 선택하세요.', 'info');
}

// ============================================================
//  자동 저장 (브라우저 localStorage) — 새로고침·앱 종료에도 작업 보존
// ============================================================
const AUTOSAVE_KEY = 'webcad_autosave_v1';
function saveLocal() {
  try {
    if (!docs.length) docs = [{}];
    docs[curDoc] = captureDoc();
    const sane = docs.map(d => ({ entities: d.entities, layers: d.layers, currentLayer: d.currentLayer, nextId: d.nextId, blocks: d.blocks, view: d.view, views: d.views, fileName: d.fileName, fileLoc: d.fileLoc === 'pc' ? null : d.fileLoc })); // 핸들·undo 제외
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ v: 2, docs: sane, cur: curDoc, t: Date.now() }));
  } catch (e) { /* 용량 초과 등 무시 */ }
}
function loadLocal() {
  try { const s = localStorage.getItem(AUTOSAVE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function clearLocal() { try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {} }
function restoreLocal(d) {
  if (d && d.docs) { // v2: 다중 문서
    docs = d.docs.map(x => ({ ...x }));
    curDoc = Math.min(d.cur || 0, docs.length - 1);
    applyDoc(docs[curDoc]); setTool('select'); renderDocTabs();
    return;
  }
  state.entities = d.entities || [];
  state.layers = (d.layers && d.layers.length) ? d.layers : [{ name: '0', color: '#ffffff', visible: true }];
  if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
  state.currentLayer = d.currentLayer && getLayer(d.currentLayer) ? d.currentLayer : '0';
  state.nextId = d.nextId || (state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  state.blocks = d.blocks || {}; insertName = null;
  if (d.view) state.view = d.view;
  setFileName(d.fileName || null, d.fileLoc === 'pc' ? null : (d.fileLoc || null)); // 핸들은 복원 불가 → 'pc' 표시는 내림
  state.selection.clear();
  undoStack.length = 0; redoStack.length = 0;
  renderLayers(); renderProps(); updateStat(); refreshBlockList(); setTool('select'); draw();
  docs[curDoc] = captureDoc(); renderDocTabs();
}
// 변경 시 자동 저장(디바운스) + 백그라운드 전환/종료 시 즉시 저장
let _autosaveTimer = null;
function autosave() { clearTimeout(_autosaveTimer); _autosaveTimer = setTimeout(saveLocal, 800); }
window.addEventListener('beforeunload', saveLocal);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLocal(); });
setInterval(saveLocal, 10000);

new ResizeObserver(resize).observe(wrap);
// 모바일 키보드가 올라오면 화면 높이를 가시영역에 맞춰 → 명령창이 키보드에 가리지 않게
if (window.visualViewport) {
  const app = document.getElementById('app');
  const onVV = () => { app.style.height = window.visualViewport.height + 'px'; resize(); };
  window.visualViewport.addEventListener('resize', onVV);
  window.visualViewport.addEventListener('scroll', onVV);
}
newDrawing();
resize();
// 시작 시: 공유 링크(#d=) 우선 → 없으면 자동 저장 복원(다중 탭 포함)
(function () {
  if (location.hash.indexOf('#d=') === 0) { loadFromHash(); }
  else {
    const d = loadLocal();
    if (d && ((d.docs && d.docs.length) || (d.entities && d.entities.length))) {
      restoreLocal(d);
      logLine(`이전 작업을 복원했습니다${d.docs ? ` (탭 ${d.docs.length}개)` : ''}. 새로 시작하려면 "새로 만들기".`, 'info');
    }
  }
  if (!docs.length) docs = [captureDoc()];
  renderDocTabs();
})();

// ============================================================
//  테스트 훅 — tests.html 에서 내부 순수 로직을 검증하기 위해 노출
// ============================================================
window.__CADTEST__ = {
  state,
  // 기하/스냅
  segSeg, segCircle, distToSeg, closestOnSeg, angleInArc, norm360, ang,
  intersectEntities, entityBBox, entityEndpoints, entityMidpoints, nearestOnEntity,
  entityFullyInBox, entityCrossesBox, pointInBoundary,
  // 변환
  T_translate, T_rotate, T_mirror, applyTransform, translateEntity, scaleEntities, stretchEntities,
  // 파서/직렬화
  parsePointOrNumber, buildDXFText, buildSVG, loadDXF, parseDXFPairs, parseDXFEntities,
  parseSTL, parseOBJ, loadMesh, csgOp, trisToPolys, polysToTris, cmdBoolean, runBoolean, boolFinish,
  get boolPending(){return boolPending;}, zTri, zRasterFaces,
  exportEntities, computeHatchSegs: (e) => hatchSegments(e),
  polyArea, polyPerimeter, polygonPoints,
  // 편집 연산(순수)
  trimLine, extendLine, doFillet, doChamfer, offsetEntity, insertChildren,
  // 유틸
  dxfColorIndex, aci2hex, rgbHex,
  // 링크 공유
  shareEncode, shareDecode, drawingPayload,
  // 편의기능(1~8)
  isLocked, reorderSel, selectSimilar, pointsAlongEntity,
  computeAngularDim, lineInfIntersect, zoomPrev, pushViewPrev,
  reset: () => { state.blocks = {}; state.views = {}; newDrawing(); },
  // BIM (단면/솔리드 수치 검증용)
  bimSolids, lineClipPoly, genSectionView, stairSolids, roofSolids, solidTopZ,
};

// ============================================================
//  공식 외부 API — 클라우드 모듈(cloud.js)이 사용
// ============================================================
window.WEBCAD_API = {
  // 현재 도면 스냅샷 (클라우드 저장용)
  getDoc: () => ({
    name: currentFileName,
    data: { v: 1, entities: state.entities, layers: state.layers, currentLayer: state.currentLayer,
            blocks: state.blocks, nextId: state.nextId, view: state.view, views: state.views,
            levels: state.levels, curLv: state.curLv },
  }),
  // 클라우드 도면 로드
  setDoc: (name, d) => {
    applyDoc({ entities: d.entities, layers: d.layers, currentLayer: d.currentLayer, nextId: d.nextId,
               blocks: d.blocks, view: d.view, views: d.views, levels: d.levels, curLv: d.curLv,
               fileName: name || null, fileLoc: 'cloud' });
    renderDocTabs(); draw();
  },
  getName: () => currentFileName,
  setName: (n) => { setFileName(n, 'cloud'); renderDocTabs(); },
  getRev: () => apiRev, // 변경 카운터 (dirty 판단)
  // 축소 썸네일 (JPEG dataURL)
  thumb: (px) => {
    try {
      const k = (px || 240) / Math.max(cv.width || 1, cv.height || 1);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(cv.width * k)); c.height = Math.max(1, Math.round(cv.height * k));
      c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    } catch (e) { return null; }
  },
  // 설정 동기화
  getSettings: () => JSON.parse(JSON.stringify(settings)),
  setOsnapMode: (k, on) => { if (settings.osnapModes && k in settings.osnapModes) { settings.osnapModes[k] = !!on; saveSettings(); } },
  applySettings: (s) => {
    if (!s) return;
    settings.units = s.units || settings.units;
    Object.assign(settings.osnapModes, s.osnapModes || {});
    if (s.polar !== undefined) settings.polar = s.polar;
    settings.aliases = s.aliases || settings.aliases;
    Object.assign(settings.dim, s.dim || {});
    Object.assign(settings.bim, s.bim || {});
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    draw();
  },
  zoomFit: () => zoomFit(true),
  redraw: () => draw(),
  // 블록 라이브러리
  getBlocks: () => state.blocks,
  addBlock: (name, def) => { state.blocks[name] = def; refreshBlockList(); logLine(`  ✔ 라이브러리에서 블록 "${name}" 가져옴 — 삽입(insert)으로 배치`, 'ok'); },
  log: (msg, kind) => logLine(msg, kind || 'info'),
  // ── 실시간 공동편집용 ──
  // 원격 변경 적용 (undo 스택에 넣지 않음 — 내 실행취소가 상대 작업을 되돌리지 않게)
  applyRemote: (ups, dels, blocks, layers) => {
    const byId = new Map(state.entities.map(e => [e.id, e]));
    for (const e of (ups || [])) {
      const ex = byId.get(e.id);
      if (ex) {
        for (const k of Object.keys(ex)) delete ex[k];
        Object.assign(ex, e);
        if (ex.type === 'HATCH') hatchDirty(ex);
      } else state.entities.push(e);
      if (e.id >= state.nextId) state.nextId = e.id + 1 + Math.floor(Math.random() * 50);
    }
    if (dels && dels.length) {
      const s = new Set(dels);
      state.entities = state.entities.filter(e => !s.has(e.id));
      for (const id of s) state.selection.delete(id);
    }
    if (blocks) { state.blocks = blocks; refreshBlockList(); }
    if (layers) { state.layers = layers; renderLayers(); }
    updateStat(); renderProps(); draw();
  },
  // 세션 참가 시 id 충돌 회피 (두 사용자가 같은 nextId로 동시에 생성하는 것 방지)
  jitterNextId: () => { state.nextId += 1000 + Math.floor(Math.random() * 9000); },
  // cloud.js가 설정하는 훅
  onUsage: null, onSettingsChange: null, onDocChange: null,
};

})();
