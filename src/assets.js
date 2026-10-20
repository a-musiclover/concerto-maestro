/**
 * Asset loading — works both over HTTP and from a plain file:// URL.
 *
 * file:// blocks fetch() and ES modules, so the standalone build swaps every
 * network read for a <script> include. `__STANDALONE__` is replaced by esbuild
 * at build time, so only one of the two branches survives in each bundle.
 */

const BASE = './';

export const STANDALONE = __STANDALONE__;

const scriptCache = new Map();

function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
  scriptCache.set(src, p);
  return p;
}

/** index + per-movement data, fetched as JSON or injected as a script */
export async function loadJSON(name) {
  if (STANDALONE) {
    await loadScript(`${BASE}data/${name}.js`);
    const v = window.__CM_DATA && window.__CM_DATA[name];
    if (!v) throw new Error(`missing data/${name}.js`);
    return v;
  }
  const res = await fetch(`${BASE}pieces/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

/** soundfont bytes */
export async function loadSoundFont() {
  if (STANDALONE) {
    await loadScript(`${BASE}data/soundfont.js`);
    const b64 = window.__CM_SF2;
    if (!b64) throw new Error('missing soundfont bundle');
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { buffer: u8.buffer, name: 'soundfont.sf3' };
  }
  // ?sf=<file> lets you A/B a different bank without touching the build
  const file = new URLSearchParams(location.search).get('sf') || 'soundfont.sf3';
  const res = await fetch(`${BASE}${file}`);
  if (!res.ok) throw new Error(`soundfont: HTTP ${res.status}`);
  return { buffer: await res.arrayBuffer(), name: file };
}

/** register the synthesiser's AudioWorklet processor */
export async function loadWorklet(ctx) {
  if (STANDALONE) {
    // file:// gives the page an opaque origin, so blob: URLs turn into blob:null
    // and Chrome refuses to load a module from them. data: URLs have no origin,
    // so they still work (measured: ~34 ms for the 524 KB processor).
    await loadScript(`${BASE}data/worklet.js`);
    const b64 = window.__CM_WORKLET_B64;
    if (!b64) throw new Error('missing worklet bundle');
    await ctx.audioWorklet.addModule(`data:text/javascript;base64,${b64}`);
    return;
  }
  await ctx.audioWorklet.addModule(`${BASE}spessasynth_processor.min.js`);
}
