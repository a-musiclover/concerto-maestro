#!/usr/bin/env node
/**
 * Build the "unzip and double-click the page" distribution.
 *
 * file:// kills fetch() and ES modules, so for this target:
 *   - the app is bundled as a classic IIFE script
 *   - every JSON read becomes a <script> include that parks data on window
 *   - the AudioWorklet processor is inlined and registered from a Blob URL
 *   - the soundfont is base64-inlined (no way to read a sibling .sf2 from disk)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import esbuild from 'esbuild';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'ConcertoMaestro');
const DATA = path.join(OUT, 'data');
const PUBLIC = path.join(ROOT, 'public');

const log = (s) => console.log(s);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // 1. app bundle (classic script, no ESM)
  log('· bundling app…');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main.js')],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    define: { __STANDALONE__: 'true' },
    outfile: path.join(OUT, 'app.js'),
    loader: { '.css': 'css' },
    logLevel: 'warning',
  });

  // 2. index.html — module script -> classic script
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  html = html.replace(
    '<script type="module" src="./app.js"></script>',
    '<script defer src="./app.js"></script>'
  );
  html = html.replace('<title>', '<title>').replace(
    '</title>',
    '</title>'
  );
  write(path.join(OUT, 'index.html'), html);

  // 3. piece data as <script>
  log('· packing piece data…');
  const index = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'pieces/index.json'), 'utf8'));
  write(
    path.join(DATA, 'index.js'),
    `window.__CM_DATA=window.__CM_DATA||{};window.__CM_DATA["index"]=${JSON.stringify(index)};\n`
  );
  for (const p of index.pieces) {
    const json = fs.readFileSync(path.join(PUBLIC, 'pieces', `${p.id}.json`), 'utf8');
    write(
      path.join(DATA, `${p.id}.js`),
      `window.__CM_DATA=window.__CM_DATA||{};window.__CM_DATA[${JSON.stringify(p.id)}]=${json};\n`
    );
  }

  // 4. AudioWorklet processor source as a string
  log('· embedding worklet…');
  const workletSrc = fs.readFileSync(path.join(PUBLIC, 'spessasynth_processor.min.js'));
  write(
    path.join(DATA, 'worklet.js'),
    `window.__CM_WORKLET_B64=${JSON.stringify(workletSrc.toString('base64'))};\n`
  );

  // 5. soundfont as base64
  log('· embedding soundfont…');
  const bankPath = path.join(PUBLIC, 'soundfont.sf3');
  if (!fs.existsSync(bankPath)) {
    console.error('缺少音源 / missing soundbank: public/soundfont.sf3\n  先跑 pnpm run build:bank');
    process.exit(1);
  }
  const sf = fs.readFileSync(bankPath);
  write(path.join(DATA, 'soundfont.js'), `window.__CM_SF2=${JSON.stringify(sf.toString('base64'))};\n`);

  // 6. a short readme the recipient can actually follow
  write(
    path.join(OUT, 'README.txt'),
    [
      'Concerto Maestro — 协奏曲排练',
      '',
      '怎么用：',
      '  1. 双击本文件夹里的 index.html（推荐用 Chrome 或 Edge 打开）',
      '  2. 左边选一首，按空格开始',
      '',
      '快捷键：空格 播放/暂停      ← → 跳一小节      Shift+← → 跳十小节',
      '',
      '右上角有输出电平表：',
      '  格子在跳 = 有声音。如果在跳却听不见，检查系统音量和输出设备。',
      '  完全不跳 = 音源没加载成功。',
      '',
      '注意：',
      '  · 请用 Chrome / Edge。Safari 对本地文件的限制更严，可能没声音。',
      '  · 第一次打开要等两三秒（要解出 16MB 音源）。',
      '  · 音源用的是裁剪过的 MS Basic（来自 MuseScore），带力度分层。',
      '  · 速度区段和循环会自动记住，下次打开同一首还在。',
      '',
      '需要联网吗：不需要。整个文件夹就是全部。',
      '',
    ].join('\n')
  );

  const files = [];
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.push([f, fs.statSync(f).size]);
    });
  walk(OUT);
  const total = files.reduce((s, [, n]) => s + n, 0);
  log(`\n${files.length} files, ${mb(total)} total`);
  const big = files.filter(([, n]) => n > 500_000).sort((a, b) => b[1] - a[1]);
  for (const [f, n] of big) log(`  ${mb(n).padStart(8)}  ${path.relative(OUT, f)}`);

  if (process.argv.includes('--zip')) {
    const zip = path.join(ROOT, 'ConcertoMaestro-standalone.zip');
    fs.rmSync(zip, { force: true });
    log('\n· zipping…');
    // zip the folder itself so unzipping gives one clean directory
    execFileSync('zip', ['-r', '-q', '-X', zip, 'ConcertoMaestro'], { cwd: DIST, stdio: 'inherit' });
    const size = fs.statSync(zip).size;
    log(`  ${path.relative(ROOT, zip)}  ${mb(size)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
