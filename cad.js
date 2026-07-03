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
  aliases: {},   // 사용자 단축키: { 입력값: 도구명 }
};
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) { settings.units = s.units || 'mm'; Object.assign(settings.osnapModes, s.osnapModes || {}); settings.polar = s.polar || 0; settings.aliases = s.aliases || {}; }
  } catch (e) {}
})();
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

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
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; if (typeof autosave === 'function') autosave(); }
function restore(snap) {
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
function entityColor(e) {
  if (e.color) return e.color;
  const l = getLayer(e.layer);
  return l ? l.color : '#ffffff';
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
  state.entities.push(e);
  return e;
}

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
    drawEntity(e, state.selection.has(e.id));
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
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
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
  let perp = null, perpD = Infinity;
  const preTol = tol / state.view.scale * 1.5; // bbox 프리체크(대형 도면 성능)
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
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
function fmtNum(n) { return (+n.toFixed(2)).toString(); }

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
  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
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
  const th = state.textHeight, ext = th * 0.4, gap = th * 0.25, s = Math.min(th * 0.6, L / 4);
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
  const txt = fmtNum(L);
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
  const th = state.textHeight, s = th * 0.5;
  const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
  ln(ex, ey, ex - ux * s + nx * s * 0.35, ey - uy * s + ny * s * 0.35);
  ln(ex, ey, ex - ux * s - nx * s * 0.35, ey - uy * s - ny * s * 0.35);
  const txt = (dia ? '⌀' : 'R') + fmtNum(dia ? e.r * 2 : e.r);
  addEntity({ type: 'TEXT', layer: '치수', x: w.x + th * 0.3, y: w.y - th * 0.3, height: th, text: txt, rotation: 0 });
  logLine(`  ✔ ${dia ? '지름' : '반지름'} 치수 ${txt}`, 'ok');
  cmdOp = { name, step: 'obj' }; updateStat();
  setPrompt('치수: 원/호를 클릭하세요. (연속 기입, Esc 종료)');
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
  const th = state.textHeight, dx = p2.x - p1.x, dy = p2.y - p1.y;
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
  const th = state.textHeight, s = Math.min(th * 0.6, r * sweep * Math.PI / 180 / 4);
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
  draft = null; pts = []; arcState = null; moveOp = null; dragSelect = null;
  cmdOp = null; previewEnts = null; trackPt = null; otrackAlign = null;
  document.querySelectorAll('.tool').forEach(el => el.classList.toggle('active', el.dataset.tool === t));
  cv.style.cursor = (t === 'select') ? 'default' : (t === 'pan') ? 'grab' : 'crosshair';
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
  if (e.type === 'TEXT')
    rows += `<div class="row"><label>내용</label><input type="text" data-k="text" value="${escapeHtml(e.text)}"></div>`;
  if (e.type === 'HATCH')
    rows += `<div class="row"><label>패턴</label><select id="pHatch">${Object.keys(HATCH_PATTERNS).map(k =>
      `<option value="${k}" ${e.pattern === k ? 'selected' : ''}>${HATCH_PATTERNS[k].ko}</option>`).join('')}</select></div>`;
  rows += `<div class="row"><label>색상</label><input type="color" id="pColor" value="${rgbHex(entityColor(e))}">
    <button class="miniBtn" id="pColClear">레이어색</button></div>`;
  rows += `<div style="display:flex;gap:6px;margin-top:6px;">
    <button class="miniBtn" id="pFront1">맨 앞</button><button class="miniBtn" id="pBack1">맨 뒤</button>
    <button class="miniBtn" id="pSim1">유사 선택</button></div>`;
  rows += `<button class="miniBtn" id="pDel" style="margin-top:6px;">삭제</button>`;
  body.innerHTML = rows;
  document.getElementById('pFront1').addEventListener('click', () => reorderSel(true));
  document.getElementById('pBack1').addEventListener('click', () => reorderSel(false));
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
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); state.entities.forEach(e => state.selection.add(e.id)); renderProps(); draw(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copySelection(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'v') { ev.preventDefault(); startPaste(); return; }
  switch (ev.key) {
    case 'Escape': setTool('select'); state.selection.clear(); renderProps(); draw(); break;
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
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', () => toggle(false));
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
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', () => toggle(false));
  menu.addEventListener('click', (e) => e.stopPropagation());
  const dlg = document.getElementById('optionsDlg');
  function openOptions(sec) {
    toggle(false);
    // 현재값 채우기
    document.getElementById('optUnits').value = settings.units;
    document.getElementById('optPolar').value = String(settings.polar || 0);
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
  document.getElementById('optCancel').addEventListener('click', () => dlg.style.display = 'none');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });
  document.getElementById('optSave').addEventListener('click', () => {
    settings.units = document.getElementById('optUnits').value;
    settings.polar = parseInt(document.getElementById('optPolar').value, 10) || 0;
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
  newDrawing();
}
document.getElementById('fileInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { if (loadDXF(reader.result)) { fileHandle = null; setFileName(f.name, null); } ev.target.value = ''; };
  reader.readAsText(f);
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
const COMMAND_LIST = [
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
        if (k === 'a') { ev.preventDefault(); ev.stopPropagation(); state.entities.forEach(e => state.selection.add(e.id)); renderProps(); draw(); return; }
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
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({ types: DXF_PICKER_TYPES });
      const f = await h.getFile(); const t = await f.text();
      if (loadDXF(t)) { fileHandle = h; setFileName(f.name, 'pc'); }
      return;
    } catch (err) { if (err && err.name === 'AbortError') return; }
  }
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
  logLine(`▷ 탭 전환: ${currentFileName || '새 파일'}`, 'info');
}
function newDocTab() {
  docs[curDoc] = captureDoc();
  docs.push({});
  curDoc = docs.length - 1;
  applyDoc({}); // 빈 도면
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
};

})();
