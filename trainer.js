/* Rondetijden Trainer — overlay voor speedhive.mylaps.com
   Draait als bladwijzer in de browser van de trainer, op de Speedhive-site zelf.
   Gebruikt dezelfde publieke practice-gegevens die de site zelf toont. */
(() => {
  const NS = '__rtTrainer';
  if (window[NS]) { (window[NS].show || window[NS].toggle)(); return; }
  if (!/(^|\.)speedhive\.mylaps\.com$/.test(location.hostname)) {
    alert('Open eerst speedhive.mylaps.com en tik daarna nog een keer op de bladwijzer.');
    location.href = 'https://speedhive.mylaps.com/practice/2497';
    return;
  }

  const VERSION = '4';
  const API = 'https://practice-api.speedhive.com/api/v1/';
  const KEY = 'rtTrainer.v1';
  const POLL_MS = 5000;
  const ACTIVE_MIN = 10;
  const HOME_RINK = 205;
  /* Nederlandse banen met MYLAPS-tijden waar nu geschaatst wordt (gecontroleerd november 2026).
     Hoorn staat bovenaan als hoofdbaan. Dubbele of gesloten banen (Flevonice, De Bonte Wever,
     CoolsteBaan, oude Uithof, Schaatsbaan Rotterdam, Thialf backup, Hoorn X2) staan er niet in. */
  const RINKS = [
    { id: 205, name: 'Hoorn · De Westfries' },
    { id: 2409, name: 'Alkmaar · De Meent' },
    { id: 2040, name: 'Amsterdam · Jaap Eden' },
    { id: 3111, name: 'Breda' },
    { id: 2392, name: 'Den Haag · De Uithof' },
    { id: 2052, name: 'Deventer · De Scheg' },
    { id: 3279, name: 'Eindhoven' },
    { id: 456, name: 'Enschede · IJsbaan Twente' },
    { id: 304668569, name: 'Geleen · Glanerbrook' },
    { id: 2427, name: 'Groningen · Kardinge' },
    { id: 2822, name: 'Haarlem' },
    { id: 2497, name: 'Heerenveen · Thialf' },
    { id: 2381, name: 'Leeuwarden · Elfstedenhal' },
    { id: 3930, name: 'Leiden · De Vliet' },
    { id: 1052, name: 'Nijmegen · Triavium' },
    { id: 2838, name: 'Tilburg · Ireen Wüst' },
    { id: 1061, name: 'Utrecht · De Vechtsebanen' }
  ];
  /* groepskleuren: bewust geen rood/groen, die betekenen sneller/langzamer */
  const COLORS = ['#2f6fed', '#f08c00', '#8e44d8', '#e0479e', '#0f9d9a', '#8a6a4b', '#4c51bf', '#6b8e23'];

  /* ---------- opslag ---------- */
  const today = () => new Date().toLocaleDateString('sv');
  const dayOf = iso => new Date(iso).toLocaleDateString('sv');
  const loadState = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const S = Object.assign({ rink: HOME_RINK, groups: [], names: {}, tab: 'ice', lapMin: 25, lapMax: 37, showEarlier: false, hist: null, rankScope: 'all', notify: true }, loadState());
  if (!S.names || typeof S.names !== 'object') S.names = {};
  if (!Array.isArray(S.groups)) S.groups = [];
  if (!(S.ver >= 3)) { S.rink = HOME_RINK; S.lapMin = 25; S.lapMax = 37; S.ver = 3; delete S.pauseFactor; delete S.rinkName; }
  if (!RINKS.some(r => r.id === S.rink)) S.rink = HOME_RINK;
  if (!(S.lapMin > 0 && S.lapMax > S.lapMin)) { S.lapMin = 25; S.lapMax = 37; }
  const nextColor = () => { const used = S.groups.map(g => g.color); return COLORS.find(c => !used.includes(c)) || COLORS[S.groups.length % COLORS.length]; };
  S.groups.forEach(g => { if (!COLORS.includes(g.color)) g.color = nextColor(); });
  if (!S.hist || S.hist.day !== today()) S.hist = { day: today(), rink: S.rink, acts: {} };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} };

  /* ---------- runtime ---------- */
  const R = {
    today: new Map(), laps: new Map(), sel: new Set(), detail: null,
    lastOk: 0, err: null, timer: null, tick: null, open: true, first: true, busy: false, wake: null,
    touching: false, lastTouch: 0, deferT: null, modal: false, q: '',
    recs: new Map(), recsReady: false, toastT: null
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseDur = str => str ? String(str).trim().split(':').reduce((a, p) => a * 60 + parseFloat(p), 0) : NaN;
  const fmt = (s, dec = 2) => {
    if (s == null || !isFinite(s)) return '–';
    const f = Math.pow(10, dec); s = Math.round(s * f) / f;
    const m = Math.floor(s / 60), r = (s - m * 60).toFixed(dec);
    return m ? m + ':' + r.padStart(dec ? dec + 3 : 2, '0') : r;
  };
  const fmtAgo = sec => sec < 60 ? Math.max(0, Math.round(sec)) + ' s' : Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  const clock = ms => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const median = a => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const uid = () => Math.random().toString(36).slice(2, 9);
  const normCode = c => { c = String(c || '').trim().toUpperCase().replace(/\s+/g, ''); return /^[A-Z]{2}\d{5}$/.test(c) ? c.slice(0, 2) + '-' + c.slice(2) : c; };
  const getJSON = async path => {
    const r = await fetch(API + path);
    if (!r.ok) { const e = new Error('Speedhive gaf ' + r.status); e.status = r.status; throw e; }
    return r.json();
  };

  /* namen: rijdernaam (door trainer ingevuld) > naam op transponder > code */
  const rider = chip => S.names[chip] || '';
  const tLabel = chip => { const a = latestAct(chip); return a && a.chipLabel && a.chipLabel !== chip ? a.chipLabel : ''; };
  const nameOf = chip => rider(chip) || tLabel(chip) || chip;
  const subOf = chip => { const r = rider(chip), l = tLabel(chip); return (r && l ? l + ' · ' : '') + (r || l ? chip : 'nog geen naam'); };

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
    for (const l of all) if (l.t !== lastT) { out.push(Object.assign({}, l)); lastT = l.t; }
    out.forEach((l, i) => {
      /* een ronde telt mee als hij binnen het venster valt (standaard 25–37 s);
         daarbuiten is het rust, een stijger of een halve ronde */
      l.pause = l.d < S.lapMin || l.d > S.lapMax;
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
      if (l.pause) {
        if (cur) { blocks.push(cur); cur = null; }
        const pb = blocks[blocks.length - 1];
        if (pb && pb.pause && !(l.gap > 5)) pb.out.push(l); else blocks.push({ pause: true, out: [l] });
        continue;
      }
      if (!cur) cur = { laps: [] };
      cur.laps.push(l);
    }
    if (cur) blocks.push(cur);
    return blocks;
  }
  /* snelste ronde die meetelt binnen een set rijders */
  function bestOf(chips) {
    let b = null;
    for (const c of chips) for (const l of lapsOf(c)) if (!l.pause && (!b || l.d < b.d)) b = { chip: c, d: l.d, t: l.t };
    return b;
  }
  const dc = s => fmt(s).replace('.', ',');
  const sec = s => String(+(+s).toFixed(2)).replace('.', ','); /* 25 → "25", 25.5 → "25,5" */
  const rinkName = () => (RINKS.find(r => r.id === S.rink) || RINKS[0]).name;
  function lapClass(d, g, prev) {
    if (g && g.target) return d <= g.target ? 'good' : d <= g.target + 0.5 ? 'ok' : 'bad';
    if (prev == null) return '';
    return d < prev - 0.05 ? 'good' : d > prev + 0.05 ? 'bad' : 'ok';
  }

  /* ---------- data ophalen ---------- */

  async function fetchLaps(act) {
    let j;
    try { j = await getJSON('training/activities/' + act.id + '/sessions'); }
    catch (e) { if (e.status === 401 || e.status === 403) { R.laps.set(act.id, { end: act.endTime, laps: [], denied: true }); return; } throw e; }
    const laps = [];
    for (const s of j.sessions || []) for (const l of s.laps || []) {
      const d = parseDur(l.duration), t = Date.parse(l.dateTimeStart);
      if (isFinite(d) && isFinite(t) && d > 0) laps.push({ t, d });
    }
    R.laps.set(act.id, { end: act.endTime, laps });
  }

  async function refreshLaps() {
    const chips = new Set();
    groupChips().forEach(c => chips.add(c)); /* alle groepen: voor klassement en meldingen */
    if (R.detail) chips.add(R.detail);
    const todo = [];
    for (const c of chips) for (const a of actsOf(c)) {
      const L = R.laps.get(a.id);
      if (!L || (!L.denied && L.end !== a.endTime)) todo.push(a);
    }
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(a => fetchLaps(a).catch(() => {})));
  }

  function remember(a) { (S.hist.acts[a.chipCode] = S.hist.acts[a.chipCode] || {})[a.id] = { s: a.startTime, e: a.endTime, l: a.chipLabel }; }

  async function poll() {
    clearTimeout(R.timer);
    if (!R.open) return;
    if (document.hidden || R.busy) { R.timer = setTimeout(poll, POLL_MS); return; }
    R.busy = true;
    const rink = S.rink;
    try {
      const j = await getJSON('locations/' + rink + '/activities?count=' + (R.first ? 400 : 150) + '&offset=0');
      if (rink !== S.rink) throw null; /* baan gewisseld tijdens het laden */
      R.first = false;
      const t = today(), gc = groupChips();
      if (S.hist.day !== t || S.hist.rink !== S.rink) S.hist = { day: t, rink: S.rink, acts: {} };
      for (const a of j.activities || []) {
        if (!a || !a.chipCode || dayOf(a.endTime) !== t) continue;
        R.today.set(a.id, a);
        if (gc.has(a.chipCode)) remember(a);
      }
      save();
      await refreshLaps();
      R.lastOk = Date.now(); R.err = null;
      checkRecords();
    } catch (e) { if (e) R.err = e.message || String(e); }
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
  .app{--bg:#f4f6f9;--card:#fff;--ink:#0f1a2a;--mute:#5d6b7e;--line:#dde3ea;--acc:#0b63ce;--accInk:#fff;--good:#13854a;--goodBg:#e3f4ea;--ok:#8a6100;--okBg:#fbf1d6;--bad:#c22a2a;--badBg:#fbe5e5;--pause:#8794a5;--scrim:rgba(10,20,35,.45);
    position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
    font:16px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
  @media (prefers-color-scheme:dark){.app{--bg:#0d1117;--card:#161c26;--ink:#e8edf4;--mute:#93a0b2;--line:#283140;--acc:#4c9bff;--accInk:#06101f;--good:#4fd18b;--goodBg:#123323;--ok:#f0c04a;--okBg:#352b10;--bad:#ff7070;--badBg:#3a1717;--pause:#6c7889;--scrim:rgba(0,0,0,.6)}}
  [hidden]{display:none!important}
  [data-a],[data-s]{cursor:pointer;touch-action:manipulation;-webkit-user-select:none;user-select:none}
  input,textarea,select{-webkit-user-select:text;user-select:text}
  .hdr{padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;background:var(--card);display:flex;align-items:center;gap:8px}
  .search{padding:0 12px 8px;background:var(--card)}
  .row{display:flex;align-items:center;gap:8px}
  .end{justify-content:flex-end}
  .grow{flex:1;min-width:0}
  select,input,textarea{font:inherit;font-size:16px;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 10px;min-height:42px;width:100%}
  textarea{font:14px/1.45 ui-monospace,Menlo,monospace;min-height:160px;resize:vertical}
  button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-height:42px;white-space:nowrap}
  button.pri{background:var(--acc);border-color:var(--acc);color:var(--accInk);font-weight:600}
  button.danger{background:var(--bad);border-color:var(--bad);color:#fff;font-weight:600}
  button.ghost{background:none;border-color:transparent;padding:8px 10px}
  button.icon{min-width:44px;padding:8px}
  .live{font-size:13px;color:var(--mute);white-space:nowrap}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--pause);margin-right:5px;vertical-align:1px}
  .dot.on{background:var(--good)} .dot.err{background:var(--bad)}
  nav{display:flex;gap:6px;overflow-x:auto;padding:8px 12px;background:var(--card);border-bottom:1px solid var(--line);scrollbar-width:none;flex:none}
  nav::-webkit-scrollbar{display:none}
  nav button{border-radius:999px;padding:6px 14px;min-height:38px;flex:none}
  nav button.on{background:var(--ink);color:var(--card);border-color:var(--ink);font-weight:600}
  main{flex:1;overflow-y:auto;padding:12px 12px calc(env(safe-area-inset-bottom) + 96px);-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
  .muted{color:var(--mute)} .small{font-size:13px}
  .empty{padding:28px 12px;text-align:center;color:var(--mute)}
  .list{display:flex;flex-direction:column;gap:6px}
  .sk{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 4px 8px 12px;min-height:60px}
  .sk.sel{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
  .sk.off{opacity:.6}
  .chk{width:26px;height:26px;border-radius:7px;border:2px solid var(--line);flex:none;display:grid;place-items:center;font-size:16px;font-weight:700}
  .sk.sel .chk{background:var(--acc);border-color:var(--acc);color:var(--accInk)}
  .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sub{font-size:13px;color:var(--mute);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .sub.noname{font-style:italic}
  .sub.wrap{white-space:normal}
  .hint{background:var(--card);border:1px solid var(--acc);border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:15px}
  .tag{display:inline-block;font-size:12px;padding:1px 7px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--mute);margin:3px 4px 0 0}
  .bar{position:fixed;left:0;right:0;bottom:0;padding:10px 12px calc(env(safe-area-inset-bottom) + 10px);background:var(--card);border-top:1px solid var(--line);display:flex;gap:8px;overflow-x:auto;box-shadow:0 -6px 20px -12px rgba(0,0,0,.35)}
  .ghead{display:flex;align-items:center;gap:6px;margin-bottom:10px}
  .ghead h2{font-size:20px;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ghead button{flex:none;padding-left:10px;padding-right:10px}
  .ghead .swatch{background:none;border-color:transparent;min-width:36px;padding:4px}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 12px 12px}
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
  .modal .hdr{flex-direction:column;align-items:stretch;border-bottom:1px solid var(--line)}
  .blk{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px}
  .blk h3{font-size:15px;margin:0 0 6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .lr{display:grid;grid-template-columns:30px 82px minmax(0,1fr) 46px;align-items:center;gap:8px;font-variant-numeric:tabular-nums;font-size:15px;padding:3px 0}
  .lr .n{color:var(--mute);font-size:13px}
  .lr .t{font-weight:600}
  .lr .t.good{color:var(--good)} .lr .t.bad{color:var(--bad)} .lr .t.ok{color:var(--ok)}
  .lr .b{height:10px;border-radius:5px;background:var(--acc);opacity:.75}
  .lr .c{color:var(--mute);font-size:12px;text-align:right}
  .prow{color:var(--pause);font-size:14px;margin-bottom:8px;border-left:3px dashed var(--line);padding:6px 2px 6px 10px}
  .err{background:var(--badBg);color:var(--bad);border-radius:10px;padding:8px 10px;font-size:14px;margin-bottom:10px}
  .settings{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--mute);margin-top:18px}
  .settings input{width:80px}
  .scrim{position:fixed;inset:0;background:var(--scrim);z-index:10}
  /* invulvenster bovenaan, zodat het toetsenbord er niet overheen valt */
  .sheet{position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top) + 10px);z-index:11;background:var(--card);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:12px;max-height:70vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.35)}
  .sheet h3{margin:0;font-size:19px}
  .sheet p{margin:0}
  .sheet .row button{flex:1}
  .sheet textarea{min-height:130px}
  @media (min-width:700px){.sheet{left:50%;right:auto;width:520px;transform:translateX(-50%);top:10vh}}
  /* tablet: wat groter, je kijkt van verder af */
  @media (min-width:700px){
    .app{font-size:17px}
    .big{font-size:52px}
    .delta{font-size:17px}
    .stats{font-size:14px}
    .lap{font-size:15px;padding:5px 8px}
    .cards{grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
    main{padding-left:16px;padding-right:16px}
  }
  .swatches{display:flex;gap:10px;flex-wrap:wrap}
  .swatches button{width:44px;height:44px;border-radius:50%;padding:0;border:3px solid transparent;background:var(--c);box-shadow:inset 0 0 0 2px var(--card)}
  .swatches button.on{border-color:var(--ink)}
  .card.gc{border-top:5px solid var(--gc)}
  .gdot{display:inline-block;width:11px;height:11px;border-radius:50%;background:var(--gc);margin-right:6px;vertical-align:0}
  nav button.on.g{background:var(--gc);border-color:var(--gc);color:#fff}
  nav button.on.g .gdot{background:#fff}
  .swatch .sw{display:block;width:22px;height:22px;border-radius:50%;background:var(--gc);margin:auto}
  .tag.g{border-color:var(--gc);color:var(--ink)}
  .tag.g::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--gc);margin-right:5px}
  .settings button{min-height:34px;padding:4px 12px}
  .scopes{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin-bottom:10px}
  .scopes::-webkit-scrollbar{display:none}
  .scopes button{border-radius:999px;padding:6px 14px;min-height:38px;flex:none}
  .scopes button.on{background:var(--ink);color:var(--card);border-color:var(--ink);font-weight:600}
  .scopes button.on.g{background:var(--gc);border-color:var(--gc);color:#fff}
  .scopes button.on.g .gdot{background:#fff}
  .rk{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 12px;min-height:60px}
  .rk.top{border-color:#c99a14;box-shadow:inset 0 0 0 1px #c99a14}
  .rk.none{opacity:.6}
  .rk .pos{font-size:22px;font-weight:700;text-align:center;font-variant-numeric:tabular-nums}
  .rk .tm{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;line-height:1.1}
  .rk .gp{font-size:13px;color:var(--mute);text-align:right;font-variant-numeric:tabular-nums}
  .tag.new{background:#c99a14;border-color:#c99a14;color:#fff;font-weight:600}
  .toast{position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top) + 62px);z-index:5;background:var(--gc);color:#fff;border-radius:16px;padding:12px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 12px 34px rgba(0,0,0,.35);animation:pop .35s ease-out}
  .toast .ti{font-size:34px;line-height:1}
  .toast .tn{font-size:22px;font-weight:700;line-height:1.2}
  .toast .tn b{font-variant-numeric:tabular-nums}
  .toast .small{opacity:.9}
  @keyframes pop{from{transform:translateY(-14px);opacity:0}}
  @media (min-width:700px){.toast{left:50%;right:auto;width:520px;transform:translateX(-50%);animation:none}.rk .tm{font-size:32px}}
  @media (prefers-reduced-motion:reduce){.toast{animation:none}}
  .fields{display:flex;gap:10px}
  .fields label{flex:1;font-size:13px;color:var(--mute);display:flex;flex-direction:column;gap:4px}
  </style><div class="app" lang="nl">
    <div class="hdr" id="hdr"></div>
    <div class="search" id="searchwrap"><input id="q" data-a="q" type="search" placeholder="Zoek rijder, naam of transponder…" autocomplete="off" autocorrect="off" spellcheck="false"></div>
    <nav id="nav"></nav>
    <main id="main"></main>
    <div id="bar"></div>
    <div id="toast"></div>
    <div class="modal" id="detail" hidden><div class="hdr" id="dhdr"></div><main id="dmain"></main></div>
  </div><div class="app" id="layerapp" style="position:static;inset:auto;display:block;background:none"><div id="layer"></div></div>`;
  const $ = id => root.getElementById(id);
  const app = root.querySelector('.app'), layer = $('layer'), qInput = $('q');
  const put = (el, html) => { if (el._h !== html) { el._h = html; el.innerHTML = html; return true; } return false; };

  /* ---------- eigen invulvenster (werkt ook waar prompt() geblokkeerd is) ---------- */
  function sheet(o) {
    return new Promise(resolve => {
      const hasInput = o.value !== undefined;
      const field = !hasInput ? '' : o.textarea
        ? `<textarea id="sin" rows="8" placeholder="${esc(o.placeholder || '')}" autocapitalize="words" spellcheck="false">${esc(o.value)}</textarea>`
        : `<input id="sin" type="text" value="${esc(o.value)}" placeholder="${esc(o.placeholder || '')}"${o.inputmode ? ` inputmode="${o.inputmode}"` : ''} autocomplete="off" autocapitalize="${o.inputmode ? 'off' : 'words'}" enterkeyhint="done">`;
      layer.innerHTML = `<div class="scrim" data-s="cancel"></div>
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
          <h3 id="sh-t">${esc(o.title)}</h3>${o.text ? `<p class="small muted">${o.text}</p>` : ''}${field}${o.extra || ''}
          <div class="row"><button data-s="cancel">Annuleren</button><button class="${o.danger ? 'danger' : 'pri'}" data-s="ok">${esc(o.ok || 'Opslaan')}</button></div>
        </div>`;
      R.modal = true;
      const inp = layer.querySelector('#sin') || layer.querySelector('input');
      const okVal = () => o.collect ? o.collect(layer) : hasInput ? inp.value : true;
      const done = v => { layer.innerHTML = ''; layer.onclick = null; R.modal = false; resolve(v); };
      layer.onclick = ev => {
        const b = ev.target.closest('[data-s]'); if (!b) return;
        ev.stopPropagation();
        if (b.dataset.s === 'ok') done(okVal());
        else if (b.dataset.s === 'cancel') done(null);
        else if (o.onExtra) o.onExtra(b.dataset.s, inp, b);
      };
      layer.querySelectorAll('input').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(okVal()); } }));
      if (inp) {
        try { inp.focus(); if (!o.textarea) inp.select(); } catch (e) {}
      }
    });
  }

  /* ---------- html-onderdelen ---------- */
  function headerHTML() {
    const opt = r => `<option value="${r.id}"${r.id === S.rink ? ' selected' : ''}>${esc(r.name)}</option>`;
    const opts = `<optgroup label="Hoofdbaan">${opt(RINKS[0])}</optgroup><optgroup label="Andere banen">${RINKS.slice(1).map(opt).join('')}</optgroup>`;
    return `<div class="grow"><select data-a="rink" aria-label="IJsbaan">${opts}</select></div>
      <span class="live" id="live"></span>
      <button class="ghost icon" data-a="names" aria-label="Namen van rijders">👤</button>
      <button class="ghost icon" data-a="close" aria-label="Sluiten">✕</button>`;
  }
  function navHTML() {
    return `<button data-a="tab" data-v="ice" class="${S.tab === 'ice' ? 'on' : ''}">Op het ijs</button>
      <button data-a="tab" data-v="rank" class="${S.tab === 'rank' ? 'on' : ''}">🏆 Klassement</button>
      ${S.groups.map(g => `<button data-a="tab" data-v="${esc(g.id)}" class="g${S.tab === g.id ? ' on' : ''}" style="--gc:${g.color}"><span class="gdot"></span>${esc(g.name)} · ${g.chips.length}</button>`).join('')}
      <button data-a="newgroup">+ Groep</button>`;
  }

  function iceHTML() {
    const now = Date.now(), byChip = new Map();
    for (const a of R.today.values()) { const b = byChip.get(a.chipCode); if (!b || a.endTime > b.endTime) byChip.set(a.chipCode, a); }
    const q = R.q.trim().toLowerCase();
    let rows = [...byChip.values()].map(a => ({ a, chip: a.chipCode, name: nameOf(a.chipCode), on: now - Date.parse(a.endTime) < ACTIVE_MIN * 60000 }));
    const activeCount = rows.filter(r => r.on).length;
    if (!S.showEarlier) rows = rows.filter(r => r.on || R.sel.has(r.chip));
    if (q) rows = rows.filter(r => (r.name + ' ' + r.chip + ' ' + (r.a.chipLabel || '') + ' ' + rider(r.chip)).toLowerCase().includes(q));
    rows.sort((x, y) => (x.on ? 0 : 1) - (y.on ? 0 : 1) || (rider(x.chip) ? 0 : 1) - (rider(y.chip) ? 0 : 1) || x.name.localeCompare(y.name, 'nl', { sensitivity: 'base' }));
    const list = rows.map(r => {
      const sel = R.sel.has(r.chip);
      const gs = groupOfChip(r.chip).map(g => `<span class="tag g" style="--gc:${g.color}">${esc(g.name)}</span>`).join('');
      const noname = !rider(r.chip) && !tLabel(r.chip);
      return `<div class="sk${sel ? ' sel' : ''}${r.on ? '' : ' off'}" data-a="pick" data-v="${esc(r.chip)}" role="checkbox" aria-checked="${sel}">
        <div class="chk" aria-hidden="true">${sel ? '✓' : ''}</div>
        <div class="grow"><div class="nm">${esc(r.name)}</div>
          <div class="sub${noname ? ' noname' : ''}">${esc(subOf(r.chip))}</div>
          <div class="sub wrap">sinds ${clock(Date.parse(r.a.startTime))} · ${r.on ? `<span data-ago="${Date.parse(r.a.endTime)}" data-mode="seen"></span>` : 'weg sinds ' + clock(Date.parse(r.a.endTime))}</div>${gs}</div>
        <button class="ghost icon" data-a="rename" data-v="${esc(r.chip)}" aria-label="Naam rijder">✎</button>
        <button class="ghost icon" data-a="detail" data-v="${esc(r.chip)}" aria-label="Rondetijden">›</button>
      </div>`;
    }).join('');
    const head = `<div class="row small muted" style="margin-bottom:8px;justify-content:space-between">
      <span>${activeCount} schaatser${activeCount === 1 ? '' : 's'} op het ijs</span>
      <button class="ghost small" data-a="earlier">${S.showEarlier ? 'Alleen op het ijs' : 'Ook eerder vandaag'}</button></div>`;
    const hg = R.hint && S.groups.find(x => x.id === R.hint);
    const hint = hg ? `<div class="hint" style="border-color:${hg.color}">Tik de rijders aan voor <b>${esc(hg.name)}</b> en tik daarna onderaan op <b>+ ${esc(hg.name)}</b>.</div>` : '';
    const empty = R.lastOk ? `<div class="empty">${q ? 'Niemand gevonden met “' + esc(R.q) + '”.' : 'Nu niemand op het ijs bij deze baan.'}</div>` : `<div class="empty">Gegevens laden…</div>`;
    return hint + head + (list ? `<div class="list">${list}</div>` : empty) + `<div class="empty small">Tik schaatsers aan om ze in een groep te zetten. ✎ = naam van de rijder invullen, › = rondetijden.</div>`;
  }

  function barHTML() {
    if (S.tab !== 'ice' || !R.sel.size || R.detail) return '';
    const hg = R.hint && S.groups.find(x => x.id === R.hint);
    const others = S.groups.filter(g => g !== hg);
    return `<div class="bar">
      ${hg ? `<button class="pri" data-a="addto" data-v="${esc(hg.id)}" style="background:${hg.color};border-color:${hg.color};color:#fff">+ ${esc(hg.name)} (${R.sel.size})</button><button data-a="mkgroup">Nieuwe groep</button>`
           : `<button class="pri" data-a="mkgroup">Nieuwe groep (${R.sel.size})</button>`}
      ${others.map(g => `<button data-a="addto" data-v="${esc(g.id)}" style="--gc:${g.color}"><span class="gdot"></span>${esc(g.name)}</button>`).join('')}
      <button class="ghost" data-a="clearsel">Wissen</button></div>`;
  }

  function cardHTML(chip, g, top) {
    const laps = lapsOf(chip), act = latestAct(chip);
    const valid = laps.filter(l => !l.pause);
    const last = laps[laps.length - 1];
    const lastValid = valid[valid.length - 1], prevValid = valid[valid.length - 2];
    const best = valid.length ? Math.min(...valid.map(l => l.d)) : NaN;
    const lapBlocks = blocksOf(laps).filter(b => b.laps), curBlock = lapBlocks.length ? lapBlocks[lapBlocks.length - 1].laps : [];
    const lastPass = lastPassOf(chip, laps);
    /* groot: de laatste ronde die meetelt; vergelijking alleen binnen hetzelfde blok */
    const shown = lastValid;
    const inBlockPrev = curBlock.length >= 2 ? curBlock[curBlock.length - 2] : null;
    const cls = shown ? lapClass(shown.d, g, inBlockPrev ? inBlockPrev.d : null) : '';
    let delta = '';
    if (shown && inBlockPrev) { const dd = shown.d - inBlockPrev.d; delta = `<span class="delta ${dd < -0.05 ? 'good' : dd > 0.05 ? 'bad' : 'ok'}">${dd > 0 ? '+' : dd < 0 ? '−' : '±'}${Math.abs(dd).toFixed(2)}</span>`; }
    const outNote = last && last.pause && (!shown || last.t > shown.t) ? `<span class="small muted">laatst ${fmt(last.d, 1)} · telt niet mee</span>` : '';
    const strip = [...laps].reverse().slice(0, 16).map((l, i, arr) => {
      const sep = l.gap > 5 ? `<span class="lap p">ijs af</span>` : '';
      if (l.pause) return `<span class="lap p" title="telt niet mee">${fmt(l.d, 1)}</span>` + sep;
      const nx = arr[i + 1];
      const prev = nx && !nx.pause && !(l.gap > 5) ? nx : null;
      return `<span class="lap ${lapClass(l.d, g, prev ? prev.d : null)}${l.d === best ? ' best' : ''}">${fmt(l.d, 1)}</span>` + sep;
    }).join('');
    const status = lastPass ? `<span data-ago="${lastPass}" data-mode="card" data-rest="${(S.lapMax + 3).toFixed(1)}"></span>` : '';
    let body;
    if (valid.length) body = `<div class="ctop"><span class="big ${cls}">${fmt(shown.d)}</span>${delta}${outNote}</div>
      <div class="stats"><span>rondes <b>${valid.length}</b></span><span>beste <b>${fmt(best)}</b></span><span>gem. blok <b>${fmt(avg(curBlock.map(l => l.d)))}</b></span>${g && g.target ? `<span>doel <b>${fmt(g.target)}</b></span>` : ''}</div>
      <div class="strip">${strip}</div>`;
    else if (laps.length) body = `<div class="small muted" style="padding:6px 0">Nog geen ronde tussen ${fmt(S.lapMin)} en ${fmt(S.lapMax)} s.</div><div class="strip">${strip}</div>`;
    else body = `<div class="small muted" style="padding:6px 0">${deniedAll(chip) ? '🔒 Deze rijder heeft de rondetijden in Speedhive op privé staan.' : act ? 'Rondes laden…' : 'Vandaag nog niet gezien op deze baan.'}</div>`;
    return `<div class="card${g ? ' gc' : ''}" ${g ? `style="--gc:${g.color}"` : ''} data-a="detail" data-v="${esc(chip)}">
      <div class="row"><div class="grow"><div class="nm">${top ? '🏆 ' : ''}${esc(nameOf(chip))}</div><div class="sub${!rider(chip) && !tLabel(chip) ? ' noname' : ''}">${esc(subOf(chip))}</div></div>
        <span class="small">${status}</span>
        <button class="ghost icon" data-a="rename" data-v="${esc(chip)}" aria-label="Naam rijder">✎</button></div>
      ${body}
    </div>`;
  }

  function groupHTML(g) {
    const top = g.chips.length > 1 ? bestOf(g.chips) : null;
    const cards = g.chips.map(c => cardHTML(c, g, top && top.chip === c)).join('');
    return `<div class="ghead" style="--gc:${g.color}"><button class="icon swatch" data-a="color" aria-label="Kleur van de groep"><span class="sw"></span></button><h2>${esc(g.name)}</h2>
      <button data-a="target">🎯 ${g.target ? fmt(g.target) : 'Doel'}</button>
      <button class="icon" data-a="rengroup" aria-label="Groep hernoemen">✎</button>
      <button class="icon" data-a="delgroup" aria-label="Groep verwijderen">🗑</button></div>
      ${g.chips.length ? `<div class="cards">${cards}</div>` : `<div class="empty">Nog niemand in deze groep.</div>`}
      <div class="row" style="margin-top:12px"><button data-a="addmore" style="flex:1">+ Rijders toevoegen</button><button data-a="share">📤 Delen</button></div>
      <div class="settings" data-a="window"><span>Ronde telt mee tussen <b>${fmt(S.lapMin)}</b> en <b>${fmt(S.lapMax)}</b> s.</span><button class="small">Wijzig</button></div>`;
  }

  /* ---------- klassement: snelste ronde van vandaag ---------- */
  const scopeChips = () => { const g = S.groups.find(x => x.id === S.rankScope); return g ? g.chips.slice() : [...groupChips()]; };
  function rankRows(chips) {
    const rows = [...new Set(chips)].map(c => {
      const valid = lapsOf(c).filter(l => !l.pause);
      let b = null; for (const l of valid) if (!b || l.d < b.d) b = l;
      return { chip: c, best: b, n: valid.length };
    });
    rows.sort((x, y) => (x.best ? x.best.d : 1e9) - (y.best ? y.best.d : 1e9) || nameOf(x.chip).localeCompare(nameOf(y.chip), 'nl'));
    return rows;
  }
  const medal = i => ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
  function rankHTML() {
    if (!S.groups.length) return `<div class="ghead"><h2>🏆 Klassement</h2></div><div class="empty">Maak eerst een groep onder <b>Op het ijs</b>. Het klassement laat de snelste ronde van de rijders in je groepen zien.</div>`;
    if (S.rankScope !== 'all' && !S.groups.some(g => g.id === S.rankScope)) S.rankScope = 'all';
    const sc = S.groups.find(g => g.id === S.rankScope);
    const scopes = S.groups.length > 1 ? `<div class="scopes"><button data-a="scope" data-v="all" class="${sc ? '' : 'on'}">Alle groepen</button>${S.groups.map(g => `<button data-a="scope" data-v="${esc(g.id)}" class="g${sc === g ? ' on' : ''}" style="--gc:${g.color}"><span class="gdot"></span>${esc(g.name)}</button>`).join('')}</div>` : '';
    const now = Date.now(), rows = rankRows(scopeChips());
    const lead = rows[0] && rows[0].best;
    const list = rows.map((r, i) => {
      const gs = sc ? '' : groupOfChip(r.chip).map(g => `<span class="tag g" style="--gc:${g.color}">${esc(g.name)}</span>`).join('');
      if (!r.best) return `<div class="rk none" data-a="detail" data-v="${esc(r.chip)}"><span class="pos">–</span><div class="grow"><div class="nm">${esc(nameOf(r.chip))}</div><div class="sub">${deniedAll(r.chip) ? '🔒 tijden op privé' : 'nog geen ronde die meetelt'}</div>${gs}</div><span></span></div>`;
      const fresh = r.best.t + r.best.d * 1000 > now - 120000;
      const gap = i && lead ? '+' + (r.best.d - lead.d).toFixed(2).replace('.', ',') : '';
      return `<div class="rk${i === 0 ? ' top' : ''}" data-a="detail" data-v="${esc(r.chip)}"><span class="pos">${medal(i)}</span>
        <div class="grow"><div class="nm">${esc(nameOf(r.chip))}</div><div class="sub">${r.n} ronde${r.n === 1 ? '' : 's'} · om ${clock(r.best.t + r.best.d * 1000)}</div>${fresh ? '<span class="tag new">net gereden</span>' : ''}${gs}</div>
        <div><div class="tm">${dc(r.best.d)}</div><div class="gp">${gap}</div></div></div>`;
    }).join('');
    return `<div class="ghead"><h2>🏆 Klassement</h2></div>${scopes}
      <div class="small muted" style="margin-bottom:8px">Snelste ronde van vandaag${sc ? ' in ' + esc(sc.name) : ''}. Alleen rondes tussen ${sec(S.lapMin)} en ${sec(S.lapMax)} s tellen mee.</div>
      ${rows.length ? `<div class="list">${list}</div>` : '<div class="empty">Nog niemand in deze groep.</div>'}
      <div class="row" style="margin-top:12px"><button data-a="share" style="flex:1">📤 Deel klassement</button><button data-a="notify">${S.notify ? '🔔 Melding aan' : '🔕 Melding uit'}</button></div>`;
  }

  /* ---------- melding bij een nieuwe snelste ronde ---------- */
  function checkRecords() {
    const now = Date.now(), news = [];
    const scopes = S.groups.filter(g => g.chips.length > 1).map(g => ({ key: g.id, g, chips: g.chips }));
    if (S.groups.length > 1) scopes.push({ key: 'all', g: null, chips: [...groupChips()] });
    for (const sc of scopes) {
      const b = bestOf(sc.chips), old = R.recs.get(sc.key);
      R.recs.set(sc.key, b);
      /* alleen echte verbeteringen van de laatste 2 minuten, niet bij het openen of na later geladen rondes */
      if (R.recsReady && b && old && b.d < old.d - 0.001 && b.t + b.d * 1000 > now - 120000) news.push({ sc, b, old });
    }
    R.recsReady = true;
    if (!S.notify || !news.length) return;
    const all = news.find(n => !n.sc.g), n = all || news[news.length - 1];
    const g = n.sc.g || groupOfChip(n.b.chip)[0];
    showToast(n, g, !!all);
  }
  function showToast(n, g, overall) {
    const el = $('toast');
    const where = overall ? 'van alle groepen' : 'in ' + esc(n.sc.g.name);
    const was = n.old.chip === n.b.chip ? 'eigen beste was ' + dc(n.old.d) : 'was ' + dc(n.old.d) + ' van ' + esc(nameOf(n.old.chip));
    el.innerHTML = `<div class="toast" data-a="toast" role="status" style="--gc:${g ? g.color : '#1f2937'}"><span class="ti">🏆</span>
      <div class="grow"><div class="small">Nieuwe snelste ronde ${where}</div><div class="tn">${esc(nameOf(n.b.chip))} <b>${dc(n.b.d)}</b></div><div class="small">${was}</div></div></div>`;
    try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) {}
    clearTimeout(R.toastT); R.toastT = setTimeout(hideToast, 9000);
  }
  function hideToast() { clearTimeout(R.toastT); const el = $('toast'); if (el) el.innerHTML = ''; }

  /* ---------- samenvatting voor WhatsApp ---------- */
  function riderText(chip) {
    const laps = lapsOf(chip), valid = laps.filter(l => !l.pause);
    if (!valid.length) return `*${nameOf(chip)}* – ${deniedAll(chip) ? 'tijden op privé' : 'geen rondes die meetellen'}`;
    const best = Math.min(...valid.map(l => l.d));
    const blocks = blocksOf(laps).filter(b => b.laps).map((b, i) => {
      const ds = b.laps.map(l => l.d);
      return ds.length === 1 ? `   Blok ${i + 1}: 1× ${dc(ds[0])}` : `   Blok ${i + 1}: ${ds.length}× gem ${dc(avg(ds))} (beste ${dc(Math.min(...ds))})`;
    });
    return [`*${nameOf(chip)}* – ${valid.length} ronde${valid.length === 1 ? '' : 's'} · beste ${dc(best)}`, ...blocks].join('\n');
  }
  function rankText(chips) {
    const rows = rankRows(chips).filter(r => r.best);
    if (!rows.length) return '';
    const lead = rows[0].best.d;
    return '🏆 *Snelste rondes*\n' + rows.map((r, i) => `${medal(i)} ${nameOf(r.chip)} ${dc(r.best.d)}${i ? ' (+' + (r.best.d - lead).toFixed(2).replace('.', ',') + ')' : ''}`).join('\n');
  }
  function summaryText(groups, rankOnly) {
    const date = new Date().toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
    const head = `*Training ${rinkName()} · ${date}*\nRondes tussen ${sec(S.lapMin)} en ${sec(S.lapMax)} s tellen mee.`;
    const chips = [...new Set(groups.flatMap(g => g.chips))];
    const parts = [head];
    if (groups.length === 1) parts[0] = head.replace('*\n', ' · ' + groups[0].name + '*\n') + (groups[0].target ? ' Doeltijd ' + sec(groups[0].target) + ' s.' : '');
    const rk = rankText(chips); if (rk) parts.push(rk);
    if (!rankOnly) for (const g of groups) {
      if (!g.chips.length) continue;
      parts.push((groups.length > 1 ? `▪️ *${g.name}*\n` : '') + g.chips.map(riderText).join('\n\n'));
    }
    return parts.join('\n\n');
  }
  function copyBtn(k, inp, b) {
    if (k !== 'copy') return;
    const ok = () => { b.textContent = 'Gekopieerd ✓'; };
    const fail = () => { inp.focus(); inp.select(); b.textContent = 'Geselecteerd, kies Kopieer'; };
    try { navigator.clipboard.writeText(inp.value).then(ok, fail); } catch (e) { fail(); }
  }
  async function shareSheet(text, title) {
    const v = await sheet({
      title, value: text, textarea: true, ok: navigator.share ? 'Deel' : 'Kopieer',
      text: navigator.share ? 'Tik op <b>Deel</b> en kies WhatsApp. Je kunt de tekst eerst nog aanpassen.' : 'Kopieer de tekst en plak hem in WhatsApp.',
      extra: navigator.share ? '<div class="row"><button data-s="copy">Kopieer tekst</button></div>' : '',
      onExtra: copyBtn
    });
    if (v === null) return;
    if (navigator.share) {
      try { await navigator.share({ text: v }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    let ok = false;
    try { await navigator.clipboard.writeText(v); ok = true; } catch (e) {}
    await sheet({ title: ok ? 'Gekopieerd' : 'Kopiëren lukte niet', text: ok ? 'Open WhatsApp, kies de groep en plak de tekst.' : 'Houd je vinger op de tekst, kies Selecteer alles en dan Kopieer.', ok: 'Oké', value: ok ? undefined : v, textarea: !ok });
  }

  function detailParts(chip) {
    const g = activeGroup();
    const laps = lapsOf(chip), valid = laps.filter(l => !l.pause);
    const best = valid.length ? Math.min(...valid.map(l => l.d)) : NaN;
    let bi = 0;
    const body = blocksOf(laps).map(b => {
      if (b.off) return `<div class="prow">van het ijs · ${fmtAgo(b.gap)} (vanaf ${clock(b.from)})</div>`;
      if (b.pause) return `<div class="prow">telt niet mee · ${b.out.map(l => fmt(l.d, 1)).join(', ')} (vanaf ${clock(b.out[0].t)})</div>`;
      bi++;
      const ds = b.laps.map(l => l.d), mn = Math.min(...ds), mx = Math.max(...ds), span = Math.max(mx - mn, 0.5);
      const rows = b.laps.map((l, i) => {
        const w = 30 + 70 * (1 - (l.d - mn) / span);
        return `<div class="lr"><span class="n">${i + 1}</span><span class="t ${lapClass(l.d, g, i ? b.laps[i - 1].d : null)}">${fmt(l.d)}${l.d === best ? ' ★' : ''}</span><span class="b" style="width:${w.toFixed(0)}%"></span><span class="c">${clock(l.t + l.d * 1000)}</span></div>`;
      }).join('');
      return `<div class="blk"><h3><span>Blok ${bi} · ${b.laps.length} ronde${b.laps.length === 1 ? '' : 's'}</span><span class="muted small">gem. ${fmt(avg(ds))} · beste ${fmt(mn)}</span></h3>${rows}</div>`;
    }).reverse().join('');
    const inGroup = g && g.chips.includes(chip);
    const hdr = `<div class="row"><button class="ghost" data-a="back">‹ Terug</button><div class="grow"><div class="nm">${esc(nameOf(chip))}</div><div class="sub">${esc(subOf(chip))}</div></div>
      <button data-a="rename" data-v="${esc(chip)}">✎ Naam</button></div>
      <div class="small muted">${valid.length} rondes · beste ${fmt(best)} · gem. ${fmt(avg(valid.map(l => l.d)))}</div>
      ${inGroup ? `<div><button class="small" data-a="remove" data-v="${esc(chip)}">Uit ${esc(g.name)} halen</button></div>` : ''}`;
    const main = laps.length ? '<div class="small muted" style="margin-bottom:8px">Nieuwste blok bovenaan.</div>' + body
      : '<div class="empty">' + (deniedAll(chip) ? '🔒 De rondetijden staan in Speedhive op privé. De rijder kan dat zelf aanzetten in de Speedhive-app.' : latestAct(chip) ? 'Rondes laden…' : 'Vandaag nog geen rondes op deze baan.') + '</div>';
    return { hdr, main };
  }

  /* ---------- tekenen ----------
     Alleen onderdelen die echt veranderen worden vervangen, en nooit midden in een tik.
     Teksten als “12 s geleden” worden elke seconde los bijgewerkt. */
  function render(force) {
    if (!R.open) return;
    if (!force && (R.touching || Date.now() - R.lastTouch < 600)) {
      clearTimeout(R.deferT); R.deferT = setTimeout(() => render(), 650); return;
    }
    clearTimeout(R.deferT);
    if (S.tab !== 'ice' && S.tab !== 'rank' && !activeGroup()) S.tab = 'ice';
    const g = activeGroup();
    put($('hdr'), headerHTML());
    $('searchwrap').hidden = S.tab !== 'ice' || !!R.detail;
    if (put($('nav'), navHTML())) {
      /* actief tabblad in beeld schuiven */
      const nav = $('nav'), on = nav.querySelector('.on');
      if (on && (on.offsetLeft < nav.scrollLeft || on.offsetLeft + on.offsetWidth > nav.scrollLeft + nav.clientWidth)) nav.scrollLeft = Math.max(0, on.offsetLeft - 12);
    }
    const err = R.err ? `<div class="err">Kan Speedhive nu niet bereiken (${esc(R.err)}). Ik probeer het elke ${POLL_MS / 1000} s opnieuw.</div>` : '';
    put($('main'), err + (g ? groupHTML(g) : S.tab === 'rank' ? rankHTML() : iceHTML()));
    put($('bar'), barHTML());
    const d = $('detail');
    if (R.detail) { const p = detailParts(R.detail); put($('dhdr'), p.hdr); put($('dmain'), p.main); d.hidden = false; }
    else if (!d.hidden) { d.hidden = true; $('dmain').scrollTop = 0; }
    tick();
  }
  function tick() {
    if (!R.open) return;
    const now = Date.now();
    root.querySelectorAll('[data-ago]').forEach(el => {
      const sec = (now - +el.dataset.ago) / 1000, rest = +el.dataset.rest || 0;
      let txt, cls = '';
      if (el.dataset.mode === 'card') {
        if (sec > ACTIVE_MIN * 60) { txt = 'niet op het ijs'; cls = 'muted'; }
        else if (rest && sec > rest) { txt = 'rust ' + fmtAgo(sec); cls = 'rest'; }
        else txt = fmtAgo(sec) + ' geleden';
      } else txt = 'gezien ' + fmtAgo(sec) + ' geleden';
      if (el.textContent !== txt) el.textContent = txt;
      if (el.className !== cls) el.className = cls;
    });
    const live = $('live');
    if (live) {
      const ok = R.lastOk && now - R.lastOk < 20000;
      const h = `<span class="dot ${R.err ? 'err' : ok ? 'on' : ''}"></span>${R.err ? 'fout' : ok ? 'live' : 'laden…'}`;
      if (live._h !== h) { live._h = h; live.innerHTML = h; }
    }
  }

  /* ---------- acties ---------- */
  const addChips = (g, chips) => { for (const c of chips) if (!g.chips.includes(c)) g.chips.push(c); };
  function rememberChips(chips) { for (const a of R.today.values()) if (chips.includes(a.chipCode)) remember(a); }
  const show_ = () => { save(); render(true); };

  async function askName(chip) {
    const l = tLabel(chip);
    const v = await sheet({
      title: 'Naam van de rijder',
      text: `Transponder <b>${esc(chip)}</b>${l ? ` (op de transponder staat “${esc(l)}”)` : ''}. De naam blijft op deze telefoon bewaard.`,
      value: rider(chip), placeholder: 'Bijv. Sanne de Vries'
    });
    if (v === null) return;
    if (v.trim()) S.names[chip] = v.trim().slice(0, 40); else delete S.names[chip];
    show_();
  }

  async function namesSheet() {
    const lines = Object.keys(S.names).sort((a, b) => S.names[a].localeCompare(S.names[b], 'nl')).map(c => c + ' ' + S.names[c]).join('\n');
    const v = await sheet({
      title: 'Namen van rijders',
      text: 'Eén rijder per regel: eerst de transpondercode, dan de naam. Je kunt deze lijst kopiëren en naar een andere trainer sturen, of een lijst plakken die je hebt gekregen.',
      value: lines, textarea: true, placeholder: 'HL-42078 Ede Kortlever\nCR-41725 Elisa Jansen',
      extra: '<div class="row"><button data-s="copy">Kopieer lijst</button></div>',
      onExtra: copyBtn
    });
    if (v === null) return;
    const names = {};
    for (const line of v.split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9-]{3,})\s*[=:,;\t ]\s*(.+)$/);
      if (m) names[normCode(m[1])] = m[2].trim().slice(0, 40);
    }
    S.names = names;
    show_();
  }

  /* kleurkeuze in een invulvenster */
  function colorPicker(start) {
    const st = { color: start };
    return {
      st,
      html: `<div class="swatches" role="radiogroup" aria-label="Kleur">${COLORS.map(c => `<button data-s="col" data-c="${c}" style="--c:${c}" class="${c === start ? 'on' : ''}" role="radio" aria-checked="${c === start}" aria-label="Kleur"></button>`).join('')}</div>`,
      onExtra: (k, inp, b) => {
        if (k !== 'col') return;
        st.color = b.dataset.c;
        b.parentNode.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      }
    };
  }
  const num = s => parseFloat(String(s).replace(',', '.'));

  async function onAction(a, v) {
    const g = activeGroup();
    switch (a) {
      case 'close': hide(); return;
      case 'names': await namesSheet(); return;
      case 'tab': S.tab = v; R.detail = null; R.hint = null; R.q = ''; qInput.value = ''; show_(); $('main').scrollTop = 0; pollNow(); return;
      case 'pick': R.sel.has(v) ? R.sel.delete(v) : R.sel.add(v); render(true); return;
      case 'clearsel': R.sel.clear(); render(true); return;
      case 'earlier': S.showEarlier = !S.showEarlier; show_(); return;
      case 'addmore': R.hint = g ? g.id : null; S.tab = 'ice'; R.detail = null; show_(); $('main').scrollTop = 0; return;
      case 'newgroup': case 'mkgroup': {
        const sel = [...R.sel];
        const cp = colorPicker(nextColor());
        const name = await sheet({ title: 'Nieuwe groep', text: (sel.length ? `${sel.length} rijder${sel.length === 1 ? '' : 's'} komen in deze groep.` : 'Daarna tik je onder “Op het ijs” de rijders aan.') + ' Kies een naam en een kleur.', value: 'Groep ' + (S.groups.length + 1), ok: 'Maak groep', extra: cp.html, onExtra: cp.onExtra });
        if (name === null) return;
        const ng = { id: 'g' + uid(), name: (name.trim() || 'Groep ' + (S.groups.length + 1)).slice(0, 30), chips: [], target: null, color: cp.st.color };
        if (a === 'mkgroup') { addChips(ng, sel); rememberChips(sel); R.sel.clear(); }
        S.groups.push(ng);
        if (a === 'mkgroup') { S.tab = ng.id; R.hint = null; }
        else { S.tab = 'ice'; R.hint = ng.id; R.detail = null; $('main').scrollTop = 0; }
        show_(); pollNow(); return;
      }
      case 'addto': { const tg = S.groups.find(x => x.id === v); if (!tg) return; const sel = [...R.sel]; addChips(tg, sel); rememberChips(sel); R.sel.clear(); R.hint = null; S.tab = tg.id; show_(); pollNow(); return; }
      case 'rengroup': { if (!g) return; const n = await sheet({ title: 'Groep hernoemen', value: g.name }); if (n && n.trim()) { g.name = n.trim().slice(0, 30); show_(); } return; }
      case 'delgroup': { if (!g) return; const ok = await sheet({ title: 'Groep “' + g.name + '” verwijderen?', text: 'De rijders en hun namen blijven gewoon bewaard.', ok: 'Verwijder', danger: true }); if (ok) { S.groups = S.groups.filter(x => x !== g); S.tab = 'ice'; show_(); } return; }
      case 'target': {
        if (!g) return;
        const n = await sheet({ title: 'Doeltijd per ronde', text: 'Bijvoorbeeld 34 of 34,5 of 1:05. Laat leeg voor geen doeltijd.', value: g.target ? fmt(g.target).replace('.', ',') : '', placeholder: '34,5', inputmode: 'decimal' });
        if (n === null) return; const t = parseDur(n.replace(/,/g, '.')); g.target = isFinite(t) && t > 0 && t < 600 ? t : null; show_(); return;
      }
      case 'color': {
        if (!g) return;
        const cp = colorPicker(g.color);
        const ok = await sheet({ title: 'Kleur van “' + g.name + '”', extra: cp.html, onExtra: cp.onExtra });
        if (ok) { g.color = cp.st.color; show_(); } return;
      }
      case 'window': {
        const r = await sheet({
          title: 'Welke rondes tellen mee?',
          text: 'Rondes daarbuiten zijn rust, een stijger of een halve ronde. Ze staan grijs en tellen niet mee voor blok, gemiddelde en beste ronde.',
          extra: `<div class="fields"><label>Snelste ronde (s)<input id="wmin" type="text" inputmode="decimal" value="${fmt(S.lapMin).replace('.', ',')}"></label><label>Langzaamste ronde (s)<input id="wmax" type="text" inputmode="decimal" value="${fmt(S.lapMax).replace('.', ',')}"></label></div>`,
          collect: L => ({ min: num(L.querySelector('#wmin').value), max: num(L.querySelector('#wmax').value) })
        });
        if (!r) return;
        if (r.min > 0 && r.max > r.min && r.max < 600) { S.lapMin = r.min; S.lapMax = r.max; R.recs.clear(); R.recsReady = false; show_(); }
        else { await sheet({ title: 'Dat klopt niet helemaal', text: 'De langzaamste ronde moet langer zijn dan de snelste, bijvoorbeeld 25 en 37.', ok: 'Oké' }); }
        return;
      }
      case 'scope': S.rankScope = v; show_(); return;
      case 'notify': S.notify = !S.notify; show_(); return;
      case 'toast': hideToast(); return;
      case 'share': {
        if (g) await shareSheet(summaryText([g]), 'Training delen');
        else { const sg = S.groups.find(x => x.id === S.rankScope); await shareSheet(summaryText(sg ? [sg] : S.groups, true), 'Klassement delen'); }
        return;
      }
      case 'detail': R.detail = v; render(true); pollNow(); return;
      case 'back': R.detail = null; render(true); return;
      case 'rename': await askName(v); return;
      case 'remove': if (g) { g.chips = g.chips.filter(c => c !== v); R.detail = null; show_(); } return;
    }
  }

  app.addEventListener('click', ev => {
    const el = ev.target.closest('[data-a]'); if (!el || !app.contains(el)) return;
    const a = el.dataset.a;
    if (a === 'q' || a === 'rink') return;
    ev.preventDefault(); ev.stopPropagation();
    onAction(a, el.dataset.v);
  });
  app.addEventListener('touchstart', () => { R.touching = true; }, { passive: true });
  const touchEnd = () => { R.touching = false; R.lastTouch = Date.now(); };
  app.addEventListener('touchend', touchEnd, { passive: true });
  app.addEventListener('touchcancel', touchEnd, { passive: true });
  qInput.addEventListener('input', () => { R.q = qInput.value; render(true); });
  app.addEventListener('change', ev => {
    const el = ev.target;
    if (el.dataset.a === 'rink') {
      S.rink = +el.value;
      R.today.clear(); R.laps.clear(); R.sel.clear(); R.first = true; R.lastOk = 0; R.err = null; R.detail = null; R.recs.clear(); R.recsReady = false; hideToast();
      S.hist = { day: today(), rink: S.rink, acts: {} }; show_(); pollNow();
    }
  });

  /* ---------- open / dicht ---------- */
  async function wake() { try { if (navigator.wakeLock && !document.hidden) R.wake = await navigator.wakeLock.request('screen'); } catch (e) {} }
  const onVis = () => { if (!document.hidden && R.open) { wake(); pollNow(); } };
  const prevOverflow = document.documentElement.style.overflow;
  function show() {
    R.open = true; host.style.display = ''; document.documentElement.style.overflow = 'hidden';
    wake(); render(true); pollNow();
    clearInterval(R.tick); R.tick = setInterval(tick, 1000);
  }
  function hide() {
    R.open = false; host.style.display = 'none'; document.documentElement.style.overflow = prevOverflow;
    clearTimeout(R.timer); clearInterval(R.tick); clearTimeout(R.deferT); hideToast();
    try { R.wake && R.wake.release(); } catch (e) {} R.wake = null;
  }
  window[NS] = { toggle: () => (R.open ? hide() : show()), show: () => { if (!R.open) show(); }, version: VERSION };
  document.addEventListener('visibilitychange', onVis);
  (document.body || document.documentElement).appendChild(host);
  show();
})();
