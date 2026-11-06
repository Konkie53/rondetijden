/* Rondetijden Trainer — overlay voor speedhive.mylaps.com
   Draait als bladwijzer in de browser van de trainer, op de Speedhive-site zelf.
   Gebruikt dezelfde publieke practice-gegevens die de site zelf toont. */
(() => {
  const NS = '__rtTrainer';
  if (window[NS]) { window[NS].toggle(); return; }
  if (!/(^|\.)speedhive\.mylaps\.com$/.test(location.hostname)) {
    alert('Open eerst speedhive.mylaps.com en tik daarna nog een keer op de bladwijzer.');
    location.href = 'https://speedhive.mylaps.com/practice';
    return;
  }

  const API = 'https://practice-api.speedhive.com/api/v1/';
  const KEY = 'rtTrainer.v1';
  const POLL_MS = 5000;
  const ACTIVE_MIN = 10;

  /* ---------- opslag ---------- */
  const today = () => new Date().toLocaleDateString('sv');
  const dayOf = iso => new Date(iso).toLocaleDateString('sv');
  const loadState = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const S = Object.assign({ rink: 2497, rinkName: 'Thialf Heerenveen', groups: [], names: {}, tab: 'ice', pauseFactor: 1.6, showEarlier: false, hist: null }, loadState());
  if (!S.hist || S.hist.day !== today()) S.hist = { day: today(), rink: S.rink, acts: {} };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };

  /* ---------- runtime ---------- */
  const R = {
    rinks: null, today: new Map(), laps: new Map(), sel: new Set(), detail: null,
    lastOk: 0, err: null, timer: null, tick: null, open: true, q: '', first: true, busy: false, wake: null
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseDur = str => str ? String(str).split(':').reduce((a, p) => a * 60 + parseFloat(p), 0) : NaN;
  const fmt = (s, dec = 2) => {
    if (s == null || !isFinite(s)) return '–';
    const f = Math.pow(10, dec); s = Math.round(s * f) / f;
    const m = Math.floor(s / 60), r = (s - m * 60).toFixed(dec);
    return m ? m + ':' + r.padStart(dec ? dec + 3 : 2, '0') : r;
  };
  const fmtAgo = sec => sec < 60 ? Math.max(0, Math.round(sec)) + ' s' : Math.floor(sec / 60) + ':' + String(Math.round(sec % 60)).padStart(2, '0');
  const clock = ms => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const nameOf = chip => S.names[chip] || (latestAct(chip) || {}).chipLabel || chip;
  const getJSON = async path => {
    const r = await fetch(API + path);
    if (!r.ok) { const e = new Error('Speedhive gaf ' + r.status); e.status = r.status; throw e; }
    return r.json();
  };

  function latestAct(chip) {
    let best = null;
    for (const a of R.today.values()) if (a.chipCode === chip && (!best || a.endTime > best.endTime)) best = a;
    if (!best) { const h = S.hist.acts[chip]; if (h) for (const id in h) { const x = h[id]; if (!best || x.e > best.endTime) best = { id: +id, chipCode: chip, chipLabel: x.l, startTime: x.s, endTime: x.e }; } }
    return best;
  }
  function actsOf(chip) {
    const m = new Map();
    const h = S.hist.acts[chip]; if (h) for (const id in h) m.set(+id, { id: +id, endTime: h[id].e });
    for (const a of R.today.values()) if (a.chipCode === chip) m.set(a.id, a);
    return [...m.values()];
  }
  const groupChips = () => new Set(S.groups.flatMap(g => g.chips));
  const groupOfChip = chip => S.groups.filter(g => g.chips.includes(chip));
  const activeGroup = () => S.groups.find(g => g.id === S.tab);

  /* ---------- rondes per schaatser ---------- */
  function lapsOf(chip) {
    const all = [];
    for (const a of actsOf(chip)) { const L = R.laps.get(a.id); if (L) all.push(...L.laps); }
    all.sort((x, y) => x.t - y.t);
    const out = []; let lastT = -1;
    for (const l of all) if (l.t !== lastT) { out.push(l); lastT = l.t; }
    const med = median(out.map(l => l.d));
    out.forEach((l, i) => {
      l.pause = out.length >= 3 && l.d > med * S.pauseFactor;
      const p = out[i - 1];
      l.gap = p ? Math.max(0, (l.t - (p.t + p.d * 1000)) / 1000) : 0; /* tijd van het ijs tussen twee sessies */
    });
    return out;
  }
  const deniedAll = chip => { const as = actsOf(chip); return as.length > 0 && as.every(a => (R.laps.get(a.id) || {}).denied); };
  function lastPassOf(chip, laps) {
    const last = laps[laps.length - 1], act = latestAct(chip);
    return Math.max(last ? last.t + last.d * 1000 : 0, act ? Date.parse(act.endTime) : 0);
  }
  function blocksOf(laps) {
    const blocks = []; let cur = null;
    for (const l of laps) {
      if (l.gap > 5) { if (cur) { blocks.push(cur); cur = null; } blocks.push({ off: true, gap: l.gap, from: l.t - l.gap * 1000 }); }
      if (l.pause) { if (cur) { blocks.push(cur); cur = null; } blocks.push({ pause: true, lap: l }); continue; }
      if (!cur) cur = { laps: [] };
      cur.laps.push(l);
    }
    if (cur) blocks.push(cur);
    return blocks;
  }
  function lapClass(d, g, prev) {
    if (g && g.target) return d <= g.target ? 'good' : d <= g.target + 0.5 ? 'ok' : 'bad';
    if (prev == null) return '';
    return d < prev - 0.05 ? 'good' : d > prev + 0.05 ? 'bad' : 'ok';
  }

  /* ---------- data ophalen ---------- */
  async function loadRinks() {
    try {
      const c = JSON.parse(localStorage.getItem(KEY + '.rinks') || 'null');
      if (c && Date.now() - c.t < 7 * 864e5) { R.rinks = c.list; return; }
    } catch (e) {}
    try {
      const j = await getJSON('locations?sportCategory=NonMotorized');
      R.rinks = (j.locations || []).filter(l => l.sport === 'IceSkating')
        .map(l => ({ id: l.id, name: l.name.trim(), c: l.country || '' }))
        .sort((a, b) => (a.c === 'nl' ? 0 : 1) - (b.c === 'nl' ? 0 : 1) || a.c.localeCompare(b.c) || a.name.localeCompare(b.name));
      try { localStorage.setItem(KEY + '.rinks', JSON.stringify({ t: Date.now(), list: R.rinks })); } catch (e) {}
    } catch (e) { R.rinks = []; }
    render();
  }

  async function fetchLaps(act) {
    let j;
    try { j = await getJSON('training/activities/' + act.id + '/sessions'); }
    catch (e) { if (e.status === 401 || e.status === 403) { R.laps.set(act.id, { end: act.endTime, laps: [], denied: true }); return; } throw e; }
    const laps = [];
    for (const s of j.sessions || []) for (const l of s.laps || []) {
      const d = parseDur(l.duration), t = Date.parse(l.dateTimeStart);
      if (isFinite(d) && isFinite(t)) laps.push({ t, d });
    }
    R.laps.set(act.id, { end: act.endTime, laps });
  }

  async function refreshLaps() {
    const chips = new Set();
    const g = activeGroup(); if (g) g.chips.forEach(c => chips.add(c));
    if (R.detail) chips.add(R.detail);
    const todo = [];
    for (const c of chips) for (const a of actsOf(c)) {
      const L = R.laps.get(a.id);
      if (!L || (!L.denied && L.end !== a.endTime)) todo.push(a);
    }
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(a => fetchLaps(a).catch(() => {})));
  }

  async function poll() {
    clearTimeout(R.timer);
    if (!R.open) return;
    if (document.hidden || R.busy) { R.timer = setTimeout(poll, POLL_MS); return; }
    R.busy = true;
    try {
      const j = await getJSON('locations/' + S.rink + '/activities?count=' + (R.first ? 400 : 150) + '&offset=0');
      R.first = false;
      const t = today(), gc = groupChips();
      if (S.hist.day !== t || S.hist.rink !== S.rink) S.hist = { day: t, rink: S.rink, acts: {} };
      for (const a of j.activities || []) {
        if (dayOf(a.endTime) !== t) continue;
        R.today.set(a.id, a);
        if (gc.has(a.chipCode)) (S.hist.acts[a.chipCode] = S.hist.acts[a.chipCode] || {})[a.id] = { s: a.startTime, e: a.endTime, l: a.chipLabel };
      }
      save();
      await refreshLaps();
      R.lastOk = Date.now(); R.err = null;
    } catch (e) { R.err = e.message || String(e); }
    R.busy = false;
    render();
    R.timer = setTimeout(poll, POLL_MS);
  }
  const pollNow = () => { R.busy = false; poll(); };

  /* ---------- scherm ---------- */
  const host = document.createElement('div');
  host.id = 'rt-trainer-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host{all:initial}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  .app{--bg:#f4f6f9;--card:#fff;--ink:#0f1a2a;--mute:#5d6b7e;--line:#dde3ea;--acc:#0b63ce;--accInk:#fff;--good:#13854a;--goodBg:#e3f4ea;--ok:#8a6100;--okBg:#fbf1d6;--bad:#c22a2a;--badBg:#fbe5e5;--pause:#8794a5;
    position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
    font:16px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
  @media (prefers-color-scheme:dark){.app{--bg:#0d1117;--card:#161c26;--ink:#e8edf4;--mute:#93a0b2;--line:#283140;--acc:#4c9bff;--accInk:#06101f;--good:#4fd18b;--goodBg:#123323;--ok:#f0c04a;--okBg:#352b10;--bad:#ff7070;--badBg:#3a1717;--pause:#6c7889}}
  header{padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;background:var(--card);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
  .row{display:flex;align-items:center;gap:8px}
  .grow{flex:1;min-width:0}
  select,input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-height:40px;width:100%}
  button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-height:40px;cursor:pointer;white-space:nowrap}
  button.pri{background:var(--acc);border-color:var(--acc);color:var(--accInk);font-weight:600}
  button.ghost{background:none;border-color:transparent;padding:8px}
  .live{font-size:13px;color:var(--mute);white-space:nowrap}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--pause);margin-right:5px;vertical-align:1px}
  .dot.on{background:var(--good)} .dot.err{background:var(--bad)}
  nav{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;background:var(--card);border-bottom:1px solid var(--line);scrollbar-width:none}
  nav::-webkit-scrollbar{display:none}
  nav button{border-radius:999px;padding:6px 14px;min-height:36px}
  nav button.on{background:var(--ink);color:var(--card);border-color:var(--ink);font-weight:600}
  main{flex:1;overflow-y:auto;padding:12px 12px calc(env(safe-area-inset-bottom) + 90px);-webkit-overflow-scrolling:touch}
  .muted{color:var(--mute)} .small{font-size:13px}
  .empty{padding:32px 12px;text-align:center;color:var(--mute)}
  .list{display:flex;flex-direction:column;gap:6px}
  .sk{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 10px 10px 12px}
  .sk.sel{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
  .sk.off{opacity:.6}
  .chk{width:24px;height:24px;border-radius:7px;border:2px solid var(--line);flex:none;display:grid;place-items:center;font-size:15px;font-weight:700}
  .sk.sel .chk{background:var(--acc);border-color:var(--acc);color:var(--accInk)}
  .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{display:inline-block;font-size:12px;padding:1px 7px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--mute);margin:2px 4px 0 0}
  .bar{position:fixed;left:0;right:0;bottom:0;padding:10px 12px calc(env(safe-area-inset-bottom) + 10px);background:var(--card);border-top:1px solid var(--line);display:flex;gap:8px;overflow-x:auto}
  .ghead{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .ghead h2{font-size:20px;margin:0;flex:1;min-width:120px}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;cursor:pointer}
  .ctop{display:flex;align-items:baseline;gap:8px}
  .big{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.5px;line-height:1.1}
  .big.good{color:var(--good)} .big.bad{color:var(--bad)} .big.ok{color:var(--ok)}
  .delta{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
  .delta.good{color:var(--good)} .delta.bad{color:var(--bad)} .delta.ok{color:var(--mute)}
  .stats{display:flex;gap:14px;font-size:13px;color:var(--mute);margin:4px 0 8px;flex-wrap:wrap}
  .stats b{color:var(--ink);font-variant-numeric:tabular-nums}
  .strip{display:flex;gap:5px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .strip::-webkit-scrollbar{display:none}
  .lap{flex:none;font-size:14px;font-variant-numeric:tabular-nums;padding:4px 7px;border-radius:7px;background:var(--bg);border:1px solid var(--line)}
  .lap.good{background:var(--goodBg);border-color:transparent;color:var(--good)}
  .lap.ok{background:var(--okBg);border-color:transparent;color:var(--ok)}
  .lap.bad{background:var(--badBg);border-color:transparent;color:var(--bad)}
  .lap.best{font-weight:700;box-shadow:inset 0 0 0 2px currentColor}
  .lap.p{color:var(--pause);background:none;border-style:dashed}
  .rest{color:var(--ok);font-weight:600}
  .modal{position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2}
  .blk{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px}
  .blk h3{font-size:15px;margin:0 0 6px;display:flex;justify-content:space-between;gap:8px}
  .lr{display:grid;grid-template-columns:34px 78px 1fr 52px;align-items:center;gap:8px;font-variant-numeric:tabular-nums;font-size:15px;padding:3px 0}
  .lr .n{color:var(--mute);font-size:13px}
  .lr .t{font-weight:600}
  .lr .t.good{color:var(--good)} .lr .t.bad{color:var(--bad)} .lr .t.ok{color:var(--ok)}
  .lr .b{height:10px;border-radius:5px;background:var(--acc);opacity:.75}
  .lr .c{color:var(--mute);font-size:12px;text-align:right}
  .prow{color:var(--pause);font-size:14px;padding:6px 2px;margin-bottom:8px;border-left:3px dashed var(--line);padding-left:10px}
  .err{background:var(--badBg);color:var(--bad);border-radius:10px;padding:8px 10px;font-size:14px;margin-bottom:10px}
  .settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--mute);margin-top:18px}
  .settings input{width:80px}
  </style><div class="app"></div>`;
  const app = root.querySelector('.app');

  function headerHTML() {
    const ok = R.lastOk && Date.now() - R.lastOk < 20000;
    const opts = (R.rinks && R.rinks.length ? R.rinks : [{ id: S.rink, name: S.rinkName, c: 'nl' }])
      .map(r => `<option value="${r.id}"${r.id === S.rink ? ' selected' : ''}>${esc(r.name)}${r.c && r.c !== 'nl' ? ' (' + esc(r.c.toUpperCase()) + ')' : ''}</option>`).join('');
    return `<header>
      <div class="row">
        <div class="grow"><select data-a="rink" aria-label="IJsbaan">${opts}</select></div>
        <span class="live"><span class="dot ${R.err ? 'err' : ok ? 'on' : ''}"></span>${R.err ? 'fout' : ok ? 'live' : 'laden…'}</span>
        <button class="ghost" data-a="close" aria-label="Sluiten">✕</button>
      </div>
      ${S.tab === 'ice' ? `<input data-a="q" type="search" placeholder="Zoek naam of transponder…" value="${esc(R.q)}" autocomplete="off">` : ''}
    </header>
    <nav>
      <button data-a="tab" data-v="ice" class="${S.tab === 'ice' ? 'on' : ''}">Op het ijs</button>
      ${S.groups.map(g => `<button data-a="tab" data-v="${g.id}" class="${S.tab === g.id ? 'on' : ''}">${esc(g.name)} · ${g.chips.length}</button>`).join('')}
      <button data-a="newgroup">+ Groep</button>
    </nav>`;
  }

  function iceHTML() {
    const now = Date.now(), byChip = new Map();
    for (const a of R.today.values()) { const b = byChip.get(a.chipCode); if (!b || a.endTime > b.endTime) byChip.set(a.chipCode, a); }
    const q = R.q.trim().toLowerCase();
    let rows = [...byChip.values()].map(a => ({ a, chip: a.chipCode, name: nameOf(a.chipCode), ago: (now - Date.parse(a.endTime)) / 1000 }));
    const activeCount = rows.filter(r => r.ago < ACTIVE_MIN * 60).length;
    if (!S.showEarlier) rows = rows.filter(r => r.ago < ACTIVE_MIN * 60);
    if (q) rows = rows.filter(r => (r.name + ' ' + r.chip + ' ' + r.a.chipLabel).toLowerCase().includes(q));
    rows.sort((x, y) => (x.ago < ACTIVE_MIN * 60 ? 0 : 1) - (y.ago < ACTIVE_MIN * 60 ? 0 : 1) || x.name.localeCompare(y.name, 'nl', { sensitivity: 'base' }));
    const list = rows.map(r => {
      const sel = R.sel.has(r.chip), off = r.ago >= ACTIVE_MIN * 60;
      const gs = groupOfChip(r.chip).map(g => `<span class="tag">${esc(g.name)}</span>`).join('');
      return `<div class="sk${sel ? ' sel' : ''}${off ? ' off' : ''}" data-a="pick" data-v="${esc(r.chip)}">
        <div class="chk">${sel ? '✓' : ''}</div>
        <div class="grow"><div class="nm">${esc(r.name)}</div>
          <div class="small muted">${r.name !== r.chip ? esc(r.chip) + ' · ' : ''}sinds ${clock(Date.parse(r.a.startTime))} · ${off ? 'weg sinds ' + clock(Date.parse(r.a.endTime)) : 'gezien ' + fmtAgo(r.ago) + ' geleden'}</div>${gs}</div>
        <button class="ghost" data-a="detail" data-v="${esc(r.chip)}" aria-label="Rondetijden">›</button>
      </div>`;
    }).join('');
    const head = `<div class="row small muted" style="margin-bottom:8px;justify-content:space-between">
      <span>${activeCount} schaatser${activeCount === 1 ? '' : 's'} op het ijs</span>
      <button class="ghost small" data-a="earlier">${S.showEarlier ? 'Alleen op het ijs' : 'Ook eerder vandaag'}</button></div>`;
    const empty = R.lastOk ? `<div class="empty">${q ? 'Niemand gevonden met “' + esc(R.q) + '”.' : 'Nu niemand op het ijs bij deze baan.'}</div>` : `<div class="empty">Gegevens laden…</div>`;
    return head + (list ? `<div class="list">${list}</div>` : empty) + `<div class="empty small">Tik schaatsers aan om ze in een groep te zetten. Tik op › voor hun rondetijden.</div>`;
  }

  function selBarHTML() {
    if (S.tab !== 'ice' || !R.sel.size) return '';
    return `<div class="bar">
      <button class="pri" data-a="mkgroup">Nieuwe groep (${R.sel.size})</button>
      ${S.groups.map(g => `<button data-a="addto" data-v="${g.id}">+ ${esc(g.name)}</button>`).join('')}
      <button class="ghost" data-a="clearsel">Wissen</button></div>`;
  }

  function cardHTML(chip, g) {
    const laps = lapsOf(chip), act = latestAct(chip), now = Date.now();
    const valid = laps.filter(l => !l.pause);
    const last = laps[laps.length - 1];
    const lastValid = valid[valid.length - 1], prevValid = valid[valid.length - 2];
    const best = valid.length ? Math.min(...valid.map(l => l.d)) : NaN;
    const lapBlocks = blocksOf(laps).filter(b => b.laps), curBlock = lapBlocks.length ? lapBlocks[lapBlocks.length - 1].laps : [];
    const lastPass = lastPassOf(chip, laps);
    const since = lastPass ? (now - lastPass) / 1000 : NaN;
    const resting = lastValid && since > lastValid.d * 1.6;
    const offIce = !act || since > ACTIVE_MIN * 60;
    const shown = last && !last.pause ? last : lastValid;
    const cls = shown ? lapClass(shown.d, g, prevValid && shown === lastValid ? prevValid.d : null) : '';
    let delta = '';
    if (shown && prevValid && shown === lastValid) { const dd = shown.d - prevValid.d; delta = `<span class="delta ${dd < -0.05 ? 'good' : dd > 0.05 ? 'bad' : 'ok'}">${dd > 0 ? '+' : dd < 0 ? '−' : '±'}${Math.abs(dd).toFixed(2)}</span>`; }
    const chips = [...laps].reverse().slice(0, 16).map((l, i, arr) => {
      const sep = l.gap > 5 ? `<span class="lap p">ijs af</span>` : '';
      if (l.pause) return `<span class="lap p">rust</span>` + sep;
      const prev = arr.slice(i + 1).find(x => !x.pause);
      return `<span class="lap ${lapClass(l.d, g, prev ? prev.d : null)}${l.d === best ? ' best' : ''}">${fmt(l.d, 1)}</span>` + sep;
    }).join('');
    const status = offIce ? `<span class="muted">niet op het ijs</span>` : resting ? `<span class="rest">rust ${fmtAgo(since)}</span>` : `<span>${fmtAgo(since)} geleden</span>`;
    return `<div class="card" data-a="detail" data-v="${esc(chip)}">
      <div class="row"><div class="nm grow">${esc(nameOf(chip))}</div><span class="small">${laps.length ? status : ''}</span></div>
      ${laps.length ? `<div class="ctop"><span class="big ${cls}">${fmt(shown ? shown.d : NaN)}</span>${delta}</div>
      <div class="stats"><span>ronde <b>${valid.length}</b></span><span>beste <b>${fmt(best)}</b></span><span>gem. blok <b>${fmt(avg(curBlock.map(l => l.d)))}</b></span>${g && g.target ? `<span>doel <b>${fmt(g.target)}</b></span>` : ''}</div>
      <div class="strip">${chips}</div>`
      : `<div class="small muted" style="padding:8px 0">${deniedAll(chip) ? '🔒 Deze schaatser heeft de rondetijden in Speedhive op privé staan.' : act ? 'Rondes laden…' : 'Vandaag nog niet gezien op deze baan.'}</div>`}
    </div>`;
  }

  function groupHTML(g) {
    const cards = g.chips.map(c => cardHTML(c, g)).join('');
    return `<div class="ghead"><h2>${esc(g.name)}</h2>
      <button data-a="target">🎯 ${g.target ? fmt(g.target) : 'Doeltijd'}</button>
      <button data-a="rengroup" aria-label="Naam wijzigen">✎</button>
      <button data-a="delgroup" aria-label="Groep verwijderen">🗑</button></div>
      ${g.chips.length ? `<div class="cards">${cards}</div>` : `<div class="empty">Nog niemand in deze groep. Ga naar “Op het ijs” en tik schaatsers aan.</div>`}
      <div class="settings"><span>Rust als ronde langer is dan</span><input data-a="pf" type="number" step="0.1" min="1.1" max="5" value="${S.pauseFactor}"><span>× de mediaan</span></div>`;
  }

  function detailHTML(chip) {
    const g = activeGroup();
    const laps = lapsOf(chip), valid = laps.filter(l => !l.pause);
    const best = valid.length ? Math.min(...valid.map(l => l.d)) : NaN;
    const blocks = blocksOf(laps);
    let bi = 0;
    const body = blocks.map(b => {
      if (b.off) return `<div class="prow">van het ijs · ${fmtAgo(b.gap)} (vanaf ${clock(b.from)})</div>`;
      if (b.pause) return `<div class="prow">rust · ${fmt(b.lap.d, 0)} (vanaf ${clock(b.lap.t)})</div>`;
      bi++;
      const ds = b.laps.map(l => l.d), mn = Math.min(...ds), mx = Math.max(...ds), span = Math.max(mx - mn, 0.5);
      const rows = b.laps.map((l, i) => {
        const w = 30 + 70 * (1 - (l.d - mn) / span);
        return `<div class="lr"><span class="n">${i + 1}</span><span class="t ${lapClass(l.d, g, i ? b.laps[i - 1].d : null)}">${fmt(l.d)}${l.d === best ? ' ★' : ''}</span><span class="b" style="width:${w.toFixed(0)}%"></span><span class="c">${clock(l.t + l.d * 1000)}</span></div>`;
      }).join('');
      return `<div class="blk"><h3><span>Blok ${bi} · ${b.laps.length} ronde${b.laps.length === 1 ? '' : 's'}</span><span class="muted small">gem. ${fmt(avg(ds))} · beste ${fmt(mn)}</span></h3>${rows}</div>`;
    }).reverse().join('');
    const inGroup = g && g.chips.includes(chip);
    return `<div class="modal"><header>
      <div class="row"><button class="ghost" data-a="back">‹ Terug</button><div class="nm grow">${esc(nameOf(chip))}</div>
      <button data-a="rename" data-v="${esc(chip)}">✎ Naam</button></div>
      <div class="small muted">${esc(chip)} · ${valid.length} rondes · beste ${fmt(best)} · gem. ${fmt(avg(valid.map(l => l.d)))}${inGroup ? ` · <button class="ghost small" data-a="remove" data-v="${esc(chip)}">uit ${esc(g.name)} halen</button>` : ''}</div>
    </header><main>${laps.length ? '<div class="small muted" style="margin-bottom:8px">Nieuwste blok bovenaan.</div>' + body : '<div class="empty">' + (deniedAll(chip) ? '🔒 Rondetijden staan in Speedhive op privé. De schaatser kan dat zelf aanzetten in de Speedhive-app.' : latestAct(chip) ? 'Rondes laden…' : 'Vandaag nog geen rondes op deze baan.') + '</div>'}</main></div>`;
  }

  function render() {
    if (!R.open) return;
    const ae = root.activeElement;
    if (ae && ae.dataset && (ae.dataset.a === 'q' || ae.dataset.a === 'pf')) { renderMainOnly(); return; }
    const sc = [...app.querySelectorAll('main')].map(m => m.scrollTop);
    const ss = [...app.querySelectorAll('.strip')].map(s => s.scrollLeft);
    app.innerHTML = headerHTML() + `<main>${mainHTML()}</main>` + selBarHTML() + (R.detail ? detailHTML(R.detail) : '');
    app.querySelectorAll('main').forEach((m, i) => { if (sc[i]) m.scrollTop = sc[i]; });
    app.querySelectorAll('.strip').forEach((s, i) => { if (ss[i]) s.scrollLeft = ss[i]; });
  }
  function mainHTML() {
    const g = activeGroup();
    if (S.tab !== 'ice' && !g) S.tab = 'ice';
    return (R.err ? `<div class="err">Kan Speedhive nu niet bereiken (${esc(R.err)}). Ik probeer het elke ${POLL_MS / 1000} s opnieuw.</div>` : '') + (g ? groupHTML(g) : iceHTML());
  }
  function renderMainOnly() {
    const m = app.querySelector('main'); if (!m) return;
    const sc = m.scrollTop; m.innerHTML = mainHTML(); m.scrollTop = sc;
    const old = app.querySelector('.bar'); const nb = selBarHTML();
    if (old) old.outerHTML = nb || ''; else if (nb) m.insertAdjacentHTML('afterend', nb);
  }

  /* ---------- acties ---------- */
  const addChips = (g, chips) => { for (const c of chips) if (!g.chips.includes(c)) g.chips.push(c); };
  function rememberActs(chips) {
    for (const a of R.today.values()) if (chips.includes(a.chipCode)) (S.hist.acts[a.chipCode] = S.hist.acts[a.chipCode] || {})[a.id] = { s: a.startTime, e: a.endTime, l: a.chipLabel };
  }
  app.addEventListener('click', ev => {
    const el = ev.target.closest('[data-a]'); if (!el) return;
    const a = el.dataset.a, v = el.dataset.v;
    if (a === 'q' || a === 'rink' || a === 'pf') return;
    ev.stopPropagation();
    const g = activeGroup();
    switch (a) {
      case 'close': hide(); return;
      case 'tab': S.tab = v; R.detail = null; save(); render(); pollNow(); return;
      case 'pick': R.sel.has(v) ? R.sel.delete(v) : R.sel.add(v); render(); return;
      case 'clearsel': R.sel.clear(); render(); return;
      case 'earlier': S.showEarlier = !S.showEarlier; save(); render(); return;
      case 'newgroup': case 'mkgroup': {
        const name = prompt('Naam van de groep?', 'Groep ' + (S.groups.length + 1)); if (!name) return;
        const ng = { id: 'g' + uid(), name: name.trim().slice(0, 30), chips: [], target: null };
        if (a === 'mkgroup') { addChips(ng, [...R.sel]); rememberActs([...R.sel]); R.sel.clear(); }
        S.groups.push(ng); S.tab = ng.id; save(); render(); pollNow(); return;
      }
      case 'addto': { const tg = S.groups.find(x => x.id === v); if (!tg) return; addChips(tg, [...R.sel]); rememberActs([...R.sel]); R.sel.clear(); save(); render(); return; }
      case 'rengroup': { const n = prompt('Nieuwe naam voor de groep?', g.name); if (n) { g.name = n.trim().slice(0, 30); save(); render(); } return; }
      case 'delgroup': if (confirm('Groep “' + g.name + '” verwijderen? De schaatsers blijven gewoon zichtbaar bij “Op het ijs”.')) { S.groups = S.groups.filter(x => x !== g); S.tab = 'ice'; save(); render(); } return;
      case 'target': {
        const n = prompt('Doeltijd per ronde voor “' + g.name + '” (bijv. 32.5 of 1:05.0). Leeg = geen doeltijd.', g.target ? fmt(g.target) : '');
        if (n === null) return; const t = parseDur(n.replace(',', '.')); g.target = isFinite(t) && t > 0 ? t : null; save(); render(); return;
      }
      case 'detail': R.detail = v; render(); pollNow(); return;
      case 'back': R.detail = null; render(); return;
      case 'rename': { const n = prompt('Naam voor transponder ' + v + ' (alleen op dit toestel)', S.names[v] || nameOf(v)); if (n === null) return; if (n.trim()) S.names[v] = n.trim().slice(0, 40); else delete S.names[v]; save(); render(); return; }
      case 'remove': if (g) { g.chips = g.chips.filter(c => c !== v); R.detail = null; save(); render(); } return;
    }
  });
  app.addEventListener('input', ev => {
    const el = ev.target;
    if (el.dataset.a === 'q') { R.q = el.value; renderMainOnly(); }
  });
  app.addEventListener('change', ev => {
    const el = ev.target;
    if (el.dataset.a === 'rink') {
      S.rink = +el.value; const r = (R.rinks || []).find(x => x.id === S.rink); S.rinkName = r ? r.name : '';
      R.today.clear(); R.laps.clear(); R.sel.clear(); R.first = true; R.lastOk = 0;
      S.hist = { day: today(), rink: S.rink, acts: {} }; save(); render(); pollNow();
    }
    if (el.dataset.a === 'pf') { const f = parseFloat(el.value); if (f >= 1.1 && f <= 5) { S.pauseFactor = f; save(); el.blur(); render(); } }
  });

  /* ---------- open / dicht ---------- */
  async function wake() { try { if (navigator.wakeLock && !document.hidden) R.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  const onVis = () => { if (!document.hidden && R.open) { wake(); pollNow(); } };
  const prevOverflow = document.documentElement.style.overflow;
  function show() {
    R.open = true; host.style.display = ''; document.documentElement.style.overflow = 'hidden';
    wake(); render(); pollNow();
    R.tick = setInterval(() => render(), 1000);
  }
  function hide() {
    R.open = false; host.style.display = 'none'; document.documentElement.style.overflow = prevOverflow;
    clearTimeout(R.timer); clearInterval(R.tick);
    try { R.wake && R.wake.release(); } catch (e) {} R.wake = null;
  }
  window[NS] = { toggle: () => (R.open ? hide() : show()) };
  document.addEventListener('visibilitychange', onVis);
  document.body.appendChild(host);
  loadRinks();
  show();
})();
