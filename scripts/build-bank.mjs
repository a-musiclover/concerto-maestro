#!/usr/bin/env node
/**
 * Build the bundled sound bank.
 *
 * Source: MuseScore 4's "MS Basic.sf3" — a real orchestral bank with velocity
 * layers (Cello and Timpani have 9) that ships with MuseScore. It is 49 MB,
 * which is far too heavy to inline into a shareable offline build, and ~85% of
 * it is instruments a piano-concerto rehearsal never touches.
 *
 * Pruning makes it usable: 48.9 MB -> ~16 MB with the layering intact. Note that
 * filtering `presets` alone does nothing — the writer emits every entry in
 * `instruments`/`samples` regardless of whether a preset still points at it, so
 * the reachable set has to be walked and both arrays rebuilt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SoundBankLoader } from 'spessasynth_core';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
/**
 * MuseScore 4 ships "MS Basic.sf3" — a real orchestral bank with velocity
 * layers. Override with CM_BANK_SRC if yours lives elsewhere.
 */
const SRC =
  process.env.CM_BANK_SRC ||
  (process.platform === 'darwin'
    ? '/Applications/MuseScore 4.app/Contents/Resources/sound/MS Basic.sf3'
    : '');
const OUT = path.join(ROOT, 'public/soundfont.sf3');

/**
 * Presets an orchestral rehearsal needs. Names are exact — "French Horns" is
 * plural in this bank, and a near-miss silently drops the whole section.
 */
const KEEP = [
  // strings, with the section + velocity-layered variants MuseScore provides
  'Violins Fast', // bank 20 / 48, 3 layers
  'Violins2 Fast', // bank 25 / 48, 3 layers
  'Violas Fast', // bank 30 / 48, 3 layers
  'Strings Fast', // bank 0 / 48, 3 layers — generic ensemble fallback
  'Violin',
  'Viola',
  'Cello', // bank 0 / 42, 9 layers
  'Contrabass',
  // winds
  'Flute',
  'Oboe',
  'Clarinet',
  'Bassoon',
  // brass
  'French Horns',
  'Trumpet',
  'Trombone',
  'Tuba',
  // percussion / misc
  'Timpani', // 9 layers
  'Harp',
  'Celesta',
];

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到音源：${SRC}\n用 CM_BANK_SRC=... 指定路径。`);
    process.exit(1);
  }
  const raw = fs.readFileSync(SRC);
  const bank = SoundBankLoader.fromArrayBuffer(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  );
  if (bank.isReady) await bank.isReady;
  console.log(`源: ${path.basename(SRC)}  ${(raw.length / 1048576).toFixed(1)} MB`);
  console.log(`  presets=${bank.presets.length} instruments=${bank.instruments.length} samples=${bank.samples.length}`);

  const keep = new Set(KEEP);
  bank.presets = bank.presets.filter((p) => keep.has(p.name));
  const missing = [...keep].filter((n) => !bank.presets.some((p) => p.name === n));
  if (missing.length) console.log(`  ⚠ 源里没有这些 preset: ${missing.join(', ')}`);

  // walk what is still reachable, then rebuild both tables so the writer drops
  // everything else
  const usedInstruments = new Set();
  for (const p of bank.presets) {
    for (const pz of p.zones || []) if (pz.instrument) usedInstruments.add(pz.instrument);
  }
  const usedSamples = new Set();
  for (const inst of usedInstruments) {
    for (const iz of inst.zones || []) if (iz.sample) usedSamples.add(iz.sample);
  }
  bank.instruments = bank.instruments.filter((i) => usedInstruments.has(i));
  bank.samples = bank.samples.filter((s) => usedSamples.has(s));

  const out = bank.writeSF2({ software: 'ConcertoMaestro' });
  fs.writeFileSync(OUT, Buffer.from(out));

  console.log(
    `产出: ${path.relative(ROOT, OUT)}  ${(out.byteLength / 1048576).toFixed(1)} MB  ` +
      `(${((1 - out.byteLength / raw.length) * 100).toFixed(0)}% 更小)`
  );
  console.log(`  presets=${bank.presets.length} instruments=${bank.instruments.length} samples=${bank.samples.length}`);

  // report the presets we will actually address, with their velocity layering
  const rows = bank.presets
    .map((p) => {
      const v = new Set();
      for (const pz of p.zones || []) if (pz.velRange) v.add(`${pz.velRange.min}-${pz.velRange.max}`);
      return { name: p.name, bank: p.bankMSB ?? p.bank ?? 0, prog: p.program, layers: v.size };
    })
    .sort((a, b) => a.bank - b.bank || a.prog - b.prog);
  for (const r of rows) {
    console.log(`    bank ${String(r.bank).padStart(2)} prog ${String(r.prog).padStart(3)}  力度层 ${String(r.layers).padStart(2)}  ${r.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
