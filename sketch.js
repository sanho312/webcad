/* ============================================================
   WebCAD 스케치 엔진 — Phase 1 (프로젝트 철학의 첫 구현)
   핵심 입력 장치는 Apple Pencil. 손그림은 끝까지 손그림이다 —
   필압·속도·감성을 원본 그대로 보존한다(Sketch Layer).
   구현 원칙:
   · cad.js 무수정 — WEBCAD_AI_BRIDGE + #cv 위 오버레이 캔버스만 사용.
   · 스트로크는 월드 좌표(mm)로 저장 → CAD·줌·팬과 항상 정합.
     이 원본 점열(좌표+필압)이 Phase 2 전처리 엔진의 입력 데이터다.
   · AI 사용 0 — 전부 알고리즘.
   ============================================================ */
(() => {
'use strict';
const B = window.WEBCAD_AI_BRIDGE;
const cv = document.getElementById('cv');
const wrap = document.getElementById('canvasWrap');
if (!B || !cv || !wrap) { console.warn('[sketch] 초기화 실패 — 브리지/캔버스 없음'); return; }
const V = () => B.state.view;
const appDraw = () => { (B.draw || B.refresh)(); };

// ---------- 상태 ----------
const SK = {
  on: false,          // 스케치 모드(입력 잠금) — 꺼져 있어도 Sketch Layer 는 항상 보인다
  visible: true,
  tool: 'pen',        // pen | eraser
  color: '#e6e1d3',   // 연필 느낌의 기본 잉크
  sizePx: 4,          // 화면 기준 굵기(px) — 그리는 순간의 줌으로 월드 굵기 확정(종이에 잉크)
  strokes: [],        // {id, color, hw(월드 반폭 mm), pts:[[x(mm), y(mm), p(필압)], ...]}
  nextId: 1,
  undo: [], redo: [], // 스트로크 단위 (CAD undo 와 독립 — 드로잉 앱 방식)
  penSeen: false,     // 펜이 한 번이라도 감지되면 손가락은 내비게이션 전용(팜 리젝션)
  rev: 0,             // 내용 변경 카운터 (rAF 뷰 동기화용)
  docKey: '',
};
const wf = (p) => 0.25 + 1.5 * (p || 0.5);   // 필압 → 폭 배율 (p=0.5 에서 1.0)
const rnd1 = (n) => Math.round(n * 10) / 10; // 저장 절약: 0.1mm

// ---------- 오버레이 캔버스 (#cv 를 그대로 따라간다 — 4분할 평면 칸 포함) ----------
const skcv = document.createElement('canvas');
skcv.id = 'skcv';
skcv.style.cssText = 'position:absolute;left:0;top:0;z-index:21;pointer-events:none;'
  + 'touch-action:none;-webkit-user-select:none;user-select:none;';
wrap.appendChild(skcv);
const g = skcv.getContext('2d');
let ovRect = { x: 0, y: 0, w: 2, h: 2 };     // wrap 기준 CSS 위치/크기

function cvRect() {
  const wr = wrap.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  return { x: cr.left - wr.left, y: cr.top - wr.top, w: cr.width, h: cr.height };
}
// cad.js 의 worldToScreen/screenToWorld 와 같은 식 (cv._w/_h 는 cad 가 쓰는 CSS 크기)
function w2s(wx, wy) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  return [(wx - v.x) * v.scale + W / 2, -(wy - v.y) * v.scale + H / 2];
}
function s2w(sx, sy) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  return [(sx - W / 2) / v.scale + v.x, -(sy - H / 2) / v.scale + v.y];
}

// ---------- 렌더링 ----------
// 필압 가변폭: 인접 점 사이를 둥근 캡 선분으로 잇는다. 잉크색이 불투명이라 겹침 자국이 없다.
function drawStroke(ctx2, s) {
  const k = V().scale;
  const pts = s.pts;
  ctx2.strokeStyle = s.color; ctx2.fillStyle = s.color;
  ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
  if (pts.length === 1) {
    const [x, y] = w2s(pts[0][0], pts[0][1]);
    ctx2.beginPath(); ctx2.arc(x, y, Math.max(0.4, s.hw * wf(pts[0][2]) * k), 0, 6.2832); ctx2.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) drawSeg(ctx2, s, pts[i - 1], pts[i], k);
}
function drawSeg(ctx2, s, a, b, k) {
  const [ax, ay] = w2s(a[0], a[1]), [bx, by] = w2s(b[0], b[1]);
  ctx2.lineWidth = Math.max(0.5, s.hw * (wf(a[2]) + wf(b[2])) * k); // 반폭 × (배율a+배율b) = 평균 지름
  ctx2.beginPath(); ctx2.moveTo(ax, ay); ctx2.lineTo(bx, by); ctx2.stroke();
}
let eraseCursor = null; // {x, y} 오버레이 로컬 px — 지우개 원 표시
function redraw() {
  const r = ovRect;
  const dpr = window.devicePixelRatio || 1;
  const nw = Math.max(2, Math.round(r.w * dpr)), nh = Math.max(2, Math.round(r.h * dpr));
  if (skcv.width !== nw || skcv.height !== nh) { skcv.width = nw; skcv.height = nh; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.w, r.h);
  if (!SK.visible) return;
  g.strokeStyle = '#000'; // 초기화
  for (const s of SK.strokes) drawStroke(g, s);
  if (live) drawStroke(g, live);
  if (eraseCursor) {
    g.lineWidth = 1; g.strokeStyle = 'rgba(255,120,120,.9)';
    g.beginPath(); g.arc(eraseCursor.x, eraseCursor.y, eraseRadiusPx(), 0, 6.2832); g.stroke();
  }
}
const eraseRadiusPx = () => Math.max(12, SK.sizePx * 2.5);

// ---------- 뷰 동기화 (rAF) — cad.js 를 건드리지 않고 팬/줌/4분할/문서 전환을 따라간다 ----------
let lastSig = '';
function syncNow() {
  const r = cvRect();
  const hidden = cv.style.display === 'none';
  ovRect = r;
  skcv.style.left = r.x + 'px'; skcv.style.top = r.y + 'px';
  skcv.style.width = r.w + 'px'; skcv.style.height = r.h + 'px';
  skcv.style.display = hidden ? 'none' : '';
  redraw();
}
function tick() {
  const v = V();
  const r = cvRect();
  const hidden = cv.style.display === 'none';
  const dk = 'webcad_sketch::' + ((B.getDocName && B.getDocName()) || '무제');
  if (dk !== SK.docKey) { SK.docKey = dk; loadNow(); }
  const sig = [v.x, v.y, v.scale, r.x, r.y, r.w, r.h, hidden, SK.visible, SK.rev,
    window.devicePixelRatio || 1].join('|');
  if (sig !== lastSig) { lastSig = sig; syncNow(); }
  requestAnimationFrame(tick);
}

// ---------- 변경/실행취소 ----------
function pushOp(op) { SK.undo.push(op); if (SK.undo.length > 100) SK.undo.shift(); SK.redo.length = 0; }
function changed() { SK.rev++; saveSoon(); }
function undoSk() {
  const op = SK.undo.pop(); if (!op) return;
  if (op.t === 'add') SK.strokes = SK.strokes.filter(s => s.id !== op.s.id);
  else if (op.t === 'del') SK.strokes.push(...op.ss);
  SK.redo.push(op); SK.rev++; saveSoon();
}
function redoSk() {
  const op = SK.redo.pop(); if (!op) return;
  if (op.t === 'add') SK.strokes.push(op.s);
  else if (op.t === 'del') { const ids = new Set(op.ss.map(s => s.id)); SK.strokes = SK.strokes.filter(s => !ids.has(s.id)); }
  SK.undo.push(op); SK.rev++; saveSoon();
}

// ---------- 영속 (문서 이름별 localStorage — Phase 1 범위) ----------
let saveTimer = null, quotaWarned = false;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 600); }
function saveNow() {
  try {
    const data = { v: 1, nextId: SK.nextId, strokes: SK.strokes.map(s => ({
      id: s.id, color: s.color, hw: Math.round(s.hw * 100) / 100,
      pts: s.pts.map(p => [rnd1(p[0]), rnd1(p[1]), Math.round(p[2] * 100) / 100]),
    })) };
    if (SK.strokes.length) localStorage.setItem(SK.docKey, JSON.stringify(data));
    else localStorage.removeItem(SK.docKey);
  } catch (e) {
    if (!quotaWarned) { quotaWarned = true; B.logLine && B.logLine('  스케치 저장 공간이 가득 찼습니다 — 일부 스트로크를 지워주세요.', 'warn'); }
  }
}
function loadNow() {
  cancelLive();
  SK.undo.length = 0; SK.redo.length = 0;
  try {
    const d = JSON.parse(localStorage.getItem(SK.docKey) || 'null');
    SK.strokes = (d && d.strokes) || [];
    SK.nextId = (d && d.nextId) || (Math.max(0, ...SK.strokes.map(s => s.id)) + 1);
  } catch (e) { SK.strokes = []; }
  SK.rev++;
}

// ---------- 입력 ----------
let live = null;            // 진행 중 스트로크
let livePid = null, livePtype = '';
let lastPt = null;          // 마지막 채택 점 (스크린 px, 씨닝용)
let erasing = null;         // 지우개 드래그 — 지운 스트로크 모음(undo 1건)
const touches = new Map();  // 활성 터치 → 팬/줌
let nav = null;             // {mode:'pan'|'pinch', ...}
let ovClient = { x: 0, y: 0 };  // 오버레이의 client 좌표 원점 캐시

const localXY = (e) => [e.clientX - ovClient.x, e.clientY - ovClient.y];
const pressureOf = (e) => (e.pressure > 0 && e.pressure <= 1) ? e.pressure : 0.5;

function startStroke(e) {
  const [sx, sy] = localXY(e);
  livePid = e.pointerId; livePtype = e.pointerType;
  try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
  if (SK.tool === 'eraser') { erasing = []; eraseCursor = { x: sx, y: sy }; eraseAt(sx, sy); return; }
  const [wx, wy] = s2w(sx, sy);
  live = { id: SK.nextId++, color: SK.color, hw: (SK.sizePx / 2) / V().scale,
    pts: [[wx, wy, pressureOf(e)]] };
  lastPt = { x: sx, y: sy, p: pressureOf(e) };
}
function extendStroke(e) {
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  const k = V().scale;
  for (const ev of evs) {
    const [sx, sy] = localXY(ev);
    const p = pressureOf(ev);
    // 씨닝: 0.35px 미만 이동이고 필압 변화도 작으면 버린다 (감성은 남고 용량만 준다)
    if (lastPt) {
      const d = Math.hypot(sx - lastPt.x, sy - lastPt.y);
      if (d < 0.35 && Math.abs(p - lastPt.p) < 0.06) continue;
    }
    const [wx, wy] = s2w(sx, sy);
    const prev = live.pts[live.pts.length - 1];
    live.pts.push([wx, wy, p]);
    drawSeg(g, live, prev, live.pts[live.pts.length - 1], k); // 라이브: 증분만 그린다(저지연)
    lastPt = { x: sx, y: sy, p };
  }
}
function finishStroke() {
  if (live && live.pts.length) {
    // 저장은 원본 그대로(반올림만) — 손그림 데이터가 전처리 엔진의 입력이 된다
    live.pts = live.pts.map(p => [rnd1(p[0]), rnd1(p[1]), Math.round(p[2] * 100) / 100]);
    SK.strokes.push(live);
    pushOp({ t: 'add', s: live });
    changed();
  }
  live = null; livePid = null; lastPt = null;
}
function cancelLive() { live = null; livePid = null; lastPt = null; erasing = null; eraseCursor = null; }

function eraseAt(sx, sy) {
  const rW = eraseRadiusPx() / V().scale; // 월드 반경
  const [wx, wy] = s2w(sx, sy);
  const hit = [];
  for (const s of SK.strokes) {
    const rr = rW + s.hw * 2;
    if (s.pts.some(p => Math.hypot(p[0] - wx, p[1] - wy) <= rr)) hit.push(s);
  }
  if (hit.length) {
    const ids = new Set(hit.map(s => s.id));
    SK.strokes = SK.strokes.filter(s => !ids.has(s.id));
    erasing.push(...hit);
    SK.rev++;
  }
}

// 팬/줌 — 두 손가락(펜 사용자) 또는 마우스 우/휠 버튼. 뷰는 cad 의 state.view 를 직접 움직인다.
function navStart() {
  const r = skcv.getBoundingClientRect(); ovClient = { x: r.left, y: r.top };
  const ts = [...touches.values()];
  const v = V();
  if (ts.length >= 2) nav = { mode: 'pinch', a0: { ...ts[0] }, b0: { ...ts[1] }, v0: { x: v.x, y: v.y, scale: v.scale } };
  else if (ts.length === 1) nav = { mode: 'pan', p0: { ...ts[0] }, v0: { x: v.x, y: v.y, scale: v.scale } };
  else nav = null;
}
function navMove() {
  if (!nav) return;
  const v = V(), ts = [...touches.values()];
  if (nav.mode === 'pan' && ts.length >= 1) {
    v.x = nav.v0.x - (ts[0].x - nav.p0.x) / nav.v0.scale;
    v.y = nav.v0.y + (ts[0].y - nav.p0.y) / nav.v0.scale;
  } else if (nav.mode === 'pinch' && ts.length >= 2) {
    const d0 = Math.hypot(nav.b0.x - nav.a0.x, nav.b0.y - nav.a0.y) || 1;
    const d1 = Math.hypot(ts[1].x - ts[0].x, ts[1].y - ts[0].y) || 1;
    const f = Math.min(20, Math.max(0.05, d1 / d0));
    const W = cv._w || ovRect.w, H = cv._h || ovRect.h;
    const m0 = { x: (nav.a0.x + nav.b0.x) / 2 - ovClient.x, y: (nav.a0.y + nav.b0.y) / 2 - ovClient.y };
    const m1 = { x: (ts[0].x + ts[1].x) / 2 - ovClient.x, y: (ts[0].y + ts[1].y) / 2 - ovClient.y };
    // 시작 중점 아래 월드점이 현재 중점을 따라오도록
    const wmx = (m0.x - W / 2) / nav.v0.scale + nav.v0.x;
    const wmy = -(m0.y - H / 2) / nav.v0.scale + nav.v0.y;
    v.scale = Math.min(1e4, Math.max(1e-7, nav.v0.scale * f));
    v.x = wmx - (m1.x - W / 2) / v.scale;
    v.y = wmy + (m1.y - H / 2) / v.scale;
  }
  appDraw();
}
let mousePan = null;
function zoomAt(sx, sy, f) {
  const v = V(), W = cv._w || ovRect.w, H = cv._h || ovRect.h;
  const [wx, wy] = s2w(sx, sy);
  v.scale = Math.min(1e4, Math.max(1e-7, v.scale * f));
  v.x = wx - (sx - W / 2) / v.scale;
  v.y = wy + (sy - H / 2) / v.scale;
  appDraw();
}

skcv.addEventListener('pointerdown', (e) => {
  if (!SK.on) return;
  e.preventDefault();
  const r = skcv.getBoundingClientRect(); ovClient = { x: r.left, y: r.top };
  if (e.pointerType === 'pen') SK.penSeen = true;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
    if (live && livePtype === 'touch' && touches.size >= 2) { cancelLive(); redraw(); } // 손가락 그리기 → 두 번째 손가락 = 팬줌 전환
    if (live) return;                       // 펜으로 그리는 중의 터치(손바닥) 전면 무시
    if (touches.size >= 2) { navStart(); return; }
    if (SK.penSeen) return;                 // 팜 리젝션: 펜 사용자는 한 손가락 무시
    startStroke(e); return;                 // 펜 없는 기기(폰 등)는 손가락 그리기
  }
  if (e.button === 2 || e.button === 1) {   // 마우스 우/휠 버튼 = 팬
    mousePan = { cx: e.clientX, cy: e.clientY, v0: { x: V().x, y: V().y }, s: V().scale };
    try { skcv.setPointerCapture(e.pointerId); } catch (err) {}
    return;
  }
  startStroke(e);
});
skcv.addEventListener('pointermove', (e) => {
  if (!SK.on) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (nav) { navMove(); return; }
  }
  if (mousePan && (e.buttons & 6)) {
    const v = V();
    v.x = mousePan.v0.x - (e.clientX - mousePan.cx) / mousePan.s;
    v.y = mousePan.v0.y + (e.clientY - mousePan.cy) / mousePan.s;
    appDraw(); return;
  }
  if (e.pointerId !== livePid) return;
  e.preventDefault();
  if (erasing) { const [sx, sy] = localXY(e); eraseCursor = { x: sx, y: sy }; eraseAt(sx, sy); redraw(); return; }
  if (live) extendStroke(e);
});
function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (nav) { if (touches.size) navStart(); else nav = null; }
  }
  if (mousePan && e.pointerType === 'mouse') mousePan = null;
  if (e.pointerId !== livePid) return;
  if (erasing) {
    if (erasing.length) { pushOp({ t: 'del', ss: erasing }); changed(); }
    erasing = null; eraseCursor = null; livePid = null; redraw(); return;
  }
  finishStroke();
}
skcv.addEventListener('pointerup', pointerEnd);
skcv.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (nav) { if (touches.size) navStart(); else nav = null; } }
  if (e.pointerId === livePid) { cancelLive(); redraw(); }
});
skcv.addEventListener('wheel', (e) => {
  if (!SK.on) return;
  e.preventDefault();
  const r = skcv.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0012));
}, { passive: false });
skcv.addEventListener('contextmenu', (e) => { if (SK.on) e.preventDefault(); });

// ---------- 키보드 (스케치 모드에서만; 캡처로 앱 단축키보다 먼저) ----------
window.addEventListener('keydown', (e) => {
  if (!SK.on) return;
  const t = e.target;
  if (t && (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || (t.closest && t.closest('#aiPanel')))) return; // 입력창·AI 채팅은 그대로
  const k = (typeof e.key === 'string' ? e.key : '').toLowerCase();
  if (e.ctrlKey && k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); undoSk(); return; }
  if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); e.stopPropagation(); redoSk(); return; }
  if (e.key === 'Escape') { e.stopPropagation(); exit(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (k === 'b') { e.stopPropagation(); setTool('pen'); return; }
    if (k === 'e') { e.stopPropagation(); setTool('eraser'); return; }
  }
  e.stopPropagation(); // 스케치 모드에선 나머지 앱 단축키(글자→명령창 점프 등)를 잠근다
}, true);

// ---------- 모드 전환 ----------
function enter() {
  if (SK.on) return;
  if (B.is3D && B.is3D()) { const b = document.getElementById('vwPlan'); if (b) b.click(); } // 스케치는 평면 위에서
  SK.on = true;
  skcv.style.pointerEvents = 'auto';
  skcv.style.cursor = 'crosshair';
  bar.style.display = 'flex';
  entryBtn.style.background = 'var(--accent)'; entryBtn.style.color = '#fff';
  B.logLine && B.logLine('  ✏️ 스케치 모드 — 펜: 그리기 · 두 손가락: 이동/확대 · Esc: 완료', 'info');
}
function exit() {
  if (!SK.on) return;
  SK.on = false;
  cancelLive();
  skcv.style.pointerEvents = 'none';
  bar.style.display = 'none';
  entryBtn.style.background = ''; entryBtn.style.color = '';
  redraw();
}
function setTool(tool) {
  SK.tool = tool;
  eraseCursor = null;
  for (const [t, btn] of Object.entries(toolBtns)) {
    btn.style.background = t === tool ? 'var(--accent,#0A84FF)' : 'transparent';
    btn.style.color = t === tool ? '#fff' : 'var(--ink,#cfe0ff)';
  }
  skcv.style.cursor = 'crosshair';
}

// ---------- UI — 드로잉 앱 문법 (Procreate 참고: 큰 터치 타깃, 최소 크롬) ----------
const SWATCHES = ['#e6e1d3', '#ffffff', '#16161a', '#e04f4f', '#3a7bd5', '#3aa66a', '#e0a33a', '#9c6bd5'];
const bar = document.createElement('div');
bar.id = 'skBar';
bar.style.cssText = 'position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:30;'
  + 'display:none;align-items:center;gap:6px;padding:7px 10px;border-radius:14px;'
  + 'background:rgba(17,24,44,.92);border:1px solid rgba(120,140,200,.35);'
  + 'box-shadow:0 8px 26px rgba(0,0,0,.45);font:13px -apple-system,system-ui,sans-serif;color:#dbe6ff;'
  + 'touch-action:manipulation;user-select:none;-webkit-user-select:none;';
function mkBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.textContent = label; b.title = title;
  b.style.cssText = 'min-width:40px;height:38px;border:none;border-radius:10px;background:transparent;'
    + 'color:var(--ink,#cfe0ff);font-size:16px;cursor:pointer;padding:0 8px;';
  b.addEventListener('click', onClick);
  return b;
}
const grip = document.createElement('span');
grip.textContent = '⠿'; grip.title = '툴바 이동';
grip.style.cssText = 'font-size:15px;color:#6d7ea8;padding:0 2px;';
bar.appendChild(grip);
const toolBtns = {};
toolBtns.pen = mkBtn('✏️', '펜 (B)', () => setTool('pen'));
toolBtns.eraser = mkBtn('⌫', '지우개 — 스트로크 단위 (E)', () => setTool('eraser'));
bar.appendChild(toolBtns.pen); bar.appendChild(toolBtns.eraser);
// 색
const swBox = document.createElement('span');
swBox.style.cssText = 'display:flex;gap:4px;align-items:center;padding:0 4px;';
const swEls = [];
for (const c of SWATCHES) {
  const s = document.createElement('span');
  s.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;`
    + 'border:2px solid transparent;box-sizing:border-box;';
  s.title = c;
  s.addEventListener('click', () => { SK.color = c; setTool('pen'); markColor(); });
  swBox.appendChild(s); swEls.push([c, s]);
}
const customC = document.createElement('input');
customC.type = 'color'; customC.value = '#e6e1d3'; customC.title = '다른 색';
customC.style.cssText = 'width:26px;height:26px;border:none;background:none;cursor:pointer;padding:0;';
customC.addEventListener('input', () => { SK.color = customC.value; setTool('pen'); markColor(); });
swBox.appendChild(customC);
bar.appendChild(swBox);
function markColor() {
  for (const [c, el] of swEls) el.style.borderColor = (c.toLowerCase() === SK.color.toLowerCase()) ? '#fff' : 'transparent';
}
// 굵기
const sizeWrapEl = document.createElement('span');
sizeWrapEl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:0 4px;';
const sizeDot = document.createElement('span');
sizeDot.style.cssText = 'width:24px;height:24px;display:flex;align-items:center;justify-content:center;';
const sizeDotIn = document.createElement('span');
sizeDotIn.style.cssText = 'border-radius:50%;background:#dbe6ff;width:8px;height:8px;';
sizeDot.appendChild(sizeDotIn);
const sizeIn = document.createElement('input');
sizeIn.type = 'range'; sizeIn.min = '1'; sizeIn.max = '24'; sizeIn.step = '0.5'; sizeIn.value = String(SK.sizePx);
sizeIn.title = '굵기';
sizeIn.style.cssText = 'width:90px;accent-color:#5ad1ff;';
sizeIn.addEventListener('input', () => {
  SK.sizePx = +sizeIn.value;
  const d = Math.max(3, Math.min(22, SK.sizePx));
  sizeDotIn.style.width = d + 'px'; sizeDotIn.style.height = d + 'px';
});
sizeWrapEl.appendChild(sizeIn); sizeWrapEl.appendChild(sizeDot);
bar.appendChild(sizeWrapEl);
// 실행취소/재실행/표시/전체지우기/완료
bar.appendChild(mkBtn('↶', '스케치 실행 취소 (Ctrl+Z)', undoSk));
bar.appendChild(mkBtn('↷', '다시 실행 (Ctrl+Y)', redoSk));
const eyeBtn = mkBtn('👁', 'Sketch Layer 표시/숨김 (CAD 와 항상 공존)', () => {
  SK.visible = !SK.visible; eyeBtn.style.opacity = SK.visible ? '1' : '.35';
});
bar.appendChild(eyeBtn);
bar.appendChild(mkBtn('🧹', '이 도면의 스케치 전체 지우기', () => {
  if (!SK.strokes.length) return;
  if (!confirm('이 도면의 손그림 스케치를 전부 지울까요? (Ctrl+Z 로 되돌릴 수 있습니다)')) return;
  pushOp({ t: 'del', ss: SK.strokes.slice() });
  SK.strokes = []; changed();
}));
const doneBtn = mkBtn('완료', '스케치 모드 종료 (Esc) — 스케치는 화면에 남습니다', exit);
doneBtn.style.fontSize = '13px'; doneBtn.style.fontWeight = '700';
bar.appendChild(doneBtn);
wrap.appendChild(bar);
if (window.webcadPopupDrag) window.webcadPopupDrag(bar, grip);
setTool('pen'); markColor();

// 상단바 진입 버튼
const entryBtn = document.createElement('button');
entryBtn.className = 'tbtn'; entryBtn.id = 'btnSketch';
entryBtn.textContent = '✏️ 스케치';
entryBtn.title = '스케치 모드 — Apple Pencil/펜으로 생각을 그린다 (손그림은 CAD 와 별도 레이어로 보존)';
entryBtn.addEventListener('click', () => { SK.on ? exit() : enter(); });
const themeBtn = document.getElementById('btnTheme');
if (themeBtn && themeBtn.parentNode) themeBtn.parentNode.insertBefore(entryBtn, themeBtn);
else document.getElementById('topbar') && document.getElementById('topbar').appendChild(entryBtn);

// ---------- 시작 ----------
SK.docKey = 'webcad_sketch::' + ((B.getDocName && B.getDocName()) || '무제');
loadNow();
requestAnimationFrame(tick);

// 외부/테스트 훅 — Phase 2 전처리 엔진이 이 데이터를 읽는다
window.WEBCAD_SKETCH = { SK, enter, exit, setTool, undoSk, redoSk, redraw, syncNow, saveNow, loadNow, w2s, s2w };
})();
