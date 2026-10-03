/* tickets.js - every practice ticket: the story, the fault, how it's fixed, how it's checked. */
(function (G) {
  const Lab = (G.Lab = G.Lab || {});
  const fail = (m) => { throw new Lab.ShellError(m); };
  const T = (r) => Lab.table(r);

  /* ---------- shared: a cluster-backed scenario ---------- */
  function clusterSim(opts) {
    return {
      prompt: 'ubuntu@lab-node:~$',
      help: opts.help,
      setup() {
        const c = Lab.newCluster();
        opts.setup && opts.setup(c);
        return { c, files: opts.files ? { ...opts.files } : {}, cwd: '/home/ubuntu' };
      },
      exec(argv, st) { return (opts.exec && opts.exec(argv, st)) ?? Lab.nodeShell(argv, st.c, st); },
      fixed: opts.fixed,
    };
  }
  const K8S_HELP = 'kubectl get | describe | logs | exec | set image | scale | patch | delete | rollout | top\nnode: df, du, ls, rm, find, dmesg, free, crictl images, ctr images ls|import, journalctl, systemctl\npipes: grep, head, tail, sort, uniq -c, wc -l, awk, cut, sed, jq';

  const webReachable = (c) => { const r = Lab.connect(c, 'app', 'web', 80); return !!r.ok; };
  const appPodsHealthy = (c) => Lab.podsOf(c).filter((p) => p.ns === 'app' && p.state !== 'Evicted').every((p) => p.state === 'Running');

  /* ---------- TLS scenario ---------- */
  const PEM = (seed) => {
    let x = 0; for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const L = [];
    for (let i = 0; i < 6; i++) { let l = ''; for (let j = 0; j < 64; j++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; l += A[(x >>> 10) % 64]; } L.push(l); }
    return '-----BEGIN CERTIFICATE-----\nMIIDHTCCAgWgAwIBAgIUQ' + L[0].slice(19) + '\n' + L.slice(1).join('\n') + '\nk2Yw==\n-----END CERTIFICATE-----';
  };
  const CERTS = {
    'srv.crt': { subject: 'CN = portal.customer.lab', issuer: 'CN = Customer Internal CA', nb: 'Oct  3 09:12:40 2026 GMT', na: 'Oct  4 09:12:40 2026 GMT', san: 'DNS:portal-old.customer.lab', naDays: 1.0 },
    'ca.crt': { subject: 'CN = Customer Internal CA', issuer: 'CN = Customer Internal CA', nb: 'Oct  3 09:12:31 2026 GMT', na: 'Nov  2 09:12:31 2026 GMT', san: null, naDays: 30 },
  };
  // "now" in the lab is Oct 3 10:00 UTC; the server cert expires 23h12m later
  function tlsFiles() {
    return {
      'ca.crt': PEM('ca'), 'srv.crt': PEM('srv'), 'srv.csr': '-----BEGIN CERTIFICATE REQUEST-----\nMIICbDCCAVQCAQAwJzElMCMGA1UEAwwccG9ydGFsLmN1c3RvbWVyLmxhYjCCASIw\n-----END CERTIFICATE REQUEST-----',
      'ca.key': '(private key, not shown)', 'srv.key': '(private key, not shown)', 'san.ext': 'subjectAltName=DNS:portal-old.customer.lab', 'ca.srl': '3A1F9C0D2B7E4458',
    };
  }
  function stripFaketime(argv) {
    if (argv[0] !== 'faketime') return { argv, days: 0 };
    let i = 1, spec;
    if (argv[1] === '-f') { spec = argv[2]; i = 3; } else { spec = argv[1]; i = 2; }
    const m = String(spec).match(/^([+-])\s*(\d+(?:\.\d+)?)\s*(d|days?|h|hours?)?$/);
    if (!m) fail(`faketime: couldn't parse '${spec}'. Try: faketime '+2 days' curl ...`);
    let n = parseFloat(m[2]); if (/^h/.test(m[3] || '')) n /= 24; if (!m[3]) n /= 86400; if (m[1] === '-') n = -n;
    return { argv: argv.slice(i), days: n };
  }
  function tlsVerdict(opts) {
    // returns ordered list of problems as openssl codes
    const errs = [];
    if (!opts.trusted) errs.push(20, 21);
    if (opts.days >= 0.97) errs.push(10);
    if (opts.days <= -0.04) errs.push(9);
    if (opts.checkHost && opts.host !== 'portal-old.customer.lab') errs.push(62);
    return errs;
  }
  const VMSG = { 20: 'unable to get local issuer certificate', 21: 'unable to verify the first certificate', 10: 'certificate has expired', 9: 'certificate is not yet valid', 62: 'hostname mismatch' };

  function tlsExec(argv, st) {
    const ft = stripFaketime(argv); argv = ft.argv; const days = ft.days;
    const cmd = argv[0];
    if (cmd === 'date') { const d = new Date(Date.UTC(2026, 9, 3, 10, 0, 0) + days * 864e5); return d.toUTCString().replace('GMT', 'UTC'); }
    if (cmd === 'ls') return Object.keys(st.files).sort().join('  ');
    if (cmd === 'cat' && argv[1] === '/etc/hosts') return '127.0.0.1 localhost\n127.0.1.1 lab-node\n127.0.0.1 portal.customer.lab';
    if (cmd === 'getent') return argv[2] === 'portal.customer.lab' ? '127.0.0.1       portal.customer.lab' : '';
    if (cmd === 'ss') return T([['State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process'], ['LISTEN', '0', '128', '0.0.0.0:8443', '0.0.0.0:*', 'users:(("openssl",pid=5120,fd=3))']]);
    if (cmd === 'curl') {
      let insecure = false, cacert = null, verbose = false, url = null, resolve = null;
      for (let i = 1; i < argv.length; i++) {
        const t = argv[i];
        if (t === '-k' || t === '--insecure') insecure = true;
        else if (t === '--cacert') cacert = argv[++i];
        else if (t === '--resolve') resolve = argv[++i];
        else if (t === '-v' || t === '--verbose') verbose = true;
        else if (/^-[sSIvkL]+$/.test(t)) { if (t.includes('v')) verbose = true; if (t.includes('k')) insecure = true; }
        else if (t === '-m' || t === '--max-time' || t === '-o' || t === '-w') i++;
        else url = t;
      }
      if (!url) fail("curl: try 'curl --help' for more information");
      const m = url.match(/^https?:\/\/([^/:]+)(?::(\d+))?/); if (!m) fail(`curl: (3) URL rejected: Malformed input to a URL function`);
      const host = m[1], port = m[2] || (url.startsWith('https') ? '443' : '80');
      const resolved = host === 'portal.customer.lab' || (resolve && resolve.startsWith(host + ':'));
      if (!resolved) return `curl: (6) Could not resolve host: ${host}`;
      if (port !== '8443') return `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`;
      if (!url.startsWith('https')) return 'curl: (52) Empty reply from server';
      if (cacert && !st.files[cacert]) return `curl: (77) error setting certificate file: ${cacert}`;
      const trusted = cacert === 'ca.crt';
      const errs = insecure ? [] : tlsVerdict({ trusted, days, checkHost: true, host });
      const first = errs.filter((e) => e !== 21)[0];
      const v = [];
      if (verbose) {
        v.push(`* Host ${host}:${port} was resolved.`, '* IPv4: 127.0.0.1', `*   Trying 127.0.0.1:${port}...`, `* Connected to ${host} (127.0.0.1) port ${port}`, '* ALPN: curl offers h2,http/1.1', '* TLSv1.3 (OUT), TLS handshake, Client hello (1):', `*  CAfile: ${cacert || '/etc/ssl/certs/ca-certificates.crt'}`, '*  CApath: /etc/ssl/certs', '* TLSv1.3 (IN), TLS handshake, Server hello (2):', '* TLSv1.3 (IN), TLS handshake, Encrypted Extensions (8):', '* TLSv1.3 (IN), TLS handshake, Certificate (11):');
        if (first === 20) v.push('* TLSv1.3 (OUT), TLS alert, unknown CA (560):', '* SSL certificate problem: unable to get local issuer certificate');
        else if (first === 10) v.push('* TLSv1.3 (OUT), TLS alert, certificate expired (557):', '* SSL certificate problem: certificate has expired');
        else {
          v.push('* TLSv1.3 (IN), TLS handshake, CERT verify (15):', '* TLSv1.3 (IN), TLS handshake, Finished (20):', '* TLSv1.3 (OUT), TLS handshake, Finished (20):', '* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384 / X25519 / RSASSA-PSS', '* Server certificate:', '*  subject: CN=portal.customer.lab', '*  start date: Oct  3 09:12:40 2026 GMT', '*  expire date: Oct  4 09:12:40 2026 GMT');
          if (first === 62) v.push(`*  subjectAltName does not match hostname ${host}`, '* SSL: no alternative certificate subject name matches target host name \'' + host + '\'');
          else v.push(`*  subjectAltName: host "${host}" matched cert's "${host}"`, '*  issuer: CN=Customer Internal CA', insecure ? '*  SSL certificate verify result: unable to get local issuer certificate (20), continuing anyway.' : '*  SSL certificate verify ok.');
        }
      }
      let res;
      if (first === 20) res = 'curl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it.';
      else if (first === 10) res = 'curl: (60) SSL certificate problem: certificate has expired\nMore details here: https://curl.se/docs/sslcerts.html';
      else if (first === 62) res = `curl: (60) SSL: no alternative certificate subject name matches target host name '${host}'\nMore details here: https://curl.se/docs/sslcerts.html`;
      else res = (verbose ? '> GET / HTTP/1.1\n> Host: ' + host + ':8443\n>\n< HTTP/1.0 200 ok\n< Content-type: text/html\n<\n' : '') + '<HTML><BODY BGCOLOR="#ffffff">\n<pre>\ns_server -accept 8443 -cert srv.crt -key srv.key -www\nSecure Renegotiation IS supported\nCiphers supported in s_server binary\n...</pre></BODY></HTML>';
      return v.concat(res).join('\n');
    }
    if (cmd === 'openssl') {
      const sub = argv[1];
      const get = (f) => { const i = argv.indexOf(f); return i > 0 ? argv[i + 1] : null; };
      if (sub === 's_client') {
        const conn = get('-connect'); if (!conn) fail('s_client: Use -help for summary.\n(Try: openssl s_client -connect portal.customer.lab:8443 -servername portal.customer.lab)');
        const [host, port] = conn.split(':');
        if (!['portal.customer.lab', 'localhost', '127.0.0.1'].includes(host)) return `BIO_lookup_ex:system lib:crypto/bio/bio_addr.c:738:Name or service not known\nconnect:errno=0`;
        if (port !== '8443') return `4087F1E3C27F0000:error:8000006F:system library:BIO_connect:Connection refused:crypto/bio/bio_sock2.c:178:calling connect()\nconnect:errno=111`;
        const caf = get('-CAfile'); if (caf && !st.files[caf]) return `Error loading file ${caf}`;
        const vh = get('-verify_hostname');
        const errs = tlsVerdict({ trusted: caf === 'ca.crt', days, checkHost: !!vh, host: vh });
        const L = ['CONNECTED(00000003)'];
        if (caf === 'ca.crt') L.push('depth=1 CN = Customer Internal CA', 'verify return:1');
        const leafErrs = errs.filter((e) => e !== 21);
        L.push('depth=0 CN = portal.customer.lab');
        leafErrs.forEach((e) => L.push(`verify error:num=${e}:${VMSG[e]}`));
        if (errs.includes(21)) L.push('verify return:1', 'depth=0 CN = portal.customer.lab', 'verify error:num=21:unable to verify the first certificate');
        L.push('verify return:1', '---', 'Certificate chain', ' 0 s:CN = portal.customer.lab', '   i:CN = Customer Internal CA', '   a:PKEY: rsaEncryption, 2048 (bit); sigalg: RSA-SHA256', '   v:NotBefore: Oct  3 09:12:40 2026 GMT; NotAfter: Oct  4 09:12:40 2026 GMT');
        if (argv.includes('-showcerts')) L.push(PEM('srv'));
        L.push('---', 'Server certificate');
        if (!argv.includes('-showcerts')) L.push(PEM('srv'));
        L.push('subject=CN = portal.customer.lab', 'issuer=CN = Customer Internal CA', '---', 'No client certificate CA names sent', 'Peer signing digest: SHA256', 'Peer signature type: RSA-PSS', 'Server Temp Key: X25519, 253 bits', '---', 'SSL handshake has read 1352 bytes and written 393 bytes');
        const last = errs.length ? errs[errs.length - 1] : 0;
        L.push(`Verification${last ? ' error: ' + VMSG[last] : ': OK'}`, '---', 'New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384', 'Protocol: TLSv1.3', 'Server public key is 2048 bit', 'This TLS version forbids renegotiation.', 'No ALPN negotiated', 'Early data was not sent', `Verify return code: ${last} (${last ? VMSG[last] : 'ok'})`, '---', 'DONE');
        return L.join('\n');
      }
      if (sub === 'x509') {
        const f = get('-in'); if (!f) fail('x509: give it a file: openssl x509 -in srv.crt -noout -text');
        const ce = CERTS[f]; if (!ce) return st.files[f] ? `Could not read certificate from ${f}\nUnable to load certificate` : `Could not open file or uri for loading certificate from ${f}`;
        const out = [];
        if (argv.includes('-text')) {
          out.push('Certificate:', '    Data:', '        Version: 3 (0x2)', '        Serial Number:', '            3a:1f:9c:0d:2b:7e:44:58', '        Signature Algorithm: sha256WithRSAEncryption', `        Issuer: ${ce.issuer}`, '        Validity', `            Not Before: ${ce.nb}`, `            Not After : ${ce.na}`, `        Subject: ${ce.subject}`, '        Subject Public Key Info:', '            Public Key Algorithm: rsaEncryption', '                Public-Key: (2048 bit)', '        X509v3 extensions:');
          if (ce.san) out.push('            X509v3 Subject Alternative Name: ', `                ${ce.san}`);
          else out.push('            X509v3 Basic Constraints: critical', '                CA:TRUE');
          out.push('            X509v3 Subject Key Identifier: ', '                5E:21:9A:0F:...', '    Signature Algorithm: sha256WithRSAEncryption');
          return out.join('\n');
        }
        for (let i = 2; i < argv.length; i++) {
          const t = argv[i];
          if (t === '-subject') out.push('subject=' + ce.subject);
          else if (t === '-issuer') out.push('issuer=' + ce.issuer);
          else if (t === '-dates') out.push('notBefore=' + ce.nb, 'notAfter=' + ce.na);
          else if (t === '-startdate') out.push('notBefore=' + ce.nb);
          else if (t === '-enddate') out.push('notAfter=' + ce.na);
          else if (t === '-ext') { const e = argv[++i]; if (e === 'subjectAltName' && ce.san) out.push('X509v3 Subject Alternative Name: ', '    ' + ce.san); else if (e === 'subjectAltName') out.push('No extensions in certificate'); }
          else if (t === '-checkend') { const s = +argv[++i]; out.push((ce.naDays - 0.033) * 86400 - days * 86400 < s ? 'Certificate will expire' : 'Certificate will not expire'); }
        }
        return out.join('\n') || PEM(f);
      }
      if (sub === 'verify') {
        const caf = get('-CAfile'); const f = argv[argv.length - 1];
        if (!CERTS[f]) return `Could not open file or uri for loading certificate from ${f}`;
        if (f === 'ca.crt') return caf === 'ca.crt' ? 'ca.crt: OK' : 'CN = Customer Internal CA\nerror 18 at 0 depth lookup: self-signed certificate\nerror ca.crt: verification failed';
        if (caf !== 'ca.crt') return 'CN = portal.customer.lab\nerror 20 at 0 depth lookup: unable to get local issuer certificate\nerror srv.crt: verification failed';
        if (days >= 0.97) return 'CN = portal.customer.lab\nerror 10 at 0 depth lookup: certificate has expired\nerror srv.crt: verification failed';
        return 'srv.crt: OK';
      }
      if (sub === 'req') return '(Generating new certs isn\'t needed here. Read the ones you have.)';
      fail(`openssl: ${sub || ''} isn't simulated. Try s_client, x509, verify.`);
    }
    return undefined;
  }

  /* ---------- packet capture scenario ---------- */
  const PCAP = [
    ['10:14:02.118204', 'C1', 8443, 'S', 'seq 1102392871, win 65495, options [mss 65495,sackOK,TS val 3184417025 ecr 0,nop,wscale 7], length 0', 'SYN', 74, ''],
    ['10:14:02.118215', 'S1', 8443, 'S.', 'seq 3923510120, ack 1102392872, win 65483, options [mss 65495,sackOK,TS val 3184417025 ecr 3184417025,nop,wscale 7], length 0', 'SYN, ACK', 74, ''],
    ['10:14:02.118224', 'C1', 8443, '.', 'ack 1, win 512, options [nop,nop,TS val 3184417025 ecr 3184417025], length 0', 'ACK', 66, ''],
    ['10:14:02.121907', 'C1', 8443, 'P.', 'seq 1:518, ack 1, win 512, options [nop,nop,TS val 3184417029 ecr 3184417025], length 517', 'PSH, ACK', 583, 'TLSv1.3 Client Hello (SNI=portal.customer.lab)'],
    ['10:14:02.123480', 'S1', 8443, 'P.', 'seq 1:1353, ack 518, win 509, options [nop,nop,TS val 3184417030 ecr 3184417029], length 1352', 'PSH, ACK', 1418, 'TLSv1.3 Server Hello, Change Cipher Spec, Application Data'],
    ['10:14:02.123911', 'C1', 8443, 'P.', 'seq 518:525, ack 1353, win 502, options [nop,nop,TS val 3184417031 ecr 3184417030], length 7', 'PSH, ACK', 73, 'TLSv1.3 Alert (Level: Fatal, Description: Unknown CA)'],
    ['10:14:02.124017', 'C1', 8443, 'F.', 'seq 525, ack 1353, win 502, length 0', 'FIN, ACK', 66, ''],
    ['10:14:02.124120', 'S1', 8443, 'F.', 'seq 1353, ack 526, win 509, length 0', 'FIN, ACK', 66, ''],
    ['10:14:02.124131', 'C1', 8443, '.', 'ack 1354, win 502, length 0', 'ACK', 66, ''],
    ['10:14:07.201310', 'C2', 9443, 'S', 'seq 288416011, win 65495, options [mss 65495,sackOK,TS val 3184422108 ecr 0,nop,wscale 7], length 0', 'SYN', 74, ''],
    ['10:14:07.201322', 'S2', 9443, 'R.', 'seq 0, ack 288416012, win 0, length 0', 'RST, ACK', 54, ''],
    ['10:14:07.402998', 'C3', 9444, 'S', 'seq 914002331, win 65495, options [mss 65495,sackOK,TS val 3184422309 ecr 0,nop,wscale 7], length 0', 'SYN', 74, ''],
    ['10:14:08.428114', 'C3', 9444, 'S', 'seq 914002331, win 65495, options [mss 65495,sackOK,TS val 3184423335 ecr 0,nop,wscale 7], length 0', 'SYN', 74, 'retransmission'],
    ['10:14:10.476102', 'C3', 9444, 'S', 'seq 914002331, win 65495, options [mss 65495,sackOK,TS val 3184425383 ecr 0,nop,wscale 7], length 0', 'SYN', 74, 'retransmission'],
  ];
  const CPORT = { C1: 51544, S1: 51544, C2: 42118, S2: 42118, C3: 39652 };
  function pcapLine(p) {
    const fromClient = p[1].startsWith('C'); const cp = CPORT[p[1]];
    const src = fromClient ? `127.0.0.1.${cp}` : `127.0.0.1.${p[2]}`; const dst = fromClient ? `127.0.0.1.${p[2]}` : `127.0.0.1.${cp}`;
    return `${p[0]} IP ${src} > ${dst}: Flags [${p[3]}], ${p[4]}`;
  }
  function pcapExec(argv, st) {
    const cmd = argv[0];
    if (cmd === 'ls') return 'cases.pcap';
    if (cmd === 'cat' && argv[1] === 'cases.pcap') return '(binary file. Read it with: tcpdump -nn -r cases.pcap   or   tshark -r cases.pcap)';
    if (cmd === 'tcpdump') {
      const r = argv.indexOf('-r'); if (r < 0) return 'tcpdump: (live capture isn\'t possible here. Read the saved one: tcpdump -nn -r cases.pcap)';
      if (argv[r + 1] !== 'cases.pcap') return `tcpdump: ${argv[r + 1]}: No such file or directory`;
      const expr = argv.slice(r + 2).filter((x) => !x.startsWith('-')).join(' ');
      let rows = PCAP;
      const pm = expr.match(/port\s+(\d+)/); if (pm) rows = rows.filter((p) => p[2] === +pm[1]);
      if (/tcp-rst|\[R/.test(expr)) rows = rows.filter((p) => p[3].includes('R'));
      if (/tcp-syn/.test(expr) && !/tcp-rst/.test(expr)) rows = rows.filter((p) => p[3].includes('S'));
      const out = ['reading from file cases.pcap, link-type EN10MB (Ethernet), snapshot length 262144', ...rows.map(pcapLine)];
      if (argv.includes('-A') || argv.includes('-X')) out.push('(payload is TLS-encrypted; try: tshark -r cases.pcap -Y tls)');
      return out.join('\n');
    }
    if (cmd === 'tshark') {
      const r = argv.indexOf('-r'); if (r < 0 || argv[r + 1] !== 'cases.pcap') return 'tshark: read the capture with: tshark -r cases.pcap [-Y filter]';
      const yi = argv.indexOf('-Y'); const f = yi > 0 ? argv[yi + 1] : '';
      const t0 = 2 * 3600 * 0 + parseFloat(PCAP[0][0].split(':')[2]) + 14 * 60;
      let rows = PCAP.map((p, i) => ({ p, i }));
      const filt = {
        '': () => true, tls: ({ p }) => p[7].startsWith('TLS'), 'tcp.flags.reset==1': ({ p }) => p[3].includes('R'), 'tcp.flags.reset == 1': ({ p }) => p[3].includes('R'),
        'tcp.analysis.retransmission': ({ p }) => p[7] === 'retransmission', 'tls.alert_message': ({ p }) => p[7].includes('Alert'), 'tcp.flags.syn==1': ({ p }) => p[3].includes('S'),
      };
      const pf = f.match(/^tcp\.port\s*==\s*(\d+)$/);
      if (pf) rows = rows.filter(({ p }) => p[2] === +pf[1]);
      else if (filt[f]) rows = rows.filter(filt[f]);
      else return `tshark: "${f}" isn't one of the filters simulated here. Try: tls, tls.alert_message, tcp.flags.reset==1, tcp.analysis.retransmission, tcp.port==9443`;
      return rows.map(({ p, i }) => {
        const tt = parseFloat(p[0].split(':')[1]) * 60 + parseFloat(p[0].split(':')[2]) - t0;
        const fromClient = p[1].startsWith('C'); const cp = CPORT[p[1]];
        const proto = p[7].startsWith('TLS') ? 'TLSv1.3' : 'TCP';
        const info = p[7] && p[7] !== 'retransmission' ? p[7].replace(/^TLSv1\.3 /, '') : `${fromClient ? cp : p[2]} → ${fromClient ? p[2] : cp} [${p[5]}]${p[7] === 'retransmission' ? ' [TCP Retransmission]' : ''}`;
        return `${String(i + 1).padStart(5)} ${tt.toFixed(6).padStart(11)}    127.0.0.1 → 127.0.0.1    ${proto} ${p[6]} ${info}`;
      }).join('\n');
    }
    if (cmd === 'curl') {
      const url = argv.find((x) => /^https?:/.test(x)) || ''; const port = (url.match(/:(\d+)/g) || []).pop();
      const v = argv.some((x) => /^-\w*v/.test(x));
      if (port === ':8443') return (v ? '*   Trying 127.0.0.1:8443...\n* Connected to portal.customer.lab (127.0.0.1) port 8443\n* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n* TLSv1.3 (IN), TLS handshake, Server hello (2):\n* TLSv1.3 (OUT), TLS alert, unknown CA (560):\n' : '') + 'curl: (60) SSL certificate problem: unable to get local issuer certificate\n(failed after 0.006s)';
      if (port === ':9443') return (v ? '*   Trying 127.0.0.1:9443...\n* connect to 127.0.0.1 port 9443 from 127.0.0.1 port 42118 failed: Connection refused\n' : '') + 'curl: (7) Failed to connect to portal.customer.lab port 9443 after 0 ms: Couldn\'t connect to server';
      if (port === ':9444') return (v ? '*   Trying 127.0.0.1:9444...\n' : '') + 'curl: (28) Connection timed out after 5002 milliseconds';
      return 'curl: which site? Sites are on ports 8443 (A), 9443 (B), 9444 (C).';
    }
    if (cmd === 'ss') return T([['State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process'], ['LISTEN', '0', '128', '0.0.0.0:8443', '0.0.0.0:*', 'users:(("openssl",pid=5120,fd=3))'], ['LISTEN', '0', '128', '0.0.0.0:9444', '0.0.0.0:*', 'users:(("openssl",pid=5188,fd=3))']]);
    if (cmd === 'iptables' || cmd === 'nft' || cmd === 'ufw') return '(That firewall belongs to the customer\'s network team, not to you. You can\'t see it. Work from the capture.)';
    return undefined;
  }

  /* ---------- log bundle scenario ---------- */
  function logsExec(argv, st) {
    if (argv[0] === 'ls') return argv.some((x) => /l/.test(x) && x.startsWith('-')) ? `-rw-r--r-- 1 ubuntu ubuntu ${st.files['bundle.jsonl'] ? st.files['bundle.jsonl'].length : 0} Oct  3 09:30 bundle.jsonl` : 'bundle.jsonl';
    if (argv[0] === 'python3' || argv[0] === 'python') return '(No Python here. jq, grep, awk, sort and uniq are enough for this one.)';
    if (['vi', 'vim', 'nano', 'code', 'less'].includes(argv[0])) return '(No editor on purpose. Real bundles are too big to scroll. Query it.)';
    return undefined;
  }

  /* ---------- chaos ---------- */
  const CHAOS = [
    { id: 'image', label: 'A rollout to an image that isn\'t on the node', apply: (c) => { const d = c.deps.find((x) => x.name === 'web'); d.prevImage = d.image; d.image = 'nginx:1.26-alpine'; d.changed = true; } },
    { id: 'selector', label: 'The service selector no longer matches the pods', apply: (c) => { c.svcs.find((s) => s.name === 'web').selector = { app: 'web-v2' }; } },
    { id: 'coredns', label: 'CoreDNS scaled down to zero', apply: (c) => { c.deps.find((d) => d.name === 'coredns').replicas = 0; } },
    { id: 'netpol', label: 'A new egress policy blocks DNS', apply: (c) => { c.netpols.push({ metadata: { name: 'baseline-egress', namespace: 'app' }, age: '41m', spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{ to: [{ podSelector: {} }] }] } }); } },
  ];

  /* ---------- the tickets ---------- */
  const tickets = [
    /* ===== Day 1 ===== */
    {
      id: '100', day: 1, title: 'Set up your real lab', kind: 'setup', pri: 'Setup', tags: ['codespace'],
      task: 'Every ticket runs in the browser simulator. When you want the real thing, the repo opens as a GitHub Codespace with an air-gapped k3s cluster. Do this once so it\'s ready.',
      steps: [
        ['Open the Codespace', 'Click "Open in Codespaces" at the top of the page. Pick the 4-core machine. First boot takes about 5 minutes while it installs k3d and builds the cluster.'],
        ['Check the cluster', 'Run <code>kubectl get nodes</code> and <code>kubectl -n app get pods</code>. You should see web and client Running.'],
        ['Prove it\'s air-gapped', 'Run <code>lab airgap status</code>, then <code>kubectl -n app run test --image=alpine:3.20 -- sleep 1</code>. It should end in ImagePullBackOff. Delete it with <code>kubectl -n app delete pod test</code>.'],
        ['Learn the lab command', '<code>lab break 101</code> injects a ticket\'s fault, <code>lab reset</code> puts everything back, <code>lab list</code> shows all of them.'],
        ['Stop it when you\'re done', 'Codespaces bill by the hour against your free quota. Stop it from github.com/codespaces when you finish a session.'],
      ],
    },
    /* ===== Day 2 ===== */
    {
      id: '101', day: 2, title: 'New module won\'t start after upgrade', pri: 'P2', priLabel: 'P2 · degraded', tags: ['air-gap', 'images'],
      customer: 'We installed the new reporting module and its helper per your release notes. Both are stuck, the rest of the system looks fine. We\'re in a closed network so please don\'t ask us to download anything.',
      task: 'Find why each one is stuck and get both running. They fail for two different reasons, even though the status looks the same.',
      hints: ['Start wide: <code>kubectl -n app get pods</code>, then <code>kubectl -n app describe pod -l app=reporter</code> and read Events from the bottom.', 'What does the node actually have? <code>crictl images</code>. What did the vendor ship? <code>ls /opt/offline-bundle</code>', 'Look at <code>kubectl -n app get pod -l app=helper -o yaml | grep -i pull</code>. What does Kubernetes do with an image that has no tag?'],
      resolution: '<p><strong>reporter:</strong> <code>nginx:1.25-alpine</code> was shipped in the offline bundle but never imported. With no registry to pull from, ImagePullBackOff forever. Fix: <code>ctr images import /opt/offline-bundle/nginx_1.25-alpine.tar</code>, then delete the pod so it retries now.</p><p><strong>helper:</strong> no tag means <code>:latest</code>, and <code>:latest</code> means <code>imagePullPolicy: Always</code>. Even with busybox on the node, the kubelet still insists on pulling. Fix: pin the tag, <code>kubectl -n app set image deploy/helper busybox=busybox:1.36</code>.</p><p>Real-world takeaway: compare the bundle with the release notes, and confirm the import step succeeded. The untagged image in the release notes is a vendor bug worth raising to R&amp;D.</p>',
      twist: 'Write the message asking the customer for <code>kubectl describe</code> output and the image list, without sounding like you\'re blaming their install.',
      codespace: 'lab break 101',
      sim: clusterSim({
        help: K8S_HELP,
        setup(c) {
          c.deps.push({ ns: 'app', name: 'reporter', image: 'nginx:1.25-alpine', replicas: 1, labels: { app: 'reporter' }, age: '14m', changed: true, freshAge: '14m' });
          c.deps.push({ ns: 'app', name: 'helper', image: 'busybox', replicas: 1, labels: { app: 'helper' }, age: '14m', cmd: ['sleep', '1d'], changed: true, freshAge: '14m' });
          c.offline = {
            'nginx_1.25-alpine.tar': { image: 'docker.io/library/nginx:1.25-alpine', size: '21M' },
            'busybox_1.36.tar': { image: 'docker.io/library/busybox:1.36', size: '4.3M' },
            'release-notes.txt': { size: '412', text: 'Reporting module 4.2\n====================\nImages (offline bundle):\n  reporter  nginx:1.25-alpine\n  helper    busybox\n\nInstall:\n  1. Import every .tar in this folder:\n       sudo k3s ctr images import <file>\n  2. kubectl -n app create deployment reporter --image=nginx:1.25-alpine\n  3. kubectl -n app create deployment helper --image=busybox -- sleep 1d' },
          };
        },
        exec(argv, st) {
          if ((argv[0] === 'cat' || argv[0] === 'less') && argv[1] && argv[1].endsWith('release-notes.txt')) return st.c.offline['release-notes.txt'].text;
          return undefined;
        },
        fixed: (st) => ['reporter', 'helper'].every((n) => Lab.podsOf(st.c).some((p) => p.dep && p.dep.name === n && p.state === 'Running')),
      }),
      requireFix: true,
      check: { type: 'choice', q: 'Busybox was already on the node. Why was helper still stuck?', options: ['The node ran out of disk for the image', 'No tag means :latest, and :latest forces imagePullPolicy Always, so it tries the registry anyway', 'The helper command "sleep 1d" is invalid', 'busybox needs a registry login'], answer: 1 },
    },
    {
      id: '102', day: 2, title: 'Everything is Running but nothing connects', pri: 'P1', priLabel: 'P1 · outage', tags: ['network', 'dns'],
      customer: 'Since this morning the frontend can\'t reach the web service. All pods are green and Running. Nothing changed on our side.',
      task: 'Prove where it breaks using only the client pod, then restore service. Keep the customer\'s security policy in place if you can.',
      hints: ['Compare <code>kubectl -n app exec client -- wget -qO- web</code> with the same command using the ClusterIP from <code>kubectl -n app get svc web</code>.', 'If the IP works and the name doesn\'t, it\'s DNS. Where does DNS live? <code>kubectl -n kube-system get pods</code>', '<code>kubectl get netpol -A</code>, then describe what you find. Which namespace does that policy allow egress to?'],
      resolution: '<p>A default-deny egress policy allows traffic only inside <code>app</code>. CoreDNS lives in <code>kube-system</code>, so lookups die while IPs still work. Add a DNS rule instead of deleting the policy:</p><pre>kubectl -n app patch netpol hardening-baseline --type=json -p \'[{"op":"add","path":"/spec/egress/-","value":{"to":[{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}}}],"ports":[{"protocol":"UDP","port":53},{"protocol":"TCP","port":53}]}}]\'</pre><p>Deleting the policy also "works", but you just removed the customer\'s security control without asking. Takeaway: "nothing changed" usually means "nothing changed that I know about". Security teams at gov and enterprise sites push policies without telling app owners.</p>',
      twist: 'Write two commands the customer can run that prove DNS vs connectivity in under a minute, and how you\'d ask about security changes politely.',
      codespace: 'lab break 102',
      sim: clusterSim({
        help: K8S_HELP,
        setup(c) { c.netpols.push({ metadata: { name: 'hardening-baseline', namespace: 'app' }, age: '2h', spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{ to: [{ podSelector: {} }] }] } }); },
        fixed: (st) => webReachable(st.c),
      }),
      requireFix: true,
      check: { type: 'choice', q: 'What was actually blocked?', options: ['Traffic from client to the web pod', 'DNS: egress from app to CoreDNS in kube-system', 'Ingress to the web service', 'The web pod\'s readiness probe'], answer: 1 },
    },
    {
      id: '103', day: 2, title: 'Report worker restarts every minute', pri: 'P2', priLabel: 'P2 · degraded', tags: ['resources'],
      customer: 'report-worker keeps restarting. We checked the logs and there is no error at all, it just dies.',
      task: 'Explain why the logs are clean, and collect the exact evidence you\'d paste into the case.',
      hints: ['<code>kubectl -n app describe pod report-worker</code>, look at Last State.', 'What is exit code 137 made of? 128 + ?', 'The kernel keeps its own log: <code>dmesg -T | grep -iE "oom|killed process"</code>'],
      resolution: '<p>OOMKilled. Exit 137 = 128 + 9 (SIGKILL). The kernel kills the process for hitting its cgroup memory limit, so the app never gets a chance to write an error. <code>kubectl logs --previous</code> only shows "starting".</p><p>Evidence for the case: Last State reason and exit code, the 48Mi limit from the spec, the dmesg line, and <code>kubectl top pod</code>. Next step: raise the limit in the deployment or Helm values, or escalate a possible leak to R&amp;D with that data. The pod spec itself is immutable, try <code>kubectl set resources</code> on it to see why.</p>',
      twist: 'The customer says "just remove the limit". Write your reply explaining the risk to the rest of the node.',
      codespace: 'lab break 103',
      sim: clusterSim({
        help: K8S_HELP,
        setup(c) {
          c.bare.push({ ns: 'app', name: 'report-worker', image: 'busybox:1.36', labels: { run: 'report-worker' }, age: '9m', memLimit: '48Mi', oom: true, fresh: true, cmd: ['sh', '-c', 'echo starting; sleep 5; tail /dev/zero'], logs: 'starting' });
          c.dmesgExtra = [
            '[Sat Oct  3 09:58:47 2026] tail invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=983',
            '[Sat Oct  3 09:58:47 2026] memory: usage 49152kB, limit 49152kB, failcnt 412',
            '[Sat Oct  3 09:58:47 2026] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=cri-containerd-7d1e2f.scope,mems_allowed=0,oom_memcg=/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod3c9a.slice,task=tail,pid=48211,uid=0',
            '[Sat Oct  3 09:58:47 2026] Memory cgroup out of memory: Killed process 48211 (tail) total-vm:51200kB, anon-rss:48964kB, file-rss:4kB, shmem-rss:0kB, UID:0 pgtables:136kB oom_score_adj:983',
          ];
        },
        fixed: () => true,
      }),
      check: { type: 'choice', q: 'Why are the application logs clean?', options: ['Logging is disabled for that pod', 'The kernel SIGKILLs it for exceeding its memory limit, so the app never writes an error', 'The liveness probe kills it before it logs', 'The logs were rotated away'], answer: 1 },
    },
    {
      id: '104', day: 2, title: 'Nothing new will schedule', pri: 'P1', priLabel: 'P1 · outage', tags: ['node', 'disk'], browserOnly: true,
      customer: 'We tried to scale up web and the new pods won\'t start. Some old pods also show "Evicted" now. Is the cluster broken?',
      task: 'Find the node condition, find the file that caused it without knowing its name, fix it, and clean up after yourself.',
      hints: ['<code>kubectl describe node | grep -A8 Conditions</code> and look at Taints.', '<code>df -h</code>, then <code>du -xh / --max-depth=3 | sort -h | tail</code>', 'Once space is back, check what\'s left behind: <code>kubectl get pods -A | grep -v Running</code>'],
      resolution: '<p>DiskPressure. The kubelet taints the node with <code>disk-pressure:NoSchedule</code> and starts evicting pods. An 11G file in <code>/var/tmp</code> filled the disk.</p><pre>rm /var/tmp/.cache-blob\nkubectl delete pod -A --field-selector=status.phase==Failed\ncrictl images   # did GC delete anything you need?</pre><p>The dangerous part: under disk pressure the kubelet garbage-collects unused images. On an air-gapped site they can\'t come back from a registry. Always check the image list after a disk incident. In real life, ask before deleting anything on a customer node.</p>',
      twist: 'Write the "please don\'t delete things yet" message, plus the three commands you want output from first.',
      sim: clusterSim({
        help: K8S_HELP,
        setup(c) {
          c.disk.blob = true; c.node.pressure = true;
          const w = c.deps.find((d) => d.name === 'web'); w.replicas = 3; w.baseReplicas = 1; w.freshAge = '4m';
          c.evicted.push({ ns: 'app', name: 'analytics-5f7d8b9c4-qm2xd', age: '2d', msg: 'The node was low on resource: ephemeral-storage. Threshold quantity: 2040359Ki, available: 401408Ki. Container analytics was using 8Ki, request is 0, has larger consumption of ephemeral-storage.' });
          c.journal = 'Oct 03 09:52:10 lab-node k3s[1022]: I1003 09:52:10.118220 1022 eviction_manager.go:370] "Eviction manager: attempting to reclaim" resourceName="ephemeral-storage"\nOct 03 09:52:10 lab-node k3s[1022]: I1003 09:52:10.204117 1022 eviction_manager.go:381] "Eviction manager: must evict pod(s) to reclaim" resourceName="ephemeral-storage"\nOct 03 09:52:11 lab-node k3s[1022]: E1003 09:52:11.880012 1022 kubelet.go:1647] "Image garbage collection failed multiple times in a row" err="Failed to garbage collect required amount of images. Attempted to free 3214983168 bytes, but only found 0 bytes eligible to free."';
        },
        fixed: (st) => !st.c.node.pressure && appPodsHealthy(st.c),
      }),
      requireFix: true,
      check: { type: 'choice', q: 'Why were the new web pods Pending?', options: ['Not enough CPU on the node', 'The node had a disk-pressure NoSchedule taint', 'The image was missing', 'The replica count was over the quota'], answer: 1 },
    },
    /* ===== Day 3 ===== */
    {
      id: '201', day: 3, title: 'Portal certificate error, three layers deep', pri: 'P2', priLabel: 'P2 · degraded', tags: ['tls'],
      customer: 'Our analysts get a certificate error on the portal. Our PKI team says the certificate is valid and was issued by our internal CA. Please advise.',
      task: 'The portal is https://portal.customer.lab:8443 and the PKI team sent you their files. There are three separate problems. The third only shows up when the client\'s clock is ahead, so test with faketime too.',
      hints: ['<code>openssl s_client -connect portal.customer.lab:8443 -servername portal.customer.lab</code> and read the Verify return code.', '<code>openssl x509 -in srv.crt -noout -subject -issuer -dates -ext subjectAltName</code>. Modern clients ignore CN, only SAN counts.', 'Trust their CA with <code>curl --cacert ca.crt ...</code>, then try <code>faketime \'+1 day\' curl --cacert ca.crt ...</code>'],
      resolution: '<ol><li><strong>Untrusted CA.</strong> Verify code 20, unable to get local issuer. Clients don\'t have the internal CA. <code>curl --cacert ca.crt</code> gets past it.</li><li><strong>SAN mismatch.</strong> With the CA trusted, curl now fails on the name. SAN says <code>portal-old.customer.lab</code>, users hit <code>portal.customer.lab</code>. The PKI team checked CN, which modern clients ignore.</li><li><strong>Validity.</strong> The cert is valid for one day. With the clock a day ahead it\'s expired. In closed networks with no NTP, clock drift causes exactly this, and it breaks tokens and Kubernetes certs too.</li></ol><p>Takeaway: fix one TLS error and the next one appears. Tell the customer early that there may be more than one layer.</p>',
      twist: 'Write the reply to the PKI team showing them the SAN line, respectfully, since they said the cert is valid.',
      codespace: 'lab break 201',
      sim: { prompt: 'ubuntu@analyst-pc:~/pki$', help: 'curl [-v] [--cacert FILE] [-k] [--resolve host:port:ip] URL\nopenssl s_client -connect HOST:PORT [-servername] [-CAfile] [-verify_hostname] [-showcerts]\nopenssl x509 -in FILE -noout [-subject] [-issuer] [-dates] [-ext subjectAltName] [-text] [-checkend SEC]\nopenssl verify -CAfile ca.crt srv.crt\nfaketime \'+2 days\' <command>\nls, cat, date, ss, grep, head', setup: () => ({ files: tlsFiles() }), exec: tlsExec, fixed: () => true },
      check: { type: 'multi', q: 'Pick all three problems.', options: ['The client doesn\'t trust the internal CA', 'The certificate\'s SAN doesn\'t include the hostname users type', 'The server key is too short', 'The certificate expires within a day, so any clock drift breaks it', 'TLS 1.3 isn\'t supported by the server'], answer: [0, 1, 3] },
    },
    {
      id: '202', day: 3, title: 'Three sites, three "can\'t connect"', pri: 'P3', priLabel: 'P3 · normal', tags: ['packets'],
      customer: 'Site A, B and C all report "can\'t connect to the service". Same product, same version. Can you tell us what\'s going on?',
      task: 'Their network team sent one capture with an attempt from each site (A = port 8443, B = 9443, C = 9444). From the capture, say what\'s happening at each site and who owns the next step.',
      hints: ['<code>tcpdump -nn -r cases.pcap port 9443</code>. What answers the SYN?', 'Wireshark-style filters work here: <code>tshark -r cases.pcap -Y tls.alert_message</code>, <code>-Y tcp.analysis.retransmission</code>', 'Look at timing. A refusal is instant. Silence makes the client retry and wait.'],
      resolution: '<table><thead><tr><th>Site</th><th>On the wire</th><th>Meaning · owner</th></tr></thead><tbody><tr><td>A :8443</td><td>Full handshake, TLS starts, the client sends Alert: Unknown CA</td><td>The network is fine. Certificate trust problem. PKI / you.</td></tr><tr><td>B :9443</td><td>SYN, instant RST</td><td>Host reachable, nothing listening. Service is down. You.</td></tr><tr><td>C :9444</td><td>SYN, SYN retransmits, never an answer</td><td>Something silently drops packets. Customer firewall team.</td></tr></tbody></table><p>Takeaway: "refused" and "timed out" are completely different tickets. Ask for the exact error text every time.</p>',
      codespace: 'lab break 202',
      sim: { prompt: 'ubuntu@support:~/case-4411$', help: 'tcpdump -nn -r cases.pcap [port N]\ntshark -r cases.pcap [-Y tls | tls.alert_message | tcp.flags.reset==1 | tcp.analysis.retransmission | tcp.port==N]\ncurl -v https://portal.customer.lab:PORT   (replays each site\'s attempt)\nss -tlnp, ls, grep, head', setup: () => ({ files: {} }), exec: pcapExec, fixed: () => true },
      check: { type: 'match', q: 'Match each site to what\'s wrong.', rows: ['Site A (8443)', 'Site B (9443)', 'Site C (9444)'], options: ['Certificate trust problem', 'Service down, nothing listening', 'Firewall dropping packets'], answer: [0, 1, 2] },
    },
    /* ===== Day 4 ===== */
    {
      id: '301', day: 4, title: 'Search was slow this morning, send an RCA', pri: 'P2', priLabel: 'P2 · RCA request', tags: ['logs', 'jq'],
      customer: 'Between about 8:20 and 8:45 searches failed or hung. It\'s fine now. Attached the log bundle. Management wants a root cause by end of day.',
      task: 'bundle.jsonl has about 7,500 JSON lines from five sources. Answer from the data, not from scrolling. Then write a five-line RCA: timeline, cause, impact, fix, prevention.',
      hints: ['First sign of trouble: <code>jq -r \'select(.level!="INFO") | [.ts,.service,.level,.msg] | @tsv\' bundle.jsonl | head</code>', 'Count per minute: <code>jq -r \'select(.status==503) | .ts[11:16]\' bundle.jsonl | sort | uniq -c | sort -rn | head -3</code>', 'Follow one request: <code>grep \'"req-01800"\' bundle.jsonl</code>. Lag over time: <code>jq -r \'select(.msg=="consumer lag") | [.ts,.lag] | @tsv\' bundle.jsonl | awk \'$2>1000\'</code>'],
      resolution: '<ol><li>First sign: 08:24:20, <code>node</code> WARN, disk 91% on <code>/var/lib/mongo</code>. Not the first ERROR at 08:25:01. The first ERROR is where people stop looking, and it\'s a symptom.</li><li>208 errors (503) in total. Worst minute 08:35 with 26.</li><li>Real user impact: 08:28:00 to 08:37:46. The customer\'s "8:20 to 8:45" is a feeling. Your RCA uses log times.</li><li><code>req-01800</code>: at 08:30:00 the collector hit a Mongo timeout and the API returned 503 for the same request in about 3 seconds.</li><li>Consumer lag peaked at 6,700 during 08:33, back under 1,000 at 08:39:00. The backlog drained after Mongo recovered around 08:34.</li><li>The 404s are noise: about 40 spread evenly across the whole hour.</li></ol><p>Chain: Mongo volume fills, a replica set member drops, collector writes time out, Kafka backs up, the API returns 503. Prevention: alert on disk before 85%.</p>',
      codespace: 'lab break 301',
      sim: { prompt: 'ubuntu@support:~/case-4419$', help: 'jq [-r] [-c] [-s] FILTER bundle.jsonl\ngrep [-c] [-v] [-i] [-E] PATTERN bundle.jsonl\nPipes: | sort [-n] [-r] | uniq -c | head -N | tail -N | wc -l | awk \'$2>1000\' | cut -f1 | sed -n 5p\nls, head, tail, wc', needsBundle: true, setup: () => ({ files: { 'bundle.jsonl': Lab.bundle || '' } }), exec: logsExec, fixed: () => true },
      check: {
        type: 'form', q: 'Fill in what the data says.', fields: [
          { label: 'Time of the first sign of trouble (HH:MM:SS)', answer: '08:24:20', norm: (v) => v.trim().replace(/^(\d):/, '0$1:') },
          { label: 'Total 503 responses', answer: '208', norm: (v) => v.replace(/[^\d]/g, '') },
          { label: 'Worst minute for 503s (HH:MM)', answer: '08:35', norm: (v) => v.trim().replace(/^(\d):/, '0$1:') },
          { label: 'Root cause', select: ['API bug in /v1/search', 'Kafka broker crash', 'Disk filled on the Mongo volume', 'Network outage between sites'], answer: '2' },
        ],
      },
    },
    {
      id: '302', day: 4, title: 'Write a support bundle script', kind: 'write', pri: 'Tooling', tags: ['linux', 'bash'],
      task: 'Write <code>triage.sh</code>: a read-only script a customer can run on a node that collects everything you need for a first look into one tarball. It becomes your five-minute routine and the thing you\'ll ask for on almost every ticket.',
      checklist: ['Load and uptime', 'Disk and inodes', 'Memory and OOM kills', 'Failed systemd units', 'Errors from the last hour', 'Listening ports', 'Clock and NTP status', 'Node and pod state', 'Recent events', 'Never changes anything', 'Timestamps the output', 'Finishes even if one command fails'],
      reference: '#!/usr/bin/env bash\n# triage.sh - read-only. Collects a first-look bundle.\nOUT="triage-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)"\nmkdir -p "$OUT"\nrun(){ echo "\\$ $2" > "$OUT/$1.txt"; bash -c "$2" >> "$OUT/$1.txt" 2>&1 || true; }\nrun 01-uptime    "uptime; nproc"\nrun 02-disk      "df -h; echo; df -i"\nrun 03-memory    "free -m"\nrun 04-oom       "dmesg -T | grep -iE \'oom|killed process\' | tail -50"\nrun 05-systemd   "systemctl --failed --no-pager"\nrun 06-errors    "journalctl -p err --since \'1 hour ago\' --no-pager | tail -200"\nrun 07-ports     "ss -tulpn"\nrun 08-time      "date -u; timedatectl"\nrun 09-nodes     "kubectl get nodes -o wide; kubectl describe nodes | grep -A8 Conditions"\nrun 10-pods      "kubectl get pods -A -o wide | grep -v -E \'Running|Completed\'"\nrun 11-events    "kubectl get events -A --sort-by=.lastTimestamp | tail -80"\ntar czf "$OUT.tgz" "$OUT" && rm -rf "$OUT"\necho "Please send us: $OUT.tgz"',
      codespace: 'lab/triage.sh is in the repo. Run it in the Codespace after any lab break.',
    },
    {
      id: '303', day: 4, title: 'Data layer quick drill', kind: 'cards', pri: 'Flash cards', tags: ['mongo', 'kafka', 'elastic'],
      task: 'No lab needed. These are the failure modes you\'ll meet inside bundled products. Answer out loud, then flip.',
      cards: [
        ['Elasticsearch is red and new data stopped indexing. Where do you look?', '<code>_cluster/health?pretty</code>, <code>_cat/allocation?v</code> for disk per node, and <code>_cluster/allocation/explain</code> for why a shard won\'t assign. Disk watermarks: 85% stops new shards, 90% moves shards away, 95% flood stage makes indices read-only. Free disk first, then check the block lifts.'],
        ['Data arrives late but nothing errors. What do you check in Kafka?', '<code>kafka-consumer-groups.sh --bootstrap-server &lt;broker&gt; --describe --group &lt;group&gt;</code>. LAG growing on every partition means slow consumers or a downstream problem. Lag on one partition means a stuck consumer or a hot key.'],
        ['App logs say "not primary" or writes hang. What do you check in Mongo?', '<code>rs.status()</code>: every member\'s stateStr and health. No PRIMARY means no majority, often a member lost to disk or network. Replication lag: <code>rs.printSecondaryReplicationInfo()</code>. Never force a reconfig on a customer site without R&amp;D.'],
        ['A Kafka broker restarted and some consumers stopped. First question?', 'Is the group rebalancing or stuck? Describe the group: no active members, or members with no partitions assigned. Then check the consumer pods\' logs for auth or offset errors.'],
        ['Elasticsearch indices went read-only. What happened and what\'s the fix?', 'Flood-stage watermark (95%) hit. Free disk, then on older versions clear it with <code>index.blocks.read_only_allow_delete: null</code>. Newer versions release it automatically once disk drops.'],
      ],
    },
    /* ===== Day 5 ===== */
    {
      id: '401', day: 5, title: 'The first response', kind: 'write', pri: 'P1', priLabel: 'P1 · outage', tags: ['writing'],
      customer: 'URGENT. Dashboards have been empty since 07:00. Operations are blocked. We need someone on this now.',
      task: 'Write the first reply you\'d send within 15 minutes. You know nothing yet.',
      checklist: ['Ownership: your name and that you\'re on it', 'Impact confirmed back in their words', 'Two or three specific asks, with exact commands', 'A time for the next update, even with no news', 'No guesses about the cause yet'],
      example: 'Hi Dana, I\'m Sitar from support and I own this case now. I understand dashboards have been empty for all users since 07:00 and operations are blocked, please correct me if it\'s only some users or sites.\n\nTo start right away, could you run these on the main node and paste the output:\n  kubectl get pods -A | grep -v Running\n  df -h\nIf you can, also run the attached triage.sh and send the file.\n\nI\'ll update you by 09:30 at the latest, sooner if I find something.',
    },
    {
      id: '402', day: 5, title: 'Follow-the-sun handover', kind: 'write', pri: 'Handover', tags: ['writing'],
      task: 'Pick ticket 301 or 104. Pretend your shift ended halfway through. Write the note the APAC engineer reads at 03:00 your time, with no way to ask you anything.',
      checklist: ['Case, customer, site, priority', 'Impact: who, since when, workaround', 'State now in one line', 'What was checked, with results', 'What\'s ruled out, and how you know', 'The single next action and its owner', 'Waiting on whom', 'Next update promised at (time + timezone)', 'Attached bundles and key log lines'],
      example: 'CASE:        #4419, customer, site, priority\nIMPACT:      who is affected, since when, workaround?\nSTATE NOW:   one line\nDONE SO FAR: what was checked, with results\nRULED OUT:   and how you know\nNEXT STEP:   the single next action, and who owns it\nWAITING ON:  customer / R&D / nobody\nPROMISED:    next update due at (time + timezone)\nATTACHED:    bundle names, relevant log lines',
    },
    {
      id: '403', day: 5, title: 'Chaos round', pri: 'Timed', priLabel: 'Timed · 30 min', tags: ['end to end'],
      customer: 'Something is wrong with the web service in namespace app since this morning. Nothing changed on our side.',
      task: 'A random fault was injected. You don\'t know which one. Start a 30 minute timer, find it, fix it, then write the case note and the closing message. Press Reset for a new random fault.',
      hints: ['Start from the customer\'s view: <code>kubectl -n app exec client -- wget -qO- web</code>', 'Then work outward: pods, service endpoints, DNS, policies, rollouts.', '<code>kubectl -n app get ep web</code> and <code>kubectl -n app rollout status deploy/web</code> are cheap and tell you a lot.'],
      resolution: '<ul><li><strong>Bad rollout:</strong> new pod ImagePullBackOff, old one still serving. <code>kubectl -n app rollout undo deploy/web</code>.</li><li><strong>Selector drift:</strong> endpoints are empty, connection refused. <code>kubectl -n app patch svc web -p \'{"spec":{"selector":{"app":"web"}}}\'</code>.</li><li><strong>CoreDNS at zero:</strong> "bad address" from every pod. <code>kubectl -n kube-system scale deploy coredns --replicas=1</code>.</li><li><strong>Egress policy:</strong> same symptom as ticket 102. Add the DNS rule or remove the new policy after asking.</li></ul>',
      codespace: 'lab chaos',
      sim: clusterSim({
        help: K8S_HELP,
        setup(c) { const f = CHAOS[Math.floor(Math.random() * CHAOS.length)]; f.apply(c); c.fault = f.id; },
        fixed: (st) => { const w = st.c.deps.find((d) => d.name === 'web'); return webReachable(st.c) && w && Lab.pullable(st.c, w.image) && !w.prevImage; },
      }),
      requireFix: true,
      check: { type: 'choice', q: 'What was the fault?', options: CHAOS.map((x) => x.label), answer: (st) => CHAOS.findIndex((x) => x.id === st.c.fault) },
    },
  ];

  Lab.tickets = tickets;
  Lab.CHAOS = CHAOS;
  Lab.DAYS = [
    { n: 1, title: 'Set up the real lab', blurb: 'Optional, but do it once. The browser simulator covers every ticket on its own.' },
    { n: 2, title: 'Kubernetes tickets', blurb: 'Run the terminal, read only the customer message, solve it, then open the resolution to compare.' },
    { n: 3, title: 'TLS and "can\'t connect"', blurb: 'Customers with internal CAs break TLS in creative ways. Packet captures end arguments.' },
    { n: 4, title: 'Log bundles and triage', blurb: 'Someone sends a huge log bundle and asks what happened. Speed with jq, grep and awk is the job.' },
    { n: 5, title: 'The customer side', blurb: 'The part that\'s actually new compared to DevOps. Write each one for real.' },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
