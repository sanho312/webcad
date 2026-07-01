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
let lastCommand = '';   // 직전에 실행한 명령(스페이스/Enter로 반복)
let lastInputWasTouch = false; // 터치 입력 중에는 명령행 자동 포커스(키보드 팝업) 억제
let osnapEnabled = true;   // 객체 스냅(OSNAP) 사용 여부
let activeSnap = null;     // 현재 스냅된 점 {x,y,type}

// ---------- 실행취소 스택 ----------
const undoStack = [], redoStack = [];
function snapshot() {
  return JSON.stringify({
    entities: state.entities, layers: state.layers,
    currentLayer: state.currentLayer, nextId: state.nextId,
  });
}
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; if (typeof autosave === 'function') autosave(); }
function restore(snap) {
  const d = JSON.parse(snap);
  state.entities = d.entities; state.layers = d.layers;
  state.currentLayer = d.currentLayer; state.nextId = d.nextId;
  state.selection.clear();
  renderLayers(); draw(); updateStat();
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
  if (activeSnap) return { x: activeSnap.x, y: activeSnap.y };
  let p = { x: raw.x, y: raw.y };
  if (state.ortho) { const b = orthoBase(); if (b) p = applyOrtho(p, b); }
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

  for (const e of state.entities) {
    const l = getLayer(e.layer);
    if (l && !l.visible) continue;
    drawEntity(e, state.selection.has(e.id));
  }

  // 작도 미리보기
  if (draft) drawEntity(draft, false, true);
  if (pts.length) drawDraftPolyline();
  if (previewEnts) for (const e of previewEnts) drawEntity({ layer: '0', ...e }, false, true);

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
    if (crossing) { ctx.strokeStyle = '#2ee6a6'; ctx.fillStyle = 'rgba(46,230,166,.12)'; ctx.setLineDash([5, 4]); }
    else { ctx.strokeStyle = '#4ea1ff'; ctx.fillStyle = 'rgba(78,161,255,.12)'; ctx.setLineDash([]); }
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
  } else { // nearest
    ctx.beginPath();
    ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
    ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
    ctx.stroke();
  }
  ctx.fillStyle = '#2ee6a6'; ctx.font = '11px "Segoe UI",sans-serif'; ctx.textBaseline = 'bottom';
  ctx.fillText(SNAP_KO[type], s.x + r + 3, s.y - r);
  ctx.restore();
}

function drawEntity(e, selected, preview) {
  ctx.save();
  ctx.lineWidth = selected ? 2 : 1.4;
  ctx.strokeStyle = selected ? '#4ea1ff' : entityColor(e);
  ctx.fillStyle = ctx.strokeStyle;
  if (preview) { ctx.globalAlpha = .8; ctx.setLineDash([5, 4]); }

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
      ctx.fillText(e.text, p.x, p.y);
      break;
    }
  }

  // 선택 시 그립 표시
  if (selected && !preview) {
    ctx.setLineDash([]); ctx.fillStyle = '#4ea1ff';
    for (const g of entityGrips(e)) {
      const s = worldToScreen(g.x, g.y);
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
  }
  ctx.restore();
}

function drawDraftPolyline() {
  ctx.save();
  ctx.strokeStyle = '#4ea1ff'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
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
function hitTest(w, tolWorld) {
  // 뒤에서부터(위에 그려진 것 우선)
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const e = state.entities[i];
    const l = getLayer(e.layer); if (l && !l.visible) continue;
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
  for (const e of state.entities) {
    const l = getLayer(e.layer); if (l && !l.visible) continue;
    if (skipSel && state.selection.has(e.id)) continue;
    for (const g of entityEndpoints(e)) consider(g.x, g.y, 'endpoint', 1);
    for (const m of entityMidpoints(e)) consider(m.x, m.y, 'midpoint', 2);
    if (e.type === 'CIRCLE' || e.type === 'ARC') consider(e.cx, e.cy, 'center', 3);
    // 수직점(perpendicular): 기준점에서 도형으로 내린 수선의 발. 커서가 그 도형 위에 있을 때 제공
    if (base) {
      for (const sg of entitySegments(e)) {
        const np = closestOnSeg(raw.x, raw.y, sg[0], sg[1], sg[2], sg[3]);
        const sn = worldToScreen(np.x, np.y);
        const dCur = Math.hypot(sn.x - mouseScreen.x, sn.y - mouseScreen.y);
        if (dCur > tol) continue;
        const f = perpFoot(base.x, base.y, sg[0], sg[1], sg[2], sg[3]);
        if (f && f.t >= -1e-9 && f.t <= 1 + 1e-9 && dCur < perpD) { perpD = dCur; perp = { x: f.x, y: f.y }; }
      }
    }
    const np = nearestOnEntity(e, raw); if (np) consider(np.x, np.y, 'nearest', 5);
  }
  // 우선순위: 끝점·중점·중심 > 수직점 > 근처점
  if (best && best.prio <= 3) return best;
  if (perp) return { x: perp.x, y: perp.y, type: 'perp' };
  return best;
}
const SNAP_KO = { endpoint: '끝점', midpoint: '중점', center: '중심', perp: '수직', nearest: '근처' };

// ============================================================
//  이동
// ============================================================
function translateEntity(e, dx, dy) {
  switch (e.type) {
    case 'LINE': e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; break;
    case 'LWPOLYLINE': e.points = e.points.map(p => [p[0] + dx, p[1] + dy]); break;
    case 'CIRCLE': case 'ARC': e.cx += dx; e.cy += dy; break;
    case 'TEXT': e.x += dx; e.y += dy; break;
  }
}

// ---------- 변환(transform) 헬퍼 : copy / mirror / rotate / array 공통 ----------
function cloneEntity(e) { const c = JSON.parse(JSON.stringify(e)); delete c.id; return c; }
function ptOnArc(e, deg) { const a = deg * Math.PI / 180; return { x: e.cx + e.r * Math.cos(a), y: e.cy + e.r * Math.sin(a) }; }

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
  }
  return e;
}
function transformedClone(e, T) { return applyTransform(cloneEntity(e), T); }
function selectedEntities() { return [...state.selection].map(id => state.entities.find(x => x.id === id)).filter(Boolean); }

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
function trimLine(line, clickW) {
  const a = [line.x1, line.y1], b = [line.x2, line.y2];
  const cuts = [];
  for (const o of state.entities) {
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
function trimCircleArc(e, clickW) {
  const angs = [];
  for (const o of state.entities) {
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
  for (const e of ents) {
    switch (e.type) {
      case 'LINE': [e.x1, e.y1] = sp(e.x1, e.y1); [e.x2, e.y2] = sp(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points = e.points.map(p => sp(p[0], p[1])); break;
      case 'CIRCLE': case 'ARC': [e.cx, e.cy] = sp(e.cx, e.cy); e.r *= f; break;
      case 'TEXT': [e.x, e.y] = sp(e.x, e.y); e.height *= f; break;
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
    }
  }
}
function entitiesTouchingBox(box) {
  const inB = (x, y) => x >= box.xmin && x <= box.xmax && y >= box.ymin && y <= box.ymax;
  return state.entities.filter(e => {
    const l = getLayer(e.layer); if (l && !l.visible) return false;
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
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');

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
  if (cmdOp) updateCmdPreview();
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
  if (pts.length) { finishPolyline(); }
  else if (draft) { cancelDraft(); }
  else { setTool('select'); }
}
cv.addEventListener('contextmenu', (ev) => { ev.preventDefault(); contextAction(); });

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
  coordsEl.textContent = `X: ${mouseWorld.x.toFixed(2)}  Y: ${mouseWorld.y.toFixed(2)}` + (activeSnap ? `   [${SNAP_KO[activeSnap.type]}]` : '');
  if (moveOp) { moveOp.dx = mouseWorld.x - moveOp.base.x; moveOp.dy = mouseWorld.y - moveOp.base.y; if (moveOp.grip) updateGripMove(); }
  if (draft) updateDraft();
  if (cmdOp) updateCmdPreview();
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
  switch (state.tool) {
    case 'select': {
      const tol = 8 / state.view.scale;
      const hit = pick(w, rawW);
      if (hit) {
        // 그립(끝점 등) 클릭 → 그 점만 늘리기. 본체 클릭은 선택만(통째 이동 안 함)
        const grip = nearGrip(hit, rawW, tol) || nearGrip(hit, w, tol);
        if (!ev.shiftKey && !state.selection.has(hit.id)) { state.selection.clear(); }
        state.selection.add(hit.id);
        if (grip) { pushUndo(); moveOp = { gripEntity: hit, gripIndex: grip.index, base: w, dx: 0, dy: 0, grip: true }; }
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
  const hit = pick(w, rawW);
  if (!hit) return;
  if (hit.type === 'LINE') { pushUndo(); if (trimLine(hit, rawW)) { logLine('  ✔ 선 자름', 'ok'); updateStat(); } }
  else if (hit.type === 'CIRCLE' || hit.type === 'ARC') { pushUndo(); if (trimCircleArc(hit, rawW)) { logLine('  ✔ 원/호 자름', 'ok'); } }
  else logLine('  자르기는 선/원/호만 지원합니다.', 'warn');
  state.selection.clear(); renderProps();
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

function nearGrip(e, w, tol) {
  const grips = entityGrips(e);
  for (let i = 0; i < grips.length; i++)
    if (Math.hypot(grips[i].x - w.x, grips[i].y - w.y) <= tol) return { index: i, p: grips[i] };
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
  delete draft._base;
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
      const l = getLayer(e.layer); if (l && !l.visible) continue;
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
};

function runCommandInput(raw) {
  const v = raw.trim().toLowerCase();
  if (!v) return; // 빈 Enter
  logLine('명령: ' + v, 'cmd');
  // 진행 중 작도 도구의 좌표/치수 입력을 우선 처리
  if (feedDrawInput(v)) return;
  // 숫자 입력 → 진행 중 명령의 수치 인자
  const num = parseFloat(v);
  if (!isNaN(num) && /^-?[\d.]+$/.test(v)) {
    if (state.tool === 'offset') { offsetDist = Math.abs(num) || offsetDist; setPrompt(`오프셋: 도형을 선택하세요. (거리 ${offsetDist})`); logLine(`  오프셋 거리 = ${offsetDist}`, 'info'); return; }
    if (state.tool === 'rotate' && cmdOp && cmdOp.step === 'angle') { logLine(`  회전 각도 = ${num}°`, 'info'); applyRotate(num); return; }
    if (state.tool === 'fillet') { filletRadius = Math.abs(num); setPrompt(`모깎기: 반지름 ${filletRadius}. 첫 번째 선을 클릭하세요.`); logLine(`  모깎기 반지름 = ${filletRadius}`, 'info'); return; }
    if (state.tool === 'scale' && cmdOp && (cmdOp.step === 'ref' || cmdOp.step === 'factor')) { applyScale(num); return; }
    logLine('  (입력한 숫자를 받을 명령이 없습니다)', 'warn'); return;
  }
  const tool = CMD_ALIASES[v];
  if (tool) { setTool(tool); if (tool !== 'select') lastCommand = tool; }
  else logLine(`  알 수 없는 명령: ${v}`, 'warn');
}

// 직전 명령 반복(스페이스/Enter)
function repeatLastCommand() {
  if (!lastCommand) { logLine('  반복할 명령이 없습니다.', 'warn'); return; }
  logLine(`명령: ${lastCommand}  (반복)`, 'cmd');
  setTool(lastCommand);
}
// 빈 칸에서 Enter/스페이스: 폴리라인 작도 중이면 종료, 아니면 직전 명령 반복
function emptyEnterAction() {
  if (state.tool === 'pline') {
    if (pts.length >= 2) { finishPolyline(); return; }
    pts = []; draw(); return;
  }
  if (draft) { cancelDraft(); return; }
  repeatLastCommand();
}

// ---------- 좌표/치수 입력 파서 ----------
// "x,y" → 절대점 | "@dx,dy" → 상대점 | "12" → 단일 수치
function parsePointOrNumber(v) {
  v = v.trim();
  let m = v.match(/^@\s*(-?[\d.]+)\s*[, ]\s*(-?[\d.]+)$/);
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
  cmdOp = null; previewEnts = null;
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
    trim: '자르기: 자를 선/원/호의 잘라낼 부분을 클릭하세요. (다른 도형이 경계, 반복)',
    extend: '연장: 늘릴 선의 끝쪽을 클릭하면 가장 가까운 경계까지 연장됩니다.',
    fillet: `모깎기: 반지름 ${filletRadius}. 첫 번째 선 → 두 번째 선을 클릭하세요. (숫자로 반지름 변경)`,
    scale: '배율: 도형을 선택하고 기준점 → 배율(숫자) 또는 참조 두 점을 지정하세요.',
    stretch: '신축: 걸침 영역의 두 모서리를 클릭하고, 기준점 → 이동점을 지정하세요.',
  };
  setPrompt(hints[t] || '');
  if (t !== 'select') {
    logLine('▶ ' + (TOOL_KO[t] || t), 'cmd');
    if (cmdInputEl && !lastInputWasTouch) cmdInputEl.focus({ preventScroll: true }); // 명령행 활성 유지(터치 제외)
  }
  draw();
}
function hint(t) { hintEl.textContent = t; hintEl.style.display = t ? 'block' : 'none'; }

document.querySelectorAll('.tool').forEach(el =>
  el.addEventListener('click', () => { setTool(el.dataset.tool); if (el.dataset.tool !== 'select') lastCommand = el.dataset.tool; }));

// 레이어 목록 렌더
function renderLayers() {
  const list = document.getElementById('layerList');
  list.innerHTML = '';
  for (const l of state.layers) {
    const div = document.createElement('div');
    div.className = 'layer' + (l.name === state.currentLayer ? ' active' : '');
    div.innerHTML =
      `<span class="sw" style="background:${l.color}"></span>
       <span class="nm">${escapeHtml(l.name)}</span>
       <span class="eye">${l.visible ? '👁' : '🚫'}</span>`;
    div.querySelector('.sw').addEventListener('click', (e) => {
      e.stopPropagation();
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = rgbHex(l.color);
      inp.addEventListener('input', () => { l.color = inp.value; renderLayers(); draw(); });
      inp.click();
    });
    div.querySelector('.eye').addEventListener('click', (e) => {
      e.stopPropagation(); l.visible = !l.visible; renderLayers(); draw();
    });
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
    body.innerHTML = `<div class="row"><label>선택</label><span>${sel.length}개 도형</span></div>
      <button class="miniBtn" id="pDel">선택 삭제</button>`;
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
  };
  if (geomRows[e.type]) for (const [k, lab] of geomRows[e.type])
    rows += `<div class="row"><label>${lab}</label><input type="number" step="any" data-k="${k}" value="${e[k]}"></div>`;
  if (e.type === 'TEXT')
    rows += `<div class="row"><label>내용</label><input type="text" data-k="text" value="${escapeHtml(e.text)}"></div>`;
  rows += `<div class="row"><label>색상</label><input type="color" id="pColor" value="${rgbHex(entityColor(e))}">
    <button class="miniBtn" id="pColClear">레이어색</button></div>`;
  rows += `<button class="miniBtn" id="pDel" style="margin-top:6px;">삭제</button>`;
  body.innerHTML = rows;

  body.querySelectorAll('input[data-k]').forEach(inp =>
    inp.addEventListener('change', () => {
      pushUndo();
      const k = inp.dataset.k;
      e[k] = (inp.type === 'number') ? parseFloat(inp.value) : inp.value;
      draw();
    }));
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

function typeKo(t) { return ({ LINE: '선', LWPOLYLINE: '폴리라인', CIRCLE: '원', ARC: '호', TEXT: '문자' })[t] || t; }
function updateStat() { statEl.textContent = `도형 ${state.entities.length}개 · 레이어 ${state.layers.length}개`; }

// ============================================================
//  뷰 조작
// ============================================================
// robust=true이면 극단 이상치(드물게 도면에서 멀리 떨어진 잔여 도형)를 제외하고 맞춤 — 불러오기 직후 사용
function zoomFit(robust) {
  if (!state.entities.length) { state.view = { x: 0, y: 0, scale: 4 }; draw(); return; }
  const xs = [], ys = [];
  const ext = (x, y) => { if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); } };
  for (const e of state.entities) {
    switch (e.type) {
      case 'LINE': ext(e.x1, e.y1); ext(e.x2, e.y2); break;
      case 'LWPOLYLINE': e.points.forEach(p => ext(p[0], p[1])); break;
      case 'CIRCLE': case 'ARC': ext(e.cx - e.r, e.cy - e.r); ext(e.cx + e.r, e.cy + e.r); break;
      case 'TEXT': ext(e.x, e.y); ext(e.x + e.text.length * e.height * .6, e.y + e.height); break;
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
  if (ev.ctrlKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return; }
  if (ev.ctrlKey && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveDXF(); return; }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); state.entities.forEach(e => state.selection.add(e.id)); renderProps(); draw(); return; }
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
  document.getElementById('miOpen').addEventListener('click', () => { close(); document.getElementById('fileInput').click(); });
  document.getElementById('miSave').addEventListener('click', () => { close(); saveDXF(); });
  document.getElementById('miSaveAs').addEventListener('click', () => { close(); openSaveAs(); });
})();
function doNew() {
  if (state.entities.length && !confirm('현재 도면을 지우고 새로 시작할까요?')) return;
  if (typeof clearLocal === 'function') clearLocal();
  newDrawing();
}
document.getElementById('fileInput').addEventListener('change', (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => { loadDXF(reader.result); ev.target.value = ''; };
  reader.readAsText(f);
});
// 다른 이름으로 저장 대화상자
function openSaveAs() { document.getElementById('saveAsDlg').style.display = 'flex'; }
function closeSaveAs() { document.getElementById('saveAsDlg').style.display = 'none'; }
(function () {
  const dlg = document.getElementById('saveAsDlg');
  document.getElementById('saveAsCancel').addEventListener('click', closeSaveAs);
  document.getElementById('saveAsOk').addEventListener('click', () => {
    const fmt = dlg.querySelector('input[name=saveFmt]:checked').value;
    const name = (document.getElementById('saveName').value || 'drawing').replace(/\.[^.]+$/, '');
    closeSaveAs();
    if (fmt === 'dxf') saveBlob(new Blob([buildDXFText()], { type: 'application/dxf' }), name + '.dxf');
    else if (fmt === 'svg') saveBlob(new Blob([buildSVG()], { type: 'image/svg+xml' }), name + '.svg');
    else if (fmt === 'pdf') saveBlob(new Blob([buildPDF()], { type: 'application/pdf' }), name + '.pdf');
    else if (fmt === 'png') savePNG(name + '.png');
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSaveAs(); });
})();
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
document.getElementById('btnGrid').addEventListener('click', (e) => { state.grid.show = !state.grid.show; e.currentTarget.classList.toggle('active', state.grid.show); draw(); });
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
    '<div style="background:#2a2a30;border:1px solid #3d3d46;border-radius:12px;max-width:360px;padding:20px 22px;color:#e6e6ea;box-shadow:0 12px 40px #000a;">' +
    '<h2 style="margin:0 0 10px;font-size:17px;">전체화면으로 쓰는 법</h2>' +
    '<p style="margin:0 0 12px;font-size:13px;color:#9a9aa5;line-height:1.6;">이 브라우저 탭은 전체화면 API를 지원하지 않습니다. 아래처럼 <b style="color:#e6e6ea;">홈 화면에 앱으로 추가</b>하면 주소창·툴바 없이 전체화면으로 실행됩니다.</p>' +
    '<ol style="margin:0 0 4px;padding-left:20px;font-size:13px;line-height:1.9;">' +
    (isiOS
      ? '<li>Safari 하단(또는 상단)의 <b>공유 버튼 <span style="display:inline-block;border:1px solid #6a6a75;border-radius:4px;padding:0 5px;">⬆️</span></b> 탭</li><li>목록에서 <b>"홈 화면에 추가"</b> 선택</li><li>오른쪽 위 <b>"추가"</b> 탭</li><li>홈 화면의 <b>WebCAD 아이콘</b>으로 실행 → 전체화면</li>'
      : '<li>브라우저 메뉴(⋮) 열기</li><li><b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b> 선택</li><li>추가된 아이콘으로 실행 → 전체화면</li>') +
    '</ol>' +
    '<div style="text-align:right;margin-top:16px;"><button id="homeHelpClose" style="background:#2b6fc0;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer;">확인</button></div>' +
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
if (cmdInputEl) {
  cmdInputEl.addEventListener('input', () => renderSuggest(cmdInputEl.value));
  cmdInputEl.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  cmdInputEl.addEventListener('keydown', (ev) => {
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
  g(9, '$INSUNITS'); g(70, 4); // mm
  g(9, '$HANDSEED'); g(5, 'FFFF');
  g(0, 'ENDSEC');

  // TABLES (레이어)
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(5, H()); g(100, 'AcDbSymbolTable'); g(70, state.layers.length);
  for (const l of state.layers) {
    g(0, 'LAYER'); g(5, H()); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLayerTableRecord');
    g(2, l.name); g(70, l.visible ? 0 : 1);
    g(62, (l.visible ? 1 : -1) * dxfColorIndex(l.color)); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // ENTITIES
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of state.entities) writeEntity(g, e, H);
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
async function saveDXF() { await saveBlob(new Blob([buildDXFText()], { type: 'application/dxf' }), 'drawing.dxf'); }

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
  for (const e of state.entities) {
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
  for (const e of state.entities) {
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
function buildPDF() {
  const b = drawingBBox();
  const margin = 28; // pt
  const maxDim = 760; // A 영역 한 변 최대 pt
  const sc = Math.min(maxDim / b.w, maxDim / b.h);
  const PW = (b.w * sc + 2 * margin), PH = (b.h * sc + 2 * margin);
  const X = x => (margin + (x - b.minX) * sc);
  const Y = y => (margin + (y - b.minY) * sc); // PDF는 Y가 위로 → 그대로
  const num = n => (Math.round(n * 1000) / 1000).toFixed(3);
  const K = 0.5522847498; // 원 베지어 상수
  const ops = [];
  ops.push((Math.max(b.w, b.h) * sc / 600).toFixed(2) + ' w');
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
  for (const e of state.entities) {
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
  const head = (type, sub) => { g(0, type); g(5, H()); g(100, 'AcDbEntity'); g(8, e.layer); if (e.color) g(62, dxfColorIndex(e.color)); g(100, sub); };
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
    state.nextId = state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    state.selection.clear();
    renderLayers(); updateStat(); zoomFit(true);
    hint(`DXF 불러오기 완료: 도형 ${state.entities.length}개`);
  } catch (err) {
    alert('DXF 파일을 읽는 중 오류가 발생했습니다:\n' + err.message);
    console.error(err);
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

  function num(d, code, def = 0) { const v = d[code]; return v === undefined ? def : parseFloat(Array.isArray(v) ? v[0] : v); }
  function baseOf(d) {
    const layer = (d[8] !== undefined ? (Array.isArray(d[8]) ? d[8][0] : d[8]) : '0').trim();
    const base = { layer };
    if (d[62] !== undefined) {
      const n = parseInt(Array.isArray(d[62]) ? d[62][0] : d[62], 10);
      if (n !== 256 && n !== 0) base.color = aci2hex(n); // 256=ByLayer, 0=ByBlock → 기본색
    }
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
      case 'TEXT': case 'MTEXT': {
        let parts = [];
        if (d[3] !== undefined) parts.push(...(Array.isArray(d[3]) ? d[3] : [d[3]])); // MTEXT 연속 텍스트
        if (d[1] !== undefined) parts.push(...(Array.isArray(d[1]) ? d[1] : [d[1]]));
        let txt = parts.join('').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '');
        return { ...base, type: 'TEXT', x: num(d, 10), y: num(d, 20), height: num(d, 40, 10), text: txt, rotation: num(d, 50) };
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
      if (t === 'INSERT') { expandInsert(data, out); continue; }
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
  return { entities, layers };
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
};

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
  undoStack.length = 0; redoStack.length = 0;
  state.view = { x: 0, y: 0, scale: 4 };
  renderLayers(); renderProps(); updateStat(); setTool('select'); draw();
  logLine('새 도면을 시작했습니다. 명령행에 명령을 입력하거나 도구를 선택하세요.', 'info');
}

// ============================================================
//  자동 저장 (브라우저 localStorage) — 새로고침·앱 종료에도 작업 보존
// ============================================================
const AUTOSAVE_KEY = 'webcad_autosave_v1';
function saveLocal() {
  try {
    const data = { entities: state.entities, layers: state.layers, currentLayer: state.currentLayer, nextId: state.nextId, view: state.view, t: Date.now() };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data));
  } catch (e) { /* 용량 초과 등 무시 */ }
}
function loadLocal() {
  try { const s = localStorage.getItem(AUTOSAVE_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function clearLocal() { try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {} }
function restoreLocal(d) {
  state.entities = d.entities || [];
  state.layers = (d.layers && d.layers.length) ? d.layers : [{ name: '0', color: '#ffffff', visible: true }];
  if (!getLayer('0')) state.layers.unshift({ name: '0', color: '#ffffff', visible: true });
  state.currentLayer = d.currentLayer && getLayer(d.currentLayer) ? d.currentLayer : '0';
  state.nextId = d.nextId || (state.entities.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
  if (d.view) state.view = d.view;
  state.selection.clear();
  undoStack.length = 0; redoStack.length = 0;
  renderLayers(); renderProps(); updateStat(); setTool('select'); draw();
}
// 변경 시 자동 저장(디바운스) + 백그라운드 전환/종료 시 즉시 저장
let _autosaveTimer = null;
function autosave() { clearTimeout(_autosaveTimer); _autosaveTimer = setTimeout(saveLocal, 800); }
window.addEventListener('beforeunload', saveLocal);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLocal(); });
setInterval(saveLocal, 10000);

new ResizeObserver(resize).observe(wrap);
newDrawing();
resize();
// 시작 시 자동 저장된 작업이 있으면 복원
(function () {
  const d = loadLocal();
  if (d && d.entities && d.entities.length) {
    restoreLocal(d);
    logLine(`이전 작업을 복원했습니다 (도형 ${d.entities.length}개). 새로 시작하려면 "새로 만들기".`, 'info');
  }
})();

})();
