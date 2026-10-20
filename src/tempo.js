/**
 * Tempo map: turns "bar / beat" into seconds.
 *
 * The whole point of the app is that tempo is data, not a rendered audio
 * property. A zone says "from this bar onward, play at N bpm". Everything else
 * (seeking, looping, the playhead) is derived from these few numbers, so a
 * tempo change costs nothing and never bends pitch.
 */
export class TempoMap {
  constructor(piece) {
    this.piece = piece;
    this.bars = piece.measureBeats;
    this.starts = piece.measureStarts;
    this.zones = [{ bar: 0, bpm: piece.baseBpm }];
    this.rebuild();
  }

  setZones(zones) {
    this.zones = zones.slice().sort((a, b) => a.bar - b.bar);
    this.rebuild();
  }

  bpmAtBar(bar) {
    let bpm = this.zones[0]?.bpm ?? this.piece.baseBpm;
    for (const z of this.zones) {
      if (z.bar <= bar) bpm = z.bpm;
      else break;
    }
    return bpm;
  }

  rebuild() {
    const n = this.bars.length;
    this.barSec = new Float64Array(n + 1);
    let t = 0;
    for (let i = 0; i < n; i++) {
      this.barSec[i] = t;
      t += (this.bars[i] * 60) / this.bpmAtBar(i);
    }
    this.barSec[n] = t;
    this.totalSec = t;
    this._zoneIdx = null;
  }

  barAtBeat(beat) {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    if (beat <= s[0]) return 0;
    if (beat >= s[hi]) return hi;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= beat) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  beatToSec(beat) {
    const bar = this.barAtBeat(beat);
    const within = beat - this.starts[bar];
    return this.barSec[bar] + (within * 60) / this.bpmAtBar(bar);
  }

  secToBeat(sec) {
    if (sec <= 0) return 0;
    if (sec >= this.totalSec) return this.piece.totalBeats;
    const b = this.barSec;
    let lo = 0;
    let hi = b.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid] <= sec) lo = mid;
      else hi = mid;
    }
    const frac = (sec - b[lo]) / Math.max(1e-9, b[lo + 1] - b[lo]);
    const startBeat = this.starts[lo];
    const endBeat = lo + 1 < this.starts.length ? this.starts[lo + 1] : this.piece.totalBeats;
    return startBeat + frac * (endBeat - startBeat);
  }

  /** seconds at the start of a 1-based bar number */
  secAtBar(bar1) {
    const i = Math.max(0, Math.min(this.bars.length, bar1 - 1));
    return this.barSec[i];
  }
}
