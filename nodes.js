// ============================================================
//  WebCAD 노드 에디터 (그래스호퍼형 파라메트릭) — 1단계
//  노드 캔버스 + 데이터플로 평가 + 라이브 프리뷰 + 베이크
//  프리뷰 개체는 _gh:true 태그 → cad.js liveEnts()가 저장·실행취소에서 제외.
// ============================================================
(function () {
  'use strict';
  const B = () => window.WEBCAD_AI_BRIDGE;
  const PREVIEW_COLOR = '#5ad1ff';
  const MAX_PREVIEW = 2000;

  // ---------- 값 유틸 (스칼라 또는 평면 리스트) ----------
  const num = v => Array.isArray(v) ? (Number(v[0]) || 0) : (Number(v) || 0);
  const asList = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
  const clean = v => Array.isArray(v) ? v.filter(x => x != null) : v;
  function zip(args, fn) { // 최장 리스트 매칭 (짧은 건 순환) — GH의 기본 데이터 매칭
    const lists = args.map(a => Array.isArray(a) ? a : null);
    if (lists.every(l => !l)) return fn.apply(null, args);
    let maxLen = 1; for (const l of lists) if (l) maxLen = Math.max(maxLen, l.length);
    const out = [];
    for (let i = 0; i < maxLen; i++) out.push(fn.apply(null, args.map((a, ai) => lists[ai] ? lists[ai][i % lists[ai].length] : a)));
    return out;
  }
  const mapGeo = (v, fn) => Array.isArray(v) ? clean(v.map(fn)) : fn(v);
  function zipGeoNum(geoV, nums, fn) { // GH 데이터 매칭: 지오 리스트 × 숫자 리스트를 인덱스 짝으로 (짧은 쪽 순환) — 개체별 다른 값 적용
    const geos = asList(geoV).filter(Boolean);
    if (!geos.length) return null;
    const lists = nums.map(a => Array.isArray(a) ? a : null);
    if (!Array.isArray(geoV) && lists.every(l => !l)) return fn(geos[0], nums.map(num)); // 스칼라×스칼라 = 기존 동작
    let maxLen = geos.length;
    for (const l of lists) if (l) maxLen = Math.max(maxLen, l.length);
    const out = [];
    for (let i = 0; i < maxLen && i < 3000; i++) {
      const args = nums.map((a, ai) => lists[ai] ? (Number(lists[ai][i % lists[ai].length]) || 0) : num(a));
      out.push(fn(geos[i % geos.length], args));
    }
    return clean(out);
  }

  // ---------- 지오메트리 값 생성/변환 ----------
  const mkPt = (x, y, z) => ({ gh: 'pt', x: +x || 0, y: +y || 0, z: +z || 0 });
  const mkLine = (a, b) => ({ gh: 'crv', t: 'LINE', x1: a.x, y1: a.y, x2: b.x, y2: b.y, z: ((a.z || 0) + (b.z || 0)) / 2 });
  const mkCircle = (c, r) => ({ gh: 'crv', t: 'CIR', cx: c.x, cy: c.y, r: Math.abs(+r || 0), z: c.z || 0 });
  const mkRect = (c, w, h) => {
    const hw = Math.abs(w) / 2, hh = Math.abs(h) / 2;
    return { gh: 'crv', t: 'PL', closed: true, z: c.z || 0, points: [[c.x - hw, c.y - hh], [c.x + hw, c.y - hh], [c.x + hw, c.y + hh], [c.x - hw, c.y + hh]] };
  };
  function xformGeo(g, fn, dz) {
    if (!g) return null; dz = dz || 0;
    if (g.gh === 'pt') { const p = fn(g.x, g.y); return mkPt(p[0], p[1], (g.z || 0) + dz); }
    if (g.gh === 'crv') {
      const o = Object.assign({}, g); o.z = (g.z || 0) + dz;
      if (g.t === 'LINE') { const a = fn(g.x1, g.y1), b = fn(g.x2, g.y2); o.x1 = a[0]; o.y1 = a[1]; o.x2 = b[0]; o.y2 = b[1]; }
      else if (g.t === 'PL') o.points = g.points.map(p => fn(p[0], p[1]));
      else if (g.t === 'CIR') { const c = fn(g.cx, g.cy); o.cx = c[0]; o.cy = c[1]; }
      return o;
    }
    if (g.gh === 'solid') {
      const o = Object.assign({}, g); o.ent = xformGeo(g.ent, fn, dz);
      o.bim = g.bim.kind === 'slab' ? Object.assign({}, g.bim, { top: (g.bim.top || 0) + dz })
        : Object.assign({}, g.bim, { base: (g.bim.base || 0) + dz });
      return o;
    }
    if (g.gh === 'mesh') return { gh: 'mesh', tris: g.tris.map(t => t.map(p => { const q = fn(p[0], p[1]); return [q[0], q[1], (p[2] || 0) + dz]; })) };
    return null;
  }
  const mkMesh = tris => ({ gh: 'mesh', tris });
  function uvSphere(cx, cy, cz, r, seg) { // UV 구 메시 (cad.js meshSphere와 동일 규약)
    const rings = Math.max(3, Math.round(seg / 2)), tris = [];
    const pt = (i, j) => { const th = Math.PI * j / rings, ph = 2 * Math.PI * i / seg;
      return [cx + r * Math.sin(th) * Math.cos(ph), cy + r * Math.sin(th) * Math.sin(ph), cz + r * Math.cos(th)]; };
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      if (j !== 0) tris.push([a, b, c]);
      if (j !== rings - 1) tris.push([a, c, d]);
    }
    return tris;
  }
  // ---------- 커브 공통 유틸 (분할·오프셋·투영 — GH Divide/Offset 대응) ----------
  function crvPts(g) { // 커브 → 정점 배열 (원은 48각 근사)
    if (!g || g.gh !== 'crv') return null;
    if (g.t === 'LINE') return { pts: [[g.x1, g.y1], [g.x2, g.y2]], closed: false };
    if (g.t === 'PL') return { pts: g.points.slice(), closed: !!g.closed };
    if (g.t === 'CIR') { const p = []; for (let i = 0; i < 48; i++) { const a = i / 48 * 2 * Math.PI; p.push([g.cx + g.r * Math.cos(a), g.cy + g.r * Math.sin(a)]); } return { pts: p, closed: true }; }
    return null;
  }
  function divideCrv(g, n) { // n등분 → {pts:[mkPt], tan:[접선각 deg]} — 열린 커브는 양끝 포함(n+1점), 닫힌 커브는 n점 (GH 규약)
    const c = crvPts(g); if (!c || c.pts.length < 2) return { pts: [], tan: [] };
    const P = c.pts, m = c.closed ? P.length : P.length - 1, segs = [];
    let total = 0;
    for (let i = 0; i < m; i++) { const a = P[i], b = P[(i + 1) % P.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, L }); total += L; }
    if (total < 1e-9) return { pts: [], tan: [] };
    const cnt = Math.max(1, Math.min(1000, Math.round(n) || 1));
    const N = c.closed ? cnt : cnt + 1, outP = [], outT = [];
    for (let i = 0; i < N; i++) {
      let d = total * (i / cnt); if (d > total) d = total;
      let acc = 0, s = segs[segs.length - 1], t = 1;
      for (const sg of segs) { if (d <= acc + sg.L + 1e-9) { s = sg; t = sg.L > 1e-9 ? (d - acc) / sg.L : 0; break; } acc += sg.L; }
      outP.push(mkPt(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, g.z || 0));
      outT.push(Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]) * 180 / Math.PI);
    }
    return { pts: outP, tan: outT };
  }
  function lineX(a, b, c, d) { // 무한 직선 교차
    const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1];
    const den = d1x * d2y - d1y * d2x; if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * d2y - (c[1] - a[1]) * d2x) / den;
    return [a[0] + d1x * t, a[1] + d1y * t];
  }
  function offsetPoly(pts, closed, d) { // 미터 오프셋 (d+ = 진행방향 오른쪽)
    const n = pts.length, m = closed ? n : n - 1, segs = [];
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      const nx = dy / L * d, ny = -dx / L * d;
      segs.push({ a: [a[0] + nx, a[1] + ny], b: [b[0] + nx, b[1] + ny] });
    }
    const out = [];
    const K = closed ? m : m + 1;
    for (let i = 0; i < K; i++) {
      if (!closed && i === 0) { out.push(segs[0].a); continue; }
      if (!closed && i === m) { out.push(segs[m - 1].b); continue; }
      const s1 = segs[(i - 1 + m) % m], s2 = segs[i % m];
      out.push(lineX(s1.a, s1.b, s2.a, s2.b) || s2.a.slice());
    }
    return out;
  }
  function curveLen(g) { // 커브 길이(mm)
    const c = crvPts(g); if (!c) return 0;
    if (g.t === 'CIR') return 2 * Math.PI * g.r;
    const m = c.closed ? c.pts.length : c.pts.length - 1; let L = 0;
    for (let i = 0; i < m; i++) { const a = c.pts[i], b = c.pts[(i + 1) % c.pts.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return L;
  }
  function polyAreaCent(g) { // 닫힌 커브 면적(mm²)+도심 (신발끈 공식)
    const c = crvPts(g); if (!c || !c.closed || c.pts.length < 3) return null;
    const P = c.pts; let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length], cr = x1 * y2 - x2 * y1;
      A += cr; cx += (x1 + x2) * cr; cy += (y1 + y2) * cr;
    }
    A /= 2; if (Math.abs(A) < 1e-9) return null;
    return { area: Math.abs(A), cx: cx / (6 * A), cy: cy / (6 * A) };
  }
  function geoBounds(g) { // 지오메트리 1개의 XY 경계 (mesh·solid 포함)
    let xs = [], ys = [];
    if (!g) return null;
    if (g.gh === 'pt') { xs = [g.x]; ys = [g.y]; }
    else if (g.gh === 'crv') { const c = crvPts(g); if (!c) return null; c.pts.forEach(p => { xs.push(p[0]); ys.push(p[1]); }); }
    else if (g.gh === 'solid') return geoBounds(g.ent);
    else if (g.gh === 'mesh') g.tris.forEach(t => t.forEach(p => { xs.push(p[0]); ys.push(p[1]); }));
    if (!xs.length) return null;
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }
  function projWidth(c, dirRad) { // 바람 진행방향에 수직인 투영 폭(mm)
    const px = -Math.sin(dirRad), py = Math.cos(dirRad);
    const cp = crvPts(c); if (!cp) return 0;
    let mn = Infinity, mx = -Infinity;
    for (const p of cp.pts) { const s = p[0] * px + p[1] * py; mn = Math.min(mn, s); mx = Math.max(mx, s); }
    return Math.max(0, mx - mn);
  }
  function solidWallArea(s) { // 외피 면적(㎡) = 둘레길이 × 높이
    const c = s.ent, h = (s.bim.h || 0) / 1000;
    const cp = crvPts(c); if (!cp || h <= 0) return 0;
    const P = cp.pts, m = cp.closed ? P.length : P.length - 1;
    let len = 0;
    for (let i = 0; i < m; i++) { const a = P[i], b = P[(i + 1) % P.length]; len += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return len / 1000 * h;
  }
  function heatColor(t) { // 파랑(낮음)→빨강(높음)
    t = Math.max(0, Math.min(1, t));
    const a = [58, 123, 213], b = [255, 69, 58];
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  const rng = seed => { let s = (seed >>> 0) || 1; return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; };
  function compileExpr(src) { // 안전한 수식 컴파일 (x,y,z + Math 화이트리스트)
    src = String(src || '').slice(0, 200);
    if (!/^[-+*/%^(),.\s0-9a-zA-Z_<>=?:!&|]*$/.test(src)) return null;
    const ids = src.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
    const allow = new Set(['x', 'y', 'z', 'abs', 'min', 'max', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'floor', 'ceil', 'round', 'exp', 'log', 'pi', 'PI']);
    for (const id of ids) if (!allow.has(id)) return null;
    const body = src.replace(/\^/g, '**')
      .replace(/\b(abs|min|max|sqrt|pow|sin|cos|tan|asin|acos|atan|atan2|floor|ceil|round|exp|log)\b/g, 'Math.$1')
      .replace(/\b(pi|PI)\b/g, 'Math.PI');
    try { return new Function('x', 'y', 'z', '"use strict";return (' + body + ');'); } catch (e) { return null; }
  }
  function entToGeo(e) { // 도면 개체 → 그래프 지오메트리 (geoIn용)
    const z = e.zo || 0;
    if (e.type === 'LINE') return { gh: 'crv', t: 'LINE', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, z };
    if (e.type === 'LWPOLYLINE') return { gh: 'crv', t: 'PL', closed: !!e.closed, points: e.points.map(p => [p[0], p[1]]), z };
    if (e.type === 'CIRCLE') return { gh: 'crv', t: 'CIR', cx: e.cx, cy: e.cy, r: e.r, z };
    if (e.type === 'ARC') {
      const pts = [], n = 24, a0 = e.startAngle, sw = ((e.endAngle - e.startAngle) % 360 + 360) % 360 || 360;
      for (let i = 0; i <= n; i++) { const a = (a0 + sw * i / n) * Math.PI / 180; pts.push([e.cx + e.r * Math.cos(a), e.cy + e.r * Math.sin(a)]); }
      return { gh: 'crv', t: 'PL', closed: false, points: pts, z };
    }
    if (e.type === 'MESH' && Array.isArray(e.tris)) return { gh: 'mesh', tris: JSON.parse(JSON.stringify(e.tris)) };
    return null;
  }

  // ---------- 노드 정의 ----------
  // ins: {k, label, kind:'num'|'geo', def}  ·  outs:[label]  ·  ev(I, params, node) -> [출력...]
  const DEFS = {
    num: { title: '숫자', cat: '입력', ins: [], params: [{ k: 'v', def: 5 }], outs: ['n'], ev: (I, P) => [P.v] },
    slider: { title: '슬라이더', cat: '입력', slider: true, ins: [], params: [{ k: 'v', def: 5 }, { k: 'min', def: 0 }, { k: 'max', def: 20 }, { k: 'step', def: 1 }], outs: ['n'], ev: (I, P) => [P.v] },
    series: { title: '수열', cat: '입력', ins: [{ k: 'start', kind: 'num', def: 0 }, { k: 'step', kind: 'num', def: 1000 }, { k: 'count', kind: 'num', def: 5 }], outs: ['수열'], ev: (I) => { const c = Math.max(0, Math.min(1000, Math.round(num(I.count)))), s = num(I.start), st = num(I.step), o = []; for (let i = 0; i < c; i++) o.push(s + st * i); return [o]; } },
    pt: { title: '점', cat: '지오메트리', ins: [{ k: 'x', kind: 'num', def: 0 }, { k: 'y', kind: 'num', def: 0 }, { k: 'z', kind: 'num', def: 0 }], outs: ['점'], ev: (I) => [zip([I.x, I.y, I.z], (x, y, z) => mkPt(x, y, z))] },
    line: { title: '선', cat: '지오메트리', ins: [{ k: 'a', kind: 'geo' }, { k: 'b', kind: 'geo' }], outs: ['선'], ev: (I) => [clean(zip([I.a, I.b], (a, b) => (a && b && a.gh === 'pt' && b.gh === 'pt') ? mkLine(a, b) : null))] },
    rect: { title: '사각형', cat: '지오메트리', ins: [{ k: 'c', kind: 'geo' }, { k: 'w', kind: 'num', def: 2000 }, { k: 'h', kind: 'num', def: 1000 }], outs: ['사각형'], ev: (I) => [clean(zip([I.c, I.w, I.h], (c, w, h) => (c && c.gh === 'pt') ? mkRect(c, num(w), num(h)) : null))] },
    circle: { title: '원', cat: '지오메트리', ins: [{ k: 'c', kind: 'geo' }, { k: 'r', kind: 'num', def: 500 }], outs: ['원'], ev: (I) => [clean(zip([I.c, I.r], (c, r) => (c && c.gh === 'pt') ? mkCircle(c, num(r)) : null))] },
    move: { title: '이동', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'dx', kind: 'num', def: 1000 }, { k: 'dy', kind: 'num', def: 0 }, { k: 'dz', kind: 'num', def: 0 }], outs: ['결과'], ev: (I) => [zipGeoNum(I.geo, [I.dx, I.dy, I.dz], (g, a) => xformGeo(g, (x, y) => [x + a[0], y + a[1]], a[2]))] },
    rotate: { title: '회전', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'cx', kind: 'num', def: 0 }, { k: 'cy', kind: 'num', def: 0 }, { k: 'deg', kind: 'num', def: 30 }], outs: ['결과'], ev: (I) => [zipGeoNum(I.geo, [I.cx, I.cy, I.deg], (g, a) => { const rd = a[2] * Math.PI / 180, cs = Math.cos(rd), sn = Math.sin(rd); return xformGeo(g, (x, y) => [a[0] + (x - a[0]) * cs - (y - a[1]) * sn, a[1] + (x - a[0]) * sn + (y - a[1]) * cs], 0); })] },
    arrayL: { title: '선형 배열', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'count', kind: 'num', def: 5 }, { k: 'dx', kind: 'num', def: 1500 }, { k: 'dy', kind: 'num', def: 0 }, { k: 'dz', kind: 'num', def: 0 }], outs: ['배열'], ev: (I) => { const cnt = Math.max(1, Math.min(500, Math.round(num(I.count)))), out = []; for (const g of asList(I.geo).filter(Boolean)) for (let i = 0; i < cnt; i++) out.push(xformGeo(g, (x, y) => [x + num(I.dx) * i, y + num(I.dy) * i], num(I.dz) * i)); return [out]; } },
    extrude: { title: '돌출', cat: 'BIM', ins: [{ k: 'geo', kind: 'geo' }, { k: 'h', kind: 'num', def: 2400 }], outs: ['솔리드'], ev: (I) => [zipGeoNum(I.geo, [I.h], (g, a) => { if (!g || g.gh !== 'crv') return null; const h = Math.max(1, a[0]); if (g.t === 'LINE' || (g.t === 'PL' && !g.closed)) return { gh: 'solid', ent: g, bim: { kind: 'wall', h, t: 100, base: g.z || 0 } }; return { gh: 'solid', ent: g, bim: { kind: 'column', h, base: g.z || 0 } }; })] },
    panel: { title: '값 보기', cat: '입력', panel: true, ins: [{ k: 'v', kind: 'geo' }], outs: ['v'], ev: (I) => [I.v] },
    // ---- 데이터 (GH: Range / Random / ReMap / Expression) ----
    range: { title: '범위분할', cat: '입력', ins: [{ k: 'start', kind: 'num', def: 0 }, { k: 'end', kind: 'num', def: 10000 }, { k: 'count', kind: 'num', def: 10 }], outs: ['수열'], ev: (I) => { const c = Math.max(1, Math.min(1000, Math.round(num(I.count)))), a = num(I.start), b = num(I.end), o = []; for (let i = 0; i <= c; i++) o.push(a + (b - a) * i / c); return [o]; } },
    rand: { title: '난수', cat: '입력', ins: [{ k: 'count', kind: 'num', def: 10 }, { k: 'min', kind: 'num', def: 0 }, { k: 'max', kind: 'num', def: 1000 }, { k: 'seed', kind: 'num', def: 1 }], outs: ['난수열'], ev: (I) => { const c = Math.max(1, Math.min(1000, Math.round(num(I.count)))), r = rng(Math.round(num(I.seed))), a = num(I.min), b = num(I.max), o = []; for (let i = 0; i < c; i++) o.push(a + (b - a) * r()); return [o]; } },
    remap: { title: '값 재매핑', cat: '입력', ins: [{ k: 'v', kind: 'num', def: 0 }, { k: 'f0', kind: 'num', def: 0 }, { k: 'f1', kind: 'num', def: 1 }, { k: 't0', kind: 'num', def: 0 }, { k: 't1', kind: 'num', def: 100 }], outs: ['결과'], ev: (I) => [zip([I.v, I.f0, I.f1, I.t0, I.t1], (v, f0, f1, t0, t1) => { const d = (f1 - f0) || 1e-9; return t0 + (v - f0) / d * (t1 - t0); })] },
    expr: { title: '수식', cat: '입력', textK: 'f', ins: [{ k: 'x', kind: 'num', def: 0 }, { k: 'y', kind: 'num', def: 0 }, { k: 'z', kind: 'num', def: 0 }], params: [{ k: 'f', def: 'x*2' }], outs: ['결과'], ev: (I, P, n) => { if (!n._exprFn || n._exprSrc !== P.f) { n._exprFn = compileExpr(P.f); n._exprSrc = P.f; } const fn = n._exprFn; if (!fn) { n._err = '수식 오류'; return [[]]; } return [zip([I.x, I.y, I.z], (x, y, z) => { const r = fn(num(x), num(y), num(z)); return isFinite(r) ? r : 0; })]; } },
    geoIn: { title: '도면 참조', cat: '입력', capture: true, ins: [], outs: ['지오메트리'], ev: (I, P, n) => { const S = B().state, out = []; for (const id of (n.sel || [])) { const e = S.entities.find(x => x.id === id && !x._gh); if (!e) continue; const g = entToGeo(e); if (g) out.push(g); } return [out]; } },
    ptGrid: { title: '점 격자', cat: '지오메트리', ins: [{ k: 'nx', kind: 'num', def: 5 }, { k: 'ny', kind: 'num', def: 4 }, { k: 'dx', kind: 'num', def: 2000 }, { k: 'dy', kind: 'num', def: 2000 }], outs: ['점들'], ev: (I) => { const nx = Math.max(1, Math.min(60, Math.round(num(I.nx)))), ny = Math.max(1, Math.min(60, Math.round(num(I.ny)))), sx = num(I.dx), sy = num(I.dy), o = []; for (let j = 0; j < ny && o.length < 2500; j++) for (let i = 0; i < nx && o.length < 2500; i++) o.push(mkPt(i * sx, j * sy, 0)); return [o]; } },
    // ---- 커브 (GH: Polygon / Arc / PolyLine / Divide Curve / Offset) ----
    polygon: { title: '다각형', cat: '지오메트리', ins: [{ k: 'c', kind: 'geo' }, { k: 'r', kind: 'num', def: 1000 }, { k: 'sides', kind: 'num', def: 6 }], outs: ['다각형'], ev: (I) => [clean(zip([I.c, I.r, I.sides], (c, r, sd) => { if (!c || c.gh !== 'pt') return null; const n2 = Math.max(3, Math.min(64, Math.round(num(sd)))), R = Math.abs(num(r)), pts = []; for (let i = 0; i < n2; i++) { const a = i / n2 * 2 * Math.PI; pts.push([c.x + R * Math.cos(a), c.y + R * Math.sin(a)]); } return { gh: 'crv', t: 'PL', closed: true, points: pts, z: c.z || 0 }; }))] },
    arc: { title: '호', cat: '지오메트리', ins: [{ k: 'c', kind: 'geo' }, { k: 'r', kind: 'num', def: 1000 }, { k: 'a0', kind: 'num', def: 0 }, { k: 'a1', kind: 'num', def: 90 }], outs: ['호'], ev: (I) => [clean(zip([I.c, I.r, I.a0, I.a1], (c, r, a0, a1) => { if (!c || c.gh !== 'pt') return null; const R = Math.abs(num(r)), sw = ((num(a1) - num(a0)) % 360 + 360) % 360 || 360; const seg = Math.max(8, Math.min(90, Math.round(sw / 5))), pts = []; for (let i = 0; i <= seg; i++) { const a = (num(a0) + sw * i / seg) * Math.PI / 180; pts.push([c.x + R * Math.cos(a), c.y + R * Math.sin(a)]); } return { gh: 'crv', t: 'PL', closed: false, points: pts, z: c.z || 0 }; }))] },
    plineN: { title: '폴리라인', cat: '지오메트리', ins: [{ k: 'pts', kind: 'geo' }, { k: 'closed', kind: 'num', def: 0 }], outs: ['폴리라인'], ev: (I) => { const ps = asList(I.pts).filter(p => p && p.gh === 'pt'); if (ps.length < 2) return [null]; return [{ gh: 'crv', t: 'PL', closed: num(I.closed) >= 0.5, points: ps.map(p => [p.x, p.y]), z: ps[0].z || 0 }]; } },
    divide: { title: '커브 분할', cat: '지오메트리', ins: [{ k: 'crv', kind: 'geo' }, { k: 'count', kind: 'num', def: 10 }], outs: ['점들', '접선각'], ev: (I) => { const P = [], T = []; for (const g of asList(I.crv).filter(x => x && x.gh === 'crv')) { const d = divideCrv(g, num(I.count)); P.push.apply(P, d.pts); T.push.apply(T, d.tan); } return [P, T]; } },
    offsetC: { title: '오프셋', cat: '지오메트리', ins: [{ k: 'crv', kind: 'geo' }, { k: 'd', kind: 'num', def: 200 }], outs: ['결과'], ev: (I) => [mapGeo(I.crv, g => { if (!g || g.gh !== 'crv') return null; const d = num(I.d); if (g.t === 'CIR') return Object.assign({}, g, { r: Math.max(1, g.r + d) }); const c = crvPts(g); if (!c) return null; return { gh: 'crv', t: 'PL', closed: c.closed, points: offsetPoly(c.pts, c.closed, d), z: g.z || 0 }; })] },
    // ---- 배치 (GH: Polar Array / Orient / 루버 프리셋) ----
    arrayP: { title: '원형 배열', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'count', kind: 'num', def: 6 }, { k: 'cx', kind: 'num', def: 0 }, { k: 'cy', kind: 'num', def: 0 }, { k: 'sweep', kind: 'num', def: 360 }], outs: ['배열'], ev: (I) => { const cnt = Math.max(1, Math.min(500, Math.round(num(I.count)))), cx = num(I.cx), cy = num(I.cy), sw = num(I.sweep), out = []; for (const g of asList(I.geo).filter(Boolean)) for (let i = 0; i < cnt; i++) { const a = (sw * i / cnt) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); out.push(xformGeo(g, (x, y) => [cx + (x - cx) * cs - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * cs], 0)); } return [out]; } },
    orientPts: { title: '점들에 배치', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'pts', kind: 'geo' }, { k: 'deg', kind: 'num', def: 0 }], outs: ['배열'], ev: (I) => { const geos = asList(I.geo).filter(Boolean), pts = asList(I.pts).filter(p => p && p.gh === 'pt'), degs = asList(I.deg), out = []; for (let i = 0; i < pts.length && out.length < 3000; i++) { const p = pts[i], dg = (Number(degs[i % Math.max(1, degs.length)]) || 0) * Math.PI / 180, cs = Math.cos(dg), sn = Math.sin(dg); for (const g of geos) { if (out.length >= 3000) break; out.push(xformGeo(g, (x, y) => { const rx = x * cs - y * sn, ry = x * sn + y * cs; return [p.x + rx, p.y + ry]; }, p.z || 0)); } } return [out]; } },
    louver: { title: '루버', cat: '변환', ins: [{ k: 'crv', kind: 'geo' }, { k: 'count', kind: 'num', def: 12 }, { k: 'depth', kind: 'num', def: 400 }, { k: 'deg', kind: 'num', def: 90 }, { k: 'h', kind: 'num', def: 2400 }, { k: 't', kind: 'num', def: 50 }], outs: ['핀 솔리드'], ev: (I) => { const out = []; for (const g of asList(I.crv).filter(x => x && x.gh === 'crv')) { const d = divideCrv(g, num(I.count)); d.pts.forEach((p, i) => { if (out.length >= 1000) return; const a = (d.tan[i] + num(I.deg)) * Math.PI / 180, hx = Math.cos(a) * num(I.depth) / 2, hy = Math.sin(a) * num(I.depth) / 2; out.push({ gh: 'solid', ent: { gh: 'crv', t: 'LINE', x1: p.x - hx, y1: p.y - hy, x2: p.x + hx, y2: p.y + hy, z: g.z || 0 }, bim: { kind: 'wall', h: Math.max(1, num(I.h)), t: Math.max(10, num(I.t)), base: (g.z || 0) } }); }); } return [out]; } },
    // ---- 분석 (개산 — 예비 설계용) ----
    thermal: { title: '열관류 분석', cat: '분석', ins: [{ k: 'geo', kind: 'geo' }, { k: 'U', kind: 'num', def: 0.24 }, { k: 'dT', kind: 'num', def: 20 }], outs: ['히트맵', 'Q합계 W', '개별Q W'], ev: (I) => { const sol = asList(I.geo).filter(s => s && s.gh === 'solid'); if (!sol.length) return [[], 0, []]; const U = Math.abs(num(I.U)), dT = num(I.dT); const Qs = sol.map(s => U * solidWallArea(s) * dT); const mx = Math.max.apply(null, Qs.concat([1e-9])); const colored = sol.map((s, i) => Object.assign({}, s, { _color: heatColor(Qs[i] / mx) })); return [colored, Math.round(Qs.reduce((a, b) => a + b, 0)), Qs.map(q => Math.round(q))]; } },
    wind: { title: '풍압 분석', cat: '분석', ins: [{ k: 'geo', kind: 'geo' }, { k: 'V', kind: 'num', def: 26 }, { k: 'dir', kind: 'num', def: 0 }, { k: 'Cp', kind: 'num', def: 0.8 }], outs: ['색상맵', 'F합계 kN', '개별F N'], ev: (I) => { const sol = asList(I.geo).filter(s => s && s.gh === 'solid'); if (!sol.length) return [[], 0, []]; const V = Math.abs(num(I.V)), q = 0.613 * V * V, dir = num(I.dir) * Math.PI / 180, Cp = num(I.Cp); const Fs = sol.map(s => { const w = projWidth(s.ent, dir) / 1000, A = w * ((s.bim.h || 0) / 1000); return q * Cp * A; }); const mx = Math.max.apply(null, Fs.concat([1e-9])); const colored = sol.map((s, i) => Object.assign({}, s, { _color: heatColor(Fs[i] / mx) })); return [colored, +((Fs.reduce((a, b) => a + b, 0)) / 1000).toFixed(1), Fs.map(f => Math.round(f))]; } },
    // ---- 데이터/리스트 (GH: List Item / Sub List / Reverse / Shift / Cull / Dispatch / Merge / Sort / Mass) ----
    listItem: { title: '리스트 항목', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }, { k: 'i', kind: 'num', def: 0 }], outs: ['항목'], ev: (I) => { const L = asList(I.list); if (!L.length) return [null]; return [zip([I.i], (i) => L[((Math.round(num(i)) % L.length) + L.length) % L.length])]; } },
    subList: { title: '부분 리스트', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }, { k: 'start', kind: 'num', def: 0 }, { k: 'count', kind: 'num', def: 5 }], outs: ['부분'], ev: (I) => { const L = asList(I.list), s = Math.max(0, Math.round(num(I.start))); return [L.slice(s, s + Math.max(0, Math.round(num(I.count))))]; } },
    revList: { title: '리스트 뒤집기', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }], outs: ['결과'], ev: (I) => [asList(I.list).slice().reverse()] },
    shiftL: { title: '리스트 밀기', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }, { k: 'n', kind: 'num', def: 1 }], outs: ['결과'], ev: (I) => { const L = asList(I.list); if (!L.length) return [[]]; const n = ((Math.round(num(I.n)) % L.length) + L.length) % L.length; return [L.slice(n).concat(L.slice(0, n))]; } },
    cull: { title: '패턴 걸러내기', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }, { k: 'pattern', kind: 'num', def: 1 }], outs: ['남김', '제거'], ev: (I) => { const L = asList(I.list), P = asList(I.pattern), keep = [], cut = []; L.forEach((v, i) => { ((P.length ? Number(P[i % P.length]) : 1) >= 0.5 ? keep : cut).push(v); }); return [keep, cut]; } },
    merge: { title: '리스트 합치기', cat: '데이터', ins: [{ k: 'a', kind: 'geo' }, { k: 'b', kind: 'geo' }, { k: 'c', kind: 'geo' }], outs: ['결과'], ev: (I) => [asList(I.a).concat(asList(I.b), asList(I.c)).filter(x => x != null)] },
    listLen: { title: '개수', cat: '데이터', ins: [{ k: 'list', kind: 'geo' }], outs: ['n'], ev: (I) => [asList(I.list).length] },
    sortL: { title: '정렬', cat: '데이터', ins: [{ k: 'keys', kind: 'num', def: 0 }, { k: 'values', kind: 'geo' }], outs: ['정렬키', '정렬값'], ev: (I) => { const K = asList(I.keys).map(x => Number(x) || 0), V = asList(I.values).filter(x => x != null); const idx = K.map((k, i) => i).sort((a, b) => K[a] - K[b]); return [idx.map(i => K[i]), V.length ? idx.map(i => V[i % V.length]) : []]; } },
    stats: { title: '통계', cat: '데이터', ins: [{ k: 'list', kind: 'num', def: 0 }], outs: ['합', '평균', '최소', '최대'], ev: (I) => { const L = asList(I.list).map(x => Number(x) || 0); if (!L.length) return [0, 0, 0, 0]; const s = L.reduce((a, b) => a + b, 0); return [s, s / L.length, Math.min.apply(null, L), Math.max.apply(null, L)]; } },
    dist: { title: '두 점 거리', cat: '데이터', ins: [{ k: 'a', kind: 'geo' }, { k: 'b', kind: 'geo' }], outs: ['거리'], ev: (I) => [clean(zip([I.a, I.b], (a, b) => (a && b && a.gh === 'pt' && b.gh === 'pt') ? Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)) : null))] },
    ptXYZ: { title: '점 분해', cat: '데이터', ins: [{ k: 'pt', kind: 'geo' }], outs: ['x', 'y', 'z'], ev: (I) => { const P = asList(I.pt).filter(p => p && p.gh === 'pt'); return [P.map(p => p.x), P.map(p => p.y), P.map(p => p.z || 0)]; } },
    // ---- 커브 분석 (GH: End Points / Length / Area / Bounding Box) ----
    endPts: { title: '커브 끝점', cat: '지오메트리', ins: [{ k: 'crv', kind: 'geo' }], outs: ['시작', '끝'], ev: (I) => { const A = [], E = []; for (const g of asList(I.crv).filter(x => x && x.gh === 'crv')) { const c = crvPts(g); if (!c || !c.pts.length) continue; A.push(mkPt(c.pts[0][0], c.pts[0][1], g.z || 0)); const e = c.closed ? c.pts[0] : c.pts[c.pts.length - 1]; E.push(mkPt(e[0], e[1], g.z || 0)); } return [A, E]; } },
    lenC: { title: '커브 길이', cat: '지오메트리', ins: [{ k: 'crv', kind: 'geo' }], outs: ['길이mm'], ev: (I) => [asList(I.crv).filter(x => x && x.gh === 'crv').map(curveLen)] },
    areaC: { title: '면적·도심', cat: '지오메트리', ins: [{ k: 'crv', kind: 'geo' }], outs: ['면적㎡', '도심'], ev: (I) => { const As = [], Cs = []; for (const g of asList(I.crv).filter(x => x && x.gh === 'crv')) { const r = polyAreaCent(g); if (!r) continue; As.push(r.area / 1e6); Cs.push(mkPt(r.cx, r.cy, g.z || 0)); } return [As, Cs]; } },
    bboxN: { title: '경계 상자', cat: '지오메트리', ins: [{ k: 'geo', kind: 'geo' }], outs: ['상자', '중심', 'w', 'h'], ev: (I) => { const R = [], C = [], W = [], H = []; for (const g of asList(I.geo).filter(Boolean)) { const b = geoBounds(g); if (!b) continue; R.push(mkRect(mkPt(b.cx, b.cy, 0), Math.max(1, b.w), Math.max(1, b.h))); C.push(mkPt(b.cx, b.cy, 0)); W.push(b.w); H.push(b.h); } return [R, C, W, H]; } },
    // ---- 변환 확장 (GH: Mirror / Scale) ----
    mirror: { title: '대칭', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'x1', kind: 'num', def: 0 }, { k: 'y1', kind: 'num', def: 0 }, { k: 'x2', kind: 'num', def: 0 }, { k: 'y2', kind: 'num', def: 1000 }], outs: ['결과'], ev: (I) => [zipGeoNum(I.geo, [I.x1, I.y1, I.x2, I.y2], (g, a) => { const dx = a[2] - a[0], dy = a[3] - a[1], L2 = dx * dx + dy * dy || 1; return xformGeo(g, (x, y) => { const t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2, px = a[0] + t * dx, py = a[1] + t * dy; return [2 * px - x, 2 * py - y]; }, 0); })] },
    scaleN: { title: '크기 조절', cat: '변환', ins: [{ k: 'geo', kind: 'geo' }, { k: 'cx', kind: 'num', def: 0 }, { k: 'cy', kind: 'num', def: 0 }, { k: 'f', kind: 'num', def: 2 }], outs: ['결과'], ev: (I) => [zipGeoNum(I.geo, [I.cx, I.cy, I.f], (g, a) => { const f = a[2] || 1; let o = xformGeo(g, (x, y) => [a[0] + (x - a[0]) * f, a[1] + (y - a[1]) * f], 0); if (!o) return null; if (o.gh === 'crv' && o.t === 'CIR') o.r = Math.abs(g.r * f); if (o.gh === 'solid') { if (o.ent.t === 'CIR') o.ent = Object.assign({}, o.ent, { r: Math.abs(g.ent.r * f) }); o.bim = Object.assign({}, o.bim); if (o.bim.h) o.bim.h = Math.max(1, Math.abs(o.bim.h * f)); if (o.bim.t) o.bim.t = Math.max(1, Math.abs(o.bim.t * f)); } return o; })] },
    // ---- 솔리드/메시 (GH: Slab·Sphere·Loft·Revolve 대응 — 메시 근사) ----
    slab: { title: '슬래브', cat: 'BIM', ins: [{ k: 'crv', kind: 'geo' }, { k: 't', kind: 'num', def: 200 }, { k: 'top', kind: 'num', def: 0 }], outs: ['슬래브'], ev: (I) => [zipGeoNum(I.crv, [I.t, I.top], (g, a) => { if (!g || g.gh !== 'crv') return null; let ent = g; if (g.t === 'CIR') { const c = crvPts(g); ent = { gh: 'crv', t: 'PL', closed: true, points: c.pts, z: g.z || 0 }; } if (ent.t === 'LINE' || (ent.t === 'PL' && !ent.closed)) return null; return { gh: 'solid', ent, bim: { kind: 'slab', t: Math.max(10, a[0]), top: a[1] } }; })] },
    sphereN: { title: '구', cat: 'BIM', ins: [{ k: 'c', kind: 'geo' }, { k: 'r', kind: 'num', def: 500 }, { k: 'seg', kind: 'num', def: 16 }], outs: ['구'], ev: (I) => [clean(zip([I.c, I.r, I.seg], (c, r, sg) => { if (!c || c.gh !== 'pt') return null; return mkMesh(uvSphere(c.x, c.y, c.z || 0, Math.abs(num(r)) || 1, Math.max(6, Math.min(32, Math.round(num(sg)) || 16)))); }))] },
    loft: { title: '로프트', cat: 'BIM', ins: [{ k: 'a', kind: 'geo' }, { k: 'b', kind: 'geo' }, { k: 'seg', kind: 'num', def: 24 }], outs: ['메시'], ev: (I) => { const A = asList(I.a).filter(x => x && x.gh === 'crv'), Bs = asList(I.b).filter(x => x && x.gh === 'crv'); if (!A.length || !Bs.length) return [[]]; const n = Math.max(2, Math.min(120, Math.round(num(I.seg)) || 24)), out = [], m = Math.max(A.length, Bs.length); for (let i = 0; i < m && i < 200; i++) { const ga = A[i % A.length], gb = Bs[i % Bs.length]; const da = divideCrv(ga, n), db = divideCrv(gb, n); const P = da.pts.map(p => [p.x, p.y, p.z || 0]), Q = db.pts.map(p => [p.x, p.y, p.z || 0]); const N = Math.min(P.length, Q.length); if (N < 2) continue; const closed = crvPts(ga).closed && crvPts(gb).closed, M = closed ? N : N - 1, tris = []; for (let k = 0; k < M; k++) { const k2 = (k + 1) % N; tris.push([P[k], Q[k], Q[k2]]); tris.push([P[k], Q[k2], P[k2]]); } out.push(mkMesh(tris)); } return [out]; } },
    revolve: { title: '회전체', cat: 'BIM', ins: [{ k: 'profile', kind: 'geo' }, { k: 'cx', kind: 'num', def: 0 }, { k: 'cy', kind: 'num', def: 0 }, { k: 'seg', kind: 'num', def: 24 }, { k: 'sweep', kind: 'num', def: 360 }], outs: ['메시'], ev: (I) => { const out = [], seg = Math.max(4, Math.min(64, Math.round(num(I.seg)) || 24)), sw = (num(I.sweep) || 360) * Math.PI / 180, cx = num(I.cx), cy = num(I.cy); for (const g of asList(I.profile).filter(x => x && x.gh === 'crv')) { const c = crvPts(g); if (!c || c.pts.length < 2) continue; const prof = c.closed ? c.pts.concat([c.pts[0]]) : c.pts; const ring = (p, a) => [cx + p[0] * Math.cos(a), cy + p[0] * Math.sin(a), (g.z || 0) + p[1]]; const tris = []; for (let i = 0; i < prof.length - 1; i++) for (let j = 0; j < seg; j++) { const a0 = sw * j / seg, a1 = sw * (j + 1) / seg; const A2 = ring(prof[i], a0), B2 = ring(prof[i], a1), C2 = ring(prof[i + 1], a1), D2 = ring(prof[i + 1], a0); tris.push([A2, B2, C2]); tris.push([A2, C2, D2]); } out.push(mkMesh(tris)); } return [out]; } },
    // ---- 분석 확장 (GH: Gradient — 임의 값 리스트로 색칠 = 어트랙터 시각화) ----
    gradient: { title: '색 그라디언트', cat: '분석', ins: [{ k: 'geo', kind: 'geo' }, { k: 'v', kind: 'num', def: 0 }, { k: 'lo', kind: 'num', def: 0 }, { k: 'hi', kind: 'num', def: 0 }], outs: ['색칠된 지오', '정규화값'], ev: (I) => { const G = asList(I.geo).filter(Boolean), V = asList(I.v).map(x => Number(x) || 0); if (!G.length) return [[], []]; let lo = num(I.lo), hi = num(I.hi); if (!(hi > lo)) { lo = Math.min.apply(null, V.length ? V : [0]); hi = Math.max.apply(null, V.length ? V : [1]); } const d = (hi - lo) || 1e-9; const ts = G.map((g, i) => Math.max(0, Math.min(1, ((V.length ? V[i % V.length] : 0) - lo) / d))); return [G.map((g, i) => Object.assign({}, g, { _color: heatColor(ts[i]) })), ts]; } },
  };
  const CATS = ['입력', '데이터', '지오메트리', '변환', 'BIM', '분석'];

  // ---------- 그래프 모델 ----------
  let graph = { nodes: [], wires: [], seq: 1 };
  function addNode(type, x, y) {
    const def = DEFS[type]; if (!def) return null;
    const n = { id: 'n' + (graph.seq++), type, x: x || 0, y: y || 0, params: {}, inl: {} };
    (def.params || []).forEach(p => n.params[p.k] = p.def);
    def.ins.forEach(i => { if (i.kind === 'num') n.inl[i.k] = i.def || 0; });
    graph.nodes.push(n); return n;
  }
  function connect(fromId, outIdx, toId, inKey) {
    graph.wires = graph.wires.filter(w => !(w.to.node === toId && w.to.key === inKey)); // 입력 포트는 한 개만
    if (fromId === toId) return;
    graph.wires.push({ from: { node: fromId, idx: outIdx }, to: { node: toId, key: inKey } });
  }
  function delNode(id) { graph.nodes = graph.nodes.filter(n => n.id !== id); graph.wires = graph.wires.filter(w => w.from.node !== id && w.to.node !== id); }

  // ---------- 평가 (위상 정렬) ----------
  function evalGraph() {
    const byId = {}; graph.nodes.forEach(n => { byId[n.id] = n; n._err = null; });
    const ind = {}; graph.nodes.forEach(n => ind[n.id] = 0);
    graph.wires.forEach(w => { if (byId[w.to.node]) ind[w.to.node]++; });
    const q = graph.nodes.filter(n => ind[n.id] === 0).map(n => n.id), order = [];
    while (q.length) { const id = q.shift(); order.push(id); graph.wires.forEach(w => { if (w.from.node === id && --ind[w.to.node] === 0) q.push(w.to.node); }); }
    const outVals = {};
    for (const id of order) {
      const n = byId[id], def = DEFS[n.type], I = {};
      def.ins.forEach(ins => {
        const w = graph.wires.find(w => w.to.node === id && w.to.key === ins.k);
        if (w && outVals[w.from.node]) I[ins.k] = outVals[w.from.node][w.from.idx];
        else if (ins.kind === 'num') I[ins.k] = n.inl[ins.k];
        else I[ins.k] = null;
      });
      try { outVals[id] = def.ev(I, n.params, n) || []; } catch (e) { outVals[id] = []; n._err = String(e && e.message || e); }
    }
    return outVals;
  }

  // ---------- 프리뷰 · 베이크 ----------
  function geoToEntity(v) {
    const add = B().addEntity; let e;
    if (v.gh === 'pt') { e = add({ type: 'CIRCLE', cx: v.x, cy: v.y, r: 40 }); if (v.z) e.zo = v.z; }
    else if (v.gh === 'crv') {
      if (v.t === 'LINE') e = add({ type: 'LINE', x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 });
      else if (v.t === 'PL') e = add({ type: 'LWPOLYLINE', points: v.points.map(p => [p[0], p[1]]), closed: !!v.closed });
      else if (v.t === 'CIR') e = add({ type: 'CIRCLE', cx: v.cx, cy: v.cy, r: v.r });
      if (e && v.z) e.zo = v.z;
    } else if (v.gh === 'mesh') {
      if (Array.isArray(v.tris) && v.tris.length) e = add({ type: 'MESH', tris: JSON.parse(JSON.stringify(v.tris)) });
    } else if (v.gh === 'solid') {
      const c = v.ent;
      if (c.t === 'LINE') e = add({ type: 'LINE', x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 });
      else if (c.t === 'PL') e = add({ type: 'LWPOLYLINE', points: c.points.map(p => [p[0], p[1]]), closed: true });
      else if (c.t === 'CIR') e = add({ type: 'CIRCLE', cx: c.cx, cy: c.cy, r: c.r });
      if (e) e.bim = JSON.parse(JSON.stringify(v.bim));
    }
    return e || null;
  }
  function clearPreview() { const S = B().state; S.entities = S.entities.filter(e => !e._gh); }
  let lastPreviewCount = 0;
  function apply() { // 그래프 재평가 → 프리뷰 개체 갱신
    if (!B()) return;
    clearPreview();
    const outs = evalGraph();
    window.__GH_LASTEVAL__ = outs; // 값 보기(panel) 표시용 캐시
    let made = 0;
    // GH처럼 '최종 결과'만 프리뷰: 다른 노드(값 보기 제외)의 입력으로 소비된 출력은 중간 산물이므로 생략 (분석 통과 시 이중 표시 방지)
    const consumed = new Set();
    for (const w of graph.wires) { const toN = graph.nodes.find(n2 => n2.id === w.to.node); if (toN && !DEFS[toN.type].panel) consumed.add(w.from.node + ':' + w.from.idx); }
    for (const id in outs) {
      const arr = outs[id];
      for (let oi = 0; oi < arr.length; oi++) {
        if (consumed.has(id + ':' + oi)) continue;
        for (const v of asList(arr[oi])) {
          if (made >= MAX_PREVIEW) break;
          if (v && v.gh) { const e = geoToEntity(v); if (e) { e._gh = true; e.color = v._color || PREVIEW_COLOR; made++; } } // 분석 노드는 _color 히트맵
        }
      }
    }
    lastPreviewCount = made;
    B().refresh();
    if (ui.open) render();
    updateCtrl();
  }
  function bake() { // 프리뷰 → 영구 개체 (실행취소 1단계)
    const S = B().state, gh = S.entities.filter(e => e._gh);
    if (!gh.length) return { baked: 0 };
    B().pushUndo();                             // pre-bake 스냅샷은 _gh 제외 → 실행취소 시 사라짐
    for (const e of gh) { delete e._gh; delete e.color; }
    B().refresh();
    B().logLine('  ✔ 노드 그래프 베이크: ' + gh.length + '개 개체 확정 (실행취소로 원복)', 'ok');
    return { baked: gh.length };
  }

  // ---------- 그래프 실행취소 / 클립보드 / 로직 라이브러리 ----------
  const stripPriv = (k, v) => (k && k[0] === '_' ? undefined : v); // _err, _exprFn 등 내부 필드 제외
  const snapGraph = () => JSON.stringify(graph, stripPriv);
  let gUndo = [], gRedo = [];
  function pushGraphUndo() { gUndo.push(snapGraph()); if (gUndo.length > 50) gUndo.shift(); gRedo.length = 0; }
  function gUndoDo() { if (!gUndo.length) return; gRedo.push(snapGraph()); graph = JSON.parse(gUndo.pop()); ui.sel.clear(); apply(); }
  function gRedoDo() { if (!gRedo.length) return; gUndo.push(snapGraph()); graph = JSON.parse(gRedo.pop()); ui.sel.clear(); apply(); }
  let clip = null; // 노드 클립보드 (내부 와이어 포함)
  function copySel(cut) {
    if (!ui.sel.size) return;
    const ids = [...ui.sel];
    const nodesC = ids.map(id => nodeOf(id)).filter(Boolean)
      .map(n => JSON.parse(JSON.stringify({ type: n.type, x: n.x, y: n.y, params: n.params, inl: n.inl, label: n.label, sel: n.sel }, stripPriv)));
    const idx = {}; ids.forEach((id, i) => idx[id] = i);
    const wiresC = graph.wires.filter(w => idx[w.from.node] != null && idx[w.to.node] != null)
      .map(w => ({ f: idx[w.from.node], i: w.from.idx, t: idx[w.to.node], k: w.to.key }));
    clip = { nodes: nodesC, wires: wiresC };
    if (cut) { pushGraphUndo(); ids.forEach(delNode); ui.sel.clear(); apply(); }
    if (statEl) statEl.textContent = (cut ? '✂ 잘라내기 ' : '📋 복사 ') + nodesC.length + '개 (Ctrl+V 붙여넣기)';
  }
  function pasteClip() {
    if (!clip || !clip.nodes.length) return;
    pushGraphUndo();
    const made = [];
    for (const c of clip.nodes) {
      const n = addNode(c.type, c.x + 30, c.y + 30);
      if (!n) { made.push(null); continue; }
      n.params = JSON.parse(JSON.stringify(c.params || {}));
      n.inl = JSON.parse(JSON.stringify(c.inl || {}));
      if (c.label) n.label = c.label;
      if (c.sel) n.sel = c.sel.slice();
      made.push(n);
    }
    for (const w of clip.wires) { const a = made[w.f], b = made[w.t]; if (a && b) connect(a.id, w.i, b.id, w.k); }
    clip.nodes.forEach(c => { c.x += 30; c.y += 30; }); // 연속 붙여넣기 계단식 배치
    ui.sel = new Set(made.filter(Boolean).map(n => n.id));
    apply();
  }
  const LIB_KEY = 'webcad_gh_lib';
  const readLib = () => { try { return JSON.parse(localStorage.getItem(LIB_KEY) || '{}') || {}; } catch (e) { return {}; } };
  function saveLogic() { // Ctrl+S: 현재 노드 로직을 이름으로 저장 (브라우저 보관)
    if (!graph.nodes.length) { window.alert('저장할 노드가 없습니다.'); return; }
    const name = window.prompt('로직 이름으로 저장 (같은 이름은 덮어씀):', '내 로직');
    if (!name) return;
    const lib = readLib();
    lib[String(name).slice(0, 40)] = { v: 1, at: Date.now(), graph: JSON.parse(snapGraph()) };
    try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { window.alert('저장 실패 — 브라우저 저장공간 부족'); return; }
    B().logLine('  ✔ 노드 로직 저장: ' + name + ' (📂 불러오기에서 재사용)', 'ok');
    if (statEl) statEl.textContent = '💾 저장됨: ' + name;
  }
  function loadLogicUI() { // 저장된 로직 목록 → 불러오기/삭제
    const lib = readLib(), names = Object.keys(lib).sort();
    const old = document.getElementById('ghLib'); if (old) old.remove();
    const box = el('div', { id: 'ghLib' });
    box.appendChild(el('div', { class: 'hd' }, '📂 저장된 노드 로직'));
    if (!names.length) box.appendChild(el('div', { class: 'empty' }, '저장된 로직이 없습니다 — Ctrl+S로 저장하세요'));
    for (const nm of names) {
      const row = el('div', { class: 'row' });
      const b1 = el('button', { class: 'ld' }, nm + ' <span>' + new Date(lib[nm].at).toLocaleDateString() + '</span>');
      b1.addEventListener('click', () => { pushGraphUndo(); graph = JSON.parse(JSON.stringify(lib[nm].graph)); ui.sel.clear(); box.remove(); apply(); if (statEl) statEl.textContent = '📂 불러옴: ' + nm; });
      const b2 = el('button', { class: 'del', title: '삭제' }, '✕');
      b2.addEventListener('click', () => { const l2 = readLib(); delete l2[nm]; localStorage.setItem(LIB_KEY, JSON.stringify(l2)); box.remove(); loadLogicUI(); });
      row.appendChild(b1); row.appendChild(b2); box.appendChild(row);
    }
    const bc = el('button', { class: 'close' }, '닫기'); bc.addEventListener('click', () => box.remove());
    box.appendChild(bc);
    ov.appendChild(box);
  }

  // ---------- UI ----------
  const NW = 168, TITLE_H = 24, ROW = 22, PORT_R = 5;
  const ui = { open: false, view: { x: 0, y: 0, s: 1 }, drag: null, hits: null, sel: new Set() }; // sel = 선택된 노드 (GH 녹색 하이라이트)
  let ov, cv, ctx, statEl;
  function nodeH(n) { const def = DEFS[n.type]; const rows = Math.max(def.ins.length, def.outs.length) + (def.slider ? 1 : 0) + (def.panel ? 1 : 0) + ((def.textK || def.capture) ? 1 : 0); return TITLE_H + rows * ROW + 8; }
  const S = (x, y) => [x * ui.view.s + ui.view.x, y * ui.view.s + ui.view.y];
  const G = (x, y) => [(x - ui.view.x) / ui.view.s, (y - ui.view.y) / ui.view.s];
  function portGraphPos(n, io, idx) {
    const def = DEFS[n.type];
    const yy = n.y + TITLE_H + idx * ROW + ROW / 2;
    return io === 'in' ? [n.x, yy] : [n.x + NW, yy];
  }

  function render() {
    if (!ui.open || !ctx) return;
    const W = cv.width, H = cv.height, dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c1322'; ctx.fillRect(0, 0, W, H);
    // 격자
    ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
    const g0 = G(0, 0), g1 = G(W, H), step = 50;
    for (let gx = Math.floor(g0[0] / step) * step; gx < g1[0]; gx += step) { const s = S(gx, 0); ctx.beginPath(); ctx.moveTo(s[0], 0); ctx.lineTo(s[0], H); ctx.stroke(); }
    for (let gy = Math.floor(g0[1] / step) * step; gy < g1[1]; gy += step) { const s = S(0, gy); ctx.beginPath(); ctx.moveTo(0, s[0] !== undefined ? 0 : 0); ctx.moveTo(0, s[1]); ctx.lineTo(W, s[1]); ctx.stroke(); }
    const hits = { ports: [], vals: [], sliders: [], nodes: [], wires: [] };
    // 와이어
    ctx.lineWidth = 2 * dpr;
    for (const w of graph.wires) {
      const a = nodeOf(w.from.node), b = nodeOf(w.to.node); if (!a || !b) continue;
      const p0 = S.apply(null, portGraphPos(a, 'out', w.from.idx));
      const ki = DEFS[b.type].ins.findIndex(i => i.k === w.to.key);
      const p1 = S.apply(null, portGraphPos(b, 'in', ki));
      ctx.strokeStyle = 'rgba(120,180,255,.7)';
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.bezierCurveTo(p0[0] + 50, p0[1], p1[0] - 50, p1[1], p1[0], p1[1]); ctx.stroke();
      hits.wires.push({ w, mid: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2] });
    }
    // 연결 중 임시 와이어
    if (ui.drag && ui.drag.mode === 'wire') {
      const p0 = S.apply(null, ui.drag.from);
      ctx.strokeStyle = 'rgba(120,180,255,.5)'; ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(ui.drag.cur[0], ui.drag.cur[1]); ctx.stroke();
    }
    // 노드
    for (const n of graph.nodes) {
      const def = DEFS[n.type], p = S(n.x, n.y), w = NW * ui.view.s, h = nodeH(n) * ui.view.s;
      hits.nodes.push({ n, rect: [p[0], p[1], w, h] });
      const isSel = ui.sel.has(n.id); // GH: 선택 = 녹색
      ctx.fillStyle = n._err ? '#3a1e26' : (isSel ? '#1d3a2b' : '#182238');
      ctx.strokeStyle = isSel ? '#7ee2a8' : '#31456e'; ctx.lineWidth = (isSel ? 2.4 : 1.5) * dpr;
      roundRect(p[0], p[1], w, h, 7 * ui.view.s); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#22314e'; roundRectTop(p[0], p[1], w, TITLE_H * ui.view.s, 7 * ui.view.s); ctx.fill();
      ctx.fillStyle = '#dbe6ff'; ctx.font = (13 * ui.view.s) + 'px -apple-system,system-ui,sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.fillText((n.label ? def.title + ' · ' + n.label : def.title).slice(0, 18), p[0] + 8 * ui.view.s, p[1] + TITLE_H * ui.view.s / 2);
      // 입력 포트
      def.ins.forEach((ins, i) => {
        const gp = portGraphPos(n, 'in', i), sp = S.apply(null, gp);
        const wired = graph.wires.some(w2 => w2.to.node === n.id && w2.to.key === ins.k);
        drawPort(sp, wired); hits.ports.push({ node: n.id, io: 'in', key: ins.k, idx: i, x: sp[0], y: sp[1] });
        ctx.fillStyle = '#9fb2d8'; ctx.font = (11 * ui.view.s) + 'px system-ui'; ctx.textAlign = 'left';
        ctx.fillText(ins.label || ins.k, sp[0] + 9 * ui.view.s, sp[1]);
        if (ins.kind === 'num' && !wired) { // 인라인 값
          const vx = sp[0] + 62 * ui.view.s, vw = 40 * ui.view.s;
          ctx.fillStyle = '#0e1730'; roundRect(vx, sp[1] - 8 * ui.view.s, vw, 16 * ui.view.s, 3); ctx.fill();
          ctx.fillStyle = '#cfe0ff'; ctx.textAlign = 'center'; ctx.font = (10.5 * ui.view.s) + 'px system-ui';
          ctx.fillText(fmt(n.inl[ins.k]), vx + vw / 2, sp[1]);
          hits.vals.push({ node: n.id, key: ins.k, rect: [vx, sp[1] - 8 * ui.view.s, vw, 16 * ui.view.s] });
        }
      });
      // 출력 포트
      def.outs.forEach((label, i) => {
        const gp = portGraphPos(n, 'out', i), sp = S.apply(null, gp);
        drawPort(sp, true); hits.ports.push({ node: n.id, io: 'out', idx: i, x: sp[0], y: sp[1] });
        ctx.fillStyle = '#9fb2d8'; ctx.font = (11 * ui.view.s) + 'px system-ui'; ctx.textAlign = 'right';
        ctx.fillText(label, sp[0] - 9 * ui.view.s, sp[1]);
      });
      // 슬라이더
      if (def.slider) {
        const ty = p[1] + (TITLE_H + def.ins.length * ROW + ROW / 2) * ui.view.s, tx = p[0] + 12 * ui.view.s, tw = w - 24 * ui.view.s;
        ctx.strokeStyle = '#31456e'; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx + tw, ty); ctx.stroke();
        const frac = (n.params.v - n.params.min) / ((n.params.max - n.params.min) || 1);
        const kx = tx + Math.max(0, Math.min(1, frac)) * tw;
        ctx.fillStyle = '#5ad1ff'; ctx.beginPath(); ctx.arc(kx, ty, 6 * ui.view.s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#cfe0ff'; ctx.textAlign = 'center'; ctx.font = (10.5 * ui.view.s) + 'px system-ui';
        ctx.fillText(fmt(n.params.v), tx + tw / 2, ty - 10 * ui.view.s);
        hits.sliders.push({ node: n.id, rect: [tx, ty - 8 * ui.view.s, tw, 16 * ui.view.s] });
      }
      // 수식(textK) / 도면 참조(capture) 칩
      if (def.textK || def.capture) {
        const ty = p[1] + (TITLE_H + def.ins.length * ROW + ROW / 2) * ui.view.s;
        const txt = def.capture ? ('선택 ' + ((n.sel || []).length) + '개 · 클릭=가져오기') : ('f = ' + String(n.params[def.textK]));
        ctx.fillStyle = '#0e1730'; roundRect(p[0] + 8 * ui.view.s, ty - 8 * ui.view.s, w - 16 * ui.view.s, 16 * ui.view.s, 3); ctx.fill();
        ctx.fillStyle = '#ffd88f'; ctx.textAlign = 'center'; ctx.font = (10 * ui.view.s) + 'px system-ui';
        ctx.fillText(txt.slice(0, 26), p[0] + w / 2, ty);
        hits.vals.push({ node: n.id, key: def.capture ? '__cap' : '__t:' + def.textK, rect: [p[0] + 8 * ui.view.s, ty - 8 * ui.view.s, w - 16 * ui.view.s, 16 * ui.view.s] });
      }
      // 값 보기(panel) / 숫자 노드 값
      if (def.panel || n.type === 'num') {
        const ty = p[1] + (TITLE_H + def.ins.length * ROW + ROW / 2) * ui.view.s;
        let txt = '';
        if (n.type === 'num') { txt = fmt(n.params.v); hits.vals.push({ node: n.id, key: '__numv', rect: [p[0] + 12 * ui.view.s, ty - 8 * ui.view.s, w - 24 * ui.view.s, 16 * ui.view.s] }); }
        else txt = panelText(n.id);
        ctx.fillStyle = '#0e1730'; roundRect(p[0] + 12 * ui.view.s, ty - 8 * ui.view.s, w - 24 * ui.view.s, 16 * ui.view.s, 3); ctx.fill();
        ctx.fillStyle = '#8fe6c8'; ctx.textAlign = 'center'; ctx.font = (10.5 * ui.view.s) + 'px system-ui';
        ctx.fillText(txt, p[0] + w / 2, ty);
      }
    }
    // 박스 선택 마퀴 (GH 스타일)
    if (ui.drag && ui.drag.mode === 'box' && ui.drag.moved > 3) {
      const d = ui.drag, bx = Math.min(d.x0, d.cur[0]), by = Math.min(d.y0, d.cur[1]);
      const bw = Math.abs(d.cur[0] - d.x0), bh = Math.abs(d.cur[1] - d.y0);
      ctx.fillStyle = 'rgba(126,226,168,.08)'; ctx.strokeStyle = 'rgba(126,226,168,.85)'; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([5, 4]);
      ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh); ctx.setLineDash([]);
    }
    ui.hits = hits;
    if (statEl) statEl.textContent = '노드 ' + graph.nodes.length + (ui.sel.size ? ' · 선택 ' + ui.sel.size + '개 (Del=삭제)' : '') + ' · 프리뷰 개체 ' + lastPreviewCount + ' · 좌드래그=선택 · 우드래그=이동';
  }
  function panelText(id) { const outs = window.__GH_LASTEVAL__ || {}; const v = outs[id] && outs[id][0]; if (v == null) return '—'; if (Array.isArray(v)) return '리스트[' + v.length + ']'; if (v.gh) return v.gh; return fmt(v); }
  function drawPort(sp, filled) { ctx.beginPath(); ctx.arc(sp[0], sp[1], PORT_R * ui.view.s, 0, Math.PI * 2); ctx.fillStyle = filled ? '#5ad1ff' : '#26365a'; ctx.fill(); ctx.strokeStyle = '#1a2740'; ctx.lineWidth = 1; ctx.stroke(); }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function roundRectTop(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h); ctx.closePath(); }
  const fmt = v => { const n = +v; return Number.isInteger(n) ? String(n) : n.toFixed(2); };
  const nodeOf = id => graph.nodes.find(n => n.id === id);

  // ---------- 상호작용 ----------
  function bindCanvas() {
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const mx = e.offsetX * (devicePixelRatio || 1), my = e.offsetY * (devicePixelRatio || 1);
      if (e.button === 2 || e.button === 1) { ui.drag = { mode: 'pan', sx: mx, sy: my, vx: ui.view.x, vy: ui.view.y }; return; }
      const H = ui.hits; if (!H) return;
      // 포트
      for (const p of H.ports) if (Math.hypot(mx - p.x, my - p.y) < 11 * (devicePixelRatio || 1)) {
        if (p.io === 'out') { ui.drag = { mode: 'wire', from: portGraphPos(nodeOf(p.node), 'out', p.idx), fromNode: p.node, fromIdx: p.idx, cur: [mx, my] }; }
        else if (graph.wires.some(w => w.to.node === p.node && w.to.key === p.key)) { pushGraphUndo(); graph.wires = graph.wires.filter(w => !(w.to.node === p.node && w.to.key === p.key)); apply(); }
        return;
      }
      // 인라인 값 편집
      for (const v of H.vals) if (inRect(mx, my, v.rect)) { editVal(v.node, v.key); return; }
      // 슬라이더
      for (const s of H.sliders) if (inRect(mx, my, s.rect, 10)) { pushGraphUndo(); ui.drag = { mode: 'slider', node: s.node, rect: s.rect }; sliderSet(s.node, mx, s.rect); return; }
      // 노드 클릭 (GH: 클릭=단일 선택, Shift=추가/토글, Ctrl=선택 해제, 드래그=선택된 노드 전체 이동)
      for (let i = H.nodes.length - 1; i >= 0; i--) {
        const nd = H.nodes[i];
        if (inRect(mx, my, nd.rect)) {
          const id = nd.n.id;
          if (e.ctrlKey || e.metaKey) { ui.sel.delete(id); render(); return; }
          if (e.shiftKey) { if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id); render(); return; }
          if (!ui.sel.has(id)) { ui.sel.clear(); ui.sel.add(id); }
          ui.drag = { mode: 'node', ox: mx, oy: my, items: [...ui.sel].map(sid => { const n2 = nodeOf(sid); return n2 && { id: sid, nx: n2.x, ny: n2.y }; }).filter(Boolean) };
          render(); return;
        }
      }
      // 와이어 삭제
      for (const wh of H.wires) if (Math.hypot(mx - wh.mid[0], my - wh.mid[1]) < 12 * (devicePixelRatio || 1)) { pushGraphUndo(); graph.wires = graph.wires.filter(w => w !== wh.w); apply(); return; }
      // 빈 곳 좌드래그 = 박스 선택 (GH — 화면 이동은 우클릭/휠클릭 드래그)
      ui.drag = { mode: 'box', x0: mx, y0: my, cur: [mx, my], shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, moved: 0 };
    });
    cv.addEventListener('pointermove', (e) => {
      const mx = e.offsetX * (devicePixelRatio || 1), my = e.offsetY * (devicePixelRatio || 1);
      if (!ui.drag) return;
      const d = ui.drag;
      if (d.mode === 'pan') { ui.view.x = d.vx + (mx - d.sx); ui.view.y = d.vy + (my - d.sy); render(); }
      else if (d.mode === 'node') { if (!d.gpushed) { d.gpushed = true; pushGraphUndo(); } for (const it of d.items) { const n = nodeOf(it.id); if (n) { n.x = it.nx + (mx - d.ox) / ui.view.s; n.y = it.ny + (my - d.oy) / ui.view.s; } } render(); }
      else if (d.mode === 'wire') { d.cur = [mx, my]; render(); }
      else if (d.mode === 'box') { d.cur = [mx, my]; d.moved = Math.max(d.moved, Math.abs(mx - d.x0) + Math.abs(my - d.y0)); render(); }
      else if (d.mode === 'slider') sliderSet(d.node, mx, d.rect);
    });
    cv.addEventListener('pointerup', (e) => {
      const mx = e.offsetX * (devicePixelRatio || 1), my = e.offsetY * (devicePixelRatio || 1);
      const d = ui.drag; ui.drag = null;
      if (d && d.mode === 'wire' && ui.hits) {
        for (const p of ui.hits.ports) if (p.io === 'in' && Math.hypot(mx - p.x, my - p.y) < 13 * (devicePixelRatio || 1)) { pushGraphUndo(); connect(d.fromNode, d.fromIdx, p.node, p.key); apply(); return; }
      }
      if (d && d.mode === 'box') { // 박스 선택 확정 (GH: 걸친 노드 모두 선택, Shift=추가, Ctrl=제거)
        if (d.moved < 4) { if (!d.shift && !d.ctrl) ui.sel.clear(); } // 빈 곳 클릭 = 선택 해제
        else {
          const g0 = G(Math.min(d.x0, d.cur[0]), Math.min(d.y0, d.cur[1]));
          const g1 = G(Math.max(d.x0, d.cur[0]), Math.max(d.y0, d.cur[1]));
          const hit = graph.nodes.filter(n => n.x < g1[0] && n.x + NW > g0[0] && n.y < g1[1] && n.y + nodeH(n) > g0[1]).map(n => n.id);
          if (d.ctrl) hit.forEach(id => ui.sel.delete(id));
          else { if (!d.shift) ui.sel.clear(); hit.forEach(id => ui.sel.add(id)); }
        }
      }
      render();
    });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); const mx = e.offsetX * (devicePixelRatio || 1), my = e.offsetY * (devicePixelRatio || 1);
      const gp = G(mx, my);
      // 델타 크기에 비례한 부드러운 줌 (고해상도 휠·트랙패드의 연속 이벤트 과잉 줌 방지, 이벤트당 최대 ±8%)
      let k = Math.pow(1.0008, -e.deltaY);
      k = Math.max(0.92, Math.min(1.08, k));
      ui.view.s = Math.max(0.3, Math.min(2.5, ui.view.s * k));
      const sp = S.apply(null, gp); ui.view.x += mx - sp[0]; ui.view.y += my - sp[1]; render();
    }, { passive: false });
    // 키보드 편집 (GH 규약) — 캡처 단계: 에디터가 열려 있으면 도면 단축키(Ctrl+Z 등)보다 우선
    window.addEventListener('keydown', (e) => {
      if (!ui.open) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = (typeof e.key === 'string' ? e.key : '').toLowerCase(); // key 없는 합성 이벤트 방어
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'Delete' || e.key === 'Backspace') {
        stop();
        if (ui.sel.size) { pushGraphUndo(); [...ui.sel].forEach(delNode); ui.sel.clear(); apply(); }
      } else if (mod && k === 'z') { stop(); e.shiftKey ? gRedoDo() : gUndoDo(); }
      else if (mod && k === 'y') { stop(); gRedoDo(); }
      else if (mod && k === 'c') { stop(); copySel(false); }
      else if (mod && k === 'x') { stop(); copySel(true); }
      else if (mod && k === 'v') { stop(); pasteClip(); }
      else if (mod && k === 's') { stop(); saveLogic(); }
      else if (mod && k === 'a') { stop(); ui.sel = new Set(graph.nodes.map(n => n.id)); render(); }
      else if (e.key === 'Escape') { if (ui.sel.size) { ui.sel.clear(); render(); } }
    }, true);
  }
  function sliderSet(id, mx, rect) { const n = nodeOf(id); const frac = Math.max(0, Math.min(1, (mx - rect[0]) / rect[2])); let v = n.params.min + frac * (n.params.max - n.params.min); const st = n.params.step || 1; v = Math.round(v / st) * st; n.params.v = +v.toFixed(4); apply(); }
  function editVal(id, key) {
    const n = nodeOf(id);
    if (key === '__cap') { // 도면 참조: 현재 선택 개체를 다시 가져오기
      const S2 = B().state;
      pushGraphUndo();
      n.sel = [...S2.selection].filter(sid => { const e = S2.entities.find(x => x.id === sid); return e && !e._gh; }).slice(0, 500);
      B().logLine('  ▷ 노드 [도면 참조]: 선택 개체 ' + n.sel.length + '개를 가져왔습니다', 'info');
      apply(); return;
    }
    if (key.indexOf('__t:') === 0) { // 수식 편집
      const pk = key.slice(4);
      const s3 = window.prompt('수식 입력 — 변수 x,y,z · 함수 sin cos tan sqrt abs min max floor round pow exp log · 상수 pi\n예: sin(x/1000)*500 + y', String(n.params[pk]));
      if (s3 == null) return;
      pushGraphUndo();
      n.params[pk] = String(s3).slice(0, 200);
      delete n._exprFn; apply(); return;
    }
    const cur = key === '__numv' ? n.params.v : n.inl[key];
    const s2 = window.prompt('값 입력:', String(cur)); if (s2 == null) return;
    const v = parseFloat(s2); if (!isFinite(v)) return;
    pushGraphUndo();
    if (key === '__numv') n.params.v = v; else n.inl[key] = v; apply();
  }
  const inRect = (x, y, r, pad) => { pad = pad || 0; return x >= r[0] - pad && x <= r[0] + r[2] + pad && y >= r[1] - pad && y <= r[1] + r[3] + pad; };

  // ---------- 오버레이 만들기 ----------
  const css = `
  /* 노드 버튼: 문서 탭 클러스터(#docTabs)의 맨 왼쪽에 탭처럼 배치 — 파일 탭과 높이·모서리 통일 */
  #ghFab{flex:0 0 auto;align-self:flex-end;display:flex;align-items:center;height:29px;padding:0 11px;
    border-radius:10px 10px 0 0;border:none;background:rgba(120,170,255,0.14);color:#9fd0ff;
    font:590 12px/1 system-ui;cursor:pointer;white-space:nowrap;}
  #ghFab:hover{background:rgba(120,170,255,0.24);color:#cfe6ff}
  #ghOv{position:fixed;inset:0;z-index:9500;display:none;background:#0c1322;flex-direction:column;font:13px system-ui;color:#dbe6ff;}
  #ghTop{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#101a30;border-bottom:1px solid #23314e;}
  #ghTop b{flex:1;font-size:14px}
  #ghTop button{background:#22314e;color:#dbe6ff;border:1px solid #34477a;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer}
  #ghTop button:hover{background:#2c3d63}
  #ghTop button.pri{background:#2a54b0;border-color:#356}
  #ghWrap{flex:1;display:flex;min-height:0}
  #ghPal{width:120px;background:#101a30;border-right:1px solid #23314e;overflow-y:auto;padding:6px}
  #ghPal .grp{font-size:10.5px;color:#7f95c8;margin:8px 4px 3px}
  #ghPal button{display:block;width:100%;text-align:left;background:#182238;color:#cfe0ff;border:1px solid #2a3a5c;border-radius:5px;padding:5px 7px;margin-bottom:3px;font-size:11.5px;cursor:pointer}
  #ghPal button:hover{background:#22304e}
  #ghCanWrap{flex:1;position:relative;min-width:0}
  #ghCv{width:100%;height:100%;display:block;cursor:default}
  #ghStat{position:absolute;left:8px;bottom:6px;font-size:11px;color:#8fa4d4;pointer-events:none}
  #ghCtrl{position:fixed;left:14px;bottom:64px;z-index:9000;width:238px;background:#111a30;border:1px solid #33406a;border-radius:10px;
    box-shadow:0 8px 26px rgba(0,0,0,.5);font:12px system-ui;color:#dbe6ff;display:none;overflow:hidden}
  #ghCtrl .hd{display:flex;align-items:center;padding:7px 10px;background:#16213c;border-bottom:1px solid #2a3760;font-weight:700;font-size:12.5px}
  #ghCtrl .hd span{flex:1}
  #ghCtrl .hd button{background:none;border:none;color:#8fa4d4;cursor:pointer;font-size:13px;padding:0 3px}
  #ghCtrl .bd{padding:8px 10px;max-height:46vh;overflow-y:auto}
  #ghCtrl .row{margin-bottom:9px}
  #ghCtrl .lb{display:flex;justify-content:space-between;color:#9fb2d8;font-size:11.5px;margin-bottom:2px}
  #ghCtrl .lb b{color:#eaf2ff;font-weight:600}
  #ghCtrl input[type=range]{width:100%;accent-color:#5ad1ff;height:18px;cursor:pointer}
  #ghCtrl .pv{background:#0e1730;border-radius:5px;padding:4px 8px;color:#8fe6c8;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #ghLib{position:absolute;top:52px;right:12px;z-index:10;width:260px;background:#111a30;border:1px solid #33406a;border-radius:10px;
    box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui;color:#dbe6ff;padding:8px;max-height:60vh;overflow-y:auto}
  #ghLib .hd{font-weight:700;font-size:12.5px;margin:2px 2px 8px}
  #ghLib .empty{color:#8fa4d4;padding:4px 2px 8px}
  #ghLib .row{display:flex;gap:5px;margin-bottom:5px}
  #ghLib .row .ld{flex:1;text-align:left;background:#182238;color:#cfe0ff;border:1px solid #2a3a5c;border-radius:6px;padding:6px 8px;cursor:pointer}
  #ghLib .row .ld:hover{background:#22304e}
  #ghLib .row .ld span{float:right;color:#7f95c8;font-size:10.5px}
  #ghLib .row .del{width:26px;background:#2a1b22;color:#ff9aa5;border:1px solid #5a2a38;border-radius:6px;cursor:pointer}
  #ghLib .close{display:block;width:100%;margin-top:4px;background:#22314e;color:#dbe6ff;border:1px solid #34477a;border-radius:6px;padding:5px;cursor:pointer}
  `;
  function el(t, a, html) { const e = document.createElement(t); if (a) for (const k in a) e.setAttribute(k, a[k]); if (html != null) e.innerHTML = html; return e; }
  function build() {
    document.head.appendChild(el('style', null, css));
    const fab = el('button', { id: 'ghFab' }, '◇ 노드');
    fab.addEventListener('click', toggle);
    ov = el('div', { id: 'ghOv' });
    const top = el('div', { id: 'ghTop' });
    top.appendChild(el('b', null, '◇ 파라메트릭 노드 에디터'));
    const bBake = el('button', { class: 'pri' }, '✔ 베이크(확정)'); bBake.addEventListener('click', () => { bake(); });
    const bClear = el('button', null, '프리뷰 지우기'); bClear.addEventListener('click', () => { clearPreview(); lastPreviewCount = 0; B().refresh(); render(); }); // 재생성 없이 프리뷰만 제거 (다음 편집 시 복귀)
    const bReset = el('button', null, '그래프 초기화'); bReset.addEventListener('click', () => { if (confirm('노드 그래프를 모두 지울까요? (Ctrl+Z로 복구 가능)')) { pushGraphUndo(); graph = { nodes: [], wires: [], seq: 1 }; ui.sel.clear(); apply(); } });
    const bSave = el('button', null, '💾 저장'); bSave.setAttribute('title', 'Ctrl+S — 노드 로직을 이름으로 저장'); bSave.addEventListener('click', saveLogic);
    const bLoad = el('button', null, '📂 불러오기'); bLoad.addEventListener('click', loadLogicUI);
    const bClose = el('button', null, '✕ 닫기'); bClose.addEventListener('click', toggle);
    top.appendChild(bBake); top.appendChild(bClear); top.appendChild(bReset); top.appendChild(bSave); top.appendChild(bLoad); top.appendChild(bClose);
    ov.appendChild(top);
    const wrap = el('div', { id: 'ghWrap' });
    const pal = el('div', { id: 'ghPal' });
    for (const cat of CATS) {
      pal.appendChild(el('div', { class: 'grp' }, cat));
      for (const type in DEFS) if (DEFS[type].cat === cat) {
        const b = el('button', null, DEFS[type].title);
        b.addEventListener('click', () => { pushGraphUndo(); const g = G(cv.width / 2, cv.height / 2); addNode(type, g[0] - NW / 2, g[1] - 20); apply(); });
        pal.appendChild(b);
      }
    }
    wrap.appendChild(pal);
    const cw = el('div', { id: 'ghCanWrap' });
    cv = el('canvas', { id: 'ghCv' }); cw.appendChild(cv);
    statEl = el('div', { id: 'ghStat' }, ''); cw.appendChild(statEl);
    wrap.appendChild(cw); ov.appendChild(wrap);
    document.body.appendChild(ov);
    // 노드 버튼을 문서 탭 클러스터 맨 왼쪽에 삽입 (renderDocTabs가 innerHTML을 재생성하므로 전역 참조로 매 렌더 후 재삽입)
    window.__nodeTabBtn = fab;
    const dt = document.getElementById('docTabs');
    if (dt) dt.insertBefore(fab, dt.firstChild);
    else document.body.appendChild(fab); // 폴백
    ctx = cv.getContext('2d');
    bindCanvas();
    buildCtrl();
  }
  // ---------- 컨트롤 패널 — 사용자는 노드 에디터 없이 슬라이더만 조작 (로직은 AI/에디터가, 사용은 여기서) ----------
  let ctrl, ctrlBody, ctrlHidden = false, ctrlSig = '';
  function buildCtrl() {
    ctrl = el('div', { id: 'ghCtrl' });
    const hd = el('div', { class: 'hd' });
    hd.appendChild(el('span', null, '🎛 패턴 컨트롤'));
    const bEd = el('button', { title: '노드 에디터 열기(고급)' }, '◇'); bEd.addEventListener('click', () => { if (!ui.open) toggle(); });
    const bX = el('button', { title: '닫기' }, '✕'); bX.addEventListener('click', () => { ctrlHidden = true; updateCtrl(); });
    hd.appendChild(bEd); hd.appendChild(bX);
    ctrl.appendChild(hd);
    ctrlBody = el('div', { class: 'bd' });
    ctrl.appendChild(ctrlBody);
    document.body.appendChild(ctrl);
  }
  function updateCtrl() {
    if (!ctrl) return;
    const sliders = graph.nodes.filter(n => n.type === 'slider');
    const panels = graph.nodes.filter(n => DEFS[n.type].panel);
    if ((!sliders.length && !panels.length) || ctrlHidden) { ctrl.style.display = 'none'; return; }
    ctrl.style.display = 'block';
    const sig = sliders.map(n => n.id + '/' + n.params.min + '/' + n.params.max + '/' + n.params.step + '/' + (n.label || '')).join('|') + '#' + panels.map(n => n.id + '/' + (n.label || '')).join('|');
    if (sig !== ctrlSig) { // 구조가 바뀌었을 때만 DOM 재구축 (드래그 중 재구축 방지)
      ctrlSig = sig;
      ctrlBody.innerHTML = '';
      for (const n of sliders) {
        const row = el('div', { class: 'row' });
        const lb = el('div', { class: 'lb' });
        lb.appendChild(el('b', null, n.label || '슬라이더'));
        const valEl = el('span', { 'data-v': n.id }, fmt(n.params.v));
        lb.appendChild(valEl);
        row.appendChild(lb);
        const inp = el('input', { type: 'range', min: n.params.min, max: n.params.max, step: n.params.step || 1, value: n.params.v });
        inp.addEventListener('pointerdown', () => pushGraphUndo()); // 드래그 1회 = undo 1단계
        inp.addEventListener('input', () => { const nn = nodeOf(n.id); if (!nn) return; nn.params.v = +inp.value; valEl.textContent = fmt(nn.params.v); apply(); });
        row.appendChild(inp);
        ctrlBody.appendChild(row);
      }
      for (const n of panels) {
        const row = el('div', { class: 'row' });
        const lb = el('div', { class: 'lb' }); lb.appendChild(el('b', null, n.label || '값'));
        row.appendChild(lb);
        row.appendChild(el('div', { class: 'pv', 'data-p': n.id }, panelText(n.id)));
        ctrlBody.appendChild(row);
      }
    } else { // 값만 갱신
      for (const n of sliders) { const e2 = ctrlBody.querySelector('[data-v="' + n.id + '"]'); if (e2) e2.textContent = fmt(n.params.v); }
      for (const n of panels) { const e2 = ctrlBody.querySelector('[data-p="' + n.id + '"]'); if (e2) e2.textContent = panelText(n.id); }
    }
  }
  function sizeCanvas() { const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1; cv.width = Math.max(2, r.width * dpr); cv.height = Math.max(2, r.height * dpr); }
  function toggle() {
    ui.open = !ui.open;
    ov.style.display = ui.open ? 'flex' : 'none';
    if (ui.open) { sizeCanvas(); if (!graph.nodes.length) seedExample(); apply(); render(); }
    else { B() && B().refresh(); }
  }
  function seedExample() { // 첫 진입 예시: 슬라이더 → 원 개수 배열
    const s = addNode('slider', -320, -40); s.params = { v: 5, min: 1, max: 12, step: 1 };
    const p = addNode('pt', -110, -60); const c = addNode('circle', 90, -60); c.inl.r = 300;
    const a = addNode('arrayL', 290, -30); a.inl.dx = 1000; a.inl.dy = 0;
    connect(p.id, 0, c.id, 'c'); connect(c.id, 0, a.id, 'geo'); connect(s.id, 0, a.id, 'count');
    ui.view = { x: cv.width / 2 - 40, y: cv.height / 2, s: 1 };
  }

  // ---------- 외부 API (AI 코워커 연동) ----------
  const okNum = v => typeof v === 'number' && isFinite(v) && Math.abs(v) <= 1e7;
  function specToGraph(list) { // 선언형 스펙 [{id,type,params?,inputs?}] → 그래프 (검증 + 자동 배치)
    const errors = [];
    const g = { nodes: [], wires: [], seq: 1 };
    const idMap = {};
    for (const s of list) {
      const def = DEFS[s && s.type];
      if (!def) { errors.push('알 수 없는 노드 type: ' + (s && s.type)); continue; }
      if (!s.id || idMap[s.id]) { errors.push('id 누락/중복: ' + (s.id || '(없음)')); continue; }
      const n = { id: 'n' + (g.seq++), type: s.type, x: 0, y: 0, params: {}, inl: {}, _spec: s };
      (def.params || []).forEach(p => n.params[p.k] = (s.params && okNum(s.params[p.k])) ? s.params[p.k] : p.def);
      if (def.textK && s.params && typeof s.params[def.textK] === 'string') n.params[def.textK] = String(s.params[def.textK]).slice(0, 200); // 수식 문자열 파라미터
      if (def.capture && Array.isArray(s.ids)) n.sel = s.ids.filter(v => Number.isFinite(v)).slice(0, 500); // 도면 참조 개체 id
      if (typeof s.label === 'string' && s.label) n.label = String(s.label).slice(0, 40); // 컨트롤 패널 표시용 라벨
      def.ins.forEach(i => { if (i.kind === 'num') n.inl[i.k] = i.def || 0; });
      idMap[s.id] = n;
      g.nodes.push(n);
    }
    for (const n of g.nodes) {
      const s = n._spec, def = DEFS[n.type];
      if (s.inputs) for (const k in s.inputs) {
        const ins = def.ins.find(i => i.k === k);
        if (!ins) { errors.push(s.id + ': 없는 입력 포트 "' + k + '"'); continue; }
        const v = s.inputs[k];
        if (typeof v === 'number') {
          if (ins.kind === 'num' && okNum(v)) n.inl[k] = v;
          else errors.push(s.id + '.' + k + ': 숫자 입력 불가/비정상');
        } else if (typeof v === 'string') {
          const ref = v.split(':'), src = idMap[ref[0]];
          if (!src) { errors.push(s.id + '.' + k + ': 참조 노드 "' + ref[0] + '" 없음'); continue; }
          g.wires.push({ from: { node: src.id, idx: Math.max(0, parseInt(ref[1] || '0', 10) || 0) }, to: { node: n.id, key: k } });
        }
      }
      delete n._spec;
    }
    // 자동 배치: 의존 깊이 = 열, 열 내 순서 = 행
    const depth = {}; g.nodes.forEach(n => depth[n.id] = 0);
    for (let it = 0; it < g.nodes.length; it++) {
      let ch = false;
      for (const w of g.wires) { const d = depth[w.from.node] + 1; if (d > depth[w.to.node] && d < 100) { depth[w.to.node] = d; ch = true; } }
      if (!ch) break;
    }
    const col = {};
    for (const n of g.nodes) { const d = depth[n.id]; col[d] = col[d] || 0; n.x = d * 230; n.y = col[d] * 150; col[d]++; }
    return { graph: g, errors };
  }
  window.WEBCAD_NODES = {
    types: () => Object.keys(DEFS).map(t => { const d = DEFS[t]; return { type: t, title: d.title, ins: d.ins.map(i => i.k + ':' + (i.kind || 'num')), params: (d.params || []).map(p => p.k), outs: d.outs.length }; }),
    setGraph: (list, opts) => {
      if (!Array.isArray(list) || !list.length) return { error: 'nodes 배열이 필요합니다.' };
      if (list.length > 60) return { error: '노드는 최대 60개까지 가능합니다.' };
      const r = specToGraph(list);
      if (!r.graph.nodes.length) return { error: '유효한 노드가 없습니다.', errors: r.errors };
      if (graph.nodes.length) pushGraphUndo(); // AI 교체도 Ctrl+Z로 복구 가능
      graph = r.graph;
      ui.view = { x: 80, y: 120, s: 1 };
      ui.sel.clear();
      ctrlHidden = false; ctrlSig = ''; // 사용자용 컨트롤 패널 표시 (노드 에디터는 열지 않음 — 고급 사용자만 ◇로)
      if (opts && opts.openEditor && !ui.open) toggle(); else { apply(); if (ui.open) render(); }
      const sliders = graph.nodes.filter(n => n.type === 'slider').map(n => n.label || '슬라이더');
      return { ok: true, nodes: graph.nodes.length, wires: graph.wires.length, previewEntities: lastPreviewCount, controlPanel: sliders, errors: r.errors.length ? r.errors : undefined };
    },
    getGraph: () => ({
      nodes: graph.nodes.map(n => {
        const def = DEFS[n.type], inputs = {};
        def.ins.forEach(i => {
          const w = graph.wires.find(w2 => w2.to.node === n.id && w2.to.key === i.k);
          if (w) inputs[i.k] = w.from.node + (w.from.idx ? ':' + w.from.idx : '');
          else if (i.kind === 'num') inputs[i.k] = n.inl[i.k];
        });
        const o = { id: n.id, type: n.type, params: n.params, inputs };
        if (def.capture) o.ids = n.sel || [];
        if (n.label) o.label = n.label;
        return o;
      }),
      previewEntities: lastPreviewCount,
    }),
    bake,
    clearGraph: () => { graph = { nodes: [], wires: [], seq: 1 }; clearPreview(); lastPreviewCount = 0; ctrlSig = ''; ui.sel.clear(); B().refresh(); if (ui.open) render(); updateCtrl(); return { cleared: true }; },
    open: () => { if (!ui.open) toggle(); },
  };

  function init() { if (!window.WEBCAD_AI_BRIDGE) { setTimeout(init, 300); return; } build(); window.addEventListener('resize', () => { if (ui.open) { sizeCanvas(); render(); } }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // 테스트 훅
  window.__GH_TEST__ = { get graph() { return graph; }, DEFS, addNode, connect, delNode, evalGraph, apply, bake, clearPreview, get previewCount() { return lastPreviewCount; }, get hits() { return ui.hits; }, render, reset: () => { graph = { nodes: [], wires: [], seq: 1 }; }, open: () => { if (!ui.open) toggle(); }, isOpen: () => ui.open };
})();
