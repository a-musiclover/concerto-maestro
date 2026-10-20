#!/usr/bin/env node
/**
 * ConcertoMaestro build pipeline.
 *
 *   IMSLP ABC (xml2abc output)  ->  baked JSON (orchestra-only events)
 *
 * Why bake: the browser should only have to play. Every nasty thing about this
 * corpus (28-voice full scores, clef changes written as [K:treble], tuplets that
 * abcjs reports unscaled, horn transposition) gets resolved here, once, where we
 * can inspect the numbers.
 *
 * Key trick: each voice is split out of the full score and parsed on its own.
 * abcjs' own score layout groups staves in ways that are hard to map back to
 * V: numbers; parsing one voice at a time makes the mapping trivial.
 */
import fs from 'node:fs';
import path from 'node:path';
import ABCJS from 'abcjs';

/**
 * Where the source ABC transcriptions live. Point CM_CORPUS at a directory of
 * IMSLP-derived ABC files; each entry in catalog.json names a filename prefix
 * (e.g. FC_11 for Chopin's Op.11) and the builder picks the richest file for
 * each movement.
 */
const CORPUS = process.env.CM_CORPUS || '';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUT_PIECES = path.join(ROOT, 'public/pieces');
const OUT_ABC = path.join(ROOT, 'public/abc');

const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

const CLEF_WORDS =
  /^(treble|bass|alto|tenor|none|perc|percussion|baritone|soprano|mezzo|treble\+8|treble-8|bass\+8|bass-8)$/i;

// ---------------------------------------------------------------- key handling

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseTonic(s) {
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(s.trim());
  if (!m) return null;
  const pc =
    (LETTER_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const rest = (m[3] || '').trim();
  const minor = /^(m|min|minor)$/i.test(rest) || /^m(in(or)?)?\b/.test(rest);
  return { pc, minor };
}

/** number of sharps (+) or flats (-) implied by a K: field; null => clef only */
function keyAccidentals(keyField) {
  const tok = (keyField || 'C').trim().split(/\s+/)[0];
  if (!tok || CLEF_WORDS.test(tok)) return null;
  const t = parseTonic(tok);
  if (!t) return 0;
  const pc = t.minor ? (t.pc + 3) % 12 : t.pc;
  let n = (pc * 7) % 12;
  if (n > 6) n -= 12;
  return n;
}

function keyMap(n) {
  const map = new Map();
  if (n > 0) for (let i = 0; i < Math.min(n, 7); i++) map.set(SHARP_ORDER[i], 1);
  if (n < 0) for (let i = 0; i < Math.min(-n, 7); i++) map.set(FLAT_ORDER[i], -1);
  return map;
}

const ACC_NAME = { sharp: 1, natural: 0, flat: -1, doublesharp: 2, doubleflat: -2 };

const DYN = {
  ppp: 22, pp: 34, p: 50, mp: 64, mf: 80, f: 98, ff: 112, fff: 122, sfz: 110, fp: 90,
};

// ------------------------------------------------------------------ instrument

/**
 * name -> {group, program, perc?, piano?}
 * `violin?` is resolved later: the first unqualified violin voice becomes I.
 */
function classify(name) {
  // Normalise: dots/hyphens/slashes become spaces, then match on *tokens*.
  // OMR'd scores abbreviate wildly ("V-ni I", "V-le", "C-b.", "2 Tenorposaunen",
  // "T-rino"), so enumerating regexes never converges. Tokens do.
  const norm = (name || '')
    .replace(/\\n/g, ' ')
    .replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/[.,;:()\/\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // unnamed voices inherit the previous named voice upstream; if one still gets
  // here, keep it audible rather than silently dropping it as "piano"
  if (!norm) return { group: 'other', program: 48 };

  const toks = new Set(norm.split(' ').filter(Boolean));
  const hasTok = (...xs) => xs.some((x) => toks.has(x));
  const hasSub = (re) => re.test(norm);

  // ---- keyboard: removed from playback
  if (
    hasTok('piano', 'pianoforte', 'pno', 'pf', 'klavier', 'fortepiano', 'roial', 'cembalo', 'harpsichord', 'orgel', 'organ') ||
    hasSub(/pianoforte|klavier|roial/)
  )
    return { group: 'piano', program: 0, piano: true };

  // ---- woodwinds
  if (hasTok('picc', 'piccolo', 'ottavino') || hasSub(/kleine fl/))
    return { group: 'flute', program: 72 };
  if (hasTok('fl', 'fls', 'flauto', 'flauti', 'flute', 'flutes', 'floete', 'flote', 'floten', 'fleita') || hasSub(/flau/))
    return { group: 'flute', program: 73 };
  if (hasSub(/english horn|cor anglais|eng hn|englischhorn/))
    return { group: 'oboe', program: 69 };
  if (hasTok('ob', 'obs', 'oboe', 'oboes', 'oboi', 'hoboe', 'hoboen', 'goboi'))
    return { group: 'oboe', program: 68 };
  if (hasSub(/bass.?clar/)) return { group: 'clarinet', program: 71 };
  if (hasTok('cl', 'cls', 'clarinet', 'clarinets', 'clarinetti', 'clarinetto', 'klarinette', 'klarinette', 'klarnet', 'klar'))
    return { group: 'clarinet', program: 71 };
  if (hasSub(/contra.?fag|contrabassoon/)) return { group: 'bassoon', program: 70 };
  if (hasTok('fg', 'fag', 'fagott', 'fagotte', 'fagotti', 'fagot', 'bassoon', 'bassoons', 'bsn', 'bsns'))
    return { group: 'bassoon', program: 70 };

  // ---- brass
  if (hasTok('hn', 'hns', 'horn', 'horns', 'corni', 'corno', 'cor', 'cr', 'horner', 'horner', 'valtorna', 'trompa', 'trompas', 'cor', 'cors'))
    return { group: 'horn', program: 60 };
  if (hasTok('tpt', 'tpts', 'tr', 'trumpet', 'trumpets', 'trombe', 'tromba', 'trompet', 'trompeten', 'trompeta', 'trompetas', 'trompettes', 'truba'))
    return { group: 'trumpet', program: 56 };
  if (hasSub(/posaun|trombon|trombone|tromboni|tbn|tbns|trb/))
    return { group: 'trombone', program: 57 };
  if (hasSub(/tuba/)) return { group: 'trombone', program: 58 };

  // ---- percussion
  if (hasTok('timp', 'timpani', 'timp', 'pauken', 'litavry') || hasSub(/timpani|kettledrum/))
    return { group: 'timpani', program: 47 };
  if (
    hasTok('tri', 'trgl', 'triangel', 'tamb', 'tamburo', 'tambourine', 'piatti', 'becken', 'cymbals', 'cym', 'sn', 'wh', 'tam', 'bd', 'gong') ||
    hasSub(/triang|t rino|t ro |gran cassa|gr c |bass drum|castagn|tam tam|wood block|whip|snare|percussion|\bperc\b/)
  )
    return { group: 'perc', program: 0, perc: true };

  // ---- strings (check II before I)
  if (
    hasTok('cb', 'cbs', 'contrabass', 'contrabasses', 'contrabassi', 'kontrabass', 'kontrabasse', 'kontrabassy', 'dbs', 'db', 'basso', 'bassi', 'basses', 'bass', 'bss', 'bs') ||
    hasSub(/contrabass|kontrabass|double bass|doublebass/)
  )
    return { group: 'bass', program: 43 };
  if (
    hasTok('vc', 'vcs', 'vlc', 'vlcs', 'cello', 'cellos', 'celli', 'violoncello', 'violoncellos', 'violoncelle', 'violoncelles', 'vlc') ||
    hasSub(/violoncel/)
  )
    return { group: 'cello', program: 42 };
  if (hasTok('vla', 'vlas', 'vle', 'viole', 'viola', 'violas', 'bratsche', 'bratschen', 'alty', 'alti'))
    return { group: 'viola', program: 41 };

  if (
    hasTok('vln', 'vlns', 'vl', 'violin', 'violins', 'violino', 'violini', 'violinen', 'violine', 'violon', 'violons', 'skripki', 'skrzypce', 'vn', 'vns') ||
    hasSub(/violin|v ni/)
  ) {
    const second = hasTok('ii', '2', 'second', 'secondo', 'zweite', '2nd') || hasSub(/v ni ii|violin ii|violins 2/);
    const first = hasTok('i', '1', 'first', 'primo', 'erste', '1st') || hasSub(/v ni i\b|violin i\b|violins 1/);
    if (second) return { group: 'violin2', program: 40 };
    if (first) return { group: 'violin1', program: 40 };
    return { group: 'violin?', program: 40 };
  }

  if (hasTok('harp', 'harps', 'hrp', 'hrps', 'arpa', 'arpe', 'harfe')) return { group: 'other', program: 46 };
  if (hasTok('celesta', 'celeste', 'cel')) return { group: 'other', program: 8 };
  if (hasTok('organ', 'orgel', 'org')) return { group: 'other', program: 19 };
  if (hasTok('choir', 'chorus', 'chor', 'coro', 'soprano', 'soprani', 'contralti', 'tenore')) 
    return { group: 'other', program: 52 };

  return { group: 'other', program: 48 };
}

/** canonical GM program per group, so a piccolo listed first doesn't turn the
 *  whole flute channel into a piccolo. */
const GROUP_PROGRAM = {
  flute: 73, oboe: 68, clarinet: 71, bassoon: 70, horn: 60, trumpet: 56,
  trombone: 57, timpani: 47, violin1: 40, violin2: 40, viola: 41, cello: 42,
  bass: 43, perc: 0, other: 48,
};

const GROUP_ORDER = [
  ['flute', 'Flutes'], ['oboe', 'Oboes'], ['clarinet', 'Clarinets'],
  ['bassoon', 'Bassoons'], ['horn', 'Horns'], ['trumpet', 'Trumpets'],
  ['trombone', 'Low Brass'], ['timpani', 'Timpani'],
  ['violin1', 'Violins I'], ['violin2', 'Violins II'], ['viola', 'Violas'],
  ['cello', 'Cellos'], ['bass', 'Basses'], ['other', 'Other'], ['perc', 'Percussion'],
];
const groupRank = (g) => {
  const i = GROUP_ORDER.findIndex((x) => x[0] === g);
  return i < 0 ? 99 : i;
};
const groupLabel = (g) => (GROUP_ORDER.find((x) => x[0] === g) || [g, g])[1];

// ------------------------------------------------------------------- ABC read

function readAbc(raw) {
  const lines = raw.replace(/\r/g, '').split('\n');
  const globals = [];
  const headers = new Map();
  const order = [];
  let i = 0;
  // The header block is every leading line that is either a V: declaration or a
  // field directive. Anything else means the body has started. (Whitelisting
  // field letters breaks on files that use I:percmap, so accept any letter.)
  for (; i < lines.length; i++) {
    const L = lines[i];
    const m = /^V:\s*(\d+)/.exec(L);
    if (m) {
      const n = +m[1];
      if (!headers.has(n)) {
        headers.set(n, L);
        order.push(n);
      }
      continue;
    }
    if (L.trim() === '' || /^[A-Za-z]:/.test(L) || /^%%/.test(L)) {
      globals.push(L);
      continue;
    }
    break;
  }
  // The body usually opens with a bare "V:1" that duplicates the declaration we
  // just consumed. Without rewinding one line, that whole first voice is thrown
  // away (it is the only voice whose switch we already ate).
  if (i > 0 && /^V:\s*\d+/.test(lines[i - 1])) i -= 1;

  const body = new Map();
  let cur = null;
  const seen = [];
  for (; i < lines.length; i++) {
    const L = lines[i];
    const m = /^V:\s*(\d+)/.exec(L);
    if (m) {
      cur = +m[1];
      if (!body.has(cur)) {
        body.set(cur, []);
        seen.push(cur);
      }
      continue;
    }
    if (cur == null) continue;
    // drop inline directives that are not musical content
    if (/^(I|%%|%):?/.test(L.trim())) continue;
    body.get(cur).push(L);
  }
  // voices that only ever appear in the body still count
  for (const n of seen) if (!headers.has(n)) order.push(n);
  for (const n of order) if (!body.has(n)) body.set(n, []);
  return { globals, headers, order, body };
}

function headerField(line, field) {
  const m = new RegExp(`${field}=("[^"]*"|[^\\s]+)`).exec(line || '');
  if (!m) return null;
  return m[1].replace(/^"|"$/g, '');
}

function globalField(globals, field) {
  for (const L of globals) {
    const m = new RegExp(`^${field}:(.*)$`).exec(L);
    if (m) return m[1].trim();
  }
  return null;
}

/** quarters-per-beat length of a meter like 3/4 or 6/8 */
function meterBeats(meterStr) {
  const m = /^(\d+)\/(\d+)$/.exec((meterStr || '4/4').trim());
  if (!m) return 4;
  return (+m[1] * 4) / +m[2];
}

/** Q:1/2=132 -> { quarterBpm: 264, unit: 2 } */
function parseTempo(qField, fallback = 120) {
  if (!qField) return { quarterBpm: fallback, unit: 4 };
  const m = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(qField);
  if (!m) {
    const n = /=\s*(\d+(?:\.\d+)?)/.exec(qField);
    return { quarterBpm: n ? +n[1] : fallback, unit: 4 };
  }
  const quartersPerBeat = (4 * +m[1]) / +m[2];
  return { quarterBpm: +m[3] * quartersPerBeat, unit: +m[2] / +m[1] };
}

// ----------------------------------------------------- voice segmentation

function segmentVoice(text, initial) {
  const segs = [];
  let cur = { ...initial, text: '' };
  const re = /\[(K|M|Q|L):([^\]]*)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const [whole, kind, val] = m;
    cur.text += text.slice(last, m.index);
    last = m.index + whole.length;

    if (kind === 'K') {
      if (keyAccidentals(val) === null) continue; // clef-only: drop
      segs.push(cur);
      cur = { ...cur, key: val.trim(), text: '' };
      continue;
    }
    if (kind === 'M') {
      segs.push(cur);
      cur = { ...cur, meter: val.trim(), text: '' };
      continue;
    }
    if (kind === 'Q') {
      const t = parseTempo(`Q:${val}`, cur.quarterBpm);
      segs.push(cur);
      cur = { ...cur, quarterBpm: t.quarterBpm, tempoUnit: t.unit, text: '' };
      continue;
    }
    if (kind === 'L') {
      segs.push(cur);
      cur = { ...cur, length: val.trim(), text: '' };
    }
  }
  cur.text += text.slice(last);
  segs.push(cur);
  return segs.filter((s) => s.text.trim().length > 0);
}

// --------------------------------------------------------- element -> notes

function extractVoice(voiceText, voiceHeader, seg0) {
  const notes = [];

  // Velocity used to be a single constant, which meant no soundfont could ever
  // sound alive: dynamic layers never switch, every attack is identical.
  // Three cheap sources of variation, all deterministic (rebuilds are stable):
  //   - the !p!/!f! marking in force
  //   - melodic contour (players naturally lean into a rising line)
  //   - a tiny per-note jitter so repeated notes aren't clones
  let pitchEma = null;
  let noteSeq = 0;
  const velocityFor = (rawNote, midi) => {
    const base = DYN[rawNote.dyn] ?? 80;
    pitchEma = pitchEma == null ? midi : pitchEma * 0.92 + midi * 0.08;
    const contour = Math.max(-9, Math.min(9, (midi - pitchEma) * 0.55));
    noteSeq++;
    let h = (noteSeq * 2654435761) ^ (midi * 40503);
    h = (h ^ (h >>> 13)) >>> 0;
    const jitter = (h % 7) - 3;
    const accent = rawNote.accent ? 14 : 0;
    return Math.max(1, Math.min(127, Math.round(base + contour + jitter + accent)));
  };
  const measureBeats = [];
  const tempoMarks = [];
  const warnings = [];

  for (const seg of segmentVoice(voiceText, seg0)) {
    const currentMeter = meterBeats(seg.meter);
    const head = [
      'X:1',
      `M:${seg.meter}`,
      `L:${seg.length || '1/8'}`,
      `Q:${seg.tempoUnit === 2 ? '1/2' : '1/4'}=${seg.quarterBpm * (seg.tempoUnit === 2 ? 0.5 : 1)}`,
      `K:${seg.key}`,
      voiceHeader,
    ].join('\n');
    let tune;
    try {
      tune = ABCJS.parseOnly(`${head}\n${seg.text}\n`)[0];
    } catch (e) {
      warnings.push(`parse fail: ${e.message}`);
      continue;
    }
    if (!tune) {
      warnings.push('parse returned nothing');
      continue;
    }

    const kMap = keyMap(keyAccidentals(seg.key) ?? 0);
    const transpose = parseInt(headerField(voiceHeader, 'transpose') || '0', 10) || 0;

    // --- collect elements flat, in order
    const flat = [];
    for (const L of tune.lines || [])
      for (const st of L.staff || [])
        for (const v of st.voices || []) for (const el of v) flat.push(el);

    // --- first pass: raw timing + measure boundaries
    const raw = []; // {t, dur, el}
    const rawMeasures = []; // {start, end}
    let acc = 0;
    let mStart = 0;
    let dyn = 'mf';
    let accent = false;
    for (const el of flat) {
      if (el.el_type === 'bar') {
        rawMeasures.push({ start: mStart, end: acc });
        mStart = acc;
      } else if (el.el_type === 'note') {
        const dur = (el.duration || 0) * 4;
        if (el.decoration) {
          for (const d of el.decoration) {
            const k = String(d).toLowerCase();
            if (DYN[k] != null) dyn = k;
            if (k === '>' || k === 'accent') accent = true;
          }
        }
        if (el.pitches && !el.rest) raw.push({ t: acc, dur, el, dyn, accent });
        accent = false;
        acc += dur;
      }
    }
    rawMeasures.push({ start: mStart, end: acc });
    while (rawMeasures.length && rawMeasures[rawMeasures.length - 1].end - rawMeasures[rawMeasures.length - 1].start < 1e-9)
      rawMeasures.pop();

    // --- scale measure lengths: abcjs reports tuplets unscaled, so a triplet
    //     bar comes out long. Force each bar to the written meter.
    const isPickup = (i) => i === 0 && measureBeats.length === 0;
    const scaled = rawMeasures.map((m, i) => {
      const r = m.end - m.start;
      const len = isPickup(i) || r < 0.01 ? r : Math.abs(r - currentMeter) > 0.02 ? currentMeter : r;
      return { start: m.start, raw: r, len };
    });

    // --- second pass: assign measures + pitches
    const miBase = measureBeats.length;
    let mi = 0;
    let mem = new Map();
    for (const n of raw) {
      while (mi < scaled.length - 1 && n.t >= scaled[mi].start + scaled[mi].raw - 1e-6) {
        mi++;
        mem = new Map();
      }
      const m = scaled[mi];
      if (!m) continue;
      const scale = m.raw > 0.01 ? m.len / m.raw : 1;
      const pos = (n.t - m.start) * scale;
      for (const p of n.el.pitches) {
        const vp = p.pitch;
        const oct = Math.floor(vp / 7);
        const step = ((vp % 7) + 7) % 7;
        const mk = `${step}:${oct}`;
        let accOff;
        if (p.accidental && ACC_NAME[p.accidental] != null) {
          accOff = ACC_NAME[p.accidental];
          mem.set(mk, accOff);
        } else if (mem.has(mk)) accOff = mem.get(mk);
        else accOff = kMap.get(step) || 0;
        const midi = 12 * (oct + 5) + STEP_SEMI[step] + accOff + transpose;
        if (midi < 12 || midi > 108) continue;
        notes.push({
          mi: miBase + mi,
          pos,
          dur: n.dur * scale,
          midi,
          vel: velocityFor(n, midi),
          tieStart: !!(n.el.startTie && n.el.startTie.length),
          tieEnd: !!(n.el.endTie && n.el.endTie.length),
        });
      }
    }

    for (const m of scaled) measureBeats.push(m.len);
    tempoMarks.push({ mi: miBase, quarterBpm: seg.quarterBpm, unit: seg.tempoUnit });
  }

  return { notes, measures: measureBeats, tempoMarks, warnings };
}

// ------------------------------------------------------------------- builder

const tidy = (n) => Math.round(n * 1000) / 1000;

function buildPiece(srcFile, meta) {
  const raw = fs.readFileSync(path.join(CORPUS, srcFile), 'utf8');
  const { globals, headers, order, body } = readAbc(raw);
  if (!order.length) throw new Error('no voices found');

  let lastName = '';
  const names = new Map();
  for (const n of order) {
    const nm = headerField(headers.get(n), 'nm');
    if (nm) lastName = nm;
    names.set(n, lastName);
  }

  const cls = new Map();
  for (const n of order) cls.set(n, classify(names.get(n)));

  // resolve unqualified violin voices: first -> I, second -> II
  let unq = 0;
  for (const n of order) {
    const c = cls.get(n);
    if (c.group === 'violin?') c.group = unq++ === 0 ? 'violin1' : 'violin2';
  }

  const pianoVoices = order.filter((n) => cls.get(n).piano);
  const orchestraVoices = order.filter((n) => !cls.get(n).piano);
  const realOrch = orchestraVoices.filter((n) => cls.get(n).group !== 'other');
  if (realOrch.length < 3)
    throw new Error(`not an orchestral score (${realOrch.length} orchestral voices)`);

  const baseMeter = globalField(globals, 'M') || '4/4';
  const baseKey = globalField(globals, 'K') || 'C';
  const t0 = parseTempo(globalField(globals, 'Q'));
  const baseLen = globalField(globals, 'L') || '1/8';

  const tracks = new Map();
  const warnings = [];
  const tempoMarks = [];
  let masterMeasures = null;
  const measureCounts = [];

  for (const n of orchestraVoices) {
    const c = cls.get(n);
    const voiceText = (body.get(n) || []).join('\n');
    if (!voiceText.trim()) continue;
    const res = extractVoice(voiceText, headers.get(n), {
      key: baseKey,
      meter: baseMeter,
      quarterBpm: t0.quarterBpm,
      tempoUnit: t0.unit,
      length: baseLen,
    });
    warnings.push(...res.warnings);
    if (!res.notes.length) continue;
    measureCounts.push(res.measures.length);
    if (!masterMeasures || res.measures.length > masterMeasures.length) masterMeasures = res.measures;
    tempoMarks.push(...res.tempoMarks);

    if (!tracks.has(c.group)) {
      tracks.set(c.group, {
        group: c.group,
        program: c.group === 'other' ? c.program : GROUP_PROGRAM[c.group] ?? c.program,
        perc: !!c.perc,
        voices: [],
        notes: [],
        label: groupLabel(c.group),
      });
    }
    const tr = tracks.get(c.group);
    tr.voices.push(names.get(n));
    tr.notes.push(...res.notes);
  }

  if (!tracks.size || !masterMeasures) throw new Error('no notes extracted');

  const maxM = Math.max(...measureCounts);
  const minM = Math.min(...measureCounts);
  if (maxM !== minM) warnings.push(`measure count differs across voices (${minM}..${maxM})`);

  const mLens = masterMeasures.slice();
  while (mLens.length < maxM) mLens.push(4);
  const mStart = [];
  let b = 0;
  for (const l of mLens) {
    mStart.push(b);
    b += l;
  }
  const totalBeats = b;

  // channel assignment: 15 melodic channels + channel 9 for percussion
  const melodicPool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
  const ordered = [...tracks.values()].sort((a, b2) => groupRank(a.group) - groupRank(b2.group));
  let pi = 0;
  const outTracks = [];
  for (const tr of ordered) {
    const ch = tr.perc ? 9 : melodicPool[Math.min(pi++, melodicPool.length - 1)];
    const ns = tr.notes
      .map((n) => ({ ...n, abs: mStart[n.mi] + n.pos }))
      .filter((n) => Number.isFinite(n.abs) && n.abs >= 0)
      .sort((a, b2) => a.abs - b2.abs);

    // merge ties: a note ending with a tie continues into the next same pitch
    const merged = [];
    for (const n of ns) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.tieStart &&
        n.tieEnd &&
        prev.midi === n.midi &&
        n.abs - (prev.abs + prev.dur) > -0.05 &&
        n.abs - (prev.abs + prev.dur) < 0.08
      ) {
        prev.dur += n.dur + Math.max(0, n.abs - (prev.abs + prev.dur));
        prev.tieStart = n.tieStart;
        continue;
      }
      merged.push(n);
    }

    outTracks.push({
      group: tr.group,
      label: tr.label,
      channel: ch,
      program: tr.program,
      perc: tr.perc,
      voices: [...new Set(tr.voices)],
      noteCount: merged.length,
      notes: merged.map((n) => [tidy(n.abs), tidy(n.dur), n.midi, n.vel]),
    });
  }

  // Tempo map is owned by the user, not auto-extracted: the [Q:] marks in
  // these transcriptions are unreliable (they cluster in one voice and often
  // disagree across voices). One default section is emitted; the UI adds zones.
  const sections = [{ measure: 0, bpm: Math.round(t0.quarterBpm) }];

  return {
    id: meta.id,
    composer: meta.composer,
    work: meta.work,
    catalog: meta.catalog || '',
    movement: meta.movement,
    movementNo: meta.movementNo,
    sourceFile: srcFile,
    key: baseKey,
    meter: baseMeter,
    baseBpm: Math.round(t0.quarterBpm),
    tempoUnit: t0.unit,
    totalBeats: tidy(totalBeats),
    totalMeasures: mLens.length,
    measureStarts: mStart.map(tidy),
    measureBeats: mLens.map(tidy),
    tracks: outTracks,
    sections,
    pianoRemoved: [...new Set(pianoVoices.map((n) => names.get(n)))],
    pianoStaves: pianoVoices.length,
    warnings: [...new Set(warnings)].slice(0, 6),
  };
}

// ---------------------------------------------------------------------- main

function main() {
  if (!CORPUS) {
    console.error(
      '请先指定语料目录 / Set the corpus directory first:\n' +
        '  CM_CORPUS=/path/to/abc_corpus pnpm run build:pieces'
    );
    process.exit(1);
  }
  if (!fs.existsSync(CORPUS)) {
    console.error(`语料目录不存在 / corpus not found: ${CORPUS}`);
    process.exit(1);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/catalog.json'), 'utf8'));
  fs.mkdirSync(OUT_PIECES, { recursive: true });
  fs.mkdirSync(OUT_ABC, { recursive: true });
  for (const f of fs.readdirSync(OUT_PIECES)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUT_PIECES, f));

  const index = [];
  const report = [];
  for (const work of catalog) {
    const all = fs
      .readdirSync(CORPUS)
      .filter(
        (f) => f.endsWith('.abc') && (f.startsWith(work.prefix + '_') || f === work.prefix + '.abc')
      )
      .sort();
    const byMvt = new Map();
    for (const f of all) {
      const m = /_(\d+)(?:-[a-z0-9]+)?\.abc$/.exec(f);
      const mi = m ? +m[1] : 2;
      if (!byMvt.has(mi)) byMvt.set(mi, []);
      byMvt.get(mi).push(f);
    }
    const movements = [];
    for (const [mi, files] of [...byMvt.entries()].sort((a, b) => a[0] - b[0])) {
      const CORE = ['violin1', 'violin2', 'viola', 'cello', 'bass', 'flute', 'oboe',
        'clarinet', 'bassoon', 'horn', 'trumpet', 'trombone', 'timpani'];
      const scored = files
        .map((f) => {
          const raw = fs.readFileSync(path.join(CORPUS, f), 'utf8');
          // A transcription can lose a whole staff in OMR and still parse cleanly
          // (Mozart K175's first violins are empty in one source). Score how many
          // core sections actually carry notes, then fall back to sheer size.
          let score = 0;
          try {
            const { headers, order, body } = readAbc(raw);
            let last = '';
            const seen = new Set();
            for (const n of order) {
              const nm = headerField(headers.get(n), 'nm');
              if (nm) last = nm;
              const g = classify(last).group;
              if (!CORE.includes(g) || seen.has(g)) continue;
              if ((body.get(n) || []).join('').replace(/[\s|:]/g, '').length > 60) seen.add(g);
            }
            // weight the parts whose loss is most audible first
            score =
              (seen.has('violin1') ? 1000 : 0) +
              (seen.has('violin2') ? 200 : 0) +
              (seen.has('cello') || seen.has('bass') ? 200 : 0) +
              seen.size * 10;
          } catch {}
          return { f, score, size: raw.length };
        })
        .sort((a, b) => b.score - a.score || b.size - a.size);
      let built = null;
      let lastErr = null;
      for (const { f } of scored) {
        try {
          built = buildPiece(f, {
            id: `${work.id}-m${mi}`,
            composer: work.composer,
            work: work.title,
            catalog: work.catalog,
            movement: (work.movements && work.movements[mi]) || `Movement ${mi}`,
            movementNo: mi,
          });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (built) movements.push(built);
      else report.push(`  x ${work.id} mvt ${mi}: ${lastErr && lastErr.message}`);
    }

    for (const mv of movements) {
      fs.writeFileSync(path.join(OUT_PIECES, mv.id + '.json'), JSON.stringify(mv));
      if (mv.sourceFile) {
        try {
          fs.copyFileSync(path.join(CORPUS, mv.sourceFile), path.join(OUT_ABC, mv.sourceFile));
        } catch {}
      }
      const noteTotal = mv.tracks.reduce((s, t) => s + t.noteCount, 0);
      const flag = mv.warnings.length ? `  ! ${mv.warnings.slice(0, 2).join('; ')}` : '';
      report.push(
        `  ${mv.id.padEnd(24)} ${String(mv.totalMeasures).padStart(4)}bars ${String(mv.baseBpm).padStart(3)}bpm ${mv.key.padEnd(4)} ${String(mv.tracks.length).padStart(2)}tr ${(noteTotal / 1000).toFixed(1).padStart(5)}k n${flag}`
      );
      index.push({
        id: mv.id,
        composer: mv.composer,
        work: mv.work,
        catalog: mv.catalog,
        movement: mv.movement,
        movementNo: mv.movementNo,
        key: mv.key,
        meter: mv.meter,
        baseBpm: mv.baseBpm,
        totalMeasures: mv.totalMeasures,
        trackCount: mv.tracks.length,
        noteCount: noteTotal,
        tracks: mv.tracks.map((t) => ({ label: t.label, voices: t.voices })),
      });
    }
  }

  fs.writeFileSync(
    path.join(OUT_PIECES, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), pieces: index }, null, 1)
  );
  console.log(report.join('\n'));
  console.log(`\n${index.length} movements baked from ${catalog.length} works.`);
}

if (!process.env.CM_NO_MAIN) main();
export { readAbc, segmentVoice, parseTempo, extractVoice, classify, headerField, globalField, keyAccidentals };
