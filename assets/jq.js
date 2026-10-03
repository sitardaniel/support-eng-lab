/* jq.js - a small jq interpreter covering the filters support work uses daily:
   paths, select, comparisons, and/or/not, pipes, arrays, objects, slices,
   map, length, keys, sort_by, group_by, max_by, min_by, unique, @tsv, @csv, test, ... */
(function (G) {
  const Lab = (G.Lab = G.Lab || {});
  const fail = (m) => { throw new Lab.ShellError(m); };

  /* ---------- lexer ---------- */
  function lex(src) {
    const t = []; let i = 0;
    const isId = (c) => /[A-Za-z0-9_]/.test(c);
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '"') {
        let j = i + 1, s = ''; const parts = [];
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && src[j + 1] === '(') {
            let d = 1, k = j + 2;
            while (k < src.length && d) { if (src[k] === '(') d++; else if (src[k] === ')') d--; k++; }
            parts.push(s, { expr: src.slice(j + 2, k - 1) }); s = ''; j = k; continue;
          }
          if (src[j] === '\\') { const n = src[j + 1]; s += { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' }[n] ?? n; j += 2; }
          else s += src[j++];
        }
        if (j >= src.length) syntax('unterminated string');
        if (parts.length) { parts.push(s); t.push({ k: 'istr', v: parts }); } else t.push({ k: 'str', v: s });
        i = j + 1; continue;
      }
      if (/[0-9]/.test(c)) { const m = src.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/); t.push({ k: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (c === '.' && src[i + 1] === '.') { t.push({ k: 'op', v: '..' }); i += 2; continue; }
      if (c === '.' && /[A-Za-z_]/.test(src[i + 1] || '')) { let j = i + 1; while (j < src.length && isId(src[j])) j++; t.push({ k: 'field', v: src.slice(i + 1, j) }); i = j; continue; }
      if (c === '.' && src[i + 1] === '"') { t.push({ k: 'op', v: '.' }); i++; continue; }
      if (c === '@') { let j = i + 1; while (j < src.length && isId(src[j])) j++; t.push({ k: 'fmt', v: src.slice(i + 1, j) }); i = j; continue; }
      if (c === '$') { let j = i + 1; while (j < src.length && isId(src[j])) j++; t.push({ k: 'var', v: src.slice(i + 1, j) }); i = j; continue; }
      if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && isId(src[j])) j++; t.push({ k: 'id', v: src.slice(i, j) }); i = j; continue; }
      const two = src.slice(i, i + 2);
      if (['==', '!=', '>=', '<=', '//', '|='].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
      if ('.|,()[]{}:;<>+-*/?'.includes(c)) { t.push({ k: 'op', v: c }); i++; continue; }
      syntax(`unexpected '${c}'`);
    }
    t.push({ k: 'eof' });
    return t;
  }
  function syntax(m) { fail(`jq: error: syntax error, ${m}\njq: 1 compile error`); }

  /* ---------- parser ---------- */
  function parse(src) {
    const T = lex(src); let p = 0;
    const peek = () => T[p];
    const isOp = (v) => T[p].k === 'op' && T[p].v === v;
    const isId = (v) => T[p].k === 'id' && T[p].v === v;
    const expect = (v) => { if (!isOp(v)) syntax(`expected '${v}'`); p++; };

    function pipe() {
      let l = comma();
      if (isId('as')) syntax("'as' bindings aren't supported in this simulator");
      while (isOp('|')) { p++; l = { t: 'pipe', l, r: comma() }; }
      return l;
    }
    function comma() { let l = alt(); while (isOp(',')) { p++; l = { t: 'comma', l, r: alt() }; } return l; }
    function alt() { let l = or(); while (isOp('//')) { p++; l = { t: 'alt', l, r: or() }; } return l; }
    function or() { let l = and(); while (isId('or')) { p++; l = { t: 'bin', op: 'or', l, r: and() }; } return l; }
    function and() { let l = cmp(); while (isId('and')) { p++; l = { t: 'bin', op: 'and', l, r: cmp() }; } return l; }
    function cmp() {
      const l = add();
      if (T[p].k === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(T[p].v)) { const op = T[p++].v; return { t: 'bin', op, l, r: add() }; }
      return l;
    }
    function add() { let l = mul(); while (isOp('+') || isOp('-')) { const op = T[p++].v; l = { t: 'bin', op, l, r: mul() }; } return l; }
    function mul() { let l = post(); while (isOp('*') || isOp('/')) { const op = T[p++].v; l = { t: 'bin', op, l, r: post() }; } return l; }
    function post() {
      let b = prim();
      for (;;) {
        if (peek().k === 'field') { b = { t: 'idx', o: b, k: { t: 'lit', v: T[p++].v } }; continue; }
        if (isOp('.') && T[p + 1].k === 'str') { p++; b = { t: 'idx', o: b, k: { t: 'lit', v: T[p++].v } }; continue; }
        if (isOp('[')) { b = bracket(b); continue; }
        if (isOp('?')) { p++; b = { t: 'try', e: b }; continue; }
        break;
      }
      return b;
    }
    function bracket(b) {
      expect('[');
      if (isOp(']')) { p++; return { t: 'iter', o: b }; }
      if (isOp(':')) { p++; const e = pipe(); expect(']'); return { t: 'slice', o: b, a: null, b: e }; }
      const a = pipe();
      if (isOp(':')) { p++; if (isOp(']')) { p++; return { t: 'slice', o: b, a, b: null }; } const e = pipe(); expect(']'); return { t: 'slice', o: b, a, b: e }; }
      expect(']');
      return { t: 'idx', o: b, k: a };
    }
    function prim() {
      const tk = peek();
      if (tk.k === 'num') { p++; return { t: 'lit', v: tk.v }; }
      if (tk.k === 'str') { p++; return { t: 'lit', v: tk.v }; }
      if (tk.k === 'istr') { p++; return { t: 'interp', parts: tk.v.map((x) => (typeof x === 'string' ? x : parse(x.expr))) }; }
      if (tk.k === 'field') { p++; return { t: 'idx', o: { t: 'id' }, k: { t: 'lit', v: tk.v } }; }
      if (tk.k === 'fmt') { p++; return { t: 'fmt', v: tk.v }; }
      if (tk.k === 'var') syntax('variables aren\'t supported in this simulator');
      if (isOp('..')) { p++; return { t: 'recurse' }; }
      if (isOp('.')) { p++; if (peek().k === 'str') return { t: 'idx', o: { t: 'id' }, k: { t: 'lit', v: T[p++].v } }; return { t: 'id' }; }
      if (isOp('(')) { p++; const e = pipe(); expect(')'); return e; }
      if (isOp('[')) { p++; if (isOp(']')) { p++; return { t: 'arr', e: null }; } const e = pipe(); expect(']'); return { t: 'arr', e }; }
      if (isOp('{')) {
        p++; const ents = [];
        while (!isOp('}')) {
          let key, val;
          if (peek().k === 'id' || peek().k === 'str') { key = { t: 'lit', v: T[p++].v }; }
          else if (peek().k === 'var') syntax('variables aren\'t supported');
          else if (isOp('(')) { p++; key = pipe(); expect(')'); }
          else syntax('bad object key');
          if (isOp(':')) { p++; val = alt(); } else val = { t: 'idx', o: { t: 'id' }, k: key };
          ents.push([key, val]);
          if (isOp(',')) p++; else if (!isOp('}')) syntax("expected ',' or '}'");
        }
        p++; return { t: 'obj', ents };
      }
      if (isOp('-')) { p++; return { t: 'bin', op: '-', l: { t: 'lit', v: 0 }, r: post() }; }
      if (tk.k === 'id') {
        p++;
        if (tk.v === 'true') return { t: 'lit', v: true };
        if (tk.v === 'false') return { t: 'lit', v: false };
        if (tk.v === 'null') return { t: 'lit', v: null };
        if (tk.v === 'if') {
          const c = pipe(); if (!isId('then')) syntax("expected 'then'"); p++;
          const th = pipe(); let el = { t: 'id' };
          if (isId('elif')) syntax("'elif' isn't supported, nest if/else instead");
          if (isId('else')) { p++; el = pipe(); }
          if (!isId('end')) syntax("expected 'end'"); p++;
          return { t: 'if', c, th, el };
        }
        const args = [];
        if (isOp('(')) { p++; args.push(pipe()); while (isOp(';')) { p++; args.push(pipe()); } expect(')'); }
        return { t: 'call', n: tk.v, args };
      }
      if (tk.k === 'eof') syntax('unexpected end of file');
      syntax(`unexpected '${tk.v}'`);
    }
    const ast = pipe();
    if (peek().k !== 'eof') syntax(`unexpected '${peek().v}'`);
    return ast;
  }

  /* ---------- evaluation ---------- */
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
  const order = { null: 0, boolean: 1, number: 3, string: 4, array: 5, object: 6 };
  function cmpv(a, b) {
    const ta = typeOf(a), tb = typeOf(b);
    if (ta !== tb) { const oa = ta === 'boolean' ? (a ? 2 : 1) : order[ta], ob = tb === 'boolean' ? (b ? 2 : 1) : order[tb]; return oa - ob; }
    if (ta === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (ta === 'number') return a - b;
    if (ta === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (ta === 'array') { for (let i = 0; i < Math.min(a.length, b.length); i++) { const r = cmpv(a[i], b[i]); if (r) return r; } return a.length - b.length; }
    if (ta === 'object') return JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
    return 0;
  }
  const truthy = (v) => v !== false && v !== null;
  const tname = (v) => `${typeOf(v)} (${JSON.stringify(v).slice(0, 30)})`;

  function ev(n, x) {
    switch (n.t) {
      case 'id': return [x];
      case 'lit': return [n.v];
      case 'recurse': { const out = []; (function walk(v) { out.push(v); if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(x); return out; }
      case 'idx': return ev(n.o, x).flatMap((o) => ev(n.k, x).map((k) => {
        if (o === null) return null;
        if (typeof k === 'number') { if (!Array.isArray(o)) fail(`jq: error: Cannot index ${typeOf(o)} with number`); return o[k < 0 ? o.length + k : k] ?? null; }
        if (typeof o !== 'object' || Array.isArray(o)) fail(`jq: error: Cannot index ${typeOf(o)} with "${k}"`);
        return o[k] ?? null;
      }));
      case 'slice': return ev(n.o, x).map((o) => {
        if (o === null) return null;
        if (typeof o !== 'string' && !Array.isArray(o)) fail(`jq: error: Cannot index ${typeOf(o)} with object`);
        const a = n.a ? ev(n.a, x)[0] : null, b = n.b ? ev(n.b, x)[0] : null;
        return o.slice(a == null ? 0 : a, b == null ? undefined : b);
      });
      case 'iter': return ev(n.o, x).flatMap((o) => {
        if (Array.isArray(o)) return o;
        if (o && typeof o === 'object') return Object.values(o);
        fail(`jq: error: Cannot iterate over ${tname(o)}`);
      });
      case 'try': try { return ev(n.e, x); } catch (e) { return []; }
      case 'pipe': return ev(n.l, x).flatMap((v) => ev(n.r, v));
      case 'comma': return [...ev(n.l, x), ...ev(n.r, x)];
      case 'alt': { const l = (() => { try { return ev(n.l, x).filter(truthy); } catch (e) { return []; } })(); return l.length ? l : ev(n.r, x); }
      case 'arr': return [n.e ? ev(n.e, x) : []];
      case 'obj': {
        let acc = [{}];
        for (const [kn, vn] of n.ents) {
          const ks = ev(kn, x), vs = ev(vn, x); const next = [];
          acc.forEach((o) => ks.forEach((k) => vs.forEach((v) => next.push({ ...o, [k]: v }))));
          acc = next;
        }
        return acc;
      }
      case 'if': return ev(n.c, x).flatMap((c) => (truthy(c) ? ev(n.th, x) : ev(n.el, x)));
      case 'fmt': return [fmt(n.v, x)];
      case 'interp': return [n.parts.map((pt) => (typeof pt === 'string' ? pt : (() => { const v = ev(pt, x)[0]; return typeof v === 'string' ? v : JSON.stringify(v ?? null); })())).join('')];
      case 'bin': {
        if (n.op === 'and') return ev(n.l, x).flatMap((a) => (!truthy(a) ? [false] : ev(n.r, x).map(truthy)));
        if (n.op === 'or') return ev(n.l, x).flatMap((a) => (truthy(a) ? [true] : ev(n.r, x).map(truthy)));
        const out = [];
        ev(n.r, x).forEach((b) => ev(n.l, x).forEach((a) => out.push(bin(n.op, a, b))));
        return out;
      }
      case 'call': return call(n, x);
    }
    fail('jq: internal error');
  }

  function bin(op, a, b) {
    switch (op) {
      case '==': return cmpv(a, b) === 0 && typeOf(a) === typeOf(b);
      case '!=': return !(cmpv(a, b) === 0 && typeOf(a) === typeOf(b));
      case '<': return cmpv(a, b) < 0; case '>': return cmpv(a, b) > 0;
      case '<=': return cmpv(a, b) <= 0; case '>=': return cmpv(a, b) >= 0;
      case '+':
        if (a === null) return b; if (b === null) return a;
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
        if (typeOf(a) === 'object' && typeOf(b) === 'object') return { ...a, ...b };
        fail(`jq: error: ${tname(a)} and ${tname(b)} cannot be added`);
      case '-':
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (Array.isArray(a) && Array.isArray(b)) return a.filter((v) => !b.some((w) => cmpv(v, w) === 0));
        fail(`jq: error: ${tname(a)} and ${tname(b)} cannot be subtracted`);
      case '*': if (typeof a === 'number' && typeof b === 'number') return a * b; fail(`jq: error: ${tname(a)} and ${tname(b)} cannot be multiplied`);
      case '/':
        if (typeof a === 'number' && typeof b === 'number') { if (b === 0) fail('jq: error: division by zero'); return a / b; }
        if (typeof a === 'string' && typeof b === 'string') return a.split(b);
        fail(`jq: error: ${tname(a)} and ${tname(b)} cannot be divided`);
    }
  }

  function fmt(kind, x) {
    const cell = (v) => (v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
    switch (kind) {
      case 'tsv': if (!Array.isArray(x)) fail(`jq: error: ${tname(x)} cannot be tsv-formatted, only an array can be`); return x.map((v) => cell(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n')).join('\t');
      case 'csv': if (!Array.isArray(x)) fail(`jq: error: ${tname(x)} cannot be csv-formatted, only an array can be`); return x.map((v) => (typeof v === 'string' ? '"' + v.replace(/"/g, '""') + '"' : cell(v))).join(',');
      case 'json': return JSON.stringify(x);
      case 'text': return typeof x === 'string' ? x : JSON.stringify(x);
      case 'base64': return typeof btoa !== 'undefined' ? btoa(String(x)) : Buffer.from(String(x)).toString('base64');
    }
    fail(`jq: error: ${kind} is not a valid format`);
  }

  function arity(n, k) { if (n.args.length !== k) fail(`jq: error: ${n.n}/${n.args.length} is not defined at <top-level>, line 1:\njq: 1 compile error`); }
  function needArr(name, x) { if (!Array.isArray(x)) fail(`jq: error: Cannot ${name} ${tname(x)}${name === 'iterate over' ? '' : ', expected an array'}`); }
  const keyOf = (f, e) => ev(f, e);

  function call(n, x) {
    const A = n.args, f = A[0];
    const one = (k) => arity(n, k);
    switch (n.n) {
      case 'empty': one(0); return [];
      case 'not': one(0); return [!truthy(x)];
      case 'select': one(1); return ev(f, x).filter(truthy).map(() => x);
      case 'map': one(1); needArr('iterate over', x); return [x.flatMap((e) => ev(f, e))];
      case 'map_values': one(1); if (Array.isArray(x)) return [x.map((e) => ev(f, e)[0])]; return [Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ev(f, v)[0]]))];
      case 'length': one(0);
        if (x === null) return [0]; if (typeof x === 'string' || Array.isArray(x)) return [x.length];
        if (typeof x === 'object') return [Object.keys(x).length]; if (typeof x === 'number') return [Math.abs(x)];
        fail(`jq: error: ${tname(x)} has no length`);
      case 'keys': case 'keys_unsorted': one(0); if (Array.isArray(x)) return [x.map((_, i) => i)]; if (typeOf(x) !== 'object') fail(`jq: error: ${tname(x)} has no keys`); return [n.n === 'keys' ? Object.keys(x).sort() : Object.keys(x)];
      case 'has': one(1); return ev(f, x).map((k) => (Array.isArray(x) ? k < x.length : Object.prototype.hasOwnProperty.call(x, k)));
      case 'type': one(0); return [typeOf(x)];
      case 'add': one(0); needArr('add', x); return [x.reduce((a, b) => (a === undefined ? b : bin('+', a, b)), undefined) ?? null];
      case 'sort': one(0); needArr('sort', x); return [x.slice().sort(cmpv)];
      case 'reverse': one(0); if (typeof x === 'string') return [[...x].reverse().join('')]; needArr('reverse', x); return [x.slice().reverse()];
      case 'unique': one(0); needArr('unique', x); return [x.slice().sort(cmpv).filter((v, i, a) => i === 0 || cmpv(v, a[i - 1]) !== 0)];
      case 'sort_by': one(1); needArr('sort', x); return [x.map((e) => [keyOf(f, e), e]).sort((a, b) => cmpv(a[0], b[0])).map((p) => p[1])];
      case 'group_by': one(1); needArr('group', x); {
        const s = x.map((e) => [keyOf(f, e), e]).sort((a, b) => cmpv(a[0], b[0])); const g = [];
        s.forEach((p, i) => { if (i && cmpv(p[0], s[i - 1][0]) === 0) g[g.length - 1].push(p[1]); else g.push([p[1]]); });
        return [g];
      }
      case 'unique_by': one(1); needArr('unique', x); { const s = x.map((e) => [keyOf(f, e), e]).sort((a, b) => cmpv(a[0], b[0])); return [s.filter((p, i) => i === 0 || cmpv(p[0], s[i - 1][0]) !== 0).map((p) => p[1])]; }
      case 'max_by': case 'min_by': one(1); needArr('find max of', x); {
        if (!x.length) return [null];
        let best = x[0], bk = keyOf(f, x[0]);
        for (const e of x.slice(1)) { const k = keyOf(f, e); const c = cmpv(k, bk); if (n.n === 'max_by' ? c >= 0 : c < 0) { best = e; bk = k; } }
        return [best];
      }
      case 'max': case 'min': one(0); needArr('find max of', x); if (!x.length) return [null]; return [x.slice().sort(cmpv)[n.n === 'max' ? x.length - 1 : 0]];
      case 'first': if (A.length) { const r = ev(f, x); return r.length ? [r[0]] : []; } return [Array.isArray(x) ? x[0] ?? null : null];
      case 'last': if (A.length) { const r = ev(f, x); return r.length ? [r[r.length - 1]] : []; } return [Array.isArray(x) ? x[x.length - 1] ?? null : null];
      case 'limit': arity(n, 2); { const k = ev(A[0], x)[0]; return ev(A[1], x).slice(0, k); }
      case 'tostring': one(0); return [typeof x === 'string' ? x : JSON.stringify(x)];
      case 'tonumber': one(0); { const v = typeof x === 'number' ? x : parseFloat(x); if (isNaN(v)) fail(`jq: error: Cannot parse '${x}' as JSON`); return [v]; }
      case 'ascii_downcase': one(0); return [String(x).toLowerCase()];
      case 'ascii_upcase': one(0); return [String(x).toUpperCase()];
      case 'floor': one(0); return [Math.floor(x)];
      case 'round': one(0); return [Math.round(x)];
      case 'test': { const re = ev(f, x)[0]; const fl = A[1] ? ev(A[1], x)[0] : ''; if (typeof x !== 'string') fail(`jq: error: ${tname(x)} cannot be matched, as it is not a string`); return [new RegExp(re, fl.replace(/[^gimsuy]/g, '')).test(x)]; }
      case 'startswith': one(1); if (typeof x !== 'string') fail('jq: error: startswith() requires string inputs'); return ev(f, x).map((s) => x.startsWith(s));
      case 'endswith': one(1); if (typeof x !== 'string') fail('jq: error: endswith() requires string inputs'); return ev(f, x).map((s) => x.endsWith(s));
      case 'contains': one(1); return ev(f, x).map((s) => (typeof x === 'string' ? x.includes(s) : Array.isArray(x) ? s.every((v) => x.some((w) => cmpv(v, w) === 0)) : Object.entries(s).every(([k, v]) => cmpv(x[k], v) === 0)));
      case 'ltrimstr': one(1); return ev(f, x).map((s) => (typeof x === 'string' && x.startsWith(s) ? x.slice(s.length) : x));
      case 'rtrimstr': one(1); return ev(f, x).map((s) => (typeof x === 'string' && x.endsWith(s) ? x.slice(0, -s.length) : x));
      case 'split': one(1); return ev(f, x).map((s) => String(x).split(s));
      case 'join': one(1); needArr('join', x); return ev(f, x).map((s) => x.map((v) => (v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))).join(s));
      case 'to_entries': one(0); return [Object.entries(x).map(([key, value]) => ({ key, value }))];
      case 'from_entries': one(0); return [Object.fromEntries(x.map((e) => [e.key ?? e.name ?? e.k, e.value ?? e.v]))];
      case 'with_entries': one(1); return [Object.fromEntries(Object.entries(x).map(([key, value]) => ev(f, { key, value })[0]).map((e) => [e.key, e.value]))];
      case 'any': one(0); needArr('iterate over', x); return [x.some(truthy)];
      case 'all': one(0); needArr('iterate over', x); return [x.every(truthy)];
      case 'values': one(0); return x === null ? [] : [x];
      case 'tojson': one(0); return [JSON.stringify(x)];
      case 'fromjson': one(0); return [JSON.parse(x)];
      case 'fromdate': case 'fromdateiso8601': one(0); return [Math.floor(Date.parse(x) / 1000)];
      case 'todate': one(0); return [new Date(x * 1000).toISOString().replace(/\.\d+Z$/, 'Z')];
    }
    fail(`jq: error: ${n.n}/${A.length} is not defined at <top-level>, line 1:\njq: 1 compile error`);
  }

  /* ---------- CLI ---------- */
  Lab.jq = function (argv, input, sc) {
    let raw = false, compact = false, slurp = false, nul = false, filter = null; const files = [];
    for (let k = 1; k < argv.length; k++) {
      const t = argv[k];
      if (t === '--raw-output') { raw = true; continue; }
      if (t === '--compact-output') { compact = true; continue; }
      if (t === '--slurp') { slurp = true; continue; }
      if (t === '--null-input') { nul = true; continue; }
      if (/^-[rcsnMCSej]+$/.test(t)) { for (const f of t.slice(1)) { if (f === 'r' || f === 'j') raw = true; if (f === 'c') compact = true; if (f === 's') slurp = true; if (f === 'n') nul = true; } continue; }
      if (t === '--arg' || t === '--argjson') fail('jq: --arg isn\'t supported in this simulator. Put the value directly in the filter.');
      if (filter == null) filter = t; else files.push(t);
    }
    if (filter == null) filter = '.';
    const ast = parse(filter);
    let inputs;
    if (nul) inputs = [null];
    else {
      let text;
      if (files.length) text = files.map((f) => { const c = sc.readFile(f); if (c == null) fail(`jq: error: Could not open ${f}: No such file or directory`); return c; }).join('\n');
      else if (input != null) text = input;
      else fail('jq: reading from the terminal isn\'t supported here. Give it a file or pipe something in.');
      inputs = parseStream(text);
      if (slurp) inputs = [inputs];
    }
    const out = [];
    for (const v of inputs) for (const r of ev(ast, v)) out.push(raw && typeof r === 'string' ? r : JSON.stringify(r, null, compact ? 0 : 2));
    return out.join('\n');
  };

  function parseStream(text) {
    const t = text.trim(); if (!t) return [];
    try { return [JSON.parse(t)]; } catch (e) { /* fall through to line mode */ }
    return t.split('\n').filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch (e) { fail(`jq: error (at <stdin>:${i + 1}): Cannot parse input as JSON: "${l.slice(0, 40)}..."\n(Tip: jq needs JSON input. Use grep/awk for plain text.)`); }
    });
  }
  Lab.jqEval = (filter, value) => ev(parse(filter), value);
})(typeof window !== 'undefined' ? window : globalThis);
