// Lightweight line-based syntax highlighter (no dependency).
// Each language is a set of states; each state is an ordered list of [regex, token, nextState?].
'use strict';
(function () {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const words = (list, flags = '') => new RegExp('\\b(?:' + list.trim().split(/\s+/).join('|') + ')\\b', flags);

  const DQ = /"(?:[^"\\]|\\.)*"?/;
  const SQ = /'(?:[^'\\]|\\.)*'?/;
  const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)[a-zA-Z]*/;
  const CALL = /[A-Za-z_$][\w$]*(?=\s*\()/;
  const CAPS = /\b[A-Z][A-Z0-9_]{2,}\b/;
  const TYPE = /\b[A-Z][a-z0-9_]\w*/;

  function clike({ kw, consts = 'true false null', types = '', extra = [], hash = false, slash = true, bt = false, ci = false }) {
    const f = ci ? 'i' : '';
    const start = [
      ...extra,
      ...(slash ? [[/\/\/.*/, 'com'], [/\/\*/, 'com', 'bcom']] : []),
      ...(hash ? [[/#(?!\[).*/, 'com']] : []),
      [DQ, 'str'], [SQ, 'str'],
      ...(bt ? [[/`/, 'str', 'bt']] : []),
      [words(kw, f), 'kw'],
      [words(consts, f), 'con'],
      ...(types ? [[words(types, f), 'type']] : []),
      [NUM, 'num'],
      [CALL, 'fn'],
      [CAPS, 'con'],
      [TYPE, 'type'],
    ];
    return { start, bcom: [[/[\s\S]*?\*\//, 'com', 'start'], [/.+/, 'com']], bt: [[/(?:[^`\\]|\\.)*`/, 'str', 'start'], [/.+/, 'str']] };
  }

  const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as interface type enum implements private public protected readonly declare namespace abstract keyof satisfies get set';
  const SHELL = (extraKw = '') => ({
    start: [
      [/#.*/, 'com'],
      [/\$\{[^}]*\}|\$\([^)]*\)|\$[\w@#?$!*-]/, 'var'],
      [DQ, 'str'], [SQ, 'str'],
      [words('if then else elif fi for while until do done case esac function in select return local export readonly declare unset shift exit source alias sudo ' + extraKw), 'kw'],
      [/^\s*[\w.-]+(?=\s*\(\))/, 'fn'],
      [/(?:^|(?<=[|;&]\s*))[\w./-]+(?=\s|$)/, 'fn'],
      [/\s--?[\w-]+/, 'attr'],
      [NUM, 'num'],
    ],
  });

  const L = {
    js: clike({ kw: JS_KW, consts: 'true false null undefined NaN Infinity', types: 'string number boolean any unknown never object symbol bigint', bt: true, extra: [[/@[\w.]+/, 'meta']] }),
    json: { start: [[/\/\/.*/, 'com'], [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'prop'], [DQ, 'str'], [/\b(?:true|false|null)\b/, 'con'], [/-?\d+\.?\d*(?:[eE][+-]?\d+)?/, 'num']] },
    php: clike({
      kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield',
      consts: 'true false null TRUE FALSE NULL self parent', types: 'int float string bool void mixed object iterable never',
      hash: true, extra: [[/<\?(?:php|=)?|\?>/, 'meta'], [/\$[A-Za-z_]\w*/, 'var'], [/#\[[^\]]*\]/, 'meta']],
    }),
    py: {
      start: [
        [/#.*/, 'com'],
        [/[rRbBuUfF]{0,2}"""/, 'str', 'tdq'], [/[rRbBuUfF]{0,2}'''/, 'str', 'tsq'],
        [/[rRbBuUfF]{0,2}"(?:[^"\\]|\\.)*"?/, 'str'], [/[rRbBuUfF]{0,2}'(?:[^'\\]|\\.)*'?/, 'str'],
        [/@[\w.]+/, 'meta'],
        [/(?<=\b(?:def|class)\s+)\w+/, 'fn'],
        [words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'), 'kw'],
        [words('True False None self cls'), 'con'],
        [words('int float str bool list dict set tuple bytes object type'), 'type'],
        [NUM, 'num'], [CALL, 'fn'], [CAPS, 'con'], [TYPE, 'type'],
      ],
      tdq: [[/[\s\S]*?"""/, 'str', 'start'], [/.+/, 'str']],
      tsq: [[/[\s\S]*?'''/, 'str', 'start'], [/.+/, 'str']],
    },
    go: clike({ kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var', consts: 'true false nil iota', types: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any', bt: true }),
    rust: clike({
      kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
      consts: 'true false None Some Ok Err', types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box',
      extra: [[/'(?:[^'\\]|\\.)'/, 'str'], [/'[a-z_]\w*/, 'meta'], [/#!?\[[^\]]*\]/, 'meta'], [/[a-z_]\w*!/, 'fn']],
    }),
    java: clike({ kw: 'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var volatile while record sealed permits yield', types: 'boolean byte char double float int long short void String', extra: [[/@\w+/, 'meta']] }),
    kotlin: clike({ kw: 'as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor data enum finally get import init internal lateinit open override private protected public sealed set suspend companion inline', consts: 'true false null', types: 'Int Long Double Float Boolean String Unit Any Char Byte Short', bt: false, extra: [[/@\w+/, 'meta']] }),
    cs: clike({ kw: 'abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while async await var record init get set when where yield', types: 'bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic', extra: [[/\[\w+(?:\([^)]*\))?\]/, 'meta'], [/#\s*\w+/, 'meta']] }),
    c: clike({ kw: 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual override new delete using try catch throw this friend operator constexpr noexcept nullptr', types: 'int char float double long short signed unsigned void bool size_t auto', consts: 'true false NULL nullptr', extra: [[/^\s*#\s*\w+/, 'meta'], [/<[\w./]+\.h(?:pp)?>/, 'str']] }),
    dart: clike({ kw: 'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory final finally for get hide if implements import in interface is late library mixin new on operator part required rethrow return sealed set show static super switch sync this throw try typedef var void while with yield', types: 'int double num String bool List Map Set Future Stream Widget', extra: [[/@\w+/, 'meta'], [/\$\{[^}]*\}|\$\w+/, 'var']] }),
    swift: clike({ kw: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is super self Self throw throws try async await', consts: 'true false nil', types: 'Int Double Float Bool String Character Array Dictionary Optional Void', extra: [[/@\w+/, 'meta']] }),
    css: {
      start: [
        [/\/\*/, 'com', 'bcom'], [/\/\/.*/, 'com'], [DQ, 'str'], [SQ, 'str'],
        [/#[\da-fA-F]{3,8}\b(?![\w-])/, 'num'],
        [/-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt|cm|mm|in|dpi)?/, 'num'],
        [/@[\w-]+/, 'kw'], [/![a-z]+/, 'kw'], [/\$[\w-]+|--[\w-]+|@\{[\w-]+\}/, 'var'],
        [/[\w-]+(?=\s*:(?!:)[^{;]*(?:;|$))/, 'prop'],
        [/\.[a-zA-Z_][\w-]*/, 'type'], [/::?[\w-]+/, 'meta'], [/[\w-]+(?=\()/, 'fn'],
      ],
      bcom: [[/[\s\S]*?\*\//, 'com', 'start'], [/.+/, 'com']],
    },
    html: {
      start: [
        [/<!--/, 'com', 'hcom'], [/<!DOCTYPE[^>]*>/i, 'meta'], [/<\/?[\w:.-]+/, 'tag', 'tag'], [/&[\w#]+;/, 'con'],
        [/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/, 'var'],
      ],
      hcom: [[/[\s\S]*?-->/, 'com', 'start'], [/.+/, 'com']],
      tag: [[/\/?>/, 'tag', 'start'], [/[@:#]?[\w:.\-@]+(?=\s*=)/, 'attr'], [/[\w:.-]+/, 'attr'], [DQ, 'str'], [SQ, 'str'], [/\{\{[\s\S]*?\}\}/, 'var']],
    },
    md: {
      start: [
        [/^\s*(?:```|~~~).*/, 'meta', 'code'],
        [/^\s{0,3}#{1,6}(?:\s.*|$)/, 'h'],
        [/^\s*<h[1-6][^>]*>.*$/i, 'h'],
        [/^\s*>+/, 'com'],
        [/^\s*(?:[-*_]\s*){3,}$/, 'com'],
        [/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s)?/, 'kw'],
        [/`[^`]+`/, 'code'],
        [/!?\[[^\]]*\]\([^)]*\)/, 'link'],
        [/<https?:\/\/[^>]+>|https?:\/\/[^\s<)]+/, 'link'],
        [/\*\*[^*\n]+\*\*|__[^_\n]+__/, 'b'],
        [/\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w])/, 'i'],
        [/~~[^~\n]+~~/, 'del'],
        [/<\/?[a-zA-Z][^>]*>/, 'tag'],
        [/^\s*\|.*\|\s*$/, 'punc'],
      ],
      code: [[/^\s*(?:```|~~~)\s*$/, 'meta', 'start'], [/.+/, 'code']],
    },
    yaml: {
      start: [
        [/#.*/, 'com'], [/^(?:---|\.\.\.)\s*$/, 'meta'],
        [/[\w.\-/$]+(?=\s*:(?:\s|$))/, 'prop'], [/"(?:[^"\\]|\\.)*"(?=\s*:(?:\s|$))/, 'prop'],
        [DQ, 'str'], [SQ, 'str'],
        [/\b(?:true|false|yes|no|null|on|off|~)\b/i, 'con'], [/[&*][\w-]+/, 'meta'], [/!!?\w+/, 'meta'],
        [/(?<=:\s+)-?\d[\d_.]*(?=\s*(?:#|$))/, 'num'], [/\$\{\{[^}]*\}\}|\$\{[^}]*\}/, 'var'],
      ],
    },
    ini: {
      start: [
        [/^\s*[#;].*/, 'com'], [/^\s*\[\[?[^\]]*\]\]?/, 'type'], [/^\s*[\w.\-"]+(?=\s*=)/, 'prop'],
        [DQ, 'str'], [SQ, 'str'], [/\b(?:true|false|null)\b/i, 'con'], [/\$\{?\w+\}?/, 'var'], [/(?<==\s*)-?\d[\d_.]*\s*$/, 'num'], [/\s#.*/, 'com'],
      ],
    },
    sh: SHELL(),
    dockerfile: (() => { const s = SHELL(); s.start.unshift([/^\s*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/i, 'kw'], [/\bAS\b/, 'kw']); return s; })(),
    make: (() => {
      const s = SHELL();
      s.start.unshift([/^#.*/, 'com'], [/^[\w.\-/ %$()]+(?=\s*::?(?!=))/, 'fn'], [/^\s*[\w.-]+\s*(?=[:?+!]?=)/, 'prop'], [/\$\([^)]*\)|\$\{[^}]*\}|\$[@<^*?%]/, 'var'], [/^\.PHONY|^\.\w+/, 'meta'], [/^\s*(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|define|endef|export)\b/, 'kw']);
      return s;
    })(),
    ps1: {
      start: [
        [/<#/, 'com', 'bcom'], [/#.*/, 'com'], [DQ, 'str'], [SQ, 'str'], [/\$[\w:]+|\$\{[^}]*\}/, 'var'],
        [/\b(?:if|else|elseif|foreach|for|while|do|until|switch|function|filter|param|return|try|catch|finally|throw|break|continue|in|begin|process|end|exit|trap|class|using)\b/i, 'kw'],
        [/\s-[A-Za-z][\w]*/, 'attr'], [/\b[A-Z][a-z]+-[A-Z]\w+/, 'fn'], [/\[[\w.]+\]/, 'type'], [NUM, 'num'],
      ],
      bcom: [[/[\s\S]*?#>/, 'com', 'start'], [/.+/, 'com']],
    },
    bat: {
      start: [
        [/^\s*@?(?:rem\b.*|::.*)/i, 'com'], [/%[\w~:,=-]+%|%%~?\w|%~?\d|!\w+!/, 'var'], [DQ, 'str'],
        [/^\s*:\w+/, 'fn'], [/\b(?:if|else|for|do|in|goto|call|set|echo|exit|not|exist|defined|errorlevel|setlocal|endlocal|enabledelayedexpansion|shift|pause|cd|start|equ|neq|lss|leq|gtr|geq)\b/i, 'kw'], [/@echo\s+off/i, 'kw'], [NUM, 'num'],
      ],
    },
    sql: {
      start: [
        [/--.*/, 'com'], [/#.*/, 'com'], [/\/\*/, 'com', 'bcom'], [SQ, 'str'], [/"(?:[^"]|"")*"|`[^`]*`/, 'prop'],
        [words('select from where and or not insert into values update set delete create alter drop table index view database schema primary key foreign references unique default null is in like between join inner left right full outer on as group by order having limit offset union all distinct case when then else end exists if begin commit rollback transaction grant revoke trigger procedure function returns return declare cascade constraint check auto_increment engine with recursive asc desc', 'i'), 'kw'],
        [words('int integer bigint smallint tinyint varchar char text date datetime timestamp time boolean bool decimal numeric float double real serial uuid json jsonb blob', 'i'), 'type'],
        [/\b(?:true|false)\b/i, 'con'], [NUM, 'num'], [CALL, 'fn'],
      ],
      bcom: [[/[\s\S]*?\*\//, 'com', 'start'], [/.+/, 'com']],
    },
    diff: { start: [[/^(?:\+\+\+|---).*/, 'meta'], [/^@@.*/, 'type'], [/^\+.*/, 'ins'], [/^-.*/, 'del'], [/^diff .*|^index .*/, 'meta']] },
  };

  const EXT = {
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', babelrc: 'json', eslintrc: 'json', prettierrc: 'json',
    php: 'php', phtml: 'php', py: 'py', pyw: 'py', pyi: 'py', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', gradle: 'kotlin', groovy: 'kotlin',
    cs: 'cs', c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c', ino: 'c', dart: 'dart', swift: 'swift', scala: 'java',
    css: 'css', scss: 'css', sass: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', xaml: 'html', csproj: 'html', plist: 'html',
    md: 'md', markdown: 'md', mdx: 'md', mdown: 'md', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini',
    sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ps1: 'ps1', psm1: 'ps1', bat: 'bat', cmd: 'bat', sql: 'sql', diff: 'diff', patch: 'diff', gitignore: 'ini', dockerignore: 'ini', npmrc: 'ini',
  };

  function langFor(path) {
    const name = (path.split('/').pop() || '').toLowerCase();
    if (name.endsWith('.blade.php')) return 'html';
    if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile';
    if (name === 'makefile' || name === 'gnumakefile' || name.endsWith('.mk')) return 'make';
    if (name.startsWith('.env')) return 'ini';
    if (name === 'justfile') return 'make';
    const i = name.lastIndexOf('.');
    const ext = i >= 0 ? name.slice(i + 1) : name;
    return EXT[ext] || null;
  }

  // compile regexes to sticky
  const COMPILED = {};
  for (const [id, def] of Object.entries(L)) {
    COMPILED[id] = {};
    for (const [st, rules] of Object.entries(def)) {
      COMPILED[id][st] = rules.map(([re, tok, next]) => ({ re: new RegExp(re.source, re.flags.replace(/[gy]/g, '') + 'y'), tok, next }));
    }
  }
  const CHUNK = /[\w$]+|\s+|[^\w$\s]/y;

  const cache = new Map();
  function line(lang, text, state) {
    const key = lang + '\u0001' + state + '\u0001' + text;
    const hit = cache.get(key);
    if (hit) return hit;
    const def = COMPILED[lang];
    let rules = def[state] || def.start;
    let pos = 0;
    let out = '';
    let plain = '';
    const n = text.length;
    let guard = 0;
    while (pos < n && guard++ < 20000) {
      let matched = false;
      for (const r of rules) {
        r.re.lastIndex = pos;
        const m = r.re.exec(text);
        if (!m || (!m[0].length && !r.next)) continue;
        if (plain) { out += esc(plain); plain = ''; }
        if (m[0].length) out += r.tok ? '<span class="t-' + r.tok + '">' + esc(m[0]) + '</span>' : esc(m[0]);
        pos += m[0].length;
        if (r.next) { state = r.next; rules = def[state] || def.start; }
        matched = true;
        break;
      }
      if (!matched) {
        CHUNK.lastIndex = pos;
        const m = CHUNK.exec(text);
        const s = m ? m[0] : text[pos];
        plain += s;
        pos += s.length;
      }
    }
    if (plain) out += esc(plain);
    const res = { html: out, state };
    if (cache.size > 60000) cache.clear();
    cache.set(key, res);
    return res;
  }

  // Returns html for lines [from, to) — states are carried from the top of the file.
  function render(lang, lines, from, to) {
    let state = 'start';
    const out = [];
    for (let i = 0; i < to && i < lines.length; i++) {
      const r = line(lang, lines[i], state);
      if (i >= from) out.push(r.html);
      state = r.state;
    }
    return out;
  }

  window.DashHL = { langFor, render };
})();
