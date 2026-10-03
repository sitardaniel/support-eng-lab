/* app.js - page rendering, routing, terminals, progress. */
(function () {
  const REPO = 'sitardaniel/support-eng-lab';
  const CS_URL = `https://codespaces.new/${REPO}?quickstart=1`;
  const GH_URL = `https://github.com/${REPO}`;
  const MAX_LINES = 2000;
  const app = document.getElementById('app');

  /* ---------- storage (per-browser convenience only) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sel:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sel:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  let solved = store.get('solved', {});
  const markSolved = (id) => { solved[id] = true; store.set('solved', solved); };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const pills = (t) => `<span class="pill ${t.pri}">${esc(t.priLabel || t.pri)}</span>` + (t.tags || []).map((g) => `<span class="pill">${esc(g)}</span>`).join('');

  /* ---------- home ---------- */
  function renderHome() {
    document.title = 'Support Engineer Lab';
    const total = Lab.tickets.length; const done = Lab.tickets.filter((t) => solved[t.id]).length;
    const days = Lab.DAYS.map((d) => {
      const rows = Lab.tickets.filter((t) => t.day === d.n).map((t) => `
        <a class="trow ${solved[t.id] ? 'done' : ''}" href="#t${t.id}">
          <span class="tid">#${t.id}</span>
          <span class="t"><b>${esc(t.title)}</b><span class="meta">${pills(t)}${t.sim ? '<span class="pill">terminal</span>' : ''}</span></span>
          <span class="state ${solved[t.id] ? 'solved' : 'open'}">${solved[t.id] ? 'Solved' : 'Open'}</span>
        </a>`).join('');
      return `<section class="day" id="day${d.n}"><div class="dayhead"><span class="eyebrow">Day ${d.n}</span><h2>${esc(d.title)}</h2><p>${esc(d.blurb)}</p></div><div class="tlist">${rows}</div></section>`;
    }).join('');
    app.innerHTML = `
      <header class="top">
        <span class="eyebrow">Customer technical support · practice lab</span>
        <h1>Support Engineer Lab</h1>
        <p class="lede">Break-and-fix tickets from a product that runs on Kubernetes inside customers' closed, air-gapped networks. Every ticket has a working terminal right here in the browser. When you want the real thing, open the Codespace for an actual air-gapped k3s cluster.</p>
        <div class="actions">
          <a class="btn primary" href="${CS_URL}" target="_blank" rel="noopener">Open in Codespaces</a>
          <a class="btn" href="${GH_URL}" target="_blank" rel="noopener">View on GitHub</a>
        </div>
        <div class="progress"><div class="bar"><i style="width:${(100 * done) / total}%"></i></div><span class="count">${done} of ${total} solved</span></div>
        <div class="rule"><strong>The one rule for every ticket</strong><p>You already know how to fix these. The new skill is fixing them through someone else's hands. After each fix, write the exact message you'd send a customer who won't give you access: what to run, what to paste back, and why.</p></div>
      </header>
      ${days}
      <footer class="foot"><span>Progress and drafts are saved in this browser only.</span><span>Terminal is a simulator: it knows the commands each ticket needs, not all of Linux. Type <code>help</code> in any terminal.</span></footer>`;
  }

  /* ---------- terminal ---------- */
  function mountTerminal(t, host, ctx) {
    const box = el(`<div class="term">
      <div class="term-bar"><span>${esc(t.sim.prompt.split(':')[0])}</span><span class="sp"></span><button type="button" data-a="help">help</button><button type="button" data-a="reset">Reset</button></div>
      <div class="term-out" role="log" aria-live="polite"></div>
      <div class="term-in"><span class="pr"></span><input id="term-${t.id}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Terminal input"></div>
    </div>`);
    host.appendChild(box);
    const out = box.querySelector('.term-out'); const inp = box.querySelector('input'); const pr = box.querySelector('.term-in .pr');
    let hist = store.get('hist:' + t.id, []); let hi = hist.length;
    let st = null;
    const sc = {
      exec: (a, raw) => t.sim.exec(a, st, raw),
      readFile: (f) => (st.files && Object.prototype.hasOwnProperty.call(st.files, f.replace(/^\.\//, '')) ? st.files[f.replace(/^\.\//, '')] : null),
      get files() { return st.files; },
      get cwd() { return st.cwd; }, set cwd(v) { st.cwd = v; },
    };
    function print(text, cls) {
      let lines = String(text).split('\n');
      if (lines.length > MAX_LINES) lines = lines.slice(0, MAX_LINES).concat(`... output cut at ${MAX_LINES.toLocaleString()} lines. On a real bundle you'd pipe to head, wc -l or grep.`);
      const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = lines.join('\n');
      out.appendChild(d); out.scrollTop = out.scrollHeight;
    }
    function echo(line) {
      const d = document.createElement('div'); d.className = 'cmd';
      const p = document.createElement('span'); p.className = 'pr'; p.textContent = t.sim.prompt + ' ';
      d.appendChild(p); d.appendChild(document.createTextNode(line)); out.appendChild(d);
    }
    function reset(note) {
      if (t.sim.needsBundle && !Lab.bundle) {
        out.innerHTML = ''; print('Loading bundle.jsonl ...', 'sys');
        fetch('lab/data/bundle.jsonl').then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then((txt) => { Lab.bundle = txt; reset(note); })
          .catch(() => print('Couldn\'t load bundle.jsonl. Reload the page to try again.', 'err'));
        return;
      }
      st = t.sim.setup(); ctx.st = st; ctx.fixed = t.requireFix ? !!t.sim.fixed(st) : true; ctx.wasFixed = false;
      pr.textContent = t.sim.prompt;
      out.innerHTML = '';
      print((note ? note + '\n' : '') + `Ticket #${t.id}. Type help for what works here, hint for a nudge.`, 'sys');
      ctx.onState && ctx.onState();
    }
    function run(line) {
      echo(line);
      const cmd = line.trim();
      if (!cmd) return;
      hist = hist.filter((h) => h !== cmd).concat(cmd).slice(-60); hi = hist.length; store.set('hist:' + t.id, hist);
      if (cmd === 'clear') { out.innerHTML = ''; return; }
      if (cmd === 'help') { print(t.sim.help + '\nlab: hint, clear, reset, history', 'sys'); return; }
      if (cmd === 'reset') { reset(t.id === '403' ? 'New random fault injected.' : 'Scenario reset.'); return; }
      if (cmd === 'history') { print(hist.map((h, i) => String(i + 1).padStart(4) + '  ' + h).join('\n')); return; }
      if (cmd === 'hint') { ctx.nextHint ? print(ctx.nextHint(), 'sys') : print('No hints for this one.', 'sys'); return; }
      if (cmd === 'exit' || cmd === 'logout') { print('(There\'s nowhere to go. You\'re on the customer\'s box until the ticket is closed.)', 'sys'); return; }
      let res;
      try { res = Lab.run(cmd, sc); } catch (e) { res = 'simulator error: ' + e.message + '\n(This is a bug in the lab, not in your command. Try another way.)'; console.error(e); }
      if (res) print(res);
      if (t.requireFix) {
        const now = !!t.sim.fixed(st); ctx.fixed = now;
        if (now && !ctx.wasFixed) { ctx.wasFixed = true; print('Customer update: "It works now, thank you." Close the ticket below.', 'ok'); }
        ctx.onState && ctx.onState();
      }
    }
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = inp.value; inp.value = ''; run(v); }
      else if (e.key === 'ArrowUp') { if (hi > 0) { hi--; inp.value = hist[hi]; } e.preventDefault(); }
      else if (e.key === 'ArrowDown') { if (hi < hist.length) { hi++; inp.value = hist[hi] || ''; } e.preventDefault(); }
      else if (e.key === 'l' && e.ctrlKey) { out.innerHTML = ''; e.preventDefault(); }
    });
    box.querySelector('[data-a=help]').addEventListener('click', () => { run('help'); inp.focus(); });
    box.querySelector('[data-a=reset]').addEventListener('click', () => { run('reset'); inp.focus(); });
    out.addEventListener('mouseup', () => { if (!String(window.getSelection())) inp.focus({ preventScroll: true }); });
    ctx.paste = (text) => { inp.value = text; inp.focus(); };
    reset();
  }

  /* ---------- check (close the ticket) ---------- */
  function renderCheck(t, host, ctx, onSolved) {
    const c = t.check; const name = 'q' + t.id;
    let body = '';
    if (c.type === 'choice' || c.type === 'multi') {
      body = c.options.map((o, i) => `<label class="opt"><input type="${c.type === 'choice' ? 'radio' : 'checkbox'}" name="${name}" id="${name}-${i}" value="${i}"><span>${esc(o)}</span></label>`).join('');
    } else if (c.type === 'match') {
      body = c.rows.map((r, i) => `<div class="mrow"><label for="${name}-${i}"><b>${esc(r)}</b></label><select id="${name}-${i}"><option value="">Choose...</option>${c.options.map((o, j) => `<option value="${j}">${esc(o)}</option>`).join('')}</select></div>`).join('');
    } else if (c.type === 'form') {
      body = c.fields.map((f, i) => `<div class="field"><label for="${name}-${i}">${esc(f.label)}</label>${f.select ? `<select id="${name}-${i}"><option value="">Choose...</option>${f.select.map((o, j) => `<option value="${j}">${esc(o)}</option>`).join('')}</select>` : `<input id="${name}-${i}" autocomplete="off">`}</div>`).join('');
    }
    const p = el(`<section class="panel check"><span class="label j">Close the ticket</span><p><b>${esc(c.q)}</b></p>${body}<div><button class="btn primary small" type="button">Submit</button></div><div class="verdict" hidden></div></section>`);
    host.appendChild(p);
    const v = p.querySelector('.verdict');
    const say = (cls, text) => { v.hidden = false; v.className = 'verdict ' + cls; v.textContent = text; };
    p.querySelector('button').addEventListener('click', () => {
      let ok = false;
      const ans = typeof c.answer === 'function' ? c.answer(ctx.st) : c.answer;
      if (c.type === 'choice') { const s = p.querySelector('input:checked'); if (!s) return say('wait', 'Pick an answer first.'); ok = +s.value === ans; }
      if (c.type === 'multi') { const s = [...p.querySelectorAll('input:checked')].map((x) => +x.value).sort(); if (!s.length) return say('wait', 'Pick at least one.'); ok = JSON.stringify(s) === JSON.stringify(ans.slice().sort()); if (!ok && s.length !== ans.length) return say('bad', `Not quite. There are exactly ${ans.length} real problems.`); }
      if (c.type === 'match') { const s = c.rows.map((_, i) => p.querySelector(`#${name}-${i}`).value); if (s.includes('')) return say('wait', 'Match every site first.'); ok = s.every((x, i) => +x === ans[i]); }
      if (c.type === 'form') {
        const wrong = c.fields.filter((f, i) => { const raw = p.querySelector(`#${name}-${i}`).value; return (f.norm ? f.norm(raw) : raw.trim()) !== f.answer; });
        ok = !wrong.length;
        if (!ok) return say('bad', `${wrong.length} of ${c.fields.length} don't match the data yet: ${wrong.map((f) => f.label.split(' (')[0].toLowerCase()).join(', ')}.`);
      }
      if (!ok) return say('bad', 'Not quite. Go back to the evidence.');
      if (t.requireFix && !ctx.fixed) return say('wait', 'Right diagnosis. The customer still sees the problem though. Fix it in the terminal, then submit again.');
      say('good', 'Correct. Ticket closed.');
      onSolved();
    });
  }

  /* ---------- ticket page ---------- */
  function renderTicket(t) {
    document.title = `#${t.id} ${t.title} · Support Engineer Lab`;
    const idx = Lab.tickets.indexOf(t); const next = Lab.tickets[idx + 1];
    const ctx = {};
    app.innerHTML = '';
    const page = el(`<article class="ticket">
      <a class="back" href="#">← All tickets</a>
      <div class="thead"><div class="row"><span class="tid">#${t.id}</span><span class="meta">${pills(t)}</span><span class="state ${solved[t.id] ? 'solved' : 'open'}" id="st">${solved[t.id] ? 'Solved' : 'Open'}</span></div><h2>${esc(t.title)}</h2></div>
    </article>`);
    app.appendChild(page);
    const add = (html) => { const n = el(html); page.appendChild(n); return n; };
    const setSolved = () => { markSolved(t.id); const s = page.querySelector('#st'); s.className = 'state solved'; s.textContent = 'Solved'; unlockResolution(); };

    if (t.customer) add(`<div class="msg"><div class="from">From customer</div><p>${esc(t.customer)}</p></div>`);
    add(`<section class="panel"><span class="label j">Your job</span><p>${t.task}</p>${t.codespace ? `<p class="cs muted">Real cluster: <code>${esc(t.codespace)}</code> in the <a href="${CS_URL}" target="_blank" rel="noopener">Codespace</a></p>` : ''}${t.browserOnly ? '<p class="muted">Browser only. Filling a real disk would take the Codespace down with it.</p>' : ''}</section>`);

    if (t.kind === 'setup') {
      add(`<section class="panel"><ol class="steps">${t.steps.map(([h, b]) => `<li><div><b>${esc(h)}</b><p>${b}</p></div></li>`).join('')}</ol><div class="actions"><a class="btn primary" href="${CS_URL}" target="_blank" rel="noopener">Open in Codespaces</a><button class="btn" type="button" id="done">Mark done</button></div></section>`)
        .querySelector('#done').addEventListener('click', setSolved);
    }

    if (t.sim) mountTerminal(t, page, ctx);

    if (t.hints) {
      const hp = add(`<section class="panel"><span class="label">Hints</span><div class="hints"></div><div><button class="btn small" type="button">Show a hint</button></div></section>`);
      const list = hp.querySelector('.hints'); const btn = hp.querySelector('button'); let shown = 0;
      const reveal = () => {
        if (shown >= t.hints.length) return 'No more hints. You have everything you need.';
        const h = el(`<div class="hint">${t.hints[shown]}</div>`);
        h.querySelectorAll('code').forEach((c) => { c.style.cursor = 'pointer'; c.title = 'Click to put this in the terminal'; c.addEventListener('click', () => ctx.paste && ctx.paste(c.textContent)); });
        list.appendChild(h); shown++;
        btn.textContent = shown >= t.hints.length ? 'All hints shown' : `Show hint ${shown + 1} of ${t.hints.length}`;
        btn.disabled = shown >= t.hints.length;
        return 'Hint: ' + h.textContent;
      };
      btn.addEventListener('click', reveal);
      ctx.nextHint = reveal;
    }

    if (t.check) renderCheck(t, page, ctx, setSolved);

    if (t.kind === 'cards') {
      const cp = add(`<section class="panel"><span class="label j">Tap a card to flip it</span><div class="cards">${t.cards.map(([q, a]) => `<button type="button" class="card"><b>${esc(q)}</b><div class="a">${a}</div></button>`).join('')}</div><div><button class="btn small" type="button" id="done">Mark done</button></div></section>`);
      cp.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => c.classList.toggle('flipped')));
      cp.querySelector('#done').addEventListener('click', setSolved);
    }

    if (t.kind === 'write') {
      const key = 'draft:' + t.id; const checks = store.get('checks:' + t.id, {});
      const wp = add(`<section class="panel"><span class="label j">Your draft</span>
        <textarea id="draft-${t.id}" placeholder="Write it like you'd send it.">${esc(store.get(key, ''))}</textarea><span class="saved" aria-live="polite"></span>
        <span class="label">Check your draft against this</span><div class="checklist">${t.checklist.map((c, i) => `<label><input type="checkbox" id="ck-${t.id}-${i}" ${checks[i] ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}</div>
        <div class="actions"><button class="btn small" type="button" id="ex">Show ${t.reference ? 'the reference version' : 'an example'}</button><button class="btn primary small" type="button" id="done">Mark done</button></div>
        <div class="ref" hidden><pre></pre></div></section>`);
      const ta = wp.querySelector('textarea'); const sv = wp.querySelector('.saved'); let tm;
      ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { store.set(key, ta.value); sv.textContent = 'Saved in this browser'; }, 400); });
      wp.querySelectorAll('.checklist input').forEach((b, i) => b.addEventListener('change', () => { checks[i] = b.checked; store.set('checks:' + t.id, checks); }));
      wp.querySelector('#ex').addEventListener('click', (e) => { const r = wp.querySelector('.ref'); r.hidden = !r.hidden; r.querySelector('pre').textContent = t.reference || t.example; e.target.textContent = r.hidden ? (t.reference ? 'Show the reference version' : 'Show an example') : 'Hide'; });
      wp.querySelector('#done').addEventListener('click', () => { if (!ta.value.trim()) { sv.textContent = 'Write something first. The writing is the exercise.'; return; } setSolved(); sv.textContent = 'Marked done.'; });
      if (t.codespace) add(`<p class="muted">${esc(t.codespace)}</p>`);
    }

    let unlockResolution = () => {};
    if (t.resolution) {
      const rp = add(`<section class="panel"><span class="label f">Resolution</span><div class="body"></div></section>`);
      const body = rp.querySelector('.body');
      unlockResolution = () => { body.innerHTML = t.resolution; };
      if (solved[t.id]) unlockResolution();
      else {
        body.innerHTML = '<p class="locked">Unlocks when you close the ticket.</p><div style="margin-top:8px"><button class="btn small" type="button">Show it anyway</button></div>';
        body.querySelector('button').addEventListener('click', unlockResolution);
      }
    }

    if (t.twist) {
      const key = 'twist:' + t.id;
      const tp = add(`<section class="panel"><span class="label r">Remote-hands twist</span><p>${t.twist}</p><textarea id="twist-${t.id}" placeholder="Your message to the customer">${esc(store.get(key, ''))}</textarea><span class="saved" aria-live="polite"></span></section>`);
      const ta = tp.querySelector('textarea'); const sv = tp.querySelector('.saved'); let tm;
      ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { store.set(key, ta.value); sv.textContent = 'Saved in this browser'; }, 400); });
    }

    add(`<nav class="actions" style="justify-content:space-between"><a class="btn small" href="#">All tickets</a>${next ? `<a class="btn small" href="#t${next.id}">Next: #${next.id} ${esc(next.title)} →</a>` : ''}</nav>`);
    window.scrollTo(0, 0);
  }

  /* ---------- routing ---------- */
  function route() {
    const m = location.hash.match(/^#t(\d+)$/);
    const t = m && Lab.tickets.find((x) => x.id === m[1]);
    if (t) renderTicket(t); else { renderHome(); const d = location.hash.match(/^#day(\d)$/); if (d) { const n = document.getElementById('day' + d[1]); n && n.scrollIntoView(); } }
  }
  window.addEventListener('hashchange', route);
  route();
})();
