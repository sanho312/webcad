// ============================================================
//  WebCAD AI 코워크 챗봇 — 자연어로 작도·3D 작업 (Anthropic Claude, 사용자 API 키)
//  cad.js의 WEBCAD_AI_BRIDGE를 통해 도면을 직접 조작한다.
// ============================================================
(function () {
  'use strict';
  const LS = 'webcad_ai_cfg';
  const MODELS = [
    ['claude-sonnet-5', 'Sonnet 5 (권장)'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5 (빠름·저렴)'],
    ['claude-opus-4-8', 'Opus 4.8 (고급)'],
  ];
  let cfg = { key: '', model: MODELS[0][0] };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}
  function saveCfg() { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} }
  const B = () => window.WEBCAD_AI_BRIDGE;

  // ---------- 시스템 프롬프트 ----------
  const SYSTEM = [
    '당신은 WebCAD(웹 기반 2D 도면·3D BIM 편집기)에 내장된 한국어 CAD 코워커입니다.',
    '사용자의 자연어 요청을 도구 호출로 실제 도면 작업으로 옮깁니다.',
    '',
    '# 좌표계·단위',
    '- 단위 mm, 평면 = XY, 높이 = Z(위+). 각도는 도(deg), 반시계 +.',
    '',
    '# 개체 스키마 (add_entities)',
    '- LINE {x1,y1,x2,y2, z1?,z2?} — z를 주면 3D 선',
    '- LWPOLYLINE {points:[[x,y],...], closed?} — 닫힌 다각형은 closed:true 필수',
    '- CIRCLE {cx,cy,r} / ARC {cx,cy,r,startAngle,endAngle(도, 반시계)}',
    '- TEXT {x,y,text,height?}',
    '- SPHERE {cx,cy,cz,r} / CONE {cx,cy,base_z,r,h} — 3D 메시로 생성됨',
    '- 공통 옵션: layer?, color?(#hex), bim?',
    '',
    '# BIM(3D 입체) — bim 필드를 붙이면 입체가 됨',
    '- 벽: LINE + bim {kind:"wall", h:높이, t:두께, base:바닥z} (예 h:2400,t:100,base:0)',
    '- 기둥/박스(돌출 솔리드): 닫힌 LWPOLYLINE 또는 CIRCLE + bim {kind:"column", h:높이, base:바닥z}',
    '- 슬래브(바닥판): 닫힌 LWPOLYLINE + bim {kind:"slab", t:두께, top:윗면z}',
    '- bim 없는 도형은 평면 밑그림(높이 0)으로만 보임.',
    '',
    '# 작업 원칙',
    '1. 기존 도면을 다루는 요청이면 먼저 get_drawing으로 현황을 파악하라.',
    '2. 새 도형은 기존 도면과 겹치지 않게 배치하고, 치수가 모호하면 건축 상식적 기본값을 쓰고 보고에 명시하라.',
    '3. 여러 개체는 한 번의 add_entities로 묶어서 생성하라.',
    '4. 3D 결과물을 만들었으면 set_view {mode:"3d", fit:true}로 보여줘라.',
    '5. 끝나면 무엇을 어떤 치수로 만들었는지 1~3문장으로 간단히 보고하라. 되돌리기는 실행취소(Ctrl+Z) 안내.',
    '6. 파괴적 작업(전체 삭제 등)은 사용자가 명시했을 때만.',
  ].join('\n');

  // ---------- 도구 정의 ----------
  const num = { type: 'number' };
  const TOOLS = [
    {
      name: 'get_drawing', description: '현재 도면 상태(레이어·층·선택·개체 목록)를 요약해 반환. 기존 도면을 다루기 전에 호출.',
      input_schema: { type: 'object', properties: { detail: { type: 'boolean', description: 'true면 개체별 좌표 포함(최대 150개)' } } },
    },
    {
      name: 'add_entities', description: '개체들을 생성한다(최대 200개). 반환: 생성된 id 목록.',
      input_schema: {
        type: 'object', required: ['entities'],
        properties: { entities: { type: 'array', items: { type: 'object' }, description: '시스템 프롬프트의 개체 스키마를 따르는 객체 배열' } },
      },
    },
    {
      name: 'update_entities', description: '개체 속성 수정(얕은 병합, bim은 필드 단위 병합). 예: bim.h 변경, layer 이동.',
      input_schema: {
        type: 'object', required: ['updates'],
        properties: { updates: { type: 'array', items: { type: 'object', required: ['id', 'set'], properties: { id: num, set: { type: 'object' } } } } },
      },
    },
    {
      name: 'delete_entities', description: '개체 삭제.',
      input_schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: num } } },
    },
    {
      name: 'transform_entities', description: '개체 이동/회전. move: dx,dy,dz(mm). rotate: 중심(cx,cy) 기준 deg도(수평 회전).',
      input_schema: {
        type: 'object', required: ['ids', 'op'],
        properties: { ids: { type: 'array', items: num }, op: { type: 'string', enum: ['move', 'rotate'] }, dx: num, dy: num, dz: num, cx: num, cy: num, deg: num },
      },
    },
    {
      name: 'boolean_op', description: '3D 불리언. keep(베이스)에 cutter를 합/차/교집합. 대상은 BIM 솔리드 또는 메시.',
      input_schema: {
        type: 'object', required: ['op', 'keep_ids', 'cutter_ids'],
        properties: { op: { type: 'string', enum: ['union', 'subtract', 'intersect'] }, keep_ids: { type: 'array', items: num }, cutter_ids: { type: 'array', items: num } },
      },
    },
    {
      name: 'set_view', description: '뷰 전환/맞춤. mode 2d|3d, fit=전체보기.',
      input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['2d', '3d'] }, fit: { type: 'boolean' } } },
    },
    {
      name: 'select_entities', description: '개체를 선택 상태로 표시(사용자에게 보여주기용).',
      input_schema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: num } } },
    },
  ];

  // ---------- 도구 실행 ----------
  let turnPushed = false; // 사용자 요청 1건 = undo 1단계
  function ensureUndo() { if (!turnPushed) { B().pushUndo(); turnPushed = true; } }

  function entSummary(e, detail) {
    const o = { id: e.id, type: e.type, layer: e.layer };
    if (e.bim) o.bim = e.bim;
    if (!detail) { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); return o; }
    switch (e.type) {
      case 'LINE': o.x1 = e.x1; o.y1 = e.y1; o.x2 = e.x2; o.y2 = e.y2; if (e.z1 != null) { o.z1 = e.z1; o.z2 = e.z2; } break;
      case 'LWPOLYLINE': o.points = e.points.map(p => [Math.round(p[0]), Math.round(p[1])]); o.closed = !!e.closed; break;
      case 'CIRCLE': o.cx = e.cx; o.cy = e.cy; o.r = e.r; break;
      case 'ARC': o.cx = e.cx; o.cy = e.cy; o.r = e.r; o.startAngle = e.startAngle; o.endAngle = e.endAngle; break;
      case 'TEXT': o.x = e.x; o.y = e.y; o.text = e.text; break;
      case 'MESH': o.tris = e.tris.length; { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); } break;
      default: { const bb = safeBBox(e); if (bb) o.bbox = [bb.xmin, bb.ymin, bb.xmax, bb.ymax].map(Math.round); }
    }
    if (e.zo) o.zo = e.zo;
    return o;
  }
  function safeBBox(e) { try { return B().entityBBox(e); } catch (err) { return null; } }

  function toolGetDrawing(inp) {
    const S = B().state;
    const ents = S.entities.slice(0, 150).map(e => entSummary(e, inp && inp.detail));
    return {
      units: 'mm', view: B().is3D() ? '3d' : '2d',
      layers: S.layers.map(l => l.name), currentLayer: S.currentLayer,
      levels: S.levels, currentLevel: S.curLv || 0,
      selection: [...S.selection],
      totalEntities: S.entities.length,
      truncated: S.entities.length > 150,
      entities: ents,
    };
  }

  function toolAddEntities(inp) {
    const list = (inp && inp.entities) || [];
    if (!Array.isArray(list) || !list.length) return { error: 'entities 배열이 비어 있습니다.' };
    if (list.length > 200) return { error: '한 번에 최대 200개까지 생성할 수 있습니다.' };
    ensureUndo();
    const ids = [], errors = [];
    for (const spec of list) {
      try {
        const e = buildEntity(spec);
        if (typeof e === 'string') { errors.push(e); continue; }
        ids.push(e.id);
      } catch (err) { errors.push(String(err && err.message || err)); }
    }
    return { created: ids.length, ids, errors: errors.length ? errors.slice(0, 10) : undefined };
  }
  const fin = v => typeof v === 'number' && isFinite(v);
  function buildEntity(s) {
    const t = String(s.type || '').toUpperCase();
    let base = null;
    if (t === 'LINE') {
      if (![s.x1, s.y1, s.x2, s.y2].every(fin)) return 'LINE 좌표 누락';
      base = { type: 'LINE', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
      if (fin(s.z1) || fin(s.z2)) { base.z1 = s.z1 || 0; base.z2 = s.z2 || 0; }
    } else if (t === 'LWPOLYLINE') {
      if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(p => Array.isArray(p) && fin(p[0]) && fin(p[1]))) return 'LWPOLYLINE points 형식 오류';
      base = { type: 'LWPOLYLINE', points: s.points.map(p => [p[0], p[1]]), closed: !!s.closed };
    } else if (t === 'CIRCLE') {
      if (![s.cx, s.cy, s.r].every(fin) || s.r <= 0) return 'CIRCLE cx,cy,r 오류';
      base = { type: 'CIRCLE', cx: s.cx, cy: s.cy, r: s.r };
    } else if (t === 'ARC') {
      if (![s.cx, s.cy, s.r, s.startAngle, s.endAngle].every(fin) || s.r <= 0) return 'ARC 필드 오류';
      base = { type: 'ARC', cx: s.cx, cy: s.cy, r: s.r, startAngle: s.startAngle, endAngle: s.endAngle };
    } else if (t === 'TEXT') {
      if (![s.x, s.y].every(fin) || !s.text) return 'TEXT 필드 오류';
      base = { type: 'TEXT', x: s.x, y: s.y, text: String(s.text), height: fin(s.height) ? s.height : 250 };
    } else if (t === 'SPHERE') {
      if (![s.cx, s.cy, s.cz, s.r].every(fin) || s.r <= 0) return 'SPHERE 필드 오류';
      base = { type: 'MESH', tris: B().meshSphere(s.cx, s.cy, s.cz, s.r, 24, 12), name: 'sphere' };
    } else if (t === 'CONE') {
      if (![s.cx, s.cy, s.base_z, s.r, s.h].every(fin) || s.r <= 0 || s.h <= 0) return 'CONE 필드 오류';
      base = { type: 'MESH', tris: B().meshCone(s.cx, s.cy, s.base_z, s.r, s.h, 24), name: 'cone' };
    } else return '지원하지 않는 type: ' + t;
    if (s.layer) base.layer = String(s.layer);
    const e = B().addEntity(base);
    if (s.color && /^#[0-9a-fA-F]{6}$/.test(s.color)) e.color = s.color;
    if (s.bim && typeof s.bim === 'object' && s.bim.kind) {
      const ok = (s.bim.kind === 'wall' && t === 'LINE') ||
                 (s.bim.kind === 'column' && (t === 'LWPOLYLINE' || t === 'CIRCLE')) ||
                 (s.bim.kind === 'slab' && t === 'LWPOLYLINE');
      if (ok) e.bim = JSON.parse(JSON.stringify(s.bim));
      if (e.bim && e.bim.kind === 'wall') { if (!fin(e.bim.h)) e.bim.h = 2400; if (!fin(e.bim.t)) e.bim.t = 100; if (!fin(e.bim.base)) e.bim.base = 0; }
      if (e.bim && e.bim.kind === 'column') { if (!fin(e.bim.h)) e.bim.h = 2400; if (!fin(e.bim.base)) e.bim.base = 0; }
      if (e.bim && e.bim.kind === 'slab') { if (!fin(e.bim.t)) e.bim.t = 150; if (!fin(e.bim.top)) e.bim.top = 0; }
    }
    return e;
  }

  function byIds(ids) {
    const S = B().state;
    return (ids || []).map(id => S.entities.find(e => e.id === id)).filter(Boolean);
  }
  function toolUpdateEntities(inp) {
    const ups = (inp && inp.updates) || [];
    if (!ups.length) return { error: 'updates가 비어 있습니다.' };
    ensureUndo();
    let done = 0; const missing = [];
    for (const u of ups) {
      const e = B().state.entities.find(x => x.id === u.id);
      if (!e) { missing.push(u.id); continue; }
      const set = u.set || {};
      for (const k of Object.keys(set)) {
        if (k === 'id' || k === 'type') continue;
        if (k === 'bim' && typeof set.bim === 'object' && e.bim) Object.assign(e.bim, set.bim);
        else e[k] = set[k];
      }
      done++;
    }
    return { updated: done, missing: missing.length ? missing : undefined };
  }
  function toolDeleteEntities(inp) {
    const ids = new Set((inp && inp.ids) || []);
    if (!ids.size) return { error: 'ids가 비어 있습니다.' };
    ensureUndo();
    const S = B().state;
    const before = S.entities.length;
    S.entities = S.entities.filter(e => !ids.has(e.id));
    for (const id of ids) S.selection.delete(id);
    return { deleted: before - S.entities.length };
  }
  function toolTransform(inp) {
    const ents = byIds(inp.ids);
    if (!ents.length) return { error: '대상 개체를 찾지 못했습니다.' };
    ensureUndo();
    if (inp.op === 'move') {
      for (const e of ents) B().move3DEnt(e, inp.dx || 0, inp.dy || 0, inp.dz || 0);
      return { moved: ents.length, dx: inp.dx || 0, dy: inp.dy || 0, dz: inp.dz || 0 };
    }
    if (inp.op === 'rotate') {
      if (![inp.cx, inp.cy, inp.deg].every(fin)) return { error: 'rotate에는 cx,cy,deg가 필요합니다.' };
      for (const e of ents) B().gumRotate(e, 'z', inp.cx, inp.cy, 0, inp.deg);
      return { rotated: ents.length, deg: inp.deg };
    }
    return { error: '지원하지 않는 op' };
  }
  function toolBoolean(inp) {
    const keep = byIds(inp.keep_ids), cut = byIds(inp.cutter_ids);
    if (!keep.length || !cut.length) return { error: 'keep/cutter 개체를 찾지 못했습니다.' };
    const bad = keep.concat(cut).filter(e => !B().isBoolable(e));
    if (bad.length) return { error: '불리언 불가 개체: ' + bad.map(e => e.id + '(' + e.type + ')').join(', ') + ' — BIM 솔리드/메시만 가능' };
    B().runBoolean(inp.op, keep, cut); // 내부에서 pushUndo
    const sel = [...B().state.selection];
    return { op: inp.op, resultIds: sel };
  }
  function feedCmd(s) {
    const inp = document.getElementById('cmdInput');
    if (!inp) return false;
    inp.value = s;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }
  function toolSetView(inp) {
    const is3 = B().is3D();
    if (inp.mode === '3d' && !is3) feedCmd('3d');
    if (inp.mode === '2d' && is3) feedCmd('3d');
    if (inp.fit) feedCmd('zoom');
    return { view: B().is3D() ? '3d' : '2d' };
  }
  function toolSelect(inp) {
    const S = B().state;
    S.selection.clear();
    let n = 0;
    for (const e of byIds(inp.ids)) { S.selection.add(e.id); n++; }
    return { selected: n };
  }

  function execTool(name, input) {
    try {
      switch (name) {
        case 'get_drawing': return toolGetDrawing(input);
        case 'add_entities': return toolAddEntities(input);
        case 'update_entities': return toolUpdateEntities(input);
        case 'delete_entities': return toolDeleteEntities(input);
        case 'transform_entities': return toolTransform(input);
        case 'boolean_op': return toolBoolean(input);
        case 'set_view': return toolSetView(input);
        case 'select_entities': return toolSelect(input);
        default: return { error: '알 수 없는 도구: ' + name };
      }
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  }

  // ---------- Anthropic API ----------
  async function callClaude(messages) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: cfg.model, max_tokens: 4096, system: SYSTEM, tools: TOOLS, messages }),
    });
    if (!res.ok) {
      let msg = 'API 오류 ' + res.status;
      try { const j = await res.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  // ---------- 에이전트 루프 ----------
  let history = [];
  let busy = false;
  const TOOL_KO = { get_drawing: '도면 파악', add_entities: '개체 생성', update_entities: '속성 수정', delete_entities: '삭제', transform_entities: '이동/회전', boolean_op: '불리언', set_view: '뷰 전환', select_entities: '선택 표시' };

  async function send(text) {
    if (busy) return;
    busy = true; setBusy(true);
    turnPushed = false;
    history.push({ role: 'user', content: text });
    try {
      let rounds = 0;
      while (rounds++ < 8) {
        const resp = await callClaude(history);
        history.push({ role: 'assistant', content: resp.content });
        for (const b of resp.content) if (b.type === 'text' && b.text.trim()) addMsg('ai', b.text);
        const uses = resp.content.filter(b => b.type === 'tool_use');
        if (!uses.length || resp.stop_reason !== 'tool_use') break;
        const results = [];
        for (const tu of uses) {
          addMsg('tool', '🔧 ' + (TOOL_KO[tu.name] || tu.name));
          const out = execTool(tu.name, tu.input || {});
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 20000) });
        }
        try { B().refresh(); } catch (e) {}
        history.push({ role: 'user', content: results });
      }
      // 히스토리 길이 관리: 앞에서부터 '문자열 user 메시지'가 맨 앞이 되도록 잘라냄 (tool 짝 고아 방지)
      while (history.length > 34) {
        history.shift();
        while (history.length && !(history[0].role === 'user' && typeof history[0].content === 'string')) history.shift();
      }
    } catch (err) {
      addMsg('err', String(err && err.message || err));
    }
    busy = false; setBusy(false);
  }

  // ---------- UI ----------
  const css = `
  #aiFab{position:fixed;right:14px;bottom:14px;z-index:9000;width:46px;height:46px;border-radius:50%;border:1px solid #3a4a6a;
    background:#16213c;color:#eaf2ff;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45);}
  #aiFab:hover{background:#1d2b4f}
  #aiPanel{position:fixed;right:14px;bottom:68px;z-index:9001;width:360px;max-width:calc(100vw - 28px);height:500px;max-height:calc(100vh - 90px);
    display:none;flex-direction:column;background:#111a30;border:1px solid #33406a;border-radius:12px;overflow:hidden;
    box-shadow:0 10px 34px rgba(0,0,0,.55);font:13px/1.5 -apple-system,system-ui,sans-serif;color:#dbe6ff;}
  #aiHead{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#16213c;border-bottom:1px solid #2a3760;}
  #aiHead b{flex:1;font-size:13px}
  #aiHead select{background:#0e1730;color:#cfe0ff;border:1px solid #2a3760;border-radius:6px;font-size:11px;padding:2px 4px;max-width:130px}
  #aiHead button{background:none;border:none;color:#8fa4d4;font-size:14px;cursor:pointer;padding:2px 5px}
  #aiHead button:hover{color:#fff}
  #aiMsgs{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
  .aiM{max-width:92%;padding:7px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
  .aiM.user{align-self:flex-end;background:#2a54b0;color:#fff;border-bottom-right-radius:3px}
  .aiM.ai{align-self:flex-start;background:#1b2748;border:1px solid #2a3760;border-bottom-left-radius:3px}
  .aiM.tool{align-self:flex-start;background:none;color:#7f95c8;font-size:11.5px;padding:0 4px}
  .aiM.err{align-self:flex-start;background:#3a1b22;border:1px solid #6a2a38;color:#ffb9c4}
  #aiInRow{display:flex;gap:6px;padding:8px;border-top:1px solid #2a3760;background:#16213c}
  #aiIn{flex:1;resize:none;height:38px;background:#0e1730;color:#eaf2ff;border:1px solid #2a3760;border-radius:8px;padding:7px 9px;font:13px/1.4 inherit}
  #aiSend{width:60px;border:none;border-radius:8px;background:#2a54b0;color:#fff;font-weight:700;cursor:pointer}
  #aiSend:disabled{opacity:.45;cursor:default}
  #aiSetup{padding:12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid #2a3760;background:#141f3a}
  #aiSetup input{background:#0e1730;color:#eaf2ff;border:1px solid #2a3760;border-radius:6px;padding:7px 9px;font-size:12px}
  #aiSetup .hint{font-size:11px;color:#8fa4d4}
  #aiSetup button{align-self:flex-start;background:#2a54b0;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px}
  `;

  function h(tag, attrs, html) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    if (html != null) el.innerHTML = html;
    return el;
  }
  let panel, msgsEl, inEl, sendBtn, setupEl;
  function buildUI() {
    document.head.appendChild(h('style', null, css));
    const fab = h('button', { id: 'aiFab', title: 'AI 코워커 (자연어 작도)' }, '🤖');
    fab.addEventListener('click', () => { panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex'; if (panel.style.display === 'flex') inEl.focus(); });
    panel = h('div', { id: 'aiPanel' });
    const head = h('div', { id: 'aiHead' });
    head.appendChild(h('b', null, '🤖 AI 코워커'));
    const modelSel = h('select', { title: '모델' });
    for (const [v, label] of MODELS) { const o = h('option', { value: v }, label); if (v === cfg.model) o.selected = true; modelSel.appendChild(o); }
    modelSel.addEventListener('change', () => { cfg.model = modelSel.value; saveCfg(); });
    head.appendChild(modelSel);
    const keyBtn = h('button', { title: 'API 키 설정' }, '⚙');
    keyBtn.addEventListener('click', () => { setupEl.style.display = setupEl.style.display === 'none' ? 'flex' : 'none'; });
    head.appendChild(keyBtn);
    const clrBtn = h('button', { title: '대화 초기화' }, '🗑');
    clrBtn.addEventListener('click', () => { history = []; msgsEl.innerHTML = ''; greet(); });
    head.appendChild(clrBtn);
    const closeBtn = h('button', { title: '닫기' }, '✕');
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    head.appendChild(closeBtn);
    panel.appendChild(head);
    // 키 설정
    setupEl = h('div', { id: 'aiSetup' });
    setupEl.innerHTML = `
      <div class="hint">Anthropic API 키를 넣으면 활성화됩니다. 키는 <b>이 브라우저에만</b>(localStorage) 저장되며 서버로 전송되지 않습니다.
      키 발급: console.anthropic.com → API Keys</div>`;
    const keyIn = h('input', { type: 'password', placeholder: 'sk-ant-…' });
    keyIn.value = cfg.key || '';
    const keySave = h('button', null, '저장');
    keySave.addEventListener('click', () => {
      cfg.key = keyIn.value.trim(); saveCfg();
      setupEl.style.display = 'none';
      addMsg('ai', cfg.key ? 'API 키가 저장되었습니다. 무엇을 그려볼까요?' : 'API 키가 삭제되었습니다.');
    });
    setupEl.appendChild(keyIn); setupEl.appendChild(keySave);
    panel.appendChild(setupEl);
    msgsEl = h('div', { id: 'aiMsgs' });
    panel.appendChild(msgsEl);
    const row = h('div', { id: 'aiInRow' });
    inEl = h('textarea', { id: 'aiIn', placeholder: '예: 5000×4000 방 하나 벽 두께 150으로 그려줘' });
    inEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      e.stopPropagation(); // 앱 전역 단축키와 충돌 방지
    });
    sendBtn = h('button', { id: 'aiSend' }, '보내기');
    sendBtn.addEventListener('click', submit);
    row.appendChild(inEl); row.appendChild(sendBtn);
    panel.appendChild(row);
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    setupEl.style.display = cfg.key ? 'none' : 'flex';
    greet();
  }
  function greet() {
    addMsg('ai', '안녕하세요! 자연어로 작도를 도와드리는 AI 코워커입니다.\n예) "10평 원룸 평면 그려줘" · "이 벽들 높이 3000으로" · "기둥에서 구를 빼줘"' + (cfg.key ? '' : '\n\n먼저 ⚙에서 API 키를 설정해 주세요.'));
  }
  function addMsg(kind, text) {
    if (!msgsEl) return;
    const d = h('div', { class: 'aiM ' + kind });
    d.textContent = text;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  let busyEl = null;
  function setBusy(on) {
    if (sendBtn) sendBtn.disabled = on;
    if (on) { busyEl = h('div', { class: 'aiM tool' }, '⋯ 작업 중'); msgsEl.appendChild(busyEl); msgsEl.scrollTop = msgsEl.scrollHeight; }
    else if (busyEl) { busyEl.remove(); busyEl = null; }
  }
  function submit() {
    const t = (inEl.value || '').trim();
    if (!t || busy) return;
    if (!cfg.key) { setupEl.style.display = 'flex'; addMsg('err', 'API 키를 먼저 설정해 주세요 (⚙).'); return; }
    inEl.value = '';
    addMsg('user', t);
    send(t);
  }

  function init() {
    if (!window.WEBCAD_AI_BRIDGE) { setTimeout(init, 300); return; }
    buildUI();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 테스트 훅
  window.__WEBCAD_AI_TEST__ = { execTool, send, get history() { return history; }, get cfg() { return cfg; }, addMsg: (k, t) => addMsg(k, t) };
})();
