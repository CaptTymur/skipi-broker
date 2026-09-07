#!/usr/bin/env node
/**
 * broker_escaping_negative_harness.mjs — негативы BACKLOG №191 (security) и №197.
 *
 * Что доказывает:
 *   1. Внешнее значение не доезжает до исполняемого sink'а — inline-обработчика,
 *      значения атрибута, HTML-текста, тултипа Leaflet, заголовка RFC-822.
 *   2. Экранирование обратимо: значение, доехавшее до обработчика, после разбора
 *      HTML-парсером и разбора JS-строкового литерала ПОБАЙТОВО равно исходному
 *      (иначе `state.team.sendTarget === nick` молча ломается).
 *   3. №197: слово «неверный» произносится только когда сервер явно отверг токен.
 *
 * Как доказывает: каждая проверка сопровождается ДРИЛЛОМ — точечной мутацией
 * исходника, которая обязана уронить ИМЕННО свою проверку. `require_all_of`
 * гейта доказывает лишь касание файла, поэтому выхолащивание харнесса обязано
 * краснить само себя: снизу зафиксированы минимальное число проверок и полный
 * список их имён.
 *
 * Запуск: node tests/broker_escaping_negative_harness.mjs
 * Корень можно переопределить: BROKER_HARNESS_ROOT=<путь> (используется дриллами).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT =
  process.env.BROKER_HARNESS_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REL = {
  index: 'dist/index.html',
  map: 'dist/map.js',
  rust: 'src-tauri/src/lib.rs',
};

function loadFiles() {
  const f = {};
  for (const [k, rel] of Object.entries(REL)) {
    f[k] = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  }
  return f;
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
function mustHave(src, needle, msg) {
  must(src.includes(needle), msg + '\n    ожидалось в исходнике: ' + needle);
}
function mustNotHave(src, needle, msg) {
  must(!src.includes(needle), msg + '\n    осталось в исходнике: ' + needle);
}

/* ------------------------------------------------------------------ *
 * Исполнение реальных экранировщиков из dist/index.html
 * ------------------------------------------------------------------ */
const ESC_BEGIN = '// SKIPI-ESCAPERS-BEGIN';
const ESC_END = '// SKIPI-ESCAPERS-END';

function escaperBlock(index) {
  const a = index.indexOf(ESC_BEGIN);
  const b = index.indexOf(ESC_END, a + 1);
  must(a >= 0 && b > a, 'в dist/index.html нет блока ' + ESC_BEGIN + '…' + ESC_END);
  must(index.indexOf(ESC_BEGIN, a + 1) < 0, 'блок экранировщиков объявлен больше одного раза');
  return index.slice(a, b);
}
function escapers(index) {
  const block = escaperBlock(index);
  // eslint-disable-next-line no-new-func
  return new Function(
    block + '\nreturn { esc, escJs, escAttrVal, escNum, hdrSafe };'
  )();
}

/** Декодирование сущностей так, как это делает HTML-парсер: один проход. */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Разбор JS-строкового литерала — так, как это сделает движок. */
function parseJsString(text, start) {
  const q = text[start];
  must(q === "'" || q === '"', 'ожидался строковый литерал в позиции ' + start);
  let out = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      const n = text[++i];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'u') {
        out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += n;
      continue;
    }
    if (c === q) return { value: out, end: i };
    if (c === '\n') throw new Error('литерал разорван переводом строки');
    out += c;
  }
  throw new Error('незакрытый строковый литерал');
}

/**
 * Прогон значения по реальному маршруту: сборка разметки → разбор атрибута
 * HTML-парсером → разбор JS-строки движком.
 * `wrap` — функция экранирования, которую проверяем.
 */
function throughInlineHandler(wrap, raw) {
  const html = '<button onclick="pick(\'' + wrap(raw) + '\')">x</button>';
  const at = html.indexOf('onclick="') + 'onclick="'.length;
  const close = html.indexOf('"', at);
  must(close > at, 'значение атрибута не закрыто — разметка сломана целиком');
  const jsCode = decodeEntities(html.slice(at, close));
  const open = jsCode.indexOf("'");
  const parsed = parseJsString(jsCode, open);
  return { jsCode, value: parsed.value, tail: jsCode.slice(parsed.end + 1) };
}

const BREAKOUT_PAYLOADS = [
  "x'); MARK(); //",
  "1234567'); MARK(); //",
  "\\');MARK()//",
  '</span><script>MARK()</script>',
  '<img src=x onerror=MARK()>',
  'MV "SEA STAR"',
  "O'Brien",
  'a\\b',
  'line1\r\nline2',
  '&#39;&amp;',
  'обычная тема письма',
];

/* ------------------------------------------------------------------ *
 * Механический скан обоих файлов: контекст каждой подстановки
 * ------------------------------------------------------------------ */
function tokenize(src) {
  const toks = [];
  let i = 0, code = '', codeStart = 0;
  const flush = () => { if (code) { toks.push({ t: 'CODE', v: code, s: codeStart }); code = ''; } };
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      let j = i + 1, ok = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) { ok = true; break; }
        if (q !== '`' && src[j] === '\n') break;
        j++;
      }
      if (ok) { flush(); toks.push({ t: 'STR', v: src.slice(i, j + 1), s: i }); i = j + 1; continue; }
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length;
      if (!code) codeStart = i;
      code += src.slice(i, j); i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i); j = j < 0 ? src.length : j + 2;
      if (!code) codeStart = i;
      code += src.slice(i, j); i = j; continue;
    }
    if (!code) codeStart = i;
    code += c; i++;
  }
  flush();
  return toks;
}
function unescapeLit(v) {
  const body = v.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      const n = body[++i];
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === undefined ? '' : n;
      continue;
    }
    out += c;
  }
  return out;
}
function splitTopLevelPlus(expr) {
  const parts = [];
  let cur = '', depth = 0, instr = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (instr) { cur += c; if (c === '\\') { cur += expr[++i] || ''; continue; } if (c === instr) instr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { instr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === '+' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}
function bracketDelta(code) {
  let d = 0;
  for (const c of code) {
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') d--;
  }
  return d;
}
/**
 * Цепочка конкатенации: STR (+ выражение + STR)*.
 *
 * Соединитель между двумя литералами собирается со СКЛЕЙКОЙ по скобкам: без
 * неё `+ (isActive ? ' active' : '') +` рвал цепочку, и весь хвост разметки
 * вместе с inline-обработчиком выпадал из скана — ровно так был потерян сайт
 * renderLeadTabs.
 */
function chains(src) {
  const toks = tokenize(src);
  const res = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== 'STR') continue;
    const parts = [{ kind: 'lit', v: unescapeLit(toks[k].v), pos: toks[k].s }];
    let cur = k;
    for (;;) {
      if (cur + 1 >= toks.length || toks[cur + 1].t !== 'CODE') break;
      let v = toks[cur + 1].v;
      let depth = bracketDelta(v);
      let j = cur + 1;
      let guard = 0;
      while (depth > 0 && j + 1 < toks.length && guard++ < 200) {
        j++;
        v += toks[j].v;
        if (toks[j].t === 'CODE') depth += bracketDelta(toks[j].v);
      }
      if (depth !== 0) break;
      if (j + 1 >= toks.length || toks[j + 1].t !== 'STR') break;
      if (/[;{}]/.test(v)) break;
      if (/^\s*\+\s*$/.test(v)) {
        // чистая склейка двух литералов
      } else {
        const m = v.match(/^\s*\+\s*([\s\S]*?)\s*\+\s*$/);
        if (!m) break;
        for (const p of splitTopLevelPlus(m[1])) parts.push({ kind: 'expr', v: p, pos: toks[cur + 1].s });
      }
      parts.push({ kind: 'lit', v: unescapeLit(toks[j + 1].v), pos: toks[j + 1].s });
      cur = j + 1;
    }
    if (parts.some((p) => p.kind === 'expr')) res.push(parts);
    k = cur;
  }
  return res;
}
const SENT = String.fromCharCode(1);
function classify(parts) {
  let pseudo = '';
  const idx = [];
  for (const p of parts) {
    if (p.kind === 'lit') pseudo += p.v;
    else { idx.push(p); pseudo += SENT + (idx.length - 1) + SENT; }
  }
  const out = new Array(idx.length).fill(null);
  let i = 0, inTag = false, attr = null, quote = null, cur = '';
  while (i < pseudo.length) {
    const c = pseudo[i];
    if (c === SENT) {
      const j = pseudo.indexOf(SENT, i + 1);
      const n = parseInt(pseudo.slice(i + 1, j), 10);
      out[n] = inTag && quote
        ? { ctx: /^on[a-z]+$/i.test(attr || '') ? 'HANDLER' : 'ATTR', attr: (attr || '').toLowerCase() }
        : inTag ? { ctx: 'TAG', attr: null } : { ctx: 'TEXT', attr: null };
      i = j + 1; continue;
    }
    if (!inTag) { if (c === '<') { inTag = true; attr = null; quote = null; cur = ''; } i++; continue; }
    if (quote) { if (c === quote) { quote = null; attr = null; } i++; continue; }
    if (c === '>') { inTag = false; i++; continue; }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '=') { attr = cur.trim().split(/\s+/).pop(); cur = ''; i++; continue; }
    cur += c; i++;
  }
  return idx.map((p, n) => ({ expr: p.v, pos: p.pos, ...(out[n] || { ctx: 'TEXT', attr: null }) }));
}
function scanSinks(src, label) {
  const res = [];
  for (const ch of chains(src)) {
    const html = ch.filter((p) => p.kind === 'lit').map((p) => p.v).join('');
    if (!/<[a-zA-Z/!]/.test(html)) continue;   // не разметка — не sink
    for (const c of classify(ch)) {
      res.push({ file: label, line: src.slice(0, c.pos).split('\n').length, ...c });
    }
  }
  return res;
}

const WRAPPED = {
  HANDLER: /^(escAttrVal\(escJs\(|escNum\(|appsHandlerArg\()/,
  ATTR: /^(escAttrVal\(|escNum\(|appsAttrVal\()/,
  TAG: /^(escAttrVal\(|escNum\()/,
  TEXT: /^(esc\(|escAttrVal\(|escNum\(|Number\()/,
};

/**
 * Разбор доказанных исключений. Правило: сюда попадают ТОЛЬКО голые
 * идентификаторы локальных переменных, собранных из литералов или уже
 * экранированных значений, вызовы функций-производителей HTML и вендорные
 * экранировщики. Ни одно выражение вида `данные.поле` сюда не допускается —
 * поэтому дрилл «снять обёртку с сайта» всегда краснит скан.
 */
const ALLOW = {
  'dist/index.html': {
    ATTR: [
      // ageRingSvg: геометрия из чисел и палитра из литералов (см. var color = ageH<=2 ? '#4ec970' …)
      'cx', 'cy', 'r', 'sz', 'color', 'largeArc', '(r-1.5)', '(cy-(r-1.5))', 'x.toFixed(2)', 'y.toFixed(2)',
      // CSS-классы и inline-стили, собранные из литералов
      'stCls', 'cacheCls', 'st', 'cls', 'loadCls', 'unr', 'sel', 'weight',
      // dt = esc(...) строкой выше
      'dt',
      // константы контактов
      'TRIAL_CONTACT_EMAIL', 'TRIAL_CONTACT_WA_URL',
      // вендорный QR-модуль со своим экранировщиком
      'escapeXml(title.id)', 'escapeXml(alt.id)',
      // вендорный @skipi/settings со своим экранировщиком
      'ctx.escapeAttr(action)', 'ctx.escapeAttr(_companyEmail())', 'tone',
    ],
    TEXT: [
      // локальные переменные, собранные из литералов/тернаров
      'adoptLabel', 'btnLabel', 'chIcon', 'chTag', 'icon', 'iconL', 'label', 'roleIcon', 'roleLabel',
      'stateLabel', 'statusOpts', 'typeOpts', 'tag', 'pinHtml', 'hotHtml', 'dismissHtml', 'badge',
      'sweep', 'ageLabel', 'recipientsBlock', 'sendBtn', 'hint', 'addBtn', 'pulse', 'linkLbl',
      // локальные переменные, собранные уже экранированной разметкой
      'actions', 'ageHtml', 'ageRing', 'bodyHtml', 'btn', 'canonFlags', 'canonSender', 'canonTs',
      'chip', 'chips', 'confDot', 'contactBadge', 'copiesHtml', 'editedTag', 'events', 'fv', 'header',
      'inner', 'modTiles', 'perms', 'reasonRows', 'reviewsBlock', 'ring', 'ringHtml', 'ringWrap',
      'rows', 'scores', 'scoresBlock', 'sigBadge', 'snd', 'snFlags', 'sub', 'tiles', 'title', 'ts',
      'ttl', 'v', 'dt', 'subj', 'axisHtml',
      // третий аргумент _vcChip: ни один из пяти вызовов его не передаёт
      'suffix',
      // FLAG_META — константная таблица инлайновых SVG в этом же файле
      'meta.svg',
      // вендорный @skipi/settings: control собирается его же построителями,
      // tone приходит литералом из вызывающего кода
      'control', 'tone',
      // функции-производители HTML (их собственный вывод экранирован внутри)
      '_dedupStrengthBadge(c.strength)', '_fmtPartnerAge(r.first)', '_fmtPartnerAge(r.last)',
      '_miniRouteSvg(loadC, dischC)', '_sigIdBadge(s.id)', '_sigIdBadge(sig.id)',
      'feedbackStarsHtml()', 'trialContactHtml()', 'vesselNameLinkHtml(tv)',
      // константы контактов
      'TRIAL_CONTACT_EMAIL', 'TRIAL_CONTACT_PHONE',
      // вендорные блоки со своими экранировщиками
      'escapeXml(title.text)', 'escapeXml(alt.text)',
      'ctx.escapeHtml(ctx.t(labelKey))', 'ctx.escapeHtml(ctx.t(titleKey))', 'ctx.escapeHtml(description)',
    ],
    HANDLER: [],
    TAG: [],
  },
  'dist/map.js': {
    // цвета приходят из палитры _flowColor (проверяется отдельной проверкой)
    ATTR: ['color', 'cargoColor', 'glow'],
    TEXT: ['badge'],
    HANDLER: [],
    TAG: [],
  },
};

/**
 * Функции, которые сами возвращают уже экранированную разметку. Их вывод —
 * HTML по построению, и их собственные подстановки проверяются этим же сканом
 * там, где они собираются.
 */
const HTML_PRODUCERS = [
  'esc', 'escAttrVal', 'escNum', 'Number',
  'ageRingSvg', 'renderFlagBadges', 'vesselNameLinkHtml', 'imoLinkHtml',
  '_sigIdBadge', '_dedupStrengthBadge', '_miniRouteSvg', '_vcChip',
  'feedbackStarsHtml', 'trialContactHtml', '_renderTeamBody', '_sysEvent',
  '_publisherContactsHtml', 'brokerMobileModuleTilesHtml', 'brokerPluginStateLabel',
  'appsAttrVal', 'appsHandlerArg',
  // вендорные модули со своими экранировщиками
  'escapeXml', 'ctx.escapeHtml', 'ctx.escapeAttr',
];

function stripOuterParens(e) {
  let s2 = e.trim();
  for (;;) {
    if (!(s2.startsWith('(') && s2.endsWith(')'))) return s2;
    let d = 0, ok = true;
    for (let i = 0; i < s2.length; i++) {
      const c = s2[i];
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0 && i < s2.length - 1) { ok = false; break; } }
    }
    if (!ok) return s2;
    s2 = s2.slice(1, -1).trim();
  }
}
function splitTopLevel(expr, ops) {
  const parts = [];
  let cur = '', depth = 0, instr = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (instr) { cur += c; if (c === '\\') { cur += expr[++i] || ''; continue; } if (c === instr) instr = null; continue; }
    if (c === "'" || c === '"' || c === '`') { instr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (depth === 0) {
      const hit = ops.find((op) => expr.startsWith(op, i));
      if (hit) { parts.push(cur); cur = ''; i += hit.length - 1; continue; }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter(Boolean);
}
/** Ветви, значение которых реально попадает в разметку. */
function outputOperands(expr) {
  const e = stripOuterParens(expr);
  const tern = splitTopLevel(e, ['?']);
  if (tern.length === 2) {
    const branches = splitTopLevel(tern[1], [':']);
    return branches.flatMap(outputOperands);
  }
  const or = splitTopLevel(e, ['||']);
  if (or.length > 1) return or.flatMap(outputOperands);
  const and = splitTopLevel(e, ['&&']);
  if (and.length > 1) return outputOperands(and[and.length - 1]);
  const plus = splitTopLevel(e, ['+']);
  if (plus.length > 1) return plus.flatMap(outputOperands);
  return [e];
}
function isLiteral(e) {
  return /^'([^'\\]|\\.)*'$/.test(e) || /^"([^"\\]|\\.)*"$/.test(e) || /^-?\d+(\.\d+)?$/.test(e);
}
function isProducerCall(e) {
  return HTML_PRODUCERS.some((fn) => e.startsWith(fn + '(') || e.startsWith(fn + ' ('));
}
function isJoinOfScannedParts(e) {
  // X.join('') / X.map(...).join(' ') — куски массива собираются собственными
  // цепочками, которые этот же скан проверяет отдельно.
  return /\.join\(\s*('[^']*'|"[^"]*")\s*\)$/.test(e);
}
function isSafeExpr(e, ctx, allow) {
  if (WRAPPED[ctx].test(e)) return true;
  if ((allow[ctx] || []).includes(e)) return true;
  if (isLiteral(e)) return true;
  if (isProducerCall(e) && ctx !== 'HANDLER') return true;
  if (isJoinOfScannedParts(e) && ctx !== 'HANDLER') return true;
  const ops = outputOperands(e);
  if (ops.length === 1 && ops[0] === stripOuterParens(e)) return false;
  return ops.every((o) => isSafeExpr(o, ctx, allow));
}
function unwrappedSinks(src, label) {
  const allow = ALLOW[label];
  return scanSinks(src, label).filter((x) => !isSafeExpr(x.expr, x.ctx, allow));
}
function reportSinks(list) {
  return list.map((x) => `${x.file}:${x.line} [${x.ctx}${x.attr ? ' ' + x.attr : ''}] ${x.expr}`).join('\n    ');
}

/* ------------------------------------------------------------------ *
 * ПРОВЕРКИ
 * ------------------------------------------------------------------ */
const CHECKS = [];
const check = (name, run) => CHECKS.push({ name, run });

/* --- A. Экранировщики: поведение на реальных payload'ах --------------- */

check('A1 три контекстных экранировщика объявлены ровно по одному разу', (F) => {
  for (const fn of ['escJs', 'escAttrVal', 'escNum', 'hdrSafe']) {
    const n = F.index.split('function ' + fn + '(').length - 1;
    must(n === 1, `функция ${fn} объявлена ${n} раз(а), ожидался ровно 1`);
  }
  const H = escapers(F.index);
  for (const fn of ['esc', 'escJs', 'escAttrVal', 'escNum', 'hdrSafe']) {
    must(typeof H[fn] === 'function', `${fn} не исполняется как функция`);
  }
});

check('A2 escAttrVal(escJs(x)) не даёт выйти из JS-строки в inline-обработчике', (F) => {
  const H = escapers(F.index);
  const wrap = (x) => H.escAttrVal(H.escJs(x));
  for (const p of BREAKOUT_PAYLOADS) {
    const r = throughInlineHandler(wrap, p);
    must(r.tail === ')', `payload ${JSON.stringify(p)} вырвался из строки: хвост ${JSON.stringify(r.tail)}`);
    must(!/MARK\s*\(/.test(r.tail), `payload ${JSON.stringify(p)} протащил исполняемый код`);
  }
});

check('A3 round-trip: значение в обработчике побайтово равно исходному', (F) => {
  const H = escapers(F.index);
  const wrap = (x) => H.escAttrVal(H.escJs(x));
  for (const p of BREAKOUT_PAYLOADS) {
    const r = throughInlineHandler(wrap, p);
    must(r.value === p, `round-trip сломан: ${JSON.stringify(p)} → ${JSON.stringify(r.value)}`);
  }
});

check('A4 негативный контроль: голого esc() в обработчике НЕ хватает', (F) => {
  const H = escapers(F.index);
  let broke = false;
  try {
    const r = throughInlineHandler((x) => H.esc(x), "x'); MARK(); //");
    broke = r.tail !== ')' || r.value !== "x'); MARK(); //";
  } catch (_) {
    broke = true;
  }
  must(broke, 'esc() внезапно «безопасен» в обработчике — проверка стала пустой');
});

check('A5 escNum пропускает только конечные числа', (F) => {
  const H = escapers(F.index);
  must(H.escNum(42) === '42', 'число не прошло');
  must(H.escNum('7654321') === '7654321', 'числовая строка не прошла');
  for (const bad of ["1234567'); MARK(); //", '<img src=x onerror=MARK()>', 'abc', {}, [1, 2], NaN, Infinity]) {
    must(H.escNum(bad) === '', `escNum пропустил ${JSON.stringify(String(bad))}`);
  }
  must(H.escNum('abc', 0) === '0', 'явный fallback не сработал');
});

check('A6 легальные символы остаются видимыми (апостроф — апостроф)', (F) => {
  const H = escapers(F.index);
  for (const v of ["O'Brien", 'MV "SEA STAR"', 'Тема письма', "m/v St. John's"]) {
    must(decodeEntities(H.esc(v)) === v, `esc() исказил легальное значение ${JSON.stringify(v)}`);
    must(decodeEntities(H.escAttrVal(v)) === v, `escAttrVal() исказил ${JSON.stringify(v)}`);
  }
  const H2 = escapers(F.index);
  must(H2.escJs("O'Brien").indexOf('&') < 0, 'escJs не должен трогать HTML-сущности');
});

check('A7 hdrSafe убирает CR/LF и НЕ режет кириллицу по длине', (F) => {
  const H = escapers(F.index);
  const injected = 'MV X\r\nBcc: attacker@evil.com';
  must(!/[\r\n]/.test(H.hdrSafe(injected)), 'CR/LF остались в значении заголовка');
  const cyr = 'Тема письма про перевозку зерна из Новороссийска в Александрию с длинным описанием условий';
  must(H.hdrSafe(cyr) === cyr, 'hdrSafe обрезал или исказил кириллическую тему');
});

/* --- B. Сайты вызова: по одному негативу на сайт ---------------------- */

check('N1a index: openMarineTraffic получает v.imo только числом', (F) => {
  mustHave(F.index, "openMarineTraffic(\\''+escNum(v.imo)+'\\'", 'v.imo уехал в обработчик без escNum');
});
check('N1b index: openVesselPage получает v.imo только числом', (F) => {
  mustHave(F.index, "openVesselPage(\\''+escNum(v.imo)+'\\')", 'v.imo уехал в соседнюю кнопку без escNum');
});
check('N2 index: ключ/почта контрагента в selectCounterpart', (F) => {
  mustHave(F.index, "selectCounterpart(\\''+escAttrVal(escJs(r.key || r.email))+'\\')",
    'ключ контрагента идёт в обработчик не через escAttrVal(escJs(...))');
});
check('N3 index: ник члена команды в selectTeamTargetFromPanel', (F) => {
  mustHave(F.index, "selectTeamTargetFromPanel(\\''+escAttrVal(escJs(nick))+'\\'",
    'ник идёт в обработчик не через escAttrVal(escJs(...))');
});
check('N4 index: механический скан — незакрытых sink’ов нет', (F) => {
  const bad = unwrappedSinks(F.index, 'dist/index.html');
  must(bad.length === 0, `незакрытых подстановок в dist/index.html: ${bad.length}\n    ${reportSinks(bad)}`);
});
check('N4map map.js: механический скан — незакрытых sink’ов нет', (F) => {
  const bad = unwrappedSinks(F.map, 'dist/map.js');
  must(bad.length === 0, `незакрытых подстановок в dist/map.js: ${bad.length}\n    ${reportSinks(bad)}`);
});
check('N5 index: канал письма (ch) в значении атрибута', (F) => {
  mustHave(F.index, 'mch-pill-\'+escAttrVal(ch)+\'" title="канал: \'+escAttrVal(ch)+\'"',
    'ch подставляется в атрибуты без escAttrVal');
});
check('N6 index: счётчики сигналов (sc.*) в значении атрибута — числа', (F) => {
  mustHave(F.index, "cargo='+escNum(sc.cargo,0)+', tonnage='+escNum(sc.tonnage,0)+'",
    'sc.cargo/sc.tonnage подставляются в title без escNum');
});
check('N7 index: confidence в title карточки совпадения', (F) => {
  mustHave(F.index, 'title="Confidence: \'+escAttrVal(conf)+\'"', 'conf уехал в title без escAttrVal');
});
check('N8 index: confidence в тексте conf-pill', (F) => {
  mustHave(F.index, "данных в паре\">'+esc(conf)+'</span>", 'conf уехал в HTML-текст без esc');
});
check('N9 index: CRM-профиль контрагента — числа через escNum', (F) => {
  for (const needle of [
    'escNum(c.avg_commission_pct)',
    'escNum(c.whatsapp_presence_rate)',
    'escNum(c.urgency_rate)',
    'escNum(c.total_messages)',
  ]) mustHave(F.index, needle, 'поле CRM-профиля попадает в разметку без escNum');
});
check('N10 index: счётчики контрагентов и дублей — числа через escNum', (F) => {
  for (const needle of ['escNum(c.size)', 'escNum(c.unique_senders)', 'escNum(r.cargoCount)', 'escNum(r.tonnageCount)'])
    mustHave(F.index, needle, 'счётчик попадает в разметку без escNum');
});
check('N11 index: score совпадений — числа через escNum', (F) => {
  for (const needle of ['escNum(r.score)', 'escNum(m.score)', 'escNum(score)'])
    mustHave(F.index, needle, 'score попадает в разметку без escNum');
});
check('N12 map.js: тултип груза на таймлайне экранирован', (F) => {
  mustHave(F.map, "var tip = esc(c.cargo_type || 'cargo')", 'тултип груза собирается из сырых полей');
});
check('N13 map.js: тултип судна на таймлайне экранирован', (F) => {
  mustHave(F.map, "var tip = esc(v.vessel_name || v.vessel_type || 'tonnage')", 'тултип судна собирается из сырых полей');
});
check('N14 map.js: подпись маркера груза экранирована', (F) => {
  mustHave(F.map, "var label = esc(s.cargo_type || s.title || '?')", 'подпись маркера собирается из сырых полей');
});
check('N15 map.js: тултип порта выгрузки экранирован', (F) => {
  mustHave(F.map, "bindTooltip('↓ ' + esc(s.disch_port || '?')", 'порт выгрузки уходит в тултип сырьём');
});
check('N16a map.js: flow.signals в тултипе потока — число', (F) => {
  mustHave(F.map, "'<br>сигналов: '+escNum(flow.signals)", 'flow.signals уходит в тултип сырьём');
});
check('N16b map.js: cargo_breakdown в тултипе потока — число', (F) => {
  mustHave(F.map, "esc(k)+' '+escNum(br[k])", 'br[k] уходит в тултип сырьём');
});
check('N17 map.js: id сигнала в inline-обработчике списка', (F) => {
  mustHave(F.map, "vizOpenSignalMatches(\\''+escAttrVal(escJs(s.id))+'\\')",
    'id сигнала идёт в обработчик не через escAttrVal(escJs(...))');
});
check('N17b map.js: цвета в style приходят из палитры _flowColor', (F) => {
  const m = F.map.match(/function _flowColor\(cargo\)\{[\s\S]*?\n\}/);
  must(!!m, 'функция _flowColor не найдена');
  const returns = [...m[0].matchAll(/return\s+([^;]+);/g)].map((x) => x[1].trim());
  must(returns.length > 0, '_flowColor ничего не возвращает');
  for (const r of returns) {
    must(/^'#[0-9a-fA-F]{3,8}'$/.test(r), `_flowColor возвращает не литерал палитры: ${r}`);
  }
  for (const needle of ["var color = _flowColor(", 'var cargoColor = _flowColor(']) {
    mustHave(F.map, needle, 'цвет в style-атрибуте берётся не из палитры');
  }
});
check('N18a lib.rs: заголовок From очищается от CR/LF', (F) => {
  const n = F.rust.split('from = header_safe(&from_header)').length - 1;
  must(n === 2, `From: header_safe применён на ${n} из 2 сайтов (generate_eml + circulate_eml)`);
});
check('N18b lib.rs: заголовок To очищается от CR/LF', (F) => {
  mustHave(F.rust, 'to = header_safe(&to_header)', 'To: в generate_eml подставляется без очистки');
  mustHave(F.rust, 'to = header_safe(&s.reply_to)', 'To: в circulate_eml подставляется без очистки');
});
check('N18c lib.rs: заголовок Bcc очищается от CR/LF', (F) => {
  mustHave(F.rust, 'bcc = header_safe(&bcc)', 'Bcc: подставляется без очистки — это и есть канал инъекции');
});
check('N18d lib.rs: заголовок Subject очищается от CR/LF', (F) => {
  const n = F.rust.split('subject = header_safe(&subject)').length - 1;
  must(n === 2, `Subject: header_safe применён на ${n} из 2 сайтов`);
});
check('N18e lib.rs: header_safe не режет значение по длине', (F) => {
  const m = F.rust.match(/fn header_safe\(value: &str\) -> String \{[\s\S]*?\n\}/);
  must(!!m, 'функции header_safe в lib.rs нет');
  must(!/truncate|\.take\(|\[\.\.\d/.test(m[0]), 'header_safe режет значение по длине — кириллическая тема будет разрублена');
  mustHave(F.rust, '#[cfg(test)]', 'в lib.rs нет ни одного теста');
});
check('N19 index: предварительное ручное экранирование снято (round-trip)', (F) => {
  mustNotHave(F.index, "nick.replace(/'/g", 'ручное экранирование ника осталось — с escJs получится двойное');
  mustNotHave(F.index, ".replace(/['\\]/g,'')", 'вырезание апострофа осталось — имя судна доедет искалеченным');
  mustHave(F.index, 'escAttrVal(escJs(String(name)))', 'vesselNameLinkHtml перестал экранировать имя судна');
});
check('N20 index: subject письма чистится от CRLF на месте сборки', (F) => {
  const n = F.index.split("subject = hdrSafe('RE: '").length - 1;
  must(n === 2, `subject собирается через hdrSafe на ${n} из 2 сайтов`);
  mustHave(F.index, "var subject=hdrSafe((document.getElementById('circ-subject')", 'тема циркуляра не чистится');
  mustHave(F.index, 'toEmail: hdrSafe(email)', 'адрес получателя уезжает в заголовок без очистки');
});
check('N21 index (№197): текст ошибки активации разнесён по причинам', (F) => {
  mustHave(F.index, 'if(res.status === 401 || res.status === 403)', 'нет ветки «сервер явно отверг токен»');
  mustHave(F.index, 'catch(netErr)', 'сетевая ошибка не отделена от отказа сервера');
  mustHave(F.index, 'function trialNoConnectionMessage()', 'нет отдельного текста «нет связи»');
  mustHave(F.index, 'function trialPhaseMessage(phase)', 'нет честного объяснения для фазы не free');
  mustHave(F.index, 'trialContactTail()', 'в объяснении фазы нет пути оплаты');
  const block = F.index.slice(
    F.index.indexOf('async function trialActivateLicense(){'),
    F.index.indexOf('async function trialGateApply(){')
  );
  must(block.length > 0, 'функция trialActivateLicense не найдена');
  const code = block.replace(/\/\/[^\n]*/g, '');   // комментарии — не текст для брокера
  const wrong = [...code.matchAll(/[Нн]еверный/g)].length;
  must(wrong === 1, `слово «неверный» встречается ${wrong} раз(а); допустима ровно одна ветка — 401/403`);
  must(/401 \|\| res\.status === 403\)\{[\s\S]{0,320}Неверный license-токен/.test(block),
    'слово «неверный» стоит не в ветке явного отказа сервера');
});

/* ------------------------------------------------------------------ *
 * ДРИЛЛЫ: точечная мутация обязана уронить ИМЕННО свою проверку
 * ------------------------------------------------------------------ */
const DRILLS = [];
const drill = (name, target, file, from, to) =>
  DRILLS.push({ name, target, file, from, to });

drill('D-A2 escJs перестаёт экранировать апостроф', 'A2 escAttrVal(escJs(x)) не даёт выйти из JS-строки в inline-обработчике',
  'index', `.replace(/'/g,"\\\\'").replace(/"/g,'\\\\"')`, `.replace(/"/g,'\\\\"')`);
drill('D-A5 escNum перестаёт отвергать не-числа', 'A5 escNum пропускает только конечные числа',
  'index', 'return Number.isFinite(n) ? String(n)', 'return true ? String(v)');
drill('D-A7 hdrSafe перестаёт убирать CR/LF', 'A7 hdrSafe убирает CR/LF и НЕ режет кириллицу по длине',
  'index', "function hdrSafe(s){ return String(s==null?'':s).replace(/[\\r\\n]/g,''); }",
  "function hdrSafe(s){ return String(s==null?'':s); }");
drill('D-N1a вернуть v.imo сырьём в openMarineTraffic', 'N1a index: openMarineTraffic получает v.imo только числом',
  'index', "openMarineTraffic(\\''+escNum(v.imo)+'\\'", "openMarineTraffic(\\''+v.imo+'\\'");
drill('D-N1b вернуть v.imo сырьём в openVesselPage', 'N1b index: openVesselPage получает v.imo только числом',
  'index', "openVesselPage(\\''+escNum(v.imo)+'\\')", "openVesselPage(\\''+v.imo+'\\')");
drill('D-N2 вернуть голый esc() контрагенту', 'N2 index: ключ/почта контрагента в selectCounterpart',
  'index', "selectCounterpart(\\''+escAttrVal(escJs(r.key || r.email))+'\\')", "selectCounterpart(\\''+esc(r.key || r.email)+'\\')");
drill('D-N3 вернуть голый esc() нику команды', 'N3 index: ник члена команды в selectTeamTargetFromPanel',
  'index', "selectTeamTargetFromPanel(\\''+escAttrVal(escJs(nick))+'\\'", "selectTeamTargetFromPanel(\\''+esc(nick)+'\\'");
drill('D-N4 вернуть голый esc() на сайте selectLead', 'N4 index: механический скан — незакрытых sink’ов нет',
  'index', "selectLead(\\''+escAttrVal(escJs(m.id))+'\\')", "selectLead(\\''+esc(m.id)+'\\')");
drill('D-N4b вернуть голый esc() на сайте vizOpenSignalMatches', 'N4map map.js: механический скан — незакрытых sink’ов нет',
  'map', "vizOpenSignalMatches(\\''+escAttrVal(escJs(s.id))+'\\')", "vizOpenSignalMatches(\\''+esc(s.id)+'\\')");
drill('D-N5 снять escAttrVal с канала письма', 'N5 index: канал письма (ch) в значении атрибута',
  'index', 'mch-pill-\'+escAttrVal(ch)+\'" title="канал: \'+escAttrVal(ch)+\'"', 'mch-pill-\'+ch+\'" title="канал: \'+ch+\'"');
drill('D-N6 снять escNum со счётчиков сигналов', 'N6 index: счётчики сигналов (sc.*) в значении атрибута — числа',
  'index', "cargo='+escNum(sc.cargo,0)+', tonnage='+escNum(sc.tonnage,0)+'", "cargo='+(sc.cargo||0)+', tonnage='+(sc.tonnage||0)+'");
drill('D-N7 снять обёртку с confidence в title', 'N7 index: confidence в title карточки совпадения',
  'index', 'title="Confidence: \'+escAttrVal(conf)+\'"', 'title="Confidence: \'+conf+\'"');
drill('D-N8 снять обёртку с confidence в тексте', 'N8 index: confidence в тексте conf-pill',
  'index', "данных в паре\">'+esc(conf)+'</span>", "данных в паре\">'+conf+'</span>");
drill('D-N9 снять escNum с комиссии CRM-профиля', 'N9 index: CRM-профиль контрагента — числа через escNum',
  'index', 'escNum(c.avg_commission_pct)', 'c.avg_commission_pct');
drill('D-N10 снять escNum с размера кластера дублей', 'N10 index: счётчики контрагентов и дублей — числа через escNum',
  'index', 'escNum(c.size)', 'c.size');
drill('D-N11 снять escNum со score строки совпадения', 'N11 index: score совпадений — числа через escNum',
  'index', 'escNum(r.score)', 'r.score');
drill('D-N12 снять esc с тултипа груза', 'N12 map.js: тултип груза на таймлайне экранирован',
  'map', "var tip = esc(c.cargo_type || 'cargo')", "var tip = (c.cargo_type || 'cargo')");
drill('D-N13 снять esc с тултипа судна', 'N13 map.js: тултип судна на таймлайне экранирован',
  'map', "var tip = esc(v.vessel_name || v.vessel_type || 'tonnage')", "var tip = (v.vessel_name || v.vessel_type || 'tonnage')");
drill('D-N14 снять esc с подписи маркера', 'N14 map.js: подпись маркера груза экранирована',
  'map', "var label = esc(s.cargo_type || s.title || '?')", "var label = (s.cargo_type || s.title || '?')");
drill('D-N15 снять esc с порта выгрузки', 'N15 map.js: тултип порта выгрузки экранирован',
  'map', "bindTooltip('↓ ' + esc(s.disch_port || '?')", "bindTooltip('↓ ' + (s.disch_port || '?')");
drill('D-N16a снять escNum с flow.signals', 'N16a map.js: flow.signals в тултипе потока — число',
  'map', "'<br>сигналов: '+escNum(flow.signals)", "'<br>сигналов: '+flow.signals");
drill('D-N16b снять escNum с cargo_breakdown', 'N16b map.js: cargo_breakdown в тултипе потока — число',
  'map', "esc(k)+' '+escNum(br[k])", "esc(k)+' '+br[k]");
drill('D-N17 вернуть голый esc() обработчику карты', 'N17 map.js: id сигнала в inline-обработчике списка',
  'map', "vizOpenSignalMatches(\\''+escAttrVal(escJs(s.id))+'\\')", "vizOpenSignalMatches(\\''+esc(s.id)+'\\')");
drill('D-N17b подменить палитру _flowColor данными', 'N17b map.js: цвета в style приходят из палитры _flowColor',
  'map', "    return '#4ec970';\n}", '    return cargo;\n}');
drill('D-N18a убрать очистку заголовка From', 'N18a lib.rs: заголовок From очищается от CR/LF',
  'rust', 'from = header_safe(&from_header),\n        to = header_safe(&to_header)', 'from = from_header,\n        to = header_safe(&to_header)');
drill('D-N18b убрать очистку заголовка To', 'N18b lib.rs: заголовок To очищается от CR/LF',
  'rust', 'to = header_safe(&to_header)', 'to = to_header');
drill('D-N18c убрать очистку заголовка Bcc', 'N18c lib.rs: заголовок Bcc очищается от CR/LF',
  'rust', 'bcc = header_safe(&bcc)', 'bcc = bcc');
drill('D-N18d убрать очистку заголовка Subject', 'N18d lib.rs: заголовок Subject очищается от CR/LF',
  'rust', 'subject = header_safe(&subject)', 'subject = subject');
drill('D-N18e вернуть обрезку заголовка по длине', 'N18e lib.rs: header_safe не режет значение по длине',
  'rust', "value.chars().filter(|c| *c != '\\r' && *c != '\\n').collect()",
  "value.chars().filter(|c| *c != '\\r' && *c != '\\n').take(180).collect()");
drill('D-N19 вернуть двойное экранирование ника', 'N19 index: предварительное ручное экранирование снято (round-trip)',
  'index', 'var isActive = isBot ? (tgt === \'ai\') : (tgt === nick);',
  'var isActive = isBot ? (tgt === \'ai\') : (tgt === nick);\n            var nm = nick.replace(/\'/g, "\\\\\'");');
drill('D-N20 снять очистку subject в dist', 'N20 index: subject письма чистится от CRLF на месте сборки',
  'index', "subject = hdrSafe('RE: '+(sig.vessel_name", "subject = ('RE: '+(sig.vessel_name");
drill('D-N21 вернуть один общий catch со словом «неверный»', 'N21 index (№197): текст ошибки активации разнесён по причинам',
  'index', "if(err) err.textContent = 'Не удалось активировать: '", "if(err) err.textContent = 'неверный токен: '");

/* ------------------------------------------------------------------ *
 * МЕТА: харнесс не должен выхолащиваться незаметно
 * ------------------------------------------------------------------ */
const MIN_CHECKS = 29;
const MIN_DRILLS = 32;
const EXPECTED_CHECK_NAMES = [
  'A1 три контекстных экранировщика объявлены ровно по одному разу',
  'A2 escAttrVal(escJs(x)) не даёт выйти из JS-строки в inline-обработчике',
  'A3 round-trip: значение в обработчике побайтово равно исходному',
  'A4 негативный контроль: голого esc() в обработчике НЕ хватает',
  'A5 escNum пропускает только конечные числа',
  'A6 легальные символы остаются видимыми (апостроф — апостроф)',
  'A7 hdrSafe убирает CR/LF и НЕ режет кириллицу по длине',
  'N1a index: openMarineTraffic получает v.imo только числом',
  'N1b index: openVesselPage получает v.imo только числом',
  'N2 index: ключ/почта контрагента в selectCounterpart',
  'N3 index: ник члена команды в selectTeamTargetFromPanel',
  'N4 index: механический скан — незакрытых sink’ов нет',
  'N4map map.js: механический скан — незакрытых sink’ов нет',
  'N5 index: канал письма (ch) в значении атрибута',
  'N6 index: счётчики сигналов (sc.*) в значении атрибута — числа',
  'N7 index: confidence в title карточки совпадения',
  'N8 index: confidence в тексте conf-pill',
  'N9 index: CRM-профиль контрагента — числа через escNum',
  'N10 index: счётчики контрагентов и дублей — числа через escNum',
  'N11 index: score совпадений — числа через escNum',
  'N12 map.js: тултип груза на таймлайне экранирован',
  'N13 map.js: тултип судна на таймлайне экранирован',
  'N14 map.js: подпись маркера груза экранирована',
  'N15 map.js: тултип порта выгрузки экранирован',
  'N16a map.js: flow.signals в тултипе потока — число',
  'N16b map.js: cargo_breakdown в тултипе потока — число',
  'N17 map.js: id сигнала в inline-обработчике списка',
  'N17b map.js: цвета в style приходят из палитры _flowColor',
  'N18a lib.rs: заголовок From очищается от CR/LF',
  'N18b lib.rs: заголовок To очищается от CR/LF',
  'N18c lib.rs: заголовок Bcc очищается от CR/LF',
  'N18d lib.rs: заголовок Subject очищается от CR/LF',
  'N18e lib.rs: header_safe не режет значение по длине',
  'N19 index: предварительное ручное экранирование снято (round-trip)',
  'N20 index: subject письма чистится от CRLF на месте сборки',
  'N21 index (№197): текст ошибки активации разнесён по причинам',
];

/* ------------------------------------------------------------------ *
 * ПРОГОН
 * ------------------------------------------------------------------ */
let pass = 0;
const fail = [];
function ok(msg) { pass++; console.log('  ✓ ' + msg); }
function bad(msg, err) { fail.push(msg + ' :: ' + err.message); console.log('  ✗ ' + msg + '\n    ' + err.message); }
function section(t) { console.log('\n# ' + t); }

const FILES = loadFiles();

section('контекстные экранировщики и сайты вызова');
for (const c of CHECKS) {
  try { c.run(FILES); ok(c.name); } catch (e) { bad(c.name, e); }
}

section('дриллы: каждая мутация роняет ИМЕННО свою проверку');
const byName = new Map(CHECKS.map((c) => [c.name, c]));
for (const d of DRILLS) {
  try {
    const target = byName.get(d.target);
    must(!!target, `дрилл ${d.name} ссылается на несуществующую проверку «${d.target}»`);
    const mutated = { ...FILES };
    const before = mutated[d.file];
    must(before.includes(d.from), `дрилл ${d.name}: якорь не найден — дрилл протух`);
    mutated[d.file] = before.replace(d.from, d.to);
    must(mutated[d.file] !== before, `дрилл ${d.name}: мутация ничего не изменила`);
    let threw = false;
    try { target.run(mutated); } catch (_) { threw = true; }
    must(threw, `дрилл ${d.name}: проверка «${d.target}» осталась зелёной на сломанном исходнике`);
    // и проверка «своя»: остальные проверки этой мутацией не оцениваются,
    // но целевая обязана быть единственной, названной в дрилле.
    ok(d.name + ' → красит «' + d.target + '»');
  } catch (e) { bad(d.name, e); }
}

section('мета: харнесс нельзя выхолостить незаметно');
try {
  must(CHECKS.length >= MIN_CHECKS, `проверок ${CHECKS.length}, минимум ${MIN_CHECKS}`);
  ok(`проверок ${CHECKS.length} (минимум ${MIN_CHECKS})`);
} catch (e) { bad('минимальное число проверок', e); }
try {
  must(DRILLS.length >= MIN_DRILLS, `дриллов ${DRILLS.length}, минимум ${MIN_DRILLS}`);
  ok(`дриллов ${DRILLS.length} (минимум ${MIN_DRILLS})`);
} catch (e) { bad('минимальное число дриллов', e); }
try {
  const actual = CHECKS.map((c) => c.name).sort();
  const expected = EXPECTED_CHECK_NAMES.slice().sort();
  const missing = expected.filter((n) => !actual.includes(n));
  must(missing.length === 0, 'исчезли проверки: ' + missing.join(' | '));
  ok('состав проверок не изменился (' + expected.length + ' зафиксированных имён)');
} catch (e) { bad('неизменность имён проверок', e); }

console.log('');
if (fail.length) {
  console.log(`FAILED: ${pass} passed, ${fail.length} failed`);
  for (const f of fail) console.log('  - ' + f);
  process.exit(1);
}
console.log(`ALL GREEN: ${pass} passed, 0 failed`);
