'use strict';
/* Покерный таймер — app logic. Vanilla JS, no build step.
   Architecture notes:
   - Timer is stored as an ABSOLUTE end time (endsAt), not a per-second counter,
     so locking the phone / backgrounding / reloading never loses time (P0.1).
   - The clock is driven by requestAnimationFrame updating a single text node;
     full screen re-renders happen only on structural changes (P0.2).
   - State persists to localStorage (debounced), flushed on hide/pagehide. */

const STORAGE_KEY = 'pkTimer.v2';

const THEMES = [
  { key: 'emerald', cls: 'pk-theme-emerald', label: 'Изумрудное сукно', bg: '#0c2b21' },
  { key: 'beige', cls: 'pk-theme-beige', label: 'Бежевое сукно', bg: '#c6b48f' },
];

function defaultState() {
  return {
    screen: 'setup', // setup | players | seats | running | final
    theme: 'emerald',
    soundOn: true,
    showNextBlinds: true,
    muted: false,

    buyIn: 200,
    rebuyAmount: 200,
    startingStack: 2000,
    rebuyLevels: 5,
    addonAmount: 0,      // 0 = add-on disabled
    addonStack: 0,
    split1: 50, split2: 30, split3: 20,

    levels: [
      { sb: 10,   bb: 20,   ante: 0,    dur: 12, colorUp: false },              // 1
      { sb: 20,   bb: 40,   ante: 0,    dur: 12, colorUp: false },              // 2
      { sb: 30,   bb: 60,   ante: 0,    dur: 12, colorUp: false },              // 3
      { sb: 50,   bb: 100,  ante: 0,    dur: 12, colorUp: false },              // 4
      { sb: 70,   bb: 140,  ante: 0,    dur: 12, colorUp: false },              // 5 — последний ребай
      { sb: 100,  bb: 200,  ante: 0,    dur: 12, colorUp: true  },              // 6 — убрать 10 и 20
      { type: 'break', sb: 0, bb: 0, ante: 0, dur: 10, colorUp: false },        // перерыв 10 мин
      { sb: 150,  bb: 300,  ante: 300,  dur: 12, colorUp: false },              // 7 — включается BB-анте
      { sb: 200,  bb: 400,  ante: 400,  dur: 12, colorUp: true  },              // 8 — убрать 50
      { sb: 300,  bb: 600,  ante: 600,  dur: 12, colorUp: false },              // 9
      { sb: 400,  bb: 800,  ante: 800,  dur: 12, colorUp: false },              // 10
      { sb: 600,  bb: 1200, ante: 1200, dur: 12, colorUp: false },              // 11
      { sb: 800,  bb: 1600, ante: 1600, dur: 12, colorUp: false },              // 12
      { sb: 1000, bb: 2000, ante: 2000, dur: 12, colorUp: false },              // 13
      { sb: 1500, bb: 3000, ante: 3000, dur: 12, colorUp: false },              // 14
      { sb: 2000, bb: 4000, ante: 4000, dur: 12, colorUp: false },              // 15
      { sb: 3000, bb: 6000, ante: 6000, dur: 12, colorUp: false },              // 16
    ],
    players: [
      { id: 1, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
      { id: 2, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
      { id: 3, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
      { id: 4, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
      { id: 5, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
      { id: 6, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null },
    ],
    nextId: 7,

    seatOrder: [],
    dealerIndex: 0,

    currentLevel: 0,
    // absolute-time clock (first level is 12 min)
    timer: { endsAt: null, remainingMs: 12 * 60 * 1000, running: false },

    levelEnd: false,
    showRebuyModal: false,
    confirm: null, // {title, body, label, kind}
    places: { p1: '', p2: '', p3: '' },
  };
}

let state = defaultState();

// fields that get persisted (transient UI is excluded)
function serialize() {
  const s = state;
  return {
    screen: s.screen, theme: s.theme, soundOn: s.soundOn, showNextBlinds: s.showNextBlinds, muted: s.muted,
    buyIn: s.buyIn, rebuyAmount: s.rebuyAmount, startingStack: s.startingStack, rebuyLevels: s.rebuyLevels,
    addonAmount: s.addonAmount, addonStack: s.addonStack,
    split1: s.split1, split2: s.split2, split3: s.split3,
    levels: s.levels, players: s.players, nextId: s.nextId,
    seatOrder: s.seatOrder, dealerIndex: s.dealerIndex,
    currentLevel: s.currentLevel, timer: s.timer, places: s.places,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && Array.isArray(saved.levels) && Array.isArray(saved.players)) {
      state = { ...defaultState(), ...saved, levelEnd: false, showRebuyModal: false, confirm: null };
      if (!state.timer) state.timer = { endsAt: null, remainingMs: 15 * 60 * 1000, running: false };
      state.players = state.players.map(p => ({ rebuys: 0, addons: 0, out: false, bustedAt: null, ...p }));
      state.levels = state.levels.map(l => ({ type: 'blind', ...l }));
    }
  } catch (e) { /* ignore corrupt storage */ }
}

// ——— club memory: roster + archive persist separately from the current tournament ———
const ROSTER_KEY = 'pkRoster.v1';
const ARCHIVE_KEY = 'pkArchive.v1';
const TEMPLATES_KEY = 'pkTemplates.v1';
let roster = [];   // [{ name }]
let archive = [];  // [{ date, bank, entries, players:[{name, paid, payout, net, place}] }]
let templates = []; // user-saved structure presets

// which state fields make up a "structure template"
const TPL_FIELDS = ['levels', 'rebuyLevels', 'buyIn', 'rebuyAmount', 'startingStack', 'addonAmount', 'addonStack', 'split1', 'split2', 'split3'];
function templateFromState(s) {
  const t = {};
  TPL_FIELDS.forEach(k => { t[k] = k === 'levels' ? s.levels.map(l => ({ ...l })) : s[k]; });
  return t;
}
// built-in preset = the code default, so it's identical on every device
const BUILTIN_TEMPLATES = [Object.assign({ name: 'Домашняя (база)', builtin: true }, templateFromState(defaultState()))];
function allTemplates() { return [...BUILTIN_TEMPLATES, ...templates]; }

function loadClub() {
  try { const r = JSON.parse(localStorage.getItem(ROSTER_KEY)); if (Array.isArray(r)) roster = r; } catch (e) {}
  try { const a = JSON.parse(localStorage.getItem(ARCHIVE_KEY)); if (Array.isArray(a)) archive = a; } catch (e) {}
  try { const t = JSON.parse(localStorage.getItem(TEMPLATES_KEY)); if (Array.isArray(t)) templates = t; } catch (e) {}
  archive.forEach(t => { if (!t.id) t.id = rndId(); }); // stable ids for cloud merge
  saveArchive();
}
function saveRoster() { try { localStorage.setItem(ROSTER_KEY, JSON.stringify(roster)); } catch (e) {} }
function saveArchive() { try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive)); } catch (e) {} }
function saveTemplates() { try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates)); } catch (e) {} }
function rosterAdd(name) {
  const n = (name || '').trim();
  if (!n) return;
  if (!roster.some(r => r.name.toLowerCase() === n.toLowerCase())) { roster.push({ name: n }); saveRoster(); }
}
function rndId() {
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ═══════════ optional cloud sync (Supabase) — local-first, degrades gracefully ═══════════
const ACTIVE_CLUB_KEY = 'pkActiveClub'; // which club this device shows
const LOCAL_CLUB_KEY = 'pkLocalClub';   // which club the current local archive/roster belongs to
let sb = null;
let cloud = { status: 'off', session: null, club: null, clubs: [], isOwner: true, email: '', pendingEmail: '', lastSync: 0, busy: false };
function cloudConfigured() {
  const c = window.PK_SUPABASE || {};
  return !!(c.url && c.anonKey && !/ВАШ_|YOUR_/.test(c.url) && !/ВАШ_|YOUR_/.test(c.anonKey));
}
function cloudOn() { return !!(sb && cloud.session && cloud.club); }
function initCloud() {
  if (!cloudConfigured() || !window.supabase) { cloud.status = 'off'; return; }
  try {
    sb = window.supabase.createClient(window.PK_SUPABASE.url, window.PK_SUPABASE.anonKey, {
      // detectSessionInUrl+implicit: клик по магик-ссылке из письма логинит автоматически,
      // когда пользователь возвращается на приложение (не нужен ручной ввод кода).
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
    cloud.status = 'connecting'; // don't flash the email form before we know if a session is stored
    sb.auth.getSession().then(({ data }) => {
      if (data && data.session) onSignedIn(data.session);
      else { cloud.status = 'signedout'; render(); }
    }).catch(() => { cloud.status = 'signedout'; render(); });
    sb.auth.onAuthStateChange((_e, session) => {
      if (session && (!cloud.session || cloud.session.user.id !== session.user.id)) onSignedIn(session);
      else if (!session && cloud.session) { cloud.session = null; cloud.club = null; cloud.status = 'signedout'; render(); }
    });
  } catch (e) { cloud.status = 'off'; }
}
async function onSignedIn(session) {
  if (cloud.signingIn) return; // guard against concurrent calls (getSession + onAuthStateChange) racing ensure_club
  cloud.signingIn = true;
  cloud.session = session; cloud.email = session.user.email || ''; cloud.status = 'syncing'; render();
  try {
    // RLS lets us read every club we can access (owned + joined by code)
    let { data: clubs, error } = await sb.from('clubs').select('*');
    if (error) throw error;
    if (!clubs || !clubs.length) {
      const { data, error: e2 } = await sb.rpc('ensure_club'); // first time → create our own
      if (e2) throw e2;
      clubs = [Array.isArray(data) ? data[0] : data];
    }
    cloud.clubs = clubs;
    setActiveClub(pickActiveClub(clubs, session.user.id), session.user.id);
    await syncMerge();
    cloud.status = 'synced'; cloud.lastSync = Date.now();
  } catch (e) { cloud.status = 'error'; }
  cloud.signingIn = false;
  render();
}
function pickActiveClub(clubs, uid) {
  let savedId = null; try { savedId = localStorage.getItem(ACTIVE_CLUB_KEY); } catch (e) {}
  return clubs.find(c => c.id === savedId) || clubs.find(c => c.owner === uid) || clubs[0];
}
function setActiveClub(club, uid) {
  cloud.club = club;
  cloud.isOwner = !!(club && club.owner === (uid || (cloud.session && cloud.session.user.id)));
  try { if (club) localStorage.setItem(ACTIVE_CLUB_KEY, club.id); } catch (e) {}
}
async function syncMerge() {
  if (!sb || !cloud.club) return;
  cloud.busy = true;
  const cloudRoster = Array.isArray(cloud.club.roster) ? cloud.club.roster : [];
  const { data: tours, error } = await sb.from('tournaments').select('id,payload').eq('club_id', cloud.club.id);
  if (error) throw error;
  const cloudArchive = (tours || []).map(t => ({ id: t.id, ...(t.payload || {}) }));

  let localClub = null; try { localClub = localStorage.getItem(LOCAL_CLUB_KEY); } catch (e) {}
  const switching = localClub && localClub !== cloud.club.id; // moved to a *different* club → don't merge, replace

  if (switching) {
    roster = cloudRoster.map(r => ({ name: r.name }));
    archive = cloudArchive.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    saveRoster(); saveArchive();
  } else {
    // same club (or first login) → union, folding in any offline-local additions
    const rmap = {};
    [...cloudRoster, ...roster].forEach(r => { const k = (r.name || '').trim().toLowerCase(); if (k && !rmap[k]) rmap[k] = { name: r.name }; });
    roster = Object.values(rmap); saveRoster();
    const amap = {};
    [...cloudArchive, ...archive].forEach(t => { if (t.id && !amap[t.id]) amap[t.id] = t; });
    archive = Object.values(amap).sort((a, b) => new Date(b.date) - new Date(a.date)); saveArchive();
    // push the union back so the cloud has everything too
    await pushRoster();
    const missing = archive.filter(t => !cloudArchive.some(c => c.id === t.id));
    for (const t of missing) await pushTournament(t);
  }
  try { localStorage.setItem(LOCAL_CLUB_KEY, cloud.club.id); } catch (e) {}
  cloud.busy = false;
}
async function pushRoster() {
  if (!cloudOn()) return;
  try { await sb.from('clubs').update({ roster, updated_at: new Date().toISOString() }).eq('id', cloud.club.id); } catch (e) {}
}
async function pushTournament(t) {
  if (!cloudOn()) return;
  try { await sb.from('tournaments').upsert({ id: t.id, club_id: cloud.club.id, played_at: t.date, bank: t.bank | 0, entries: t.entries | 0, payload: t }); } catch (e) {}
}
async function deleteCloudArchive() {
  if (!cloudOn()) return;
  try { await sb.from('tournaments').delete().eq('club_id', cloud.club.id); } catch (e) {}
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
function saveNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize())); } catch (e) { /* unavailable */ }
}

function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  scheduleSave();
  render();
}

// ——— formatting ———
const fmt = n => Number(n || 0).toLocaleString('ru-RU');
const money = n => fmt(Math.round(n)) + ' ₽';
const nameOf = (p, i) => (p.name && p.name.trim()) ? p.name : ('Игрок ' + (i + 1));
const two = n => String(n).padStart(2, '0');
const fmtClock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return two(Math.floor(s / 60)) + ':' + two(s % 60); };
const curLevelSeconds = () => ((state.levels[state.currentLevel] || {}).dur || 15) * 60;

// ═══════════ timer (absolute-time) ═══════════
function remainingMs() {
  const t = state.timer;
  return (t.running && t.endsAt) ? Math.max(0, t.endsAt - Date.now()) : t.remainingMs;
}
function startTimer() {
  const t = state.timer;
  if (t.remainingMs <= 0) return;
  t.endsAt = Date.now() + t.remainingMs;
  t.running = true;
  keepAwake(true);
  saveNow();
}
function pauseTimer() {
  const t = state.timer;
  t.remainingMs = remainingMs();
  t.endsAt = null;
  t.running = false;
  keepAwake(false);
  saveNow();
}
function setLevelDuration(sec) {
  const t = state.timer;
  t.remainingMs = sec * 1000;
  if (t.running) t.endsAt = Date.now() + t.remainingMs;
}
function adjustMinute(delta) {
  const t = state.timer;
  let rem = remainingMs() + delta * 60000;
  if (rem < 0) rem = 0;
  t.remainingMs = rem;
  if (t.running) t.endsAt = Date.now() + rem;
  saveNow();
  render();
}

// ——— screen wake lock ———
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && state.timer.running) {
      if (!wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } else if (!on && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch (e) { /* iOS <16.4 or no permission — non-critical */ }
}

// ——— audio ———
let ac = null;
let chimeTimer = null;
function ensureAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ac) ac = new AC();
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { /* no web audio */ }
}
function playChime(force) {
  if (!force && (state.muted || !state.soundOn)) return;
  ensureAudio();
  if (!ac) return;
  const base = ac.currentTime;
  [0, 0.85, 1.7].forEach(off => {
    const t = base + off;
    [196, 294, 392, 588].forEach((f, k) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3 / (k + 1), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g).connect(ac.destination);
      o.start(t); o.stop(t + 1.7);
    });
  });
}
function startChimeLoop() {
  playChime();
  clearInterval(chimeTimer);
  chimeTimer = setInterval(() => {
    if (state.levelEnd) playChime(); else clearInterval(chimeTimer);
  }, 4500);
}
function stopChimeLoop() { clearInterval(chimeTimer); }

// ——— clock render loop (rAF; touches only the clock node, no full re-render) ———
function clockLoop() {
  if (state.screen === 'running') {
    const el = document.getElementById('pk-clock');
    if (el) {
      const ms = remainingMs();
      const txt = fmtClock(ms);
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('pk-danger', state.timer.running && ms <= 10000 && ms > 0);
      const fill = document.getElementById('pk-progress-fill');
      if (fill) {
        const durMs = curLevelSeconds() * 1000 || 1;
        fill.style.width = Math.max(0, Math.min(100, 100 * (1 - ms / durMs))) + '%';
      }
      if (state.timer.running && ms <= 0 && !state.levelEnd) onLevelEnd();
    }
  }
  requestAnimationFrame(clockLoop);
}
function onLevelEnd() {
  state.timer.running = false;
  state.timer.remainingMs = 0;
  state.timer.endsAt = null;
  keepAwake(false);
  if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) { /* ignore */ } }
  setState({ levelEnd: true });
  startChimeLoop();
}

// ——— level flow ———
function advance(delta, autorun) {
  const n = state.levels.length;
  const i = state.currentLevel + delta;
  if (i < 0) return;                 // already at first level — ignore (don't reset clock)
  if (i > n - 1) { doEndTournament(); return; } // past last — go to settlement
  const closing = i >= state.rebuyLevels && state.currentLevel < state.rebuyLevels;
  const wasRunning = state.timer.running;
  state.currentLevel = i;
  setLevelDuration((state.levels[i].dur || 15) * 60);
  const run = closing ? false : (autorun ? true : wasRunning);
  state.timer.running = run;
  if (run) { state.timer.endsAt = Date.now() + state.timer.remainingMs; keepAwake(true); }
  else { state.timer.endsAt = null; keepAwake(false); }
  saveNow();
  setState({ showRebuyModal: closing ? true : state.showRebuyModal });
}

function doEndTournament() {
  stopChimeLoop();
  pauseTimer();
  setState({ screen: 'final', levelEnd: false, showRebuyModal: false, places: autoPlaces() });
}

// ——— finishing order → prize places ———
function autoPlaces() {
  const s = state;
  const byPlace = {};
  s.players.forEach(p => { if (p.out && p.bustedAt && p.bustedAt.place) byPlace[p.bustedAt.place] = p.id; });
  const notOut = s.players.filter(p => !p.out);
  if (notOut.length === 1) byPlace[1] = notOut[0].id;
  const pick = (k, cur) => (cur && String(cur).length) ? cur : (byPlace[k] != null ? String(byPlace[k]) : '');
  return { p1: pick(1, s.places.p1), p2: pick(2, s.places.p2), p3: pick(3, s.places.p3) };
}

// ——— money helpers ———
function payouts(bank, pcts, step = 100) {
  const sumPct = pcts.reduce((a, b) => a + (+b || 0), 0);
  const pool = Math.round(bank * sumPct / 100 / step) * step;
  const rounded = pcts.map(p => Math.round(bank * (+p || 0) / 100 / step) * step);
  const diff = pool - rounded.reduce((a, b) => a + b, 0);
  if (rounded.length) rounded[0] += diff;
  return rounded;
}
// minimal set of transfers that settles everyone (greedy)
function settle(nets) {
  const debt = nets.filter(n => n.net < -0.5).map(n => ({ name: n.name, left: -n.net })).sort((a, b) => b.left - a.left);
  const cred = nets.filter(n => n.net > 0.5).map(n => ({ name: n.name, left: n.net })).sort((a, b) => b.left - a.left);
  const tx = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i].left, cred[j].left);
    if (amt >= 1) tx.push({ from: debt[i].name, to: cred[j].name, amount: Math.round(amt) });
    debt[i].left -= amt; cred[j].left -= amt;
    if (debt[i].left < 1) i++;
    if (cred[j].left < 1) j++;
  }
  return tx;
}

// ——— shuffle / seats ———
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = b[i]; b[i] = b[j]; b[j] = t;
  }
  return b;
}

// ——— toast (DOM-only, no re-render churn) ———
let toastTimer = null;
function showToast(text, undoFn) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = `<span>${esc(text)}</span>` + (undoFn ? `<button class="btn btn-ghost" id="toast-undo">Отменить</button>` : '');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
  if (undoFn) document.getElementById('toast-undo').onclick = () => { undoFn(); el.classList.remove('show'); };
}

// ═══════════ actions ═══════════
const actions = {
  goPlayers: () => setState({ screen: 'players' }),
  backToSetup: () => setState({ screen: 'setup' }),
  goSeats: () => {
    const order = shuffle(state.players.map(p => p.id));
    setState({ screen: 'seats', seatOrder: order, dealerIndex: order.length ? Math.floor(Math.random() * order.length) : 0 });
  },
  backToPlayers: () => setState({ screen: 'players' }),
  drawSeats: () => {
    const order = shuffle(state.players.map(p => p.id));
    setState({ seatOrder: order, dealerIndex: order.length ? Math.floor(Math.random() * order.length) : 0 });
  },
  startTournament: () => {
    ensureAudio();
    state.timer = { endsAt: Date.now() + (state.levels[0].dur || 15) * 60000, remainingMs: (state.levels[0].dur || 15) * 60000, running: true };
    keepAwake(true);
    setState({
      screen: 'running', currentLevel: 0, levelEnd: false, showRebuyModal: false,
      players: state.players.map(p => ({ ...p, rebuys: 0, out: false, bustedAt: null })),
      places: { p1: '', p2: '', p3: '' },
    });
  },
  backToRunning: () => setState({ screen: 'running' }),
  endTournament: () => doEndTournament(),
  newTournament: () => setState({ confirm: { title: 'Новый турнир?', body: 'Текущий турнир будет очищен: ребаи, вылеты и таймер сбросятся. Структуру и игроков можно оставить.', label: 'Начать новый', kind: 'newTournament' } }),
  dismissModal: () => setState({ showRebuyModal: false }),
  closeGuide: () => { showGuide = false; render(); },
  confirmNo: () => setState({ confirm: null }),
  confirmYes: () => { const k = state.confirm && state.confirm.kind; if (k && confirmKinds[k]) confirmKinds[k](); else setState({ confirm: null }); },

  addLevel: () => setState(s => {
    const last = s.levels[s.levels.length - 1] || { sb: 25, bb: 50, ante: 0, dur: 15 };
    return { levels: [...s.levels, { sb: last.bb, bb: last.bb * 2, ante: last.ante, dur: last.dur, colorUp: false }] };
  }),
  removeLevel: (e) => {
    const i = +e.currentTarget.dataset.idx;
    setState(s => ({ levels: s.levels.filter((_, k) => k !== i) }));
  },
  toggleColorUp: (e) => {
    const i = +e.currentTarget.dataset.idx;
    setState(s => ({ levels: s.levels.map((l, k) => k === i ? { ...l, colorUp: !l.colorUp } : l) }));
  },
  testSound: () => { ensureAudio(); playChime(true); },

  addPlayer: () => setState(s => ({ players: [...s.players, { id: s.nextId, name: '', rebuys: 0, out: false, bustedAt: null }], nextId: s.nextId + 1 })),
  removePlayer: (e) => {
    const i = +e.currentTarget.dataset.idx;
    const removed = state.players[i];
    if (!removed) return;
    setState(s => ({ players: s.players.filter((_, k) => k !== i) }));
    showToast('Игрок удалён', () => setState(s => { const arr = s.players.slice(); arr.splice(i, 0, removed); return { players: arr }; }));
  },

  prev: () => advance(-1),
  next: () => advance(1),
  toggleRun: () => { ensureAudio(); if (state.timer.running) pauseTimer(); else startTimer(); setState({}); },
  addPlusMinute: () => adjustMinute(1),
  addMinusMinute: () => adjustMinute(-1),
  toggleSoundBtn: () => setState(s => ({ muted: !s.muted })),
  ackLevelEnd: () => {
    stopChimeLoop();
    if (state.currentLevel >= state.levels.length - 1) { doEndTournament(); return; }
    setState({ levelEnd: false });
    advance(1, true);
  },
  doRebuy: (e) => {
    const id = +e.currentTarget.dataset.id;
    if (state.currentLevel >= state.rebuyLevels) return;
    setState(s => ({ players: s.players.map(p => p.id === id ? { ...p, rebuys: (p.rebuys || 0) + 1, out: false, bustedAt: null } : p) }));
  },
  toggleOut: (e) => {
    const id = +e.currentTarget.dataset.id;
    const idx = state.players.findIndex(p => p.id === id);
    if (idx < 0) return;
    const p = state.players[idx];
    if (!p.out) {
      const place = state.players.filter(x => !x.out).length; // this player finishes here
      setState(s => ({ players: s.players.map(x => x.id === id ? { ...x, out: true, bustedAt: { level: s.currentLevel, ts: Date.now(), place } } : x) }));
      showToast('Выбыл: ' + nameOf(p, idx) + ' · место ' + place, () =>
        setState(s => ({ players: s.players.map(x => x.id === id ? { ...x, out: false, bustedAt: null } : x) })));
    } else {
      setState(s => ({ players: s.players.map(x => x.id === id ? { ...x, out: false, bustedAt: null } : x) }));
    }
  },
  copyResults: () => {
    const text = resultsText(derive());
    const done = () => showToast('Итоги скопированы');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  },

  // ——— add-on (a one-off chip top-up, while the registration window is open) ———
  doAddon: (e) => {
    const id = +e.currentTarget.dataset.id;
    if (state.currentLevel >= state.rebuyLevels) return;
    setState(s => ({ players: s.players.map(p => p.id === id ? { ...p, addons: (p.addons || 0) + 1, out: false, bustedAt: null } : p) }));
  },

  // ——— late registration: add a player mid-tournament while the window is open ———
  lateAddPlayer: () => {
    if (state.currentLevel >= state.rebuyLevels) return;
    setState(s => ({ players: [...s.players, { id: s.nextId, name: '', rebuys: 0, addons: 0, out: false, bustedAt: null }], nextId: s.nextId + 1 }));
    showToast('Игрок добавлен — впишите имя');
  },

  // ——— structure: insert a break level ———
  addBreak: () => setState(s => ({ levels: [...s.levels, { type: 'break', sb: 0, bb: 0, ante: 0, dur: 10, colorUp: false }] })),

  // ——— structure templates (presets) ———
  applyTemplate: (e) => {
    const tpl = allTemplates()[+e.currentTarget.dataset.idx];
    if (!tpl) return;
    const patch = { currentLevel: 0 };
    TPL_FIELDS.forEach(k => { patch[k] = k === 'levels' ? tpl.levels.map(l => ({ ...l })) : tpl[k]; });
    state.timer = { endsAt: null, remainingMs: ((tpl.levels[0] && tpl.levels[0].dur) || 12) * 60000, running: false };
    setState(patch);
    showToast('Шаблон применён: ' + tpl.name);
  },
  saveTemplate: () => {
    const el = document.getElementById('tpl-name');
    const name = (el && el.value || '').trim();
    if (!name) { showToast('Впишите название шаблона'); return; }
    const existing = templates.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
    const tpl = Object.assign({ name }, templateFromState(state));
    if (existing >= 0) templates[existing] = tpl; else templates.push(tpl);
    saveTemplates();
    showToast(existing >= 0 ? 'Шаблон обновлён' : 'Шаблон сохранён');
    render();
  },
  deleteTemplate: (e) => {
    const i = +e.currentTarget.dataset.uidx;
    templates.splice(i, 1); saveTemplates(); render();
  },

  // ——— roster (club regulars) ———
  addFromRoster: (e) => {
    const name = e.currentTarget.dataset.name;
    if (state.players.some(p => (p.name || '').trim().toLowerCase() === name.toLowerCase())) { showToast(name + ' уже в списке'); return; }
    const empty = state.players.findIndex(p => !(p.name || '').trim());
    if (empty >= 0) setState(s => ({ players: s.players.map((p, k) => k === empty ? { ...p, name } : p) }));
    else setState(s => ({ players: [...s.players, { id: s.nextId, name, rebuys: 0, addons: 0, out: false, bustedAt: null }], nextId: s.nextId + 1 }));
  },
  removeFromRoster: (e) => {
    const name = e.currentTarget.dataset.name;
    roster = roster.filter(r => r.name !== name); saveRoster(); pushRoster(); render();
  },
  savePlayersToRoster: () => {
    let n = 0;
    state.players.forEach((p, i) => { const nm = (p.name || '').trim(); if (nm) { const before = roster.length; rosterAdd(nm); if (roster.length > before) n++; } });
    if (n) pushRoster();
    showToast(n ? ('В ростер добавлено: ' + n) : 'Все уже в ростере');
    render();
  },

  // ——— archive ———
  saveToArchive: () => {
    const d = derive(), s = state;
    const rec = {
      id: rndId(), date: new Date().toISOString(), bank: d.bank, entries: d.entries,
      totalRebuys: d.totalRebuys, totalAddons: d.totalAddons,
      buyIn: s.buyIn, rebuyAmount: s.rebuyAmount, addonAmount: s.addonAmount, startingStack: s.startingStack,
      split: [s.split1, s.split2, s.split3],
      prizes: d.prizeRows.filter(p => p.sel).map(p => ({ place: p.place, name: p.name, pct: p.pct, amount: p.amount })),
      players: s.players.map((p, i) => {
        const st = d.standings[i];
        return { name: st.name, rebuys: p.rebuys || 0, addons: p.addons || 0, paid: st.paid, payout: st.payout, net: st.net, place: st.place };
      }),
      tx: d.tx,
    };
    archive.unshift(rec); saveArchive();
    d.standings.forEach(st => rosterAdd(st.name)); // remember these regulars
    pushTournament(rec); pushRoster();
    showToast(cloudOn() ? 'Сохранено в архив и облако' : 'Турнир сохранён в архив');
    render();
  },

  openClub: () => { if (state.screen !== 'club') clubReturn = state.screen; viewTourneyId = null; setState({ screen: 'club' }); },
  openTourney: (e) => { viewTourneyId = e.currentTarget.dataset.id; render(); },
  closeTourney: () => { viewTourneyId = null; render(); },
  copyTourney: (e) => {
    const rec = archive.find(t => t.id === e.currentTarget.dataset.id);
    if (!rec) return;
    const text = archiveText(rec);
    const done = () => showToast('Итоги скопированы');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  },
  closeClub: () => setState({ screen: (clubReturn && clubReturn !== 'club') ? clubReturn : 'setup' }),
  clearArchive: () => {
    if (cloudOn() && !cloud.isOwner) { showToast('Очищать архив может только владелец клуба'); return; }
    setState({ confirm: { title: 'Очистить архив?', body: 'Все сохранённые турниры и таблица сезона будут удалены' + (cloudOn() ? ' (и в облаке тоже)' : '') + '. Ростер игроков останется. Действие необратимо.', label: 'Очистить', kind: 'clearArchive' } });
  },

  // ——— cloud auth / sync ———
  cloudSendCode: () => {
    const el = document.getElementById('cloud-email'); const email = (el && el.value || '').trim();
    if (!email) { showToast('Впишите email'); return; }
    cloud.pendingEmail = email;
    sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
      .then(({ error }) => { if (error) { showToast('Ошибка: ' + error.message); } else { cloud.status = 'codesent'; render(); } });
  },
  cloudVerify: () => {
    const el = document.getElementById('cloud-code'); const token = (el && el.value || '').trim();
    if (!token) { showToast('Впишите код из письма'); return; }
    sb.auth.verifyOtp({ email: cloud.pendingEmail, token, type: 'email' })
      .then(({ error }) => { if (error) showToast('Неверный код'); /* onAuthStateChange handles success */ });
  },
  cloudChangeEmail: () => { cloud.status = 'signedout'; cloud.pendingEmail = ''; render(); },
  cloudSignOut: () => { if (sb) sb.auth.signOut(); cloud.session = null; cloud.club = null; cloud.clubs = []; cloud.isOwner = true; cloud.status = 'signedout'; render(); },
  cloudSyncNow: () => { if (cloud.session) onSignedIn(cloud.session); },
  cloudSwitchClub: (e) => {
    const id = e.currentTarget.dataset.id;
    const club = cloud.clubs.find(c => c.id === id);
    if (!club || (cloud.club && club.id === cloud.club.id)) return;
    cloud.status = 'syncing'; render();
    setActiveClub(club);
    syncMerge().then(() => { cloud.status = 'synced'; render(); }).catch(() => { cloud.status = 'error'; render(); });
  },
  cloudJoin: () => {
    if (!cloud.session) { showToast('Сначала войдите по email'); return; }
    const el = document.getElementById('cloud-clubcode'); const code = (el && el.value || '').trim();
    if (!code) { showToast('Впишите код клуба'); return; }
    cloud.status = 'syncing'; render();
    sb.rpc('join_club', { club_code: code }).then(async ({ data, error }) => {
      if (error) { cloud.status = 'synced'; showToast('Клуб не найден'); render(); return; }
      const joined = Array.isArray(data) ? data[0] : data;
      try {
        const { data: clubs } = await sb.from('clubs').select('*');
        cloud.clubs = clubs && clubs.length ? clubs : [joined];
        setActiveClub(cloud.clubs.find(c => c.id === joined.id) || joined);
        await syncMerge(); cloud.status = 'synced'; showToast('Клуб подключён');
      } catch (e) { cloud.status = 'error'; }
      render();
    });
  },
};

let clubReturn = 'setup';
let viewTourneyId = null; // archive detail currently open (transient)
let showGuide = false;    // tournament cheat-sheet modal (transient)
function openGuide() { showGuide = true; render(); }

function archiveText(rec) {
  const lines = [];
  const date = (() => { try { return new Date(rec.date).toLocaleDateString('ru-RU'); } catch (e) { return ''; } })();
  lines.push('♠ Покерный турнир · ' + date);
  lines.push('Банк ' + money(rec.bank) + ' · входов ' + rec.entries + (rec.totalRebuys != null ? ' (ребаев ' + rec.totalRebuys + (rec.totalAddons ? ', аддонов ' + rec.totalAddons : '') + ')' : ''));
  (rec.prizes || []).forEach(pr => lines.push(pr.place + ' место — ' + pr.name + ': ' + money(pr.amount)));
  lines.push('');
  lines.push('Баланс:');
  (rec.players || []).slice().sort((a, b) => b.net - a.net).forEach(p => {
    const sign = p.net > 0 ? '+' : p.net < 0 ? '−' : '';
    lines.push('• ' + p.name + ': ' + sign + money(Math.abs(p.net)));
  });
  if (rec.tx && rec.tx.length) {
    lines.push('');
    lines.push('Кто кому платит:');
    rec.tx.forEach(t => lines.push('• ' + t.from + ' → ' + t.to + ': ' + money(t.amount)));
  }
  return lines.join('\n');
}

const confirmKinds = {
  newTournament: () => {
    stopChimeLoop();
    state.timer = { endsAt: null, remainingMs: (state.levels[0].dur || 15) * 60000, running: false };
    keepAwake(false);
    setState({ screen: 'setup', currentLevel: 0, levelEnd: false, showRebuyModal: false, confirm: null });
  },
  clearArchive: () => { deleteCloudArchive(); archive = []; saveArchive(); setState({ confirm: null }); },
};

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    done();
  } catch (e) { showToast('Не удалось скопировать'); }
}

// ——— field input handlers ———
function onLevelField(e) {
  const i = +e.target.dataset.idx, f = e.target.dataset.field, v = e.target.value;
  setState(s => ({ levels: s.levels.map((l, k) => k === i ? { ...l, [f]: v === '' ? 0 : Math.max(0, +v || 0) } : l) }));
}
function onCfg(e) {
  const k = e.target.dataset.key, v = e.target.value;
  setState({ [k]: v === '' ? 0 : Math.max(0, +v || 0) });
}
function onPlayerName(e) {
  const i = +e.target.dataset.idx, v = e.target.value;
  setState(s => ({ players: s.players.map((p, k) => k === i ? { ...p, name: v } : p) }));
}
function onRunPlayerName(e) {
  const id = +e.target.dataset.pid, v = e.target.value;
  setState(s => ({ players: s.players.map(p => p.id === id ? { ...p, name: v } : p) }));
}
function setPlace(e) {
  const place = e.target.dataset.place, v = e.target.value;
  setState(s => ({ places: { ...s.places, ['p' + place]: v } }));
}

// ═══════════ derived values ═══════════
function derive() {
  const s = state;
  const totalRebuys = s.players.reduce((a, p) => a + (p.rebuys || 0), 0);
  const totalAddons = s.players.reduce((a, p) => a + (p.addons || 0), 0);
  const entries = s.players.length + totalRebuys;
  const bank = s.players.length * s.buyIn + totalRebuys * s.rebuyAmount + totalAddons * s.addonAmount;
  const remaining = s.players.filter(p => !p.out).length || 0;
  const totalChips = entries * s.startingStack + totalAddons * s.addonStack;
  const avgStack = remaining ? Math.round(totalChips / remaining) : 0;
  const addonOn = (+s.addonAmount || 0) > 0;

  const cur = s.levels[s.currentLevel] || {};
  const curIsBreak = cur.type === 'break';
  // "next blinds" should skip break levels
  let nxt = s.levels[s.currentLevel + 1];
  let nxtBlind = null;
  for (let k = s.currentLevel + 1; k < s.levels.length; k++) { if (s.levels[k].type !== 'break') { nxtBlind = s.levels[k]; break; } }
  const rebuyOpen = s.currentLevel < s.rebuyLevels;
  const clockInit = fmtClock(remainingMs());
  // level display number counts only blind levels (breaks don't get a number)
  let blindNo = 0, blindTotal = 0;
  s.levels.forEach((l, k) => { if (l.type !== 'break') { blindTotal++; if (k <= s.currentLevel) blindNo++; } });

  const splits = [s.split1, s.split2, s.split3];
  const splitTotal = splits.reduce((a, b) => a + (+b || 0), 0);
  const paidPlaces = splits.filter(p => (+p || 0) > 0).length;
  const bubble = paidPlaces > 0 && remaining === paidPlaces + 1;

  const pnById = id => { const idx = s.players.findIndex(p => p.id === id); return idx < 0 ? '—' : nameOf(s.players[idx], idx); };
  let order = (s.seatOrder && s.seatOrder.length) ? s.seatOrder.filter(id => s.players.some(p => p.id === id)) : s.players.map(p => p.id);
  if (order.length !== s.players.length) order = s.players.map(p => p.id);
  const nSeat = order.length;
  const dIdx = nSeat ? (s.dealerIndex % nSeat) : 0;
  let sbIdx, bbIdx;
  if (nSeat <= 1) { sbIdx = 0; bbIdx = 0; }
  else if (nSeat === 2) { sbIdx = dIdx; bbIdx = (dIdx + 1) % nSeat; }
  else { sbIdx = (dIdx + 1) % nSeat; bbIdx = (dIdx + 2) % nSeat; }
  const seats = order.map((id, i) => {
    const ang = (-90 + i * 360 / nSeat) * Math.PI / 180;
    const x = (50 + 42 * Math.cos(ang)).toFixed(2);
    const y = (50 + 45 * Math.sin(ang)).toFixed(2);
    return { name: pnById(id), seatNo: i + 1, x, y, isD: i === dIdx, isSB: i === sbIdx, isBB: i === bbIdx };
  });

  const lastLevel = s.currentLevel >= s.levels.length - 1;
  const placeIds = [s.places.p1, s.places.p2, s.places.p3];
  const prizeAmts = payouts(bank, splits, 100);
  const prizeRows = [1, 2, 3].map((pl, k) => ({
    place: pl, pct: (+splits[k] || 0) + '%', amount: prizeAmts[k], amountStr: money(prizeAmts[k]),
    sel: placeIds[k] || '', name: placeIds[k] ? pnById(+placeIds[k]) : '',
  }));

  const placeOf = (p) => {
    const k = placeIds.findIndex(id => String(id) === String(p.id));
    if (k >= 0) return k + 1;
    if (p.bustedAt && p.bustedAt.place) return p.bustedAt.place;
    return null;
  };
  const standings = s.players.map((p, i) => {
    const paid = s.buyIn + (p.rebuys || 0) * s.rebuyAmount + (p.addons || 0) * s.addonAmount;
    let payout = 0;
    placeIds.forEach((id, k) => { if (String(id) === String(p.id)) payout += prizeAmts[k]; });
    const net = payout - paid;
    return {
      name: nameOf(p, i), paid, payout, net, place: placeOf(p), paidStr: money(paid),
      payoutStr: payout ? money(payout) : '—',
      netStr: (net > 0 ? '+' : net < 0 ? '−' : '') + money(Math.abs(net)),
      netClass: net > 0 ? 'pk-net-up' : (net < 0 ? 'pk-net-down' : ''),
    };
  });
  const tx = settle(standings.map(st => ({ name: st.name, net: st.net })));

  return {
    s, totalRebuys, totalAddons, entries, bank, remaining, avgStack, cur, nxt, nxtBlind, rebuyOpen, clockInit,
    curIsBreak, blindNo, blindTotal, addonOn,
    running: s.timer.running, seats, hasSeats: nSeat > 0,
    lastLevel, splitTotal, splitOk: splitTotal === 100, paidPlaces, bubble,
    prizeRows, standings, placeIds, tx,
  };
}

function resultsText(d) {
  const lines = [];
  lines.push('♠ Покерный турнир — итоги');
  lines.push('Банк: ' + money(d.bank) + ' · входов: ' + d.entries);
  d.prizeRows.forEach(pr => { if (pr.sel) lines.push(pr.place + ' место — ' + pr.name + ': ' + pr.amountStr); });
  lines.push('');
  lines.push('Кто кому платит:');
  if (!d.tx.length) lines.push('— все в расчёте');
  else d.tx.forEach(t => lines.push('• ' + t.from + ' → ' + t.to + ': ' + money(t.amount)));
  return lines.join('\n');
}

// ═══════════ rendering ═══════════
const screenEl = document.getElementById('screen');
const modalsEl = document.getElementById('modals');
const stepsEl = document.getElementById('steps');
const headerRightEl = document.getElementById('headerRight');
const appEl = document.getElementById('app');
const themeMeta = document.querySelector('meta[name="theme-color"]');

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const active = document.activeElement;
  let focusInfo = null;
  if (active && screenEl.contains(active) && active.dataset) {
    focusInfo = {
      tag: active.tagName,
      idx: active.dataset.idx, field: active.dataset.field, key: active.dataset.key, pid: active.dataset.pid,
      selStart: 'selectionStart' in active ? active.selectionStart : null,
      selEnd: 'selectionStart' in active ? active.selectionEnd : null,
    };
  }

  const themeDef = THEMES.find(t => t.key === state.theme) || THEMES[0];
  appEl.className = 'pk-app ' + themeDef.cls;
  document.documentElement.style.background = themeDef.bg;
  document.body.style.background = themeDef.bg;
  if (themeMeta) themeMeta.setAttribute('content', themeDef.bg);

  const d = derive();

  stepsEl.querySelectorAll('span').forEach(sp => {
    sp.className = state.screen === sp.dataset.step ? 'is-active' : 'is-inactive';
  });
  headerRightEl.textContent = state.screen === 'running' ? ('Банк ' + money(d.bank)) : (state.screen === 'final' ? 'Итоги' : '');

  const renderers = { setup: setupHtml, players: playersHtml, seats: seatsHtml, running: runningHtml, final: finalHtml, club: clubHtml };
  screenEl.innerHTML = (renderers[state.screen] || setupHtml)(d);
  modalsEl.innerHTML = modalsHtml(d);

  if (focusInfo) {
    let sel = '';
    if (focusInfo.idx !== undefined && focusInfo.idx !== null) sel += `[data-idx="${focusInfo.idx}"]`;
    if (focusInfo.field) sel += `[data-field="${focusInfo.field}"]`;
    if (focusInfo.key) sel += `[data-key="${focusInfo.key}"]`;
    if (focusInfo.pid) sel += `[data-pid="${focusInfo.pid}"]`;
    if (sel) {
      const candidates = screenEl.querySelectorAll(sel);
      const again = Array.from(candidates).find(el => el.tagName === focusInfo.tag) || candidates[0];
      if (again) {
        again.focus();
        if (focusInfo.selStart != null && again.setSelectionRange) {
          try { again.setSelectionRange(focusInfo.selStart, focusInfo.selEnd); } catch (e) { /* not text */ }
        }
      }
    }
  }

  renderSettingsPanel();
}

// ——— screens ———
function setupHtml(d) {
  const s = d.s;
  let blindN = 0;
  const rows = s.levels.map((lv, i) => {
    if (lv.type === 'break') {
      return `
      <tr>
        <td class="pk-num text-muted" style="color:var(--color-accent)">⏸</td>
        <td colspan="4" style="letter-spacing:.08em;text-transform:uppercase;font-size:12px;color:var(--color-accent)">Перерыв
          <input class="input pk-num" type="text" inputmode="numeric" style="width:50px;display:inline-block;margin-left:10px" value="${lv.dur}" data-idx="${i}" data-field="dur"> мин</td>
        <td></td>
        <td><button class="btn btn-icon pk-btn-danger" title="Удалить" data-idx="${i}" data-action="removeLevel">×</button></td>
      </tr>`;
    }
    blindN++;
    return `
    <tr>
      <td class="pk-num text-muted">${blindN}</td>
      <td><input class="input pk-num" type="text" inputmode="numeric" style="width:70px" value="${lv.sb}" data-idx="${i}" data-field="sb"></td>
      <td><input class="input pk-num" type="text" inputmode="numeric" style="width:70px" value="${lv.bb}" data-idx="${i}" data-field="bb"></td>
      <td><input class="input pk-num" type="text" inputmode="numeric" style="width:62px" value="${lv.ante}" data-idx="${i}" data-field="ante"></td>
      <td><input class="input pk-num" type="text" inputmode="numeric" style="width:50px" value="${lv.dur}" data-idx="${i}" data-field="dur"></td>
      <td style="text-align:center">
        <button class="btn" style="border:1px solid var(--color-divider);font-size:12px;${lv.colorUp ? 'color:var(--color-accent);border-color:var(--color-accent) !important;' : 'color:var(--color-neutral-600);'}" data-idx="${i}" data-action="toggleColorUp">${lv.colorUp ? '● Замена' : 'Нет'}</button>
      </td>
      <td><button class="btn btn-icon pk-btn-danger" title="Удалить" data-idx="${i}" data-action="removeLevel">×</button></td>
    </tr>`;
  }).join('');

  const splitWarn = !d.splitOk ? `<div style="color:var(--pk-danger,#c0662f);font-size:12px;margin-top:4px">⚠ Сумма ${d.splitTotal}% — должно быть 100%</div>` : `<div class="text-muted pk-num" style="font-size:12px;margin-top:4px">Итого: ${d.splitTotal}%</div>`;

  const nBuiltin = BUILTIN_TEMPLATES.length;
  const tplList = allTemplates().map((t, i) => `
    <div style="display:flex;align-items:center;gap:6px">
      <button class="btn btn-secondary" style="flex:1;justify-content:flex-start;font-size:13px" data-action="applyTemplate" data-idx="${i}" title="Применить">${t.builtin ? '★ ' : ''}${esc(t.name)} <span class="text-muted pk-num" style="margin-left:auto;font-size:11px">${t.levels.filter(l => l.type !== 'break').length} ур.</span></button>
      ${t.builtin ? '' : `<button class="btn btn-icon pk-btn-danger" data-action="deleteTemplate" data-uidx="${i - nBuiltin}" title="Удалить">×</button>`}
    </div>`).join('');
  const templatesCard = `
    <div class="card">
      <div class="card-kicker">Шаблоны структуры</div>
      <div style="display:flex;flex-direction:column;gap:6px">${tplList}</div>
      <div style="display:flex;gap:6px;margin-top:2px">
        <input class="input" id="tpl-name" placeholder="Название нового шаблона" style="flex:1;font-size:13px">
        <button class="btn btn-ghost" data-action="saveTemplate" style="white-space:nowrap">Сохранить текущую</button>
      </div>
      <div class="text-muted" style="font-size:11px">Нажмите шаблон — структура и взносы подставятся. «★ Домашняя (база)» есть всегда.</div>
    </div>
`;

  return `
  <main class="pk-main pk-wide">
    <span class="pk-kicker">Настройка</span>
    <h1 class="pk-h1">Структура турнира</h1>
    <p class="text-muted" style="max-width:60ch;margin:0 0 24px">Стандартный шаблон уже загружен. Отредактируйте уровни, суммы взносов и окно ребаев, затем перейдите к выбору игроков.</p>

    <div class="pk-setup-grid">
      <section style="min-width:0;overflow-x:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px">
          <h4 style="font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Уровни блайндов</h4>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost" data-action="addBreak">+ Перерыв</button>
            <button class="btn btn-ghost" data-action="addLevel">+ Уровень</button>
          </div>
        </div>
        <table class="table">
          <thead><tr>
            <th style="width:28px">#</th><th>SB</th><th>BB</th><th>Анте</th><th>Мин</th>
            <th style="text-align:center">Замена фишек</th><th style="width:28px"></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>

      <aside style="display:flex;flex-direction:column;gap:20px">
        ${templatesCard}
        <div class="card">
          <div class="card-kicker">Взносы и фишки</div>
          <div class="field"><label>Бай-ин, ₽</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.buyIn}" data-key="buyIn"></div>
          <div class="field"><label>Ребай, ₽</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.rebuyAmount}" data-key="rebuyAmount"></div>
          <div class="field"><label>Стартовый стек, фишек</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.startingStack}" data-key="startingStack"></div>
          <div class="field"><label>Ребаи открыты первые N уровней</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.rebuyLevels}" data-key="rebuyLevels"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="field" style="margin:0"><label>Аддон, ₽ (0 = выкл.)</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.addonAmount}" data-key="addonAmount"></div>
            <div class="field" style="margin:0"><label>Аддон, фишек</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.addonStack}" data-key="addonStack"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-kicker">Призовые, %</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
            <div class="field" style="margin:0"><label>1 место</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.split1}" data-key="split1"></div>
            <div class="field" style="margin:0"><label>2 место</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.split2}" data-key="split2"></div>
            <div class="field" style="margin:0"><label>3 место</label><input class="input pk-num" type="text" inputmode="numeric" value="${s.split3}" data-key="split3"></div>
          </div>
          ${splitWarn}
        </div>

        <button class="btn btn-secondary" data-action="testSound">♪ Проверить сигнал</button>
      </aside>
    </div>

    <hr class="hr">
    <div style="display:flex;justify-content:flex-end">
      <button class="btn btn-primary" style="padding:11px 24px" data-action="goPlayers">Далее · Игроки →</button>
    </div>
  </main>`;
}

function playersHtml(d) {
  const s = d.s;
  const rows = s.players.map((p, i) => `
    <div style="display:flex;align-items:center;gap:12px">
      <span class="pk-num" style="width:26px;font-family:var(--font-heading);font-size:20px;color:var(--color-accent)">${i + 1}</span>
      <input class="input" style="flex:1" value="${esc(p.name)}" placeholder="Игрок ${i + 1}" data-idx="${i}">
      <button class="btn btn-icon pk-btn-danger" title="Убрать" data-idx="${i}" data-action="removePlayer">×</button>
    </div>`).join('');

  const inGame = name => s.players.some(p => (p.name || '').trim().toLowerCase() === name.toLowerCase());
  const rosterChips = roster.length ? `
    <div style="margin:0 0 22px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <div class="card-kicker">Ростер клуба — нажмите, чтобы добавить</div>
        <button class="btn btn-ghost" data-action="savePlayersToRoster" style="font-size:12px">Сохранить этот состав в ростер</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${roster.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(r => `
          <span class="pk-chip ${inGame(r.name) ? 'is-in' : ''}">
            <button class="pk-chip-add" data-action="addFromRoster" data-name="${esc(r.name)}" title="Добавить за стол">${esc(r.name)}</button>
            <button class="pk-chip-x" data-action="removeFromRoster" data-name="${esc(r.name)}" title="Убрать из ростера">×</button>
          </span>`).join('')}
      </div>
    </div>` : `
    <div class="text-muted" style="font-size:12px;margin:0 0 22px">Ростер пуст. Впишите игроков ниже и нажмите «Сохранить состав в ростер» — в следующий раз добавите их одним нажатием.
      <button class="btn btn-ghost" data-action="savePlayersToRoster" style="font-size:12px;margin-left:6px">Сохранить состав в ростер</button>
    </div>`;

  return `
  <main class="pk-main pk-narrow">
    <span class="pk-kicker">Регистрация</span>
    <h1 class="pk-h1">Игроки за столом</h1>
    <p class="text-muted" style="margin:0 0 20px">Каждый вносит бай-ин ${money(s.buyIn)} и получает ${fmt(s.startingStack)} фишек. Ребаи добавляются во время игры.</p>

    ${rosterChips}

    <div style="display:flex;flex-direction:column;gap:10px">${rows}</div>
    <button class="btn btn-ghost" style="margin-top:14px" data-action="addPlayer">+ Добавить игрока</button>

    <hr class="hr">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <button class="btn btn-secondary" data-action="backToSetup">← Структура</button>
      <div style="display:flex;align-items:center;gap:18px">
        <span class="text-muted pk-num" style="font-size:13px">${s.players.length} игроков · банк ${money(s.players.length * s.buyIn)}</span>
        <button class="btn btn-primary" style="padding:11px 24px" data-action="goSeats">Далее · Жеребьёвка →</button>
      </div>
    </div>
  </main>`;
}

function seatsHtml(d) {
  const seatEls = d.seats.map(seat => `
    <div class="pk-seat" style="left:${seat.x}%;top:${seat.y}%">
      <div class="pk-seat-badges">
        ${seat.isD ? '<span class="pk-seat-d">D</span>' : ''}
        ${seat.isSB ? '<span class="tag tag-outline" style="font-size:9px;padding:2px 6px">SB</span>' : ''}
        ${seat.isBB ? '<span class="tag tag-accent" style="font-size:9px;padding:2px 6px">BB</span>' : ''}
      </div>
      <div class="pk-seat-card">
        <div class="text-muted pk-num" style="font-size:10px;letter-spacing:.06em">Место ${seat.seatNo}</div>
        <div class="pk-seat-name">${esc(seat.name)}</div>
      </div>
    </div>`).join('');

  return `
  <main class="pk-main pk-mid">
    <div style="align-self:flex-start">
      <span class="pk-kicker">Жеребьёвка</span>
      <h1 class="pk-h1">Рассадка и кнопка</h1>
      <p class="text-muted" style="max-width:64ch;margin:0 0 8px">Места и дилерская кнопка розданы случайно. Кнопка <b style="color:var(--color-accent)">D</b> задаёт малый (SB) и большой (BB) блайнды. Перемешайте, если нужно.</p>
    </div>

    <div class="pk-table-wrap">
      <div class="pk-felt"></div>
      <div class="pk-felt-label">Стол №1</div>
      ${seatEls}
    </div>

    <hr class="hr" style="width:100%">
    <div style="display:flex;justify-content:space-between;align-items:center;width:100%;flex-wrap:wrap;gap:12px">
      <button class="btn btn-secondary" data-action="backToPlayers">← Игроки</button>
      <div style="display:flex;gap:12px;align-items:center">
        <button class="btn btn-secondary" data-action="drawSeats">⟳ Перемешать</button>
        <button class="btn btn-primary" style="padding:11px 24px" data-action="startTournament">Запустить турнир ▸</button>
      </div>
    </div>
  </main>`;
}

function runningHtml(d) {
  const s = d.s;
  let bn = 0;
  const structureRows = s.levels.map((l, i) => {
    const cls = i === s.currentLevel ? 'is-current' : (i < s.currentLevel ? 'is-past' : '');
    if (l.type === 'break') {
      return `
        <div class="pk-level-row ${cls}">
          <span class="pk-num" style="width:20px;font-family:var(--font-heading);font-size:16px;color:var(--color-accent)">⏸</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-accent)">Перерыв</div>
            <div class="text-muted pk-num" style="font-size:11px">${l.dur} мин</div>
          </div>
        </div>`;
    }
    bn++;
    return `
      <div class="pk-level-row ${cls}">
        <span class="pk-num" style="width:20px;font-family:var(--font-heading);font-size:16px;color:var(--color-accent)">${bn}</span>
        <div style="flex:1;min-width:0">
          <div class="pk-num" style="font-size:15px">${fmt(l.sb)} / ${fmt(l.bb)}</div>
          <div class="text-muted pk-num" style="font-size:11px">${(l.ante ? 'анте ' + fmt(l.ante) + ' · ' : '') + l.dur + ' мин'}</div>
        </div>
        ${l.colorUp ? '<span class="tag tag-outline" style="font-size:9px;padding:2px 6px">замена</span>' : ''}
      </div>`;
  }).join('');

  const rebuyOpen = d.rebuyOpen;
  const addonOn = d.addonOn;
  const playersRows = s.players.map((p, i) => {
    const extras = (p.rebuys || 0) > 0 || (p.addons || 0) > 0
      ? (1 + (p.rebuys || 0)) + '× вход' + ((p.addons || 0) > 0 ? ' · +аддон' : '')
      : '1× вход';
    const meta = p.out
      ? ('выбыл' + (p.bustedAt && p.bustedAt.place ? ' · место ' + p.bustedAt.place : ''))
      : (extras + ' · ' + money(s.buyIn + (p.rebuys || 0) * s.rebuyAmount + (p.addons || 0) * s.addonAmount));
    return `
      <div class="pk-player-row ${p.out ? 'is-out' : ''}">
        <div style="flex:1;min-width:0">
          <input class="pk-name-edit" value="${esc(p.name)}" placeholder="Игрок ${i + 1}" data-pid="${p.id}">
          <div class="text-muted pk-num" style="font-size:11px">${meta}</div>
        </div>
        ${!p.out ? `
          ${addonOn ? `<button class="btn btn-ghost" data-id="${p.id}" data-action="doAddon" ${!rebuyOpen ? 'disabled' : ''} style="font-size:12px;padding:5px 6px" title="Аддон">+А</button>` : ''}
          <button class="btn btn-secondary" data-id="${p.id}" data-action="doRebuy" ${!rebuyOpen ? 'disabled' : ''} style="font-size:12px;padding:5px 9px">+ Ребай</button>
          <button class="btn btn-icon pk-btn-danger" title="Выбыл" data-id="${p.id}" data-action="toggleOut">✕</button>
        ` : `
          <button class="btn btn-ghost" data-id="${p.id}" data-action="toggleOut" style="font-size:12px">Вернуть</button>
        `}
      </div>`;
  }).join('');

  const cur = d.cur, nxtBlind = d.nxtBlind;
  const showNextRow = s.showNextBlinds && !!nxtBlind;
  const levelLabel = d.curIsBreak ? 'Перерыв' : ('Уровень ' + d.blindNo + ' / ' + d.blindTotal);

  // ——— hero pieces (clock centred, blinds on the left flank, stats on the right) ———
  const blindsBlock = `
    <div class="pk-flank-blinds">
      <div class="pk-flank-cap">${d.curIsBreak ? 'Статус' : 'Малый / Большой'}</div>
      <div class="pk-num pk-blinds-big" style="font-family:var(--font-heading)">${d.curIsBreak ? '⏸ Перерыв' : fmt(cur.sb) + ' / ' + fmt(cur.bb)}</div>
      ${(!d.curIsBreak && cur.ante) ? `<div style="margin-top:10px"><div class="pk-flank-cap">Анте</div><div class="pk-num" style="font-family:var(--font-heading);font-size:clamp(26px,3.4vw,40px);line-height:1;margin-top:2px">${fmt(cur.ante)}</div></div>` : ''}
      ${showNextRow ? `<div style="margin-top:10px"><div class="pk-flank-cap">${d.curIsBreak ? 'После перерыва' : 'Далее'}</div><div class="pk-num text-muted" style="font-size:clamp(16px,2vw,22px);line-height:1;margin-top:4px">${fmt(nxtBlind.sb)} / ${fmt(nxtBlind.bb)}${nxtBlind.ante ? ' · анте ' + fmt(nxtBlind.ante) : ''}</div></div>` : ''}
      ${d.bubble ? `<div class="pk-bubble" style="margin-top:12px"><span class="dot"></span><span>Бабл — один вылет до призов</span></div>` : ''}
      ${cur.colorUp ? `<div class="pk-colorup" style="margin-top:12px"><span class="dot"></span><span>Замена фишек (color up)</span></div>` : ''}
    </div>`;

  const statCell = (label, value) => `<div class="pk-stat-cell"><div class="pk-flank-cap">${label}</div><div class="pk-num" style="font-family:var(--font-heading);font-size:clamp(20px,2.4vw,26px)">${value}</div></div>`;
  const statsBlock = `
    <div class="pk-flank-stats">
      <div class="pk-stat-grid">
        ${statCell('Банк', money(d.bank))}
        ${statCell('Осталось', d.remaining + ' / ' + s.players.length)}
        ${statCell('Входов', d.entries)}
        ${statCell('Ср. стек', fmt(d.avgStack))}
      </div>
    </div>`;

  const centerBlock = `
    <div class="pk-hero-center">
      <div style="display:flex;align-items:center;justify-content:center;gap:14px">
        <span style="font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:var(--color-neutral-600)" class="pk-num">${levelLabel}</span>
        <span class="tag ${rebuyOpen ? 'tag-accent' : 'tag-neutral'}" style="font-size:10px">${rebuyOpen ? 'Ребаи открыты' : 'Ребаи закрыты'}</span>
      </div>
      <div class="pk-num pk-clock" id="pk-clock">${d.clockInit}</div>
      <div class="pk-progress"><i id="pk-progress-fill"></i></div>
      <div class="pk-ctrl">
        <button class="btn btn-secondary" data-action="addMinusMinute" title="Убавить минуту" style="height:46px;font-size:15px;padding:0 15px">−1 мин</button>
        <button class="btn btn-secondary btn-icon" title="Предыдущий уровень" data-action="prev" style="font-size:18px">‹</button>
        <button class="btn btn-primary" data-action="toggleRun" style="width:176px;height:56px;font-size:18px;letter-spacing:.04em">${d.running ? '❙❙  Пауза' : '►  Старт'}</button>
        <button class="btn btn-secondary btn-icon" title="Следующий уровень" data-action="next" style="font-size:18px">›</button>
        <button class="btn btn-secondary" data-action="addPlusMinute" title="Добавить минуту" style="height:46px;font-size:15px;padding:0 15px">+1 мин</button>
        <button class="btn btn-icon" title="Звук" data-action="toggleSoundBtn" style="color:var(--color-neutral-700);margin-left:4px">${s.muted ? '♪̶' : '♪'}</button>
      </div>
    </div>`;

  return `
  <main class="pk-run">

    <section class="pk-hero">
      <div class="pk-hero-inner">
        ${blindsBlock}
        ${centerBlock}
        ${statsBlock}
      </div>
    </section>

    <div class="pk-below-grid">
      <div class="pk-scroll pk-below-left pk-pad">
        <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-600);margin-bottom:8px">Структура</div>
        ${structureRows}
      </div>

      <aside class="pk-scroll pk-run-right">
        <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px">
          <span style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-neutral-600)">Игроки</span>
          ${rebuyOpen ? '<button class="btn btn-ghost" data-action="lateAddPlayer" style="font-size:12px" title="Поздняя регистрация">+ Игрок</button>' : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:1">${playersRows}</div>
        ${!rebuyOpen ? '<div class="text-muted" style="font-size:12px;margin-top:8px;font-style:italic">Регистрация и ребаи закрыты</div>' : ''}
        <button class="btn btn-primary btn-block" style="margin-top:14px" data-action="endTournament">Завершить турнир</button>
      </aside>
    </div>
  </main>`;
}

function finalHtml(d) {
  const s = d.s;
  const prizeRows = d.prizeRows.map(pr => `
    <div style="display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--color-divider);padding-bottom:14px">
      <div class="pk-num" style="font-family:var(--font-heading);font-size:34px;width:34px;color:var(--color-accent)">${pr.place}</div>
      <div style="flex:1">
        <div class="text-muted" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase">${pr.pct} банка · ${pr.amountStr}</div>
        <select class="input" data-place="${pr.place}" style="margin-top:4px">
          <option value="">— выбрать игрока —</option>
          ${s.players.map((p, i) => `<option value="${p.id}" ${String(pr.sel) === String(p.id) ? 'selected' : ''}>${esc(nameOf(p, i))}</option>`).join('')}
        </select>
      </div>
    </div>`).join('');

  const standingRows = d.standings.map(st => `
    <tr>
      <td>${esc(st.name)}</td>
      <td class="pk-num text-muted" style="text-align:right">${st.paidStr}</td>
      <td class="pk-num" style="text-align:right">${st.payoutStr}</td>
      <td class="pk-num ${st.netClass}" style="text-align:right">${st.netStr}</td>
    </tr>`).join('');

  const txRows = d.tx.length
    ? d.tx.map(t => `
      <div class="pk-tx">
        <span class="pk-tx-from">${esc(t.from)}</span>
        <span class="pk-tx-arrow">→</span>
        <span>${esc(t.to)}</span>
        <span class="pk-tx-amt pk-num">${money(t.amount)}</span>
      </div>`).join('')
    : '<div class="text-muted" style="font-size:13px">Все в расчёте — переводов нет.</div>';

  const splitWarn = !d.splitOk ? `<span style="color:var(--pk-danger,#c0662f)"> · ⚠ призовые ${d.splitTotal}% (не 100%)</span>` : '';
  const rebuyCountStr = d.totalRebuys + ' ребаев по ' + money(s.rebuyAmount);

  return `
  <main class="pk-main" style="max-width:860px">
    <span class="pk-kicker">Итоги</span>
    <h1 class="pk-h1">Расчёт призовых</h1>
    <p class="text-muted" style="margin:0 0 24px">Банк ${money(d.bank)} — ${s.players.length} входов по ${money(s.buyIn)} и ${rebuyCountStr}.${splitWarn} Назначьте призёров — места уже проставлены по порядку вылетов.</p>

    <div class="pk-final-grid">
      <section>
        <h4 style="margin:0 0 12px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Призовые места</h4>
        <div style="display:flex;flex-direction:column;gap:14px">${prizeRows}</div>
      </section>

      <section style="min-width:0;overflow-x:auto">
        <h4 style="margin:0 0 12px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Баланс игроков</h4>
        <table class="table">
          <thead><tr><th>Игрок</th><th style="text-align:right">Внёс</th><th style="text-align:right">Выигрыш</th><th style="text-align:right">Итог</th></tr></thead>
          <tbody>${standingRows}</tbody>
        </table>
      </section>
    </div>

    <section style="margin-top:28px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <h4 style="margin:0;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Кто кому платит</h4>
        <button class="btn btn-secondary" data-action="copyResults">⧉ Скопировать итоги</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;max-width:520px">${txRows}</div>
    </section>

    <hr class="hr">
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px">
      <button class="btn btn-secondary" data-action="backToRunning">← Вернуться к таймеру</button>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn btn-secondary" data-action="saveToArchive">💾 Сохранить в архив</button>
        <button class="btn btn-primary" data-action="newTournament">Новый турнир</button>
      </div>
    </div>
  </main>`;
}

// ——— club: roster + archive + season table ———
function cloudCardHtml() {
  const wrap = inner => `<div class="card" style="margin-bottom:24px"><div class="card-kicker">Облачная синхронизация</div>${inner}</div>`;
  if (cloud.status === 'off') {
    return wrap(`<div class="text-muted" style="font-size:13px">Выключена — приложение работает локально. Чтобы включить синхронизацию между устройствами, заполните <b>config.js</b> данными проекта Supabase (см. SUPABASE_SETUP.md).</div>`);
  }
  if (cloud.status === 'connecting') {
    return wrap(`<div class="text-muted" style="font-size:13px">Подключение…</div>`);
  }
  if (cloud.status === 'signedout') {
    return wrap(`
      <div class="text-muted" style="font-size:13px;margin-bottom:8px">Войдите по email — пришлём ссылку для входа. <b>На каждом устройстве нужно войти один раз.</b> Укажите <b>тот же email</b>, что и на первом устройстве — данные подтянутся сами (код клуба вводить не нужно).</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input class="input" id="cloud-email" type="email" inputmode="email" placeholder="you@example.com" style="flex:1;min-width:180px" autocomplete="email">
        <button class="btn btn-primary" data-action="cloudSendCode">Прислать ссылку</button>
      </div>`);
  }
  if (cloud.status === 'codesent') {
    return wrap(`
      <div style="font-size:13px;margin-bottom:8px">Письмо отправлено на <b>${esc(cloud.pendingEmail)}</b>.</div>
      <div style="font-size:13px;margin-bottom:10px">📩 <b>Откройте ссылку из письма на этом же устройстве</b> — вход произойдёт сам, вводить ничего не нужно.</div>
      <div class="text-muted" style="font-size:12px;margin-bottom:6px">Если в письме 6-значный код (при своём SMTP) — впишите его:</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input class="input pk-num" id="cloud-code" inputmode="numeric" placeholder="Код (если есть)" style="flex:1;min-width:140px">
        <button class="btn btn-secondary" data-action="cloudVerify">Войти по коду</button>
        <button class="btn btn-ghost" data-action="cloudChangeEmail">Изменить email</button>
      </div>`);
  }
  if (cloud.status === 'syncing') return wrap(`<div class="text-muted" style="font-size:13px">Синхронизация…</div>`);
  // synced / error (signed in)
  const code = cloud.club ? cloud.club.code : '';
  const roleTag = cloud.isOwner
    ? '<span class="tag tag-accent" style="font-size:10px">Владелец</span>'
    : '<span class="tag tag-neutral" style="font-size:10px">Участник</span>';
  const err = cloud.status === 'error' ? `<div style="color:var(--pk-danger,#c0662f);font-size:12px;margin-top:6px">Последняя синхронизация не удалась — данные сохранены локально.</div>` : '';
  // switcher only when the user has access to more than one club
  const switcher = (cloud.clubs && cloud.clubs.length > 1) ? `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px">
      <span class="text-muted" style="font-size:12px">Клуб:</span>
      ${cloud.clubs.map(c => `<button class="pk-theme-opt ${c.id === cloud.club.id ? 'is-active' : ''}" data-action="cloudSwitchClub" data-id="${esc(c.id)}" style="font-size:12px">${(c.owner === cloud.session.user.id ? 'Мой' : 'Друга') + ' · ' + esc(c.code)}</button>`).join('')}
    </div>
    <div class="text-muted" style="font-size:11px;margin-top:4px">Несколько клубов? Откройте нужный и удалите лишний пустой (см. инструкцию).</div>` : '';
  return wrap(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span>Вошли как <b>${esc(cloud.email)}</b></span> ${roleTag}
        ${code ? `<span class="text-muted">· код клуба <b class="pk-num" style="color:var(--color-accent)">${esc(code)}</b></span>` : ''}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" data-action="cloudSyncNow">⟳ Синхронизировать</button>
        <button class="btn btn-ghost" data-action="cloudSignOut">Выйти</button>
      </div>
    </div>
    ${switcher}
    <div class="text-muted" style="font-size:12px;margin-top:8px">${cloud.isOwner
      ? 'Вы владелец: можете добавлять и <b>удалять</b> турниры. Дайте друзьям код клуба — они смогут смотреть и добавлять, но не удалять.'
      : 'Вы участник этого клуба: можно смотреть и добавлять турниры. Удалять/очищать архив может только владелец.'}</div>
    <div class="text-muted" style="font-size:12px;margin-top:4px">Свой архив на другом своём устройстве — войдите <b>тем же email</b> (код не нужен).</div>
    ${err}
    <details class="pk-details" style="margin-top:10px">
      <summary class="text-muted" style="font-size:12px">Подключиться к клубу друга по коду ▾</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
        <input class="input" id="cloud-clubcode" placeholder="Код клуба" style="flex:1;min-width:160px">
        <button class="btn btn-secondary" data-action="cloudJoin">Подключить</button>
      </div>
    </details>`);
}

function archiveDetailHtml(rec, dateStr) {
  const players = (rec.players || []).slice().sort((a, b) => (b.net || 0) - (a.net || 0));
  const hasExtra = players.some(p => p.rebuys != null); // records saved before this update lack rebuys/tx

  const prizeLine = (rec.prizes && rec.prizes.length)
    ? rec.prizes.map(pr => `${pr.place}. <b>${esc(pr.name)}</b> — ${money(pr.amount)}${pr.pct ? ' <span class="text-muted">(' + pr.pct + ')</span>' : ''}`).join(' · ')
    : '<span class="text-muted">призовые не назначены</span>';

  const rows = players.map(p => {
    const entriesStr = (p.rebuys != null)
      ? ((1 + (p.rebuys || 0)) + '×' + ((p.addons || 0) > 0 ? ' +' + p.addons + 'А' : ''))
      : '—';
    const net = p.net || 0;
    return `
      <tr>
        <td>${esc(p.name)}${p.place ? ` <span class="text-muted pk-num" style="font-size:11px">· ${p.place} место</span>` : ''}</td>
        <td class="pk-num text-muted" style="text-align:center">${entriesStr}</td>
        <td class="pk-num text-muted" style="text-align:right">${money(p.paid || 0)}</td>
        <td class="pk-num" style="text-align:right">${p.payout ? money(p.payout) : '—'}</td>
        <td class="pk-num ${net > 0 ? 'pk-net-up' : (net < 0 ? 'pk-net-down' : '')}" style="text-align:right">${(net > 0 ? '+' : net < 0 ? '−' : '') + money(Math.abs(net))}</td>
      </tr>`;
  }).join('');

  const txRows = (rec.tx && rec.tx.length)
    ? rec.tx.map(t => `
        <div class="pk-tx">
          <span class="pk-tx-from">${esc(t.from)}</span><span class="pk-tx-arrow">→</span><span>${esc(t.to)}</span>
          <span class="pk-tx-amt pk-num">${money(t.amount)}</span>
        </div>`).join('')
    : (hasExtra ? '<div class="text-muted" style="font-size:13px">Все в расчёте — переводов нет.</div>'
                : '<div class="text-muted" style="font-size:13px">Этот турнир сохранён до обновления — детальные переводы не записаны.</div>');

  const rebuysNote = rec.totalRebuys != null
    ? ` · ребаев ${rec.totalRebuys}${rec.totalAddons ? ', аддонов ' + rec.totalAddons : ''}`
    : '';

  return `
  <main class="pk-main" style="max-width:760px">
    <span class="pk-kicker">Клуб · турнир</span>
    <h1 class="pk-h1">${dateStr(rec.date)}</h1>
    <p class="text-muted" style="margin:0 0 6px">Банк ${money(rec.bank)} · входов ${rec.entries}${rebuysNote} · игроков ${players.length}</p>
    <p style="margin:0 0 22px;font-size:14px">${prizeLine}</p>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
      <h4 style="margin:0;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Баланс игроков</h4>
      <button class="btn btn-secondary" data-action="copyTourney" data-id="${esc(rec.id || '')}">⧉ Скопировать</button>
    </div>
    <div style="overflow-x:auto"><table class="table">
      <thead><tr><th>Игрок</th><th style="text-align:center">Входы</th><th style="text-align:right">Внёс</th><th style="text-align:right">Выигрыш</th><th style="text-align:right">Итог</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="text-muted">Нет данных</td></tr>'}</tbody>
    </table></div>

    <h4 style="margin:26px 0 10px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Кто кому платит</h4>
    <div style="display:flex;flex-direction:column;gap:8px;max-width:520px">${txRows}</div>

    <hr class="hr">
    <button class="btn btn-secondary" data-action="closeTourney">← К списку</button>
  </main>`;
}

function clubHtml() {
  // aggregate season stats across the archive, grouped by player name
  const agg = {};
  archive.forEach(t => (t.players || []).forEach(p => {
    const key = (p.name || '').trim().toLowerCase(); if (!key) return;
    const a = agg[key] || (agg[key] = { name: p.name, games: 0, net: 0, wins: 0, itm: 0 });
    a.games++; a.net += (+p.net || 0);
    if (p.place === 1) a.wins++;
    if ((+p.payout || 0) > 0) a.itm++;
  }));
  const season = Object.values(agg).sort((a, b) => b.net - a.net);

  const seasonRows = season.length ? season.map(a => `
    <tr>
      <td>${esc(a.name)}</td>
      <td class="pk-num" style="text-align:right">${a.games}</td>
      <td class="pk-num" style="text-align:right">${a.wins}</td>
      <td class="pk-num" style="text-align:right">${a.games ? Math.round(100 * a.itm / a.games) : 0}%</td>
      <td class="pk-num ${a.net > 0 ? 'pk-net-up' : (a.net < 0 ? 'pk-net-down' : '')}" style="text-align:right">${(a.net > 0 ? '+' : a.net < 0 ? '−' : '') + money(Math.abs(a.net))}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="text-muted" style="font-size:13px">Пока нет сохранённых турниров. Сыграйте и нажмите «Сохранить в архив» на экране расчёта.</td></tr>';

  const dateStr = iso => { try { return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); } catch (e) { return ''; } };

  // ——— archive detail (a single saved tournament) ———
  const openRec = viewTourneyId ? archive.find(t => t.id === viewTourneyId) : null;
  if (openRec) return archiveDetailHtml(openRec, dateStr);

  const archiveRows = archive.map(t => {
    const winner = (t.players || []).find(p => p.place === 1);
    return `
      <button class="pk-arc-row" data-action="openTourney" data-id="${esc(t.id || '')}">
        <div class="pk-num" style="width:64px;color:var(--color-neutral-700)">${dateStr(t.date)}</div>
        <div style="flex:1;min-width:0;text-align:left">
          <div style="font-size:14px">Победитель: <b style="color:var(--color-accent)">${winner ? esc(winner.name) : '—'}</b></div>
          <div class="text-muted pk-num" style="font-size:11px">банк ${money(t.bank)} · входов ${t.entries} · игроков ${(t.players || []).length}</div>
        </div>
        <span style="color:var(--color-neutral-600);font-size:18px">›</span>
      </button>`;
  }).join('');

  return `
  <main class="pk-main" style="max-width:860px">
    <span class="pk-kicker">Клуб</span>
    <h1 class="pk-h1">Сезон и архив</h1>
    <p class="text-muted" style="margin:0 0 20px">Ростер, история турниров и сводная таблица сезона. Хранится локально; при включённой синхронизации — ещё и в облаке, доступно на любом устройстве.</p>

    ${cloudCardHtml()}

    <h4 style="margin:0 0 12px;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Таблица сезона</h4>
    <table class="table" style="margin-bottom:32px">
      <thead><tr><th>Игрок</th><th style="text-align:right">Турниров</th><th style="text-align:right">Побед</th><th style="text-align:right">ITM</th><th style="text-align:right">Итог</th></tr></thead>
      <tbody>${seasonRows}</tbody>
    </table>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <h4 style="margin:0;font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-neutral-700)">Архив турниров (${archive.length})</h4>
      ${(archive.length && !(cloudOn() && !cloud.isOwner)) ? '<button class="btn btn-ghost pk-btn-danger" data-action="clearArchive" style="font-size:12px">Очистить архив</button>' : ''}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">${archiveRows || '<div class="text-muted" style="font-size:13px">Архив пуст.</div>'}</div>

    <hr class="hr">
    <div style="display:flex;justify-content:flex-start">
      <button class="btn btn-secondary" data-action="closeClub">← Назад</button>
    </div>
  </main>`;
}

function modalsHtml(d) {
  const s = d.s;
  let html = '';
  if (s.levelEnd) {
    const nb = d.nxtBlind;
    const wasBreak = d.curIsBreak;
    const nextIsBreak = d.nxt && d.nxt.type === 'break';
    const bodyText = d.lastLevel ? 'Это был последний уровень структуры. Переходите к расчёту призовых.'
      : (nextIsBreak ? 'Дальше — перерыв.' : 'Следующий уровень блайндов:');
    const blindsText = (d.lastLevel || nextIsBreak) ? '' : (nb ? (fmt(nb.sb) + ' / ' + fmt(nb.bb)) : '');
    const title = wasBreak ? 'Перерыв окончен' : ('Уровень ' + d.blindNo + ' окончен');
    const btnText = d.lastLevel ? 'К расчёту призовых' : (nextIsBreak ? '► Начать перерыв' : '► Начать следующий уровень');
    html += `
    <div class="dialog-backdrop">
      <div class="dialog pk-glow" style="text-align:center;align-items:center;border-color:var(--color-accent)">
        <span style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent)">Время вышло</span>
        <div class="dialog-title" style="font-size:30px">${title}</div>
        <p class="dialog-body">${bodyText}</p>
        ${blindsText ? `<div class="pk-num" style="font-family:var(--font-heading);font-size:52px;line-height:1;color:var(--color-accent)">${blindsText}</div>` : ''}
        <p class="text-muted" style="font-size:12px">Таймер на паузе. Сигнал звучит, пока вы не продолжите.</p>
        <button class="btn btn-primary" style="padding:12px 30px;font-size:16px;margin-top:4px" data-action="ackLevelEnd">${btnText}</button>
      </div>
    </div>`;
  }
  if (s.showRebuyModal) {
    html += `
    <div class="dialog-backdrop" data-dismissable="true">
      <div class="dialog" style="text-align:center;align-items:center">
        <span style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--color-accent)">Уровень ${s.currentLevel + 1}</span>
        <div class="dialog-title" style="font-size:30px">Ребай-окно закрыто</div>
        <p class="dialog-body" style="max-width:34ch">Приём ребаев завершён. Оставшиеся игроки продолжают до определения призёров. Банк — ${money(d.bank)}.</p>
        <button class="btn btn-primary" style="padding:10px 28px" data-action="dismissModal">Продолжить</button>
      </div>
    </div>`;
  }
  if (s.confirm) {
    const c = s.confirm;
    html += `
    <div class="dialog-backdrop" data-dismissable="true" data-dismiss-action="confirmNo">
      <div class="dialog" style="align-items:stretch">
        <div class="dialog-title">${esc(c.title)}</div>
        <p class="dialog-body">${esc(c.body)}</p>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:4px">
          <button class="btn btn-secondary" data-action="confirmNo">Отмена</button>
          <button class="btn btn-primary" data-action="confirmYes">${esc(c.label)}</button>
        </div>
      </div>
    </div>`;
  }
  if (showGuide) html += guideHtml();
  return html;
}

// ——— памятка турнира (cheat-sheet) ———
function guideHtml() {
  const cap = t => `<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--color-accent);margin:14px 0 4px">${t}</div>`;
  return `
  <div class="dialog-backdrop" data-dismissable="true" data-dismiss-action="closeGuide">
    <div class="dialog" style="width:min(560px,100%);max-height:86vh;overflow-y:auto;align-items:stretch;text-align:left">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div class="dialog-title">Памятка турнира</div>
        <button class="btn btn-icon" data-action="closeGuide" title="Закрыть" style="color:var(--color-neutral-700)">×</button>
      </div>
      <p class="text-muted" style="font-size:13px;margin:0">Домашний формат: 5–7 игроков · бай-ин 200 ₽ = 2000 фишек · уровни по 12 мин · ~3 часа.</p>

      ${cap('Ребай / аддон')}
      <div style="font-size:13px;line-height:1.5">Ребай 200 ₽ (2000 фишек) — первые <b>5 уровней</b>, только если стек <b>≤ 2000</b>. Аддон выключен.</div>

      ${cap('Анте с 7-го уровня — «BB-анте»')}
      <div style="font-size:13px;line-height:1.5">Платит <b>только игрок на большом блайнде</b>, ровно размер BB. Остальные ничего не кидают — без возни с мелочью. (В приложении в колонке «Анте» стоит то же число, что и BB.)</div>

      ${cap('Замена фишек (color up)')}
      <div style="font-size:13px;line-height:1.5">• После <b>6-го</b> уровня (на перерыве) — убрать со стола все <b>10 и 20</b>.<br>• После <b>8-го</b> — убрать все <b>50</b>. Дальше всё кратно 100.</div>

      ${cap('Раздача фишек')}
      <div style="font-size:13px;line-height:1.5">Номиналы 10/20/50/100/500/1000/5000.<br>
        <b>Старт (2000):</b> 4×10 + 3×20 + 4×50 + 7×100 + 2×500.<br>
        <b>Ребай (2000):</b> 2×50 + 4×100 + 1×500 + 1×1000.</div>

      ${cap('Призовые')}
      <div style="font-size:13px;line-height:1.5">• 5–6 игроков → <b>65 / 35</b> (двое).<br>• 7+ игроков → <b>50 / 30 / 20</b> (трое).<br><span class="text-muted">Меняется в настройке «Призовые, %» на экране «Структура».</span></div>

      <div style="font-size:13px;line-height:1.5;margin-top:12px;color:var(--color-accent-800)">Перерыв 10 мин после 6-го уровня уже стоит в структуре.</div>

      <button class="btn btn-primary btn-block" style="margin-top:16px" data-action="closeGuide">Понятно</button>
    </div>
  </div>`;
}

// ——— settings panel ———
const settingsPanel = document.getElementById('settingsPanel');
const settingsBtn = document.getElementById('settingsBtn');
const themeOptsEl = document.getElementById('themeOpts');
const soundSwitch = document.getElementById('soundSwitch');
const nextSwitch = document.getElementById('nextSwitch');

function renderSettingsPanel() {
  themeOptsEl.innerHTML = THEMES.map(t => `<button type="button" class="pk-theme-opt ${t.key === state.theme ? 'is-active' : ''}" data-theme="${t.key}">${t.label}</button>`).join('');
  soundSwitch.classList.toggle('is-on', state.soundOn);
  nextSwitch.classList.toggle('is-on', state.showNextBlinds);
}

settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); settingsPanel.classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  if (!settingsPanel.classList.contains('hidden') && !settingsPanel.contains(e.target) && e.target !== settingsBtn) {
    settingsPanel.classList.add('hidden');
  }
});
themeOptsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme]');
  if (btn) setState({ theme: btn.dataset.theme });
});
soundSwitch.addEventListener('click', () => setState(s => ({ soundOn: !s.soundOn })));
nextSwitch.addEventListener('click', () => setState(s => ({ showNextBlinds: !s.showNextBlinds })));
const guideBtn = document.getElementById('guideBtn');
if (guideBtn) guideBtn.addEventListener('click', () => { settingsPanel.classList.add('hidden'); openGuide(); });

// ——— event delegation ———
screenEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const fn = actions[btn.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn({ currentTarget: btn, target: e.target, preventDefault() {}, stopPropagation() {} });
});
screenEl.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('[data-field]')) onLevelField(e);
  else if (t.matches('[data-key]')) onCfg(e);
  else if (t.matches('[data-pid]')) onRunPlayerName(e);
  else if (t.matches('main.pk-main.pk-narrow input[data-idx]')) onPlayerName(e);
});
screenEl.addEventListener('change', (e) => {
  if (e.target.matches('select[data-place]')) setPlace(e);
});
modalsEl.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const fn = actions[actionBtn.dataset.action];
    if (fn) fn({ currentTarget: actionBtn, target: e.target, preventDefault() {}, stopPropagation() {} });
    return;
  }
  const back = e.target.classList.contains('dialog-backdrop') ? e.target : null;
  if (back && back.dataset.dismissable === 'true') {
    const da = back.dataset.dismissAction;
    (actions[da] || actions.dismissModal)();
  }
});
// Esc closes dismissable overlays
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.confirm) actions.confirmNo();
  else if (showGuide) actions.closeGuide();
  else if (state.showRebuyModal) actions.dismissModal();
});

// flush + re-sync on visibility/hide
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { saveNow(); }
  else { if (state.timer.running) keepAwake(true); render(); }
});
window.addEventListener('pagehide', saveNow);

// header "Клуб" button
const clubBtn = document.getElementById('clubBtn');
if (clubBtn) clubBtn.addEventListener('click', () => actions.openClub());

// ——— init ———
loadClub();
load();
// reconcile a timer that was running when we left
(function initTimer() {
  const t = state.timer;
  if (t && t.running) {
    const rem = t.endsAt ? (t.endsAt - Date.now()) : t.remainingMs;
    if (rem <= 0) { t.running = false; t.remainingMs = 0; t.endsAt = null; state.levelEnd = true; }
    else { keepAwake(true); }
  }
})();
render();
requestAnimationFrame(clockLoop);
initCloud(); // optional Supabase sync; no-op if config.js is not filled in

// PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
