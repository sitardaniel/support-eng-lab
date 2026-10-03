/* shell.js - tiny shell: tokenizer, pipes, text tools, mini jq.
   Scenarios plug in a handler for everything else. */
(function (G) {
  const Lab = (G.Lab = G.Lab || {});

  class ShellError extends Error {}
  Lab.ShellError = ShellError;
  const fail = (m) => { throw new ShellError(m); };

  /* ---------- parsing ---------- */
  function splitTop(s, kind) {
    // kind 'seq' splits on ; and &&, kind 'pipe' splits on single |
    const out = []; let cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (kind === 'seq') {
        if (ch === ';') { out.push(cur); cur = ''; continue; }
        if (ch === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
      } else if (ch === '|') {
        if (s[i + 1] === '|') { cur += '||'; i++; continue; }
        out.push(cur); cur = ''; continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter((x) => x.length);
  }

  function tokenize(s) {
    const out = []; let cur = '', q = null, has = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) q = null;
        else if (ch === '\\' && q === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) cur += s[++i];
        else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
      if (ch === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
      if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
      cur += ch;
    }
    if (q) fail('bash: unexpected EOF while looking for matching `' + q + "'");
    if (cur || has) out.push(cur);
    return out;
  }

  function normalize(argv) {
    argv = argv.slice();
    // drop redirections like 2>/dev/null, 2>&1, >/dev/null
    argv = argv.filter((t, i) => !/^\d?>(&\d|\/dev\/null)$/.test(t) && !/^&>/.test(t));
    while (argv[0] === 'sudo' || argv[0] === 'time' || argv[0] === 'command') argv.shift();
    if (argv[0] === 'k3s' && ['kubectl', 'crictl', 'ctr'].includes(argv[1])) argv.shift();
    if (argv[0] === 'k') argv[0] = 'kubectl';
    if (argv[0] === 'less' || argv[0] === 'more') argv[0] = 'cat';
    return argv;
  }

  /* ---------- text tools ---------- */
  function lines(t) { if (t == null || t === '') return []; const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; }

  function readInput(files, input, sc, tool) {
    if (files.length) {
      return files.map((f) => {
        const c = sc.readFile(f);
        if (c == null) fail(`${tool}: ${f}: No such file or directory`);
        return c;
      }).join('\n');
    }
    if (input == null) fail(`${tool}: reading from the terminal isn't supported here. Give it a file or pipe something in.`);
    return input;
  }

  function toRegex(p, flags, fixed) {
    if (fixed) p = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else p = p.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+').replace(/\\\?/g, '?');
    try { return new RegExp(p, flags); } catch (e) { fail('grep: Invalid regular expression'); }
  }

  const tools = {};

  tools.cat = (a, input, sc) => readInput(a.slice(1).filter((x) => !x.startsWith('-')), input, sc, 'cat');

  tools.grep = (a, input, sc) => {
    let v = false, c = false, i = false, o = false, F = false, n = false, A = 0, B = 0, pat = null;
    const files = [];
    for (let k = 1; k < a.length; k++) {
      const t = a[k];
      if (t === '-e') { pat = a[++k]; continue; }
      if (/^-[ABC]$/.test(t)) { const val = +a[++k]; if (t !== '-B') A = val; if (t !== '-A') B = val; continue; }
      const m = t.match(/^-([ABC])(\d+)$/);
      if (m) { if (m[1] !== 'B') A = +m[2]; if (m[1] !== 'A') B = +m[2]; continue; }
      if (t === '--color=never' || t === '--color' || t === '-r' || t === '-R' || t === '-h' || t === '-s') continue;
      if (/^-[vciEoFnwP]+$/.test(t)) {
        for (const f of t.slice(1)) { if (f === 'v') v = true; if (f === 'c') c = true; if (f === 'i') i = true; if (f === 'o') o = true; if (f === 'F') F = true; if (f === 'n') n = true; }
        continue;
      }
      if (pat == null) pat = t; else files.push(t);
    }
    if (pat == null) fail('Usage: grep [OPTION]... PATTERNS [FILE]...');
    const re = toRegex(pat, i ? 'i' : '', F);
    const L = lines(readInput(files, input, sc, 'grep'));
    const hit = L.map((l) => re.test(l) !== v);
    if (c) return String(hit.filter(Boolean).length);
    if (o && !v) {
      const g = toRegex(pat, i ? 'gi' : 'g', F); const out = [];
      L.forEach((l) => { const ms = l.match(g); if (ms) out.push(...ms); });
      return out.join('\n');
    }
    if (!A && !B) return L.filter((_, k) => hit[k]).map((l) => (n ? (L.indexOf(l) + 1) + ':' : '') + l).join('\n');
    const keep = new Set();
    hit.forEach((h, k) => { if (h) for (let j = Math.max(0, k - B); j <= Math.min(L.length - 1, k + A); j++) keep.add(j); });
    const idx = [...keep].sort((x, y) => x - y); const out = [];
    idx.forEach((k, j) => { if (j && k !== idx[j - 1] + 1) out.push('--'); out.push(L[k]); });
    return out.join('\n');
  };
  tools.egrep = (a, input, sc) => tools.grep(['grep', '-E', ...a.slice(1)], input, sc);

  function headTail(which) {
    return (a, input, sc) => {
      let n = 10; const files = [];
      for (let k = 1; k < a.length; k++) {
        const t = a[k];
        if (t === '-n') { n = parseInt(a[++k], 10); continue; }
        if (/^-n-?\d+$/.test(t)) { n = parseInt(t.slice(2), 10); continue; }
        if (/^-\d+$/.test(t)) { n = parseInt(t.slice(1), 10); continue; }
        if (t === '-f' || t === '-F') continue;
        files.push(t);
      }
      const L = lines(readInput(files, input, sc, which));
      return (which === 'head' ? L.slice(0, n) : L.slice(Math.max(0, L.length - n))).join('\n');
    };
  }
  tools.head = headTail('head');
  tools.tail = headTail('tail');

  function human(s) { const m = String(s).trim().match(/^([\d.]+)([KMGT]?)/i); if (!m) return 0; return parseFloat(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()]); }

  tools.sort = (a, input, sc) => {
    let num = false, rev = false, uniq = false, hum = false, key = 0, sep = null; const files = [];
    for (let k = 1; k < a.length; k++) {
      const t = a[k];
      if (t === '-k') { key = parseInt(a[++k], 10); continue; }
      if (/^-k\d+/.test(t)) { key = parseInt(t.slice(2), 10); continue; }
      if (t === '-t') { sep = a[++k]; continue; }
      if (/^-t./.test(t)) { sep = t.slice(2); continue; }
      if (/^-[nruhV]+$/.test(t)) { for (const f of t.slice(1)) { if (f === 'n') num = true; if (f === 'r') rev = true; if (f === 'u') uniq = true; if (f === 'h') hum = true; } continue; }
      files.push(t);
    }
    let L = lines(readInput(files, input, sc, 'sort'));
    const kf = (l) => { if (!key) return l; const p = sep ? l.split(sep) : l.trim().split(/\s+/); return p.slice(key - 1).join(sep || ' '); };
    L.sort((x, y) => {
      const kx = kf(x), ky = kf(y); let r;
      if (hum) r = human(kx) - human(ky);
      else if (num) r = (parseFloat(kx) || 0) - (parseFloat(ky) || 0);
      else r = kx < ky ? -1 : kx > ky ? 1 : 0;
      if (r === 0 && (num || hum)) r = x < y ? -1 : x > y ? 1 : 0;
      return rev ? -r : r;
    });
    if (uniq) L = L.filter((l, k) => k === 0 || l !== L[k - 1]);
    return L.join('\n');
  };

  tools.uniq = (a, input, sc) => {
    const c = a.includes('-c'); const files = a.slice(1).filter((x) => !x.startsWith('-'));
    const L = lines(readInput(files, input, sc, 'uniq')); const out = [];
    for (const l of L) { const last = out[out.length - 1]; if (last && last[0] === l) last[1]++; else out.push([l, 1]); }
    return out.map(([l, n]) => (c ? String(n).padStart(7) + ' ' : '') + l).join('\n');
  };

  tools.wc = (a, input, sc) => {
    const files = a.slice(1).filter((x) => !x.startsWith('-'));
    const t = readInput(files, input, sc, 'wc'); const L = lines(t);
    if (a.includes('-l')) return String(L.length) + (files.length ? ' ' + files[0] : '');
    if (a.includes('-c')) return String(t.length);
    const w = t.split(/\s+/).filter(Boolean).length;
    return `${String(L.length).padStart(7)} ${String(w).padStart(7)} ${String(t.length).padStart(7)}`;
  };

  tools.cut = (a, input, sc) => {
    let d = '\t', f = null; const files = [];
    for (let k = 1; k < a.length; k++) {
      const t = a[k];
      if (t === '-d') { d = a[++k]; continue; } if (t.startsWith('-d')) { d = t.slice(2); continue; }
      if (t === '-f') { f = a[++k]; continue; } if (t.startsWith('-f')) { f = t.slice(2); continue; }
      if (t === '-c') { f = 'c' + a[++k]; continue; } if (t.startsWith('-c')) { f = 'c' + t.slice(2); continue; }
      files.push(t);
    }
    if (!f) fail('cut: you must specify a list of bytes, characters, or fields');
    const L = lines(readInput(files, input, sc, 'cut'));
    if (f.startsWith('c')) { const [s, e] = f.slice(1).split('-').map((x) => (x ? +x : null)); return L.map((l) => l.slice((s || 1) - 1, e == null ? undefined : e)).join('\n'); }
    const idx = []; f.split(',').forEach((p) => { const [s, e] = p.split('-'); if (e === undefined) idx.push(+s); else for (let k = +s || 1; k <= (e ? +e : 50); k++) idx.push(k); });
    return L.map((l) => { const p = l.split(d); return idx.filter((k) => k <= p.length).map((k) => p[k - 1]).join(d); }).join('\n');
  };

  tools.awk = (a, input, sc) => {
    let F = null, prog = null; const files = [];
    for (let k = 1; k < a.length; k++) {
      const t = a[k];
      if (t === '-F') { F = a[++k]; continue; } if (t.startsWith('-F')) { F = t.slice(2); continue; }
      if (prog == null) prog = t; else files.push(t);
    }
    if (prog == null) fail('usage: awk [-F fs] \'program\' [file ...]');
    if (F === '\\t') F = '\t';
    const m = prog.trim().match(/^(.*?)\s*(\{\s*print\s*(.*?)\s*;?\s*\})?\s*$/s);
    const cond = (m[1] || '').trim(); const act = m[2] ? (m[3] || '').trim() : null;
    if (/END|BEGIN|\+=|printf/.test(prog)) fail('awk: this simulator supports conditions like \'$2>1000\' and actions like \'{print $1, $3}\'. Try sort/uniq -c for counting.');
    const L = lines(readInput(files, input, sc, 'awk'));
    const fieldsOf = (l) => (F ? l.split(F) : l.trim().split(/\s+/));
    const val = (expr, fs, l, nr) => {
      expr = expr.trim();
      if (expr === '$0') return l;
      if (expr === 'NR') return nr;
      if (expr === 'NF') return fs.length;
      if (expr === '$NF') return fs[fs.length - 1];
      let mm = expr.match(/^\$(\d+)$/); if (mm) return +mm[1] === 0 ? l : fs[+mm[1] - 1] ?? '';
      mm = expr.match(/^"(.*)"$/); if (mm) return mm[1];
      if (!isNaN(+expr)) return +expr;
      fail('awk: unsupported expression: ' + expr);
    };
    const test = (fs, l, nr) => {
      if (!cond) return true;
      let mm = cond.match(/^\/(.*)\/$/); if (mm) return new RegExp(mm[1]).test(l);
      mm = cond.match(/^(\S+?)\s*(==|!=|>=|<=|>|<|~)\s*(.+)$/);
      if (!mm) fail('awk: unsupported condition: ' + cond);
      let x = val(mm[1], fs, l, nr); const op = mm[2];
      if (op === '~') return new RegExp(mm[3].replace(/^\/|\/$/g, '')).test(String(x));
      let y = val(mm[3], fs, l, nr);
      const numeric = !isNaN(parseFloat(x)) && !isNaN(parseFloat(y)) && typeof y === 'number';
      if (numeric) { x = parseFloat(x); }
      switch (op) { case '==': return x == y; case '!=': return x != y; case '>': return x > y; case '<': return x < y; case '>=': return x >= y; case '<=': return x <= y; }
    };
    const out = [];
    L.forEach((l, k) => {
      const fs = fieldsOf(l);
      if (!test(fs, l, k + 1)) return;
      if (act == null || act === '' || act === '$0') { out.push(l); return; }
      out.push(act.split(',').map((e) => val(e, fs, l, k + 1)).join(' '));
    });
    return out.join('\n');
  };

  tools.sed = (a, input, sc) => {
    let quiet = false, prog = null; const files = [];
    for (let k = 1; k < a.length; k++) { const t = a[k]; if (t === '-n') { quiet = true; continue; } if (t === '-E' || t === '-r') continue; if (prog == null) prog = t; else files.push(t); }
    const L = lines(readInput(files, input, sc, 'sed'));
    let m = prog && prog.match(/^(\$|\d+)(?:,(\$|\d+))?p$/);
    if (m && quiet) {
      const n = (x) => (x === '$' ? L.length : +x); const s0 = n(m[1]), e0 = m[2] ? n(m[2]) : s0;
      return L.slice(s0 - 1, e0).join('\n');
    }
    m = prog && prog.match(/^s(.)(.*?)\1(.*?)\1(g?)$/);
    if (m) { const re = new RegExp(m[2], m[4]); return L.map((l) => l.replace(re, m[3].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'))).join('\n'); }
    fail("sed: this simulator supports 'sed -n 5p', 'sed -n 1,10p' and 's/old/new/g'");
  };

  tools.jq = (a, input, sc) => Lab.jq(a, input, sc);
  Lab.textTools = tools;

  /* ---------- runner ---------- */
  Lab.run = function (line, sc) {
    const outs = [];
    for (const part of splitTop(line, 'seq')) {
      try {
        const r = runPipeline(part, sc);
        if (r != null && r !== '') outs.push(r);
      } catch (e) {
        if (e instanceof ShellError) { outs.push(e.message); break; }
        throw e;
      }
    }
    return outs.join('\n');
  };

  function runPipeline(p, sc) {
    const stages = splitTop(p, 'pipe');
    let text = null;
    for (let i = 0; i < stages.length; i++) {
      const argv = normalize(tokenize(stages[i]));
      if (!argv.length) continue;
      const cmd = argv[0];
      if (i === 0) {
        const r = sc.exec(argv, stages[i]);
        if (r !== undefined) { text = r; continue; }
        if (tools[cmd]) { text = tools[cmd](argv, null, sc); continue; }
        fail(`${cmd}: command not found in this scenario. Type 'help' to see what works here.`);
      } else {
        if (tools[cmd]) { text = tools[cmd](argv, text == null ? '' : text, sc); continue; }
        fail(`${cmd}: can't be used in a pipe here. Supported: ${Object.keys(tools).join(', ')}`);
      }
    }
    return text;
  }

  Lab.tokenize = tokenize;
  Lab.table = function (rows, gap = 3) {
    const w = [];
    rows.forEach((r) => r.forEach((c, i) => (w[i] = Math.max(w[i] || 0, String(c).length))));
    return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i] + gap))).join('').replace(/\s+$/, '')).join('\n');
  };
})(typeof window !== 'undefined' ? window : globalThis);
