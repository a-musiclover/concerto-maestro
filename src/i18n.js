/**
 * UI strings. Two languages only, deliberately flat — a nested catalogue would
 * be more machinery than the app has text.
 *
 * Static markup carries `data-i18n` (textContent), `data-i18n-html` (innerHTML)
 * or `data-i18n-title` (title attribute); dynamic strings go through t().
 */

export const LANGS = ['zh', 'en'];

const dict = {
  zh: {
    'doc.title': 'Concerto Maestro · 协奏曲排练',
    'app.tagline': '乐团声部 · 无限重来 · 速度随你',

    'engine.idle': '音源未加载',
    'engine.loading': '载入音源…',
    'engine.soundbank': '载入音色库…',
    'engine.ready': '音源就绪',
    'engine.error': '音源加载失败 · 点此重试',
    'engine.blocked': '浏览器拦住了播放，点一下页面任意处再按播放',

    'side.catalog': '曲目',
    'side.hint': '空格 播放 / 暂停 · ←→ 跳小节 · L 循环',

    'empty.title': '选一首，开始排练',
    'empty.body':
      '这里放的是<b>去掉钢琴的乐团</b>。速度、段落、循环都由你定，练一百遍也没人烦。',
    'empty.notFound': '没找到曲库',
    'empty.buildHint': '先跑一次构建：',

    'transport.original': '原速',
    'transport.loop': '循环',
    'transport.loopTitle': 'A–B 循环（L）',
    'transport.jump': '跳',
    'transport.jumpPlaceholder': '小节',
    'transport.of': '/',

    'panel.tempo': '速度区段',
    'panel.tempoNote':
      '第一段覆盖全曲，改它就是整首变速。加成多段之后，每一段只管自己的小节。',
    'panel.addZone': '＋ 从第 <b id="addZoneBar">1</b> 小节起',

    'panel.parts': '乐团声部',
    'panel.partsNote': '点掉不想听的声部。练集中注意力的时候很有用。',

    'panel.fx': '音色处理',
    'fx.placement': '声部摆位',
    'fx.reverb': '混响',
    'fx.humanize': '演奏微时序',
    'fx.amount': '混响量',
    'fx.ab.off': 'A/B：全部关掉',
    'fx.ab.on': 'A/B：全部打开',
    'fx.note':
      '摆位：把各声部放到乐团的实际位置上（第一小提琴在左、低音提琴在右），远处的声部顺带压低一点做纵深。混响：一个合成的厅（2.6 秒衰减），关掉就是干声。微时序：声部之间 ±7ms、音符之间 ±4ms 的偏移，<b>按声部和音符固定，循环同一段时每次都一样</b>。',
    'fx.meterTitle':
      '输出电平：有格子在跳就说明音频真的出来了；如果在跳但听不见，是系统音量或输出设备的问题',

    'meta.key': '调号 {v}',
    'meta.meter': '拍号 {v}',
    'meta.bars': '{v} 小节',
    'meta.parts': '{v} 个声部',
    'meta.notes': '{v}k 音',
    'meta.piano': '已移除钢琴 {v} 个谱表',
    'meta.warn': '⚠ 这个转录可能混入了重复段落，全曲时长偏长',

    'count.works': '{w} 部 / {m} 乐章',
    'count.parts': '{n} 个',
    'zone.range': '第 <b>{a}</b> – {b} 小节',
    'zone.toEnd': '结尾',
    'zone.delete': '删除这一段',
  },

  en: {
    'doc.title': 'Concerto Maestro · Rehearsal Accompaniment',
    'app.tagline': 'Orchestra only · endless retries · your tempo',

    'engine.idle': 'Soundbank not loaded',
    'engine.loading': 'Loading engine…',
    'engine.soundbank': 'Loading soundbank…',
    'engine.ready': 'Ready',
    'engine.error': 'Soundbank failed · click to retry',
    'engine.blocked': 'Browser blocked playback — click anywhere, then press play',

    'side.catalog': 'Repertoire',
    'side.hint': 'Space play/pause · ←→ bar · L loop',

    'empty.title': 'Pick a piece and start',
    'empty.body':
      'What plays here is the <b>orchestra with the piano removed</b>. Tempo, sections, loops — all yours. Practise it a hundred times; nobody is inconvenienced.',
    'empty.notFound': 'No repertoire found',
    'empty.buildHint': 'Build it first:',

    'transport.original': 'Default',
    'transport.loop': 'Loop',
    'transport.loopTitle': 'A–B loop (L)',
    'transport.jump': 'Go',
    'transport.jumpPlaceholder': 'bar',
    'transport.of': '/',

    'panel.tempo': 'Tempo map',
    'panel.tempoNote':
      'The first zone covers the whole piece — editing it changes the overall tempo. Add more zones and each one only governs its own bars.',
    'panel.addZone': '＋ from bar <b id="addZoneBar">1</b>',

    'panel.parts': 'Orchestral parts',
    'panel.partsNote': 'Mute what you do not need. Useful for focused listening.',

    'panel.fx': 'Sound treatment',
    'fx.placement': 'Seating',
    'fx.reverb': 'Reverb',
    'fx.humanize': 'Micro-timing',
    'fx.amount': 'Wet',
    'fx.ab.off': 'A/B: turn all off',
    'fx.ab.on': 'A/B: turn all on',
    'fx.note':
      'Seating places each section where it actually sits (first violins left, double basses right) and pulls the distant ones down slightly for depth. Reverb is a synthetic hall (2.6 s decay) — off is bone dry. Micro-timing offsets sections by ±7 ms and notes by ±4 ms, <b>fixed per section and per note, so a loop sounds identical every pass</b>.',
    'fx.meterTitle':
      'Output level: moving bars mean audio is really reaching the speakers. Moving bars but no sound means system volume or output device.',

    'meta.key': 'Key {v}',
    'meta.meter': 'Metre {v}',
    'meta.bars': '{v} bars',
    'meta.parts': '{v} parts',
    'meta.notes': '{v}k notes',
    'meta.piano': 'piano removed: {v} staves',
    'meta.warn': '⚠ this transcription may repeat whole passages — total length is long',

    'count.works': '{w} works · {m} mvt',
    'count.parts': '{n}',
    'zone.range': 'bars <b>{a}</b> – {b}',
    'zone.toEnd': 'end',
    'zone.delete': 'delete this zone',
  },
};

let current = 'zh';

export function getLang() {
  return current;
}

export function setLang(l) {
  current = LANGS.includes(l) ? l : 'zh';
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  return current;
}

export function t(key, vars) {
  const table = dict[current] || dict.zh;
  let s = table[key] ?? dict.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Apply the current language to the static markup. */
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
  }
  document.title = t('doc.title');
}
