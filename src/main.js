import './style.css';
import { applyStaticI18n, getLang, setLang, t } from './i18n.js';
import { Player } from './player.js';
import { loadJSON } from './assets.js';

const $ = (s) => document.querySelector(s);
const BASE = './';

const FX_DEFAULTS = { placement: true, reverb: true, humanize: true, wet: 0.45 };

function loadFx() {
  try {
    const v = JSON.parse(localStorage.getItem('cm:v1:fx') || 'null');
    if (!v) return { ...FX_DEFAULTS };
    return {
      placement: v.placement !== false,
      reverb: v.reverb !== false,
      humanize: v.humanize !== false,
      wet: Number.isFinite(v.wet) ? Math.max(0, Math.min(1, v.wet)) : FX_DEFAULTS.wet,
    };
  } catch {
    return { ...FX_DEFAULTS };
  }
}

const state = {
  index: null,
  fx: loadFx(),
  current: null,
  zones: [],
  loopOn: false,
  dragging: false,
};

let player;

/* ------------------------------------------------------------------ utils */

const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function setEngine(stateName, key) {
  state.engineState = stateName;
  state.engineKey = key;
  $('#engine').dataset.state = stateName;
  $('#engineLabel').textContent = key.startsWith('engine.') ? t(key) : key;
}

/* ------------------------------------------------------------------ engine */

async function bootEngine() {
  player = new Player();
  window.__cm = { player, state }; // debugging handle: console access to the engine
  try {
    await player.init(setEngine);
    if (state.current) player.setPiece(state.current);
    player.setEffects(state.fx);
    renderFx();
    updateTransport();
  } catch (e) {
    console.error(e);
    setEngine('error', 'engine.error');
    $('#engine').style.cursor = 'pointer';
    $('#engine').onclick = () => {
      $('#engine').onclick = null;
      $('#engine').style.cursor = '';
      bootEngine();
    };
  }
}

/* ------------------------------------------------------------------ catalog */

function renderCatalog() {
  const byWork = new Map();
  for (const p of state.index.pieces) {
    const key = `${p.composer}|${p.work}|${p.catalog}`;
    if (!byWork.has(key)) byWork.set(key, []);
    byWork.get(key).push(p);
  }
  const nav = $('#catalog');
  nav.textContent = '';
  for (const [, pieces] of byWork) {
    const p0 = pieces[0];
    const group = document.createElement('div');
    group.className = 'work-group';

    const head = document.createElement('div');
    head.className = 'work-head';
    head.innerHTML = `<span class="composer">${p0.composer}</span><span class="title">${p0.work.replace(
      p0.composer,
      ''
    )}</span>`;
    group.appendChild(head);

    for (const p of pieces) {
      const b = document.createElement('button');
      b.className = 'mvt';
      b.dataset.id = p.id;
      b.innerHTML = `${escapeHtml(p.movement)}<span class="badge">${p.totalMeasures}</span>`;
      if (state.current && state.current.id === p.id) b.setAttribute('aria-current', 'true');
      b.onclick = () => selectPiece(p.id);
      group.appendChild(b);
    }
    nav.appendChild(group);
  }
  $('#workCount').textContent = t('count.works', { w: byWork.size, m: state.index.pieces.length });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------------------------------------------------------- persistence */

const storeKey = (id) => `cm:v1:${id}`;

function loadPrefs(id) {
  try {
    return JSON.parse(localStorage.getItem(storeKey(id)) || 'null');
  } catch {
    return null;
  }
}

function savePrefs() {
  if (!state.current) return;
  const payload = {
    zones: state.zones,
    loop: {
      on: state.loopOn,
      a: +$('#loopA').value || 1,
      b: +$('#loopB').value || 1,
    },
  };
  try {
    localStorage.setItem(storeKey(state.current.id), JSON.stringify(payload));
  } catch {}
}

/* --------------------------------------------------------------- piece load */

async function selectPiece(id) {
  document.querySelectorAll('.mvt').forEach((el) => {
    el.setAttribute('aria-current', String(el.dataset.id === id));
  });
  const piece = await loadJSON(id);
  state.current = piece;
  const prefs = loadPrefs(piece.id);
  state.zones =
    prefs && Array.isArray(prefs.zones) && prefs.zones.length
      ? prefs.zones
          .filter((z) => z && Number.isFinite(z.bar) && Number.isFinite(z.bpm))
          .map((z) => ({ bar: z.bar, bpm: z.bpm }))
      : [{ bar: 0, bpm: piece.baseBpm }];
  if (!state.zones.length || state.zones[0].bar !== 0)
    state.zones.unshift({ bar: 0, bpm: piece.baseBpm });
  state.loopOn = !!(prefs && prefs.loop && prefs.loop.on);

  $('#empty').hidden = true;
  $('#piece').hidden = false;

  $('#workTitle').textContent = `${piece.composer} · ${piece.work}`;
  $('#movementTitle').textContent = piece.movement;
  renderMeta();

  if (player?.ready) player.setPiece(piece);
  else if (player) player.piece = piece;
  player?.setEffects(state.fx);

  $('#loopBtn').setAttribute('aria-pressed', String(state.loopOn));
  $('#loopA').value = prefs?.loop?.a ?? 1;
  $('#loopB').value = prefs?.loop?.b ?? Math.min(piece.totalMeasures, 16);
  $('#loopA').max = piece.totalMeasures;
  $('#loopB').max = piece.totalMeasures;
  $('#totalTime').textContent = fmtTime(piece.totalBeats ? 0 : 0);

  state.activity = computeActivity(piece);
  renderZones();
  renderTracks();
  resizeRuler();
  player?.setTempo(state.zones);
  syncLoop();
  updateTransport();
  drawRuler();
  player?.seekBar(1);
}

/* -------------------------------------------------------------------- zones */

function activeZoneIndex(bar) {
  let idx = 0;
  state.zones.forEach((z, i) => {
    if (z.bar <= bar) idx = i;
  });
  return idx;
}

function currentBar() {
  if (!player?.tmap) return 1;
  return player.tmap.barAtBeat(player.currentBeat()) + 1;
}

function renderZones() {
  const piece = state.current;
  const box = $('#zones');
  box.textContent = '';
  state.zones.forEach((z, i) => {
    const next = state.zones[i + 1];
    const from = z.bar + 1;
    const to = next ? next.bar : piece.totalMeasures;
    const row = document.createElement('div');
    row.className = 'zone';
    row.innerHTML = `
      <span class="range">${t('zone.range', { a: from, b: next ? to : t('zone.toEnd') })}</span>
      <span class="dim">♩</span>
      <input type="number" min="20" max="320" step="1" value="${z.bpm}" aria-label="bpm">
      <button class="del" title="${t('zone.delete')}" ${i === 0 ? 'hidden' : ''}>×</button>`;
    const input = row.querySelector('input');
    input.onchange = () => {
      const v = clamp(Math.round(+input.value || z.bpm), 20, 320);
      z.bpm = v;
      input.value = v;
      applyTempo();
    };
    row.querySelector('.del').onclick = () => {
      state.zones.splice(i, 1);
      if (!state.zones.length || state.zones[0].bar !== 0) state.zones.unshift({ bar: 0, bpm: piece.baseBpm });
      renderZones();
      applyTempo();
    };
    box.appendChild(row);
  });
  $('#addZoneBar').textContent = currentBar();
}

function applyTempo() {
  player?.setTempo(state.zones);
  updateTransport();
  savePrefs();
}

$('#addZone').onclick = () => {
  const bar = currentBar();
  const barIdx = bar - 1;
  if (barIdx <= 0) return;
  if (state.zones.some((z) => z.bar === barIdx)) return;
  const prev = state.zones[activeZoneIndex(barIdx)].bpm;
  state.zones.push({ bar: barIdx, bpm: prev });
  state.zones.sort((a, b) => a.bar - b.bar);
  renderZones();
  applyTempo();
};

/* --------------------------------------------------------------------- meta */

function renderMeta() {
  const piece = state.current;
  if (!piece) return;
  const tr = piece.tracks.length;
  const notes = piece.tracks.reduce((s, t) => s + t.noteCount, 0);
  $('#pieceMeta').innerHTML = [
    t('meta.key', { v: piece.key }),
    t('meta.meter', { v: piece.meter }),
    t('meta.bars', { v: piece.totalMeasures }),
    t('meta.parts', { v: tr }),
    t('meta.notes', { v: (notes / 1000).toFixed(1) }),
    t('meta.piano', { v: piece.pianoStaves ?? piece.pianoRemoved.length }),
  ]
    .map((x) => `<span>${escapeHtml(x)}</span>`)
    .join('');
  if (piece.totalBeats / piece.baseBpm > 35) {
    const warn = document.createElement('div');
    warn.className = 'meta-warn';
    warn.textContent = t('meta.warn');
    $('#pieceMeta').appendChild(warn);
  }
}

/* ------------------------------------------------------------------ effects */

const FX_BUTTONS = [
  ['placement', '#fxPlacement'],
  ['reverb', '#fxReverb'],
  ['humanize', '#fxHumanize'],
];

function renderFx() {
  for (const [key, sel] of FX_BUTTONS) {
    $(sel).setAttribute('aria-pressed', String(!!state.fx[key]));
  }
  const pct = Math.round(state.fx.wet * 100);
  $('#fxWet').value = pct;
  $('#fxWetVal').textContent = `${pct}%`;
  $('#fxWet').style.setProperty('--pct', `${pct}%`);
  $('#fxWet').disabled = !state.fx.reverb;
  const allOn = state.fx.placement && state.fx.reverb && state.fx.humanize;
  $('#fxAB').textContent = allOn ? t('fx.ab.off') : t('fx.ab.on');
}

function applyFx() {
  player?.setEffects(state.fx);
  renderFx();
  try {
    localStorage.setItem('cm:v1:fx', JSON.stringify(state.fx));
  } catch {}
}

for (const [key, sel] of FX_BUTTONS) {
  $(sel).onclick = () => {
    state.fx[key] = !state.fx[key];
    applyFx();
  };
}

$('#fxWet').oninput = (e) => {
  state.fx.wet = clamp(+e.target.value / 100, 0, 1);
  applyFx();
};

$('#fxAB').onclick = () => {
  const allOn = state.fx.placement && state.fx.reverb && state.fx.humanize;
  state.fx.placement = state.fx.reverb = state.fx.humanize = !allOn;
  applyFx();
};

/* ------------------------------------------------------------------- tracks */

function renderTracks() {
  const box = $('#tracks');
  box.textContent = '';
  for (const tr of state.current.tracks) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.setAttribute('aria-pressed', 'true');
    b.innerHTML = `${escapeHtml(tr.label)}<span class="n">${tr.voices.length}</span>`;
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      player?.setMuted(tr.group, on);
    };
    box.appendChild(b);
  }
  $('#trackCount').textContent = t('count.parts', { n: state.current.tracks.length });
}

/* -------------------------------------------------------------------- ruler */

/** notes-starting-per-bar, used to draw the density strip under the ruler */
function computeActivity(piece) {
  const arr = new Float32Array(piece.totalMeasures);
  const starts = piece.measureStarts;
  const barAt = (beat) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= beat) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const tr of piece.tracks) {
    for (const n of tr.notes) arr[barAt(n[0])]++;
  }
  return arr;
}

const cv = $('#ruler');
let dpr = 1;
let rulerW = 0;
const RULER_H = 88;

function resizeRuler() {
  const wrap = cv.parentElement;
  rulerW = wrap.clientWidth;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(rulerW * dpr);
  cv.height = Math.round(RULER_H * dpr);
  cv.style.height = `${RULER_H}px`;
  drawRuler();
}

function barToX(bar) {
  const n = state.current.totalMeasures;
  return ((bar - 1) / n) * rulerW;
}

function xToBar(x) {
  const n = state.current.totalMeasures;
  return clamp(Math.floor((x / rulerW) * n) + 1, 1, n);
}

const TICK_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];

function drawRuler() {
  if (!state.current || !rulerW) return;
  const ctx = cv.getContext('2d');
  const W = rulerW;
  const H = RULER_H;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const total = state.current.totalMeasures;
  const pxPerBar = W / total;

  const numBase = 13;
  const tickTop = 19;
  const tickBot = 29;
  const laneTop = 31;
  const laneH = 28;
  const laneBot = laneTop + laneH;
  const actTop = 64;
  const actH = 20;

  // ---- tempo zones
  state.zones.forEach((z, i) => {
    const next = state.zones[i + 1];
    const x0 = barToX(z.bar + 1);
    const x1 = next ? barToX(next.bar + 1) : W;
    const warm = i % 2 === 0;
    ctx.fillStyle = warm ? 'rgba(224,164,88,.085)' : 'rgba(127,179,196,.085)';
    ctx.fillRect(x0, laneTop, Math.max(1, x1 - x0), laneH);
    ctx.strokeStyle = warm ? 'rgba(224,164,88,.45)' : 'rgba(127,179,196,.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, laneTop);
    ctx.lineTo(Math.round(x0) + 0.5, laneBot);
    ctx.stroke();
    if (x1 - x0 > 52) {
      ctx.fillStyle = 'rgba(233,230,223,.55)';
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(`♩${z.bpm}`, x0 + 7, laneTop + laneH / 2 + 1);
    }
  });
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.strokeRect(0.5, laneTop + 0.5, W - 1, laneH - 1);

  // ---- loop region
  if (state.loopOn) {
    const a = Math.min(+$('#loopA').value || 1, +$('#loopB').value || total);
    const b = Math.max(+$('#loopA').value || 1, +$('#loopB').value || total);
    const x0 = barToX(a);
    const x1 = barToX(b + 1);
    ctx.fillStyle = 'rgba(127,179,196,.10)';
    ctx.fillRect(x0, 0, x1 - x0, laneBot);
    ctx.fillStyle = 'rgba(127,179,196,.75)';
    ctx.fillRect(x0, 0, x1 - x0, 2);
    ctx.strokeStyle = 'rgba(127,179,196,.5)';
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, laneBot);
      ctx.stroke();
    }
  }

  // ---- density strip: where the orchestra is busy
  const act = state.activity;
  if (act && act.length) {
    let peak = 1;
    for (let i = 0; i < act.length; i++) if (act[i] > peak) peak = act[i];
    const w = Math.max(1, W / act.length - 0.25);
    for (let i = 0; i < act.length; i++) {
      if (!act[i]) continue;
      const h = Math.max(1.5, Math.sqrt(act[i] / peak) * actH);
      ctx.fillStyle = 'rgba(255,255,255,.13)';
      ctx.fillRect((i / act.length) * W, actTop + actH - h, w, h);
    }
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(0, actTop + actH, W, 1);
  }

  // ---- bar numbers + ticks
  let labelStep = TICK_STEPS[TICK_STEPS.length - 1];
  for (const s of TICK_STEPS) {
    if (s * pxPerBar >= 46) {
      labelStep = s;
      break;
    }
  }
  const minorStep = labelStep <= 5 ? 1 : labelStep / 5 >= 1 ? labelStep / 5 : 1;

  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'alphabetic';
  for (let bar = 1; bar <= total; bar++) {
    const x = Math.round(barToX(bar)) + 0.5;
    const isMajor = (bar - 1) % labelStep === 0;
    const isMinor = (bar - 1) % Math.round(minorStep) === 0;
    if (!isMinor && !isMajor) continue;
    ctx.strokeStyle = isMajor ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)';
    ctx.beginPath();
    ctx.moveTo(x, isMajor ? tickTop : tickTop + 4);
    ctx.lineTo(x, tickBot);
    ctx.stroke();
    if (isMajor) {
      const label = String(bar);
      const w = ctx.measureText(label).width;
      if (x + w + 3 < W) {
        ctx.fillStyle = 'rgba(154,160,170,.62)';
        ctx.fillText(label, x + 3, numBase);
      }
    }
  }

  // ---- playhead
  const bar = currentBar();
  const tmap = player?.tmap;
  const b = player?.currentBeat?.() ?? 0;
  let frac = 0;
  if (tmap) {
    const i = bar - 1;
    const barStart = tmap.starts[i] ?? 0;
    const barEnd = i + 1 < tmap.starts.length ? tmap.starts[i + 1] : state.current.totalBeats;
    frac = clamp((b - barStart) / Math.max(1e-9, barEnd - barStart), 0, 1);
  }
  const x = barToX(bar) + frac * pxPerBar;
  ctx.fillStyle = '#e0a458';
  ctx.fillRect(Math.round(x) - 0.5, 6, 1.5, actTop + actH - 6);
  ctx.beginPath();
  ctx.moveTo(x - 4.5, 0);
  ctx.lineTo(x + 4.5, 0);
  ctx.lineTo(x, 6);
  ctx.closePath();
  ctx.fill();
}

/* --------------------------------------------------------------- transport */

function updateTransport() {
  const piece = state.current;
  if (!piece) return;
  const tmap = player?.tmap;
  const bar = currentBar();
  $('#posBar').textContent = bar;
  $('#posOf').textContent = `/ ${piece.totalMeasures}`;
  $('#posTime').textContent = fmtTime(player?.currentSec?.() ?? 0);
  $('#totalTime').textContent = fmtTime(tmap?.totalSec ?? 0);

  const zi = activeZoneIndex(bar - 1);
  const bpm = state.zones[zi]?.bpm ?? piece.baseBpm;
  const num = $('#tempoNum');
  if (document.activeElement !== num) num.value = bpm;
  const range = $('#tempoRange');
  range.value = bpm;
  range.style.setProperty('--pct', `${((bpm - 30) / 210) * 100}%`);
  $('#addZoneBar').textContent = bar;
  const playBtn = $('#playBtn');
  playBtn.dataset.playing = String(!!player?.playing);
}

$('#playBtn').onclick = async () => {
  if (!player?.ready) return;
  await player.resume();
  if (player.ctx && player.ctx.state !== 'running') {
    setEngine('error', 'engine.blocked');
    return;
  }
  if (player.playing) {
    player.pause();
  } else {
    if (player.currentBeat() >= state.current.totalBeats - 0.05) player.seekBar(1);
    player.play();
  }
  updateTransport();
};

function setTempoValue(v) {
  const bar = currentBar() - 1;
  const zi = activeZoneIndex(bar);
  const val = clamp(Math.round(v), 20, 320);
  state.zones[zi].bpm = val;
  renderZones();
  applyTempo();
}

$('#tempoNum').onchange = (e) => setTempoValue(+e.target.value);
$('#tempoRange').oninput = (e) => setTempoValue(+e.target.value);
const jumpTo = () => {
  const v = clamp(Math.round(+$('#jumpBar').value || 1), 1, state.current.totalMeasures);
  player?.seekBar(v);
  $('#jumpBar').value = '';
  updateTransport();
  drawRuler();
};
$('#jumpGo').onclick = jumpTo;
$('#jumpBar').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    jumpTo();
  }
};

$('#tempoReset').onclick = () => {
  state.zones = [{ bar: 0, bpm: state.current.baseBpm }];
  renderZones();
  applyTempo();
};

$('#loopBtn').onclick = () => {
  state.loopOn = !state.loopOn;
  $('#loopBtn').setAttribute('aria-pressed', String(state.loopOn));
  syncLoop();
  drawRuler();
};

function syncLoop() {
  if (!state.current) return;
  if (!state.loopOn) {
    player?.setLoop(null);
    return;
  }
  let a = clamp(+$('#loopA').value || 1, 1, state.current.totalMeasures);
  let b = clamp(+$('#loopB').value || 1, 1, state.current.totalMeasures);
  if (b <= a) b = Math.min(state.current.totalMeasures, a + 1);
  $('#loopA').value = a;
  $('#loopB').value = b;
  player?.setLoop({ aBar: a, bBar: b });
  drawRuler();
  savePrefs();
}
$('#loopA').onchange = syncLoop;
$('#loopB').onchange = syncLoop;

/* ------------------------------------------------------------------- ruler IO */

function seekFromEvent(e) {
  const rect = cv.getBoundingClientRect();
  const bar = xToBar(e.clientX - rect.left);
  player?.seekBar(bar);
  updateTransport();
  drawRuler();
}

cv.addEventListener('pointerdown', (e) => {
  state.dragging = true;
  cv.setPointerCapture(e.pointerId);
  seekFromEvent(e);
});
cv.addEventListener('pointermove', (e) => {
  if (state.dragging) seekFromEvent(e);
});
cv.addEventListener('pointerup', (e) => {
  state.dragging = false;
  cv.releasePointerCapture(e.pointerId);
});

/* ---------------------------------------------------------------- language */

const LANG_KEY = 'cm:v1:lang';

function renderLang() {
  const cur = getLang();
  for (const b of document.querySelectorAll('#lang button')) {
    b.setAttribute('aria-pressed', String(b.dataset.lang === cur));
  }
}

function switchLang(l) {
  setLang(l);
  try {
    localStorage.setItem(LANG_KEY, getLang());
  } catch {}
  applyStaticI18n();
  renderLang();
  // static pass resets a few dynamic spots; put them back
  if (state.engineKey) setEngine(state.engineState, state.engineKey);
  if (state.index) renderCatalog();
  if (state.current) {
    $('#workCount').textContent = t('count.works', {
      w: new Set(state.index.pieces.map((p) => p.composer + p.work)).size,
      m: state.index.pieces.length,
    });
    renderMeta();
    renderZones();
    renderTracks();
    renderFx();
  }
}

for (const b of document.querySelectorAll('#lang button')) {
  b.onclick = () => switchLang(b.dataset.lang);
}

/* ------------------------------------------------------- autoplay unlock */

let unlocked = false;
const unlock = () => {
  if (unlocked) return;
  unlocked = true;
  player?.resume();
};
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  document.addEventListener(ev, unlock, { capture: true, passive: true });
}

/* --------------------------------------------------------------- keyboard */

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('#playBtn').click();
    return;
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const bar = clamp(currentBar() + (e.code === 'ArrowRight' ? step : -step), 1, state.current.totalMeasures);
    player?.seekBar(bar);
    updateTransport();
    drawRuler();
    return;
  }
  if (e.key === 'l' || e.key === 'L') $('#loopBtn').click();
});

/* ------------------------------------------------------------------- meter */

const meterBars = [...document.querySelectorAll('#meter i')];

function updateMeter() {
  if (!meterBars.length) return;
  const rms = player?.getLevel?.() ?? 0;
  const db = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
  const level = clamp((db + 54) / 54, 0, 1); // -54 dB .. 0 dB
  const lit = Math.round(level * meterBars.length);
  meterBars.forEach((bar, i) => {
    bar.classList.toggle('on', i < lit);
    bar.classList.toggle('hot', i < lit && i >= meterBars.length - 2);
  });
}

/* ------------------------------------------------------------------- raf */

let lastDraw = 0;
function frame(t) {
  if (state.current && player) {
    updateTransport();
    if (t - lastDraw > 60) {
      drawRuler();
      lastDraw = t;
    }
    updateMeter();
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  if (state.current) resizeRuler();
});

/* -------------------------------------------------------------------- init */

(async function main() {
  requestAnimationFrame(frame);
  // first visit: follow the browser, then remember the choice
  const browserLang = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  let saved = browserLang;
  try {
    saved = localStorage.getItem(LANG_KEY) || browserLang;
  } catch {}
  setLang(saved);
  applyStaticI18n();
  renderLang();
  renderFx();
  bootEngine();
  try {
    state.index = await loadJSON('index');
    renderCatalog();
  } catch (e) {
    console.error(e);
    $('#empty').innerHTML = `<div class="empty-inner"><h1>${t('empty.notFound')}</h1>
      <p>${t('empty.buildHint')} <code>pnpm run build:pieces</code></p></div>`;
  }
})();
