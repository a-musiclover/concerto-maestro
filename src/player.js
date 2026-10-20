import { WorkletSynthesizer } from 'spessasynth_lib';
import { TempoMap } from './tempo.js';
import { loadSoundFont, loadWorklet } from './assets.js';

/**
 * Orchestral seating, audience perspective. pan is a CC10 value (0 = hard left,
 * 64 = centre); gain doubles as a depth cue — the brass sits behind the strings
 * and is quieter at the same dynamic.
 */
const SEATING = {
  violin1: { pan: 40, gain: 0.95 },
  violin2: { pan: 55, gain: 0.9 },
  viola: { pan: 68, gain: 0.88 },
  cello: { pan: 83, gain: 0.9 },
  bass: { pan: 95, gain: 0.86 },
  flute: { pan: 52, gain: 0.8 },
  oboe: { pan: 61, gain: 0.8 },
  clarinet: { pan: 72, gain: 0.8 },
  bassoon: { pan: 84, gain: 0.78 },
  horn: { pan: 50, gain: 0.76 },
  trumpet: { pan: 71, gain: 0.72 },
  trombone: { pan: 85, gain: 0.7 },
  timpani: { pan: 88, gain: 0.72 },
  other: { pan: 44, gain: 0.75 },
  perc: { pan: 82, gain: 0.7 },
};
const CENTRE = { pan: 64, gain: 1 };

/**
 * MuseScore's bank keeps its velocity-layered string sections at alternate
 * banks of program 48 (20/25/30) rather than at the GM violin programs, so the
 * plain GM mapping would silently use the worst presets in the file. Applied
 * only when the loaded bank actually carries them, so a plain GM bank still
 * works via the program baked into the track.
 */
const ORCH_PRESET = {
  violin1: [20, 48],
  violin2: [25, 48],
  viola: [30, 48],
  cello: [0, 42],
  bass: [0, 43],
  flute: [0, 73],
  oboe: [0, 68],
  clarinet: [0, 71],
  bassoon: [0, 70],
  horn: [0, 60],
  trumpet: [0, 56],
  trombone: [0, 57],
  timpani: [0, 47],
};

/** pruned MS Basic is ~5.5 dB quieter than a plain GM bank at the same CC7 */
const BANK_TRIM = { 'soundfont.sf3': 1.54 };

/** synthetic hall: decorrelated noise tail + a few early reflections */
function makeHallIR(ctx, seconds = 2.6, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * 0.014);
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      d[i] = rnd() * Math.pow(1 - t, decay) * 0.5;
    }
    // soft early reflections, spread differently per channel for width
    for (const [ms, g] of [[13 + ch * 3, 0.45], [23 + ch * 5, 0.3], [37 + ch * 7, 0.22], [53 + ch * 9, 0.15]]) {
      const idx = Math.floor((rate * ms) / 1000) + pre;
      for (let k = 0; k < 96 && idx + k < len; k++) {
        d[idx + k] += g * (1 - k / 96) * 0.6;
      }
    }
  }
  return buf;
}

const LOOKAHEAD = 0.28; // seconds of music scheduled ahead of the audio clock
const TICK_MS = 20;
/**
 * Playback engine.
 *
 * Deliberately dumb about music: it holds a flat list of note events in *beats*
 * and hands them to the synthesiser with an explicit AudioContext timestamp.
 * Everything tempo-related stays in the TempoMap, so dragging a tempo slider
 * never touches the audio, never re-renders, never bends a pitch.
 */
export class Player {
  constructor() {
    this.ctx = null;
    this.synth = null;
    this.ready = false;
    this.piece = null;
    this.tmap = null;
    this.events = [];
    this.cursor = 0;
    this.playing = false;
    this.loop = null; // { aBar, bBar }
    this.muted = new Set();
    this.effects = { placement: true, reverb: true, humanize: true, wet: 0.45 };
    this._anchorCtx = 0;
    this._anchorBeat = 0;
    this._timer = null;
    this._onTick = null;
  }

  async init(onStatus) {
    onStatus?.('loading', 'engine.loading');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    await loadWorklet(ctx);
    const synth = new WorkletSynthesizer(ctx);
    // The synthesizer builds a 17-output worklet node and never wires it up
    // itself: without this the clock runs and voices are allocated, but nothing
    // reaches the speakers. Route it through an analyser so the UI can show
    // whether audio is actually flowing.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    // dry + synthetic-hall bus
    const master = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const convolver = ctx.createConvolver();
    convolver.buffer = makeHallIR(ctx);
    dry.gain.value = 0.82;
    wet.gain.value = 0;
    synth.connect(dry);
    synth.connect(convolver);
    dry.connect(master);
    convolver.connect(wet);
    wet.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);
    const { buffer: buf, name: bankName } = await loadSoundFont();
    this.bankName = bankName;
    this.bankTrim = BANK_TRIM[bankName] ?? 1;
    onStatus?.('loading', 'engine.soundbank');
    await synth.soundBankManager.addSoundBank(buf, 'main');
    this.ctx = ctx;
    this.synth = synth;
    this.analyser = analyser;
    this.master = master;
    master.gain.value = this.bankTrim || 1;
    this.dryBus = dry;
    this.wetBus = wet;
    this.ready = true;
    onStatus?.('ready', 'engine.ready');
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Build the flat event list + program the channels for a new piece. */
  setPiece(piece) {
    this.stop();
    this.piece = piece;
    this.tmap = new TempoMap(piece);
    const events = [];
    piece.tracks.forEach((tr, ti) => {
      for (const [b, d, midi, vel] of tr.notes) {
        events.push({ b, d, midi, vel, ch: tr.channel, ti, idx: events.length });
      }
    });
    events.sort((a, b) => a.b - b.b || a.midi - b.midi);
    this.events = events;
    this.cursor = 0;
    this.muted.clear();
    this.loop = null;
    this._program();
  }

  _hasPreset(bank, program) {
    const list = this.synth?.presetList || [];
    return list.some((x) => {
      const b = x.bankMSB ?? x.bank ?? x.bankNumber ?? 0;
      const pr = x.program ?? x.programNumber;
      return b === bank && pr === program;
    });
  }

  _program() {
    if (!this.synth || !this.piece) return;
    for (const tr of this.piece.tracks) {
      const want = ORCH_PRESET[tr.group];
      if (tr.channel === 9) continue;
      if (want && this._hasPreset(want[0], want[1])) {
        this.synth.controllerChange(tr.channel, 0, want[0]); // bank select MSB
        this.synth.programChange(tr.channel, want[1]);
      } else {
        this.synth.controllerChange(tr.channel, 0, 0);
        this.synth.programChange(tr.channel, tr.program);
      }
    }
    this.applyMix();
  }

  /** push seating (pan + depth) and mute state into the synth */
  applyMix() {
    if (!this.synth || !this.piece) return;
    const on = this.effects.placement;
    for (const tr of this.piece.tracks) {
      const seat = on ? SEATING[tr.group] || CENTRE : CENTRE;
      this.synth.controllerChange(tr.channel, 10, seat.pan);
      const base = 104 * seat.gain;
      this.synth.controllerChange(tr.channel, 7, this.muted.has(tr.group) ? 0 : Math.round(base));
    }
  }

  setEffects(next) {
    this.effects = { ...this.effects, ...next };
    if (this.wetBus) {
      const target = this.effects.reverb ? this.effects.wet : 0;
      this.wetBus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
    }
    this.applyMix();
  }

  /**
   * Micro-timing, deterministic: a fixed offset per section plus a small
   * per-note offset derived from the note index. Stable across loops on
   * purpose — a passage that shifts under you every repeat is unusable.
   */
  _offsetFor(e) {
    if (e._h !== undefined) return e._h;
    const group = this.piece.tracks[e.ti].group;
    let h = 2166136261;
    for (let i = 0; i < group.length; i++) {
      h ^= group.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const section = ((h >>> 0) % 15) - 7; // ±7ms, fixed per section
    const note = ((Math.imul(e.idx + 1, 2654435761) >>> 0) % 9) - 4; // ±4ms
    e._h = (section + note) / 1000;
    return e._h;
  }

  setTempo(zones) {
    if (!this.tmap) return;
    const posBeat = this.currentBeat();
    this.tmap.setZones(zones);
    if (this.playing) {
      // re-anchor so already-scheduled notes are not double-fired
      this._anchorBeat = posBeat;
      this._anchorCtx = this.ctx.currentTime + 0.02;
      this.cursor = this._indexAtBeat(posBeat);
    } else {
      this._anchorBeat = posBeat;
      this.cursor = this._indexAtBeat(posBeat);
    }
  }

  setMuted(group, muted) {
    if (muted) this.muted.add(group);
    else this.muted.delete(group);
    if (this.synth) this.applyMix();
  }

  setLoop(loop) {
    this.loop = loop;
  }

  /** output RMS, for the level meter */
  getLevel() {
    if (!this.analyser) return 0;
    if (!this._levelBuf) this._levelBuf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this._levelBuf);
    let s = 0;
    for (const v of this._levelBuf) s += v * v;
    return Math.sqrt(s / this._levelBuf.length);
  }

  _indexAtBeat(beat) {
    const ev = this.events;
    let lo = 0;
    let hi = ev.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].b < beat) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  currentBeat() {
    if (!this.tmap) return 0;
    if (!this.playing) return this._anchorBeat;
    const sec = this.tmap.beatToSec(this._anchorBeat) + (this.ctx.currentTime - this._anchorCtx);
    return Math.max(this._anchorBeat, this.tmap.secToBeat(sec));
  }

  currentSec() {
    return this.tmap ? this.tmap.beatToSec(this.currentBeat()) : 0;
  }

  play() {
    if (!this.ready || !this.events.length) return;
    this.resume();
    const beat = this._anchorBeat;
    this._anchorCtx = this.ctx.currentTime + 0.06;
    this.cursor = this._indexAtBeat(beat);
    this.playing = true;
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._tick();
  }

  pause() {
    const beat = this.currentBeat(); // must read while still "playing"
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._anchorBeat = beat;
    if (this.synth) this.synth.stopAll(true);
  }

  stop() {
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._anchorBeat = 0;
    if (this.synth) this.synth.stopAll(true);
  }

  seekBar(bar1) {
    this.seekBeat(this.tmap.starts[Math.max(0, Math.min(this.tmap.bars.length - 1, bar1 - 1))] ?? 0);
  }

  seekBeat(beat) {
    const wasPlaying = this.playing;
    if (this.synth) this.synth.stopAll(true);
    this._anchorBeat = Math.max(0, Math.min(this.piece.totalBeats - 0.01, beat));
    this.cursor = this._indexAtBeat(this._anchorBeat);
    if (wasPlaying) {
      const t = this.piece && this._timer;
      this.playing = false;
      if (t) clearInterval(t);
      this.play();
    }
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const secOfAnchor = this.tmap.beatToSec(this._anchorBeat);
    let musicSec = secOfAnchor + (now - this._anchorCtx);

    // loop wrap
    if (this.loop) {
      const aBeat = this.tmap.starts[this.loop.aBar - 1] ?? 0;
      const bBeat = this.tmap.starts[this.loop.bBar] ?? this.piece.totalBeats;
      const bSec = this.tmap.beatToSec(bBeat);
      if (musicSec >= bSec) {
        const aSec = this.tmap.beatToSec(aBeat);
        this.synth?.stopAll(true);
        this._anchorBeat = aBeat;
        this._anchorCtx = now + 0.03;
        this.cursor = this._indexAtBeat(aBeat);
        musicSec = aSec;
      }
    }

    const horizon = this.tmap.secToBeat(musicSec + LOOKAHEAD);
    const ev = this.events;
    while (this.cursor < ev.length && ev[this.cursor].b < horizon) {
      const e = ev[this.cursor++];
      const sec = this.tmap.beatToSec(e.b);
      const at = this._anchorCtx + (sec - secOfAnchor);
      if (at < now - 0.05) continue; // missed while catching up
      const endSec = this.tmap.beatToSec(e.b + e.d);
      const off = this._anchorCtx + (endSec - secOfAnchor);
      if (this.muted.has(this.piece.tracks[e.ti].group)) continue;
      const h = this.effects.humanize ? this._offsetFor(e) : 0;
      this.synth.noteOn(e.ch, e.midi, e.vel, { time: at + h });
      this.synth.noteOff(e.ch, e.midi, { time: Math.max(off + h, at + h + 0.03) });
    }
  }
}
