/* k8s.js - a small simulated single-node k3s cluster plus the node's shell.
   State lives in plain objects so tickets can set up faults and check fixes. */
(function (G) {
  const Lab = (G.Lab = G.Lab || {});
  const fail = (m) => { throw new Lab.ShellError(m); };
  const T = (rows) => Lab.table(rows);

  /* ---------- helpers ---------- */
  const ALPH = 'bcdfghjklmnpqrstvwxz2456789';
  function hash(str, len) {
    let x = 2166136261 >>> 0;
    for (const ch of str) { x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; }
    let o = '';
    for (let i = 0; i < len; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; o += ALPH[(x >>> 8) % ALPH.length]; }
    return o;
  }
  function splitTag(img) { const i = img.lastIndexOf(':'); const s = img.lastIndexOf('/'); return i > s ? [img.slice(0, i), img.slice(i + 1)] : [img, null]; }
  function norm(img) {
    let [name, tag] = splitTag(img); if (!tag) tag = 'latest';
    if (!name.includes('/')) name = 'docker.io/library/' + name;
    else if (!name.split('/')[0].includes('.')) name = 'docker.io/' + name;
    return name + ':' + tag;
  }
  const cname = (img) => splitTag(img)[0].split('/').pop().replace(/^mirrored-/, '').replace(/-coredns$/, '');
  const labelStr = (l) => Object.entries(l || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>';
  const matchSel = (sel, labels) => Object.entries(sel || {}).every(([k, v]) => (labels || {})[k] === v);
  function parseSel(s) {
    if (!s) return null;
    return Object.fromEntries(s.split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2));
  }
  function yaml(v, ind = '') {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return v.map((e) => {
        if (e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length) {
          const y = yaml(e, ind + '  ');
          return '\n' + ind + '- ' + y.replace(/^\n\s*/, '');
        }
        return '\n' + ind + '- ' + yaml(e, ind + '  ');
      }).join('');
    }
    if (typeof v === 'object') {
      const ks = Object.keys(v); if (!ks.length) return '{}';
      return ks.map((k) => {
        const val = v[k];
        const sub = val && typeof val === 'object' && Object.keys(val).length ? yaml(val, ind + '  ') : yaml(val, ind + '  ');
        const isBlock = val && typeof val === 'object' && (Array.isArray(val) ? val.length : Object.keys(val).length);
        return '\n' + ind + k + ':' + (isBlock ? (Array.isArray(val) ? sub.replace(new RegExp('\\n' + ind + '  - ', 'g'), '\n' + ind + '- ') : sub) : ' ' + sub);
      }).join('');
    }
    if (typeof v === 'string') return /^[\w./:@-]+$/.test(v) && !/^(true|false|null|\d+)$/.test(v) ? v : JSON.stringify(v);
    return String(v);
  }
  const toYaml = (o) => yaml(o).replace(/^\n/, '');

  /* ---------- the cluster ---------- */
  Lab.newCluster = function () {
    return {
      node: { name: 'lab-node', ip: '10.0.2.15', pressure: false, version: 'v1.33.4+k3s1' },
      images: new Set([
        'docker.io/library/nginx:1.27-alpine', 'docker.io/library/busybox:1.36',
        'docker.io/rancher/mirrored-coredns-coredns:1.12.3', 'docker.io/rancher/local-path-provisioner:v0.0.31',
        'docker.io/rancher/mirrored-metrics-server:v0.8.0', 'docker.io/rancher/mirrored-pause:3.6',
      ]),
      deps: [
        { ns: 'kube-system', name: 'coredns', image: 'rancher/mirrored-coredns-coredns:1.12.3', replicas: 1, labels: { 'k8s-app': 'kube-dns' }, age: '5d' },
        { ns: 'kube-system', name: 'local-path-provisioner', image: 'rancher/local-path-provisioner:v0.0.31', replicas: 1, labels: { app: 'local-path-provisioner' }, age: '5d' },
        { ns: 'kube-system', name: 'metrics-server', image: 'rancher/mirrored-metrics-server:v0.8.0', replicas: 1, labels: { 'k8s-app': 'metrics-server' }, age: '5d' },
        { ns: 'app', name: 'web', image: 'nginx:1.27-alpine', replicas: 1, labels: { app: 'web' }, age: '3h' },
      ],
      bare: [{ ns: 'app', name: 'client', image: 'busybox:1.36', labels: { run: 'client' }, age: '3h' }],
      evicted: [],
      svcs: [
        { ns: 'default', name: 'kubernetes', ip: '10.43.0.1', port: 443, selector: null, age: '5d' },
        { ns: 'kube-system', name: 'kube-dns', ip: '10.43.0.10', port: 53, proto: 'UDP', selector: { 'k8s-app': 'kube-dns' }, age: '5d' },
        { ns: 'kube-system', name: 'metrics-server', ip: '10.43.91.17', port: 443, selector: { 'k8s-app': 'metrics-server' }, age: '5d' },
        { ns: 'app', name: 'web', ip: '10.43.112.40', port: 80, selector: { app: 'web' }, age: '3h' },
      ],
      netpols: [],
      disk: { blob: false },
      offline: {},
      dmesgExtra: [],
      nodeEvents: [],
      home: {},
      history: [],
    };
  };

  Lab.pullable = (c, img) => { const n = norm(img); return !n.endsWith(':latest') && c.images.has(n); };

  function podsOf(c) {
    const out = [];
    const mk = (o) => {
      o.ip = '10.42.0.' + (10 + (parseInt(hash(o.name, 3), 36) % 200));
      o.container = cname(o.image);
      out.push(o);
      return o;
    };
    for (const d of c.deps) {
      const ok = Lab.pullable(c, d.image);
      const rs = hash(d.name + '|' + d.image, 10);
      if (d.prevImage && !ok) {
        mk({ ns: d.ns, name: `${d.name}-${hash(d.name + '|' + d.prevImage, 10)}-${hash('0' + d.prevImage, 5)}`, dep: d, image: d.prevImage, labels: d.labels, age: d.age, state: 'Running' });
        mk({ ns: d.ns, name: `${d.name}-${rs}-${hash('n' + d.image, 5)}`, dep: d, image: d.image, labels: d.labels, age: '6m', state: 'ImagePullBackOff', fresh: true });
        continue;
      }
      for (let i = 0; i < d.replicas; i++) {
        const base = d.baseReplicas ?? d.replicas;
        let state = 'Running';
        if (!ok) state = 'ImagePullBackOff';
        else if (c.node.pressure && i >= base) state = 'Pending';
        else if (d.oom) state = 'CrashLoopBackOff';
        const fresh = i >= base || !!d.changed;
        mk({ ns: d.ns, name: `${d.name}-${rs}-${hash(i + '|' + d.image + (d.gen || ''), 5)}`, dep: d, image: d.image, labels: d.labels, age: fresh ? (d.freshAge || '4m') : d.age, state, fresh });
      }
    }
    for (const b of c.bare) {
      let state = 'Running';
      if (!Lab.pullable(c, b.image)) state = 'ImagePullBackOff';
      else if (b.oom) state = 'CrashLoopBackOff';
      mk({ ns: b.ns, name: b.name, bare: b, image: b.image, labels: b.labels, age: b.age, state, fresh: !!b.fresh });
    }
    for (const e of c.evicted) out.push({ ns: e.ns, name: e.name, image: e.image || 'nginx:1.27-alpine', container: 'app', age: e.age, state: 'Evicted', evicted: e, labels: {}, ip: '' });
    return out;
  }
  Lab.podsOf = podsOf;

  const READY = { Running: '1/1', ImagePullBackOff: '0/1', Pending: '0/1', CrashLoopBackOff: '0/1', Evicted: '0/1' };
  const restarts = (p) => (p.state === 'CrashLoopBackOff' ? '7 (52s ago)' : '0');

  function endpoints(c, s) {
    if (!s.selector) return s.name === 'kubernetes' ? ['10.0.2.15:6443'] : [];
    return podsOf(c).filter((p) => p.ns === s.ns && p.state === 'Running' && matchSel(s.selector, p.labels)).map((p) => `${p.ip}:${s.targetPort || s.port}`);
  }

  /* network policy evaluation (egress only, which is what these tickets use) */
  function egressAllowed(c, fromNs, dest) {
    const pols = c.netpols.filter((p) => p.metadata.namespace === fromNs && (p.spec.policyTypes || []).includes('Egress'));
    if (!pols.length) return true;
    return pols.some((p) => (p.spec.egress || []).some((r) => {
      const portOk = !r.ports || !r.ports.length || r.ports.some((pt) => +pt.port === dest.port && (pt.protocol || 'TCP') === dest.proto);
      if (!portOk) return false;
      if (!r.to || !r.to.length) return true;
      return r.to.some((peer) => {
        if (peer.ipBlock) return peer.ipBlock.cidr === '0.0.0.0/0';
        const nsOk = peer.namespaceSelector ? matchSel(peer.namespaceSelector.matchLabels, { 'kubernetes.io/metadata.name': dest.ns }) : dest.ns === fromNs;
        const podOk = peer.podSelector ? matchSel(peer.podSelector.matchLabels, dest.labels) : true;
        return nsOk && podOk;
      });
    }));
  }
  function dnsOk(c, fromNs) {
    const dns = podsOf(c).filter((p) => p.ns === 'kube-system' && p.labels['k8s-app'] === 'kube-dns' && p.state === 'Running');
    if (!dns.length) return false;
    return egressAllowed(c, fromNs, { ns: 'kube-system', labels: { 'k8s-app': 'kube-dns' }, port: 53, proto: 'UDP' });
  }
  Lab.dnsOk = dnsOk;

  /* what a pod in fromNs gets when it opens host:port */
  function connect(c, fromNs, host, port) {
    let svc = null, ip = host;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const parts = host.split('.');
      const name = parts[0], ns = parts[1] && parts[1] !== 'svc' ? parts[1] : (parts.length === 1 ? fromNs : fromNs);
      const internal = parts.length === 1 || /\.svc(\.cluster\.local)?$/.test(host) || parts.length === 2;
      if (!dnsOk(c, fromNs)) return { err: 'dns' };
      svc = internal ? c.svcs.find((s) => s.name === name && s.ns === ns) : null;
      if (!svc) return { err: 'nxdomain' };
      ip = svc.ip;
    } else {
      svc = c.svcs.find((s) => s.ip === host) || null;
    }
    const pod = svc ? null : podsOf(c).find((p) => p.ip === host);
    if (!svc && !pod) return { err: 'timeout', ip };
    if (svc) {
      const ep = podsOf(c).filter((p) => p.ns === svc.ns && p.state === 'Running' && matchSel(svc.selector, p.labels));
      if (!ep.length) return { err: 'refused', ip };
      if (!egressAllowed(c, fromNs, { ns: svc.ns, labels: ep[0].labels, port: svc.targetPort || svc.port, proto: 'TCP' })) return { err: 'timeout', ip };
      return { ok: true, ip, target: ep[0] };
    }
    if (pod.state !== 'Running') return { err: 'refused', ip };
    if (!egressAllowed(c, fromNs, { ns: pod.ns, labels: pod.labels, port: port || 80, proto: 'TCP' })) return { err: 'timeout', ip };
    return { ok: true, ip, target: pod };
  }
  Lab.connect = connect;

  const NGINX_HTML = '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n<style>\nhtml { color-scheme: light dark; }';

  /* ---------- kubectl ---------- */
  const KINDS = {
    po: 'pods', pod: 'pods', pods: 'pods', deploy: 'deployments', deployment: 'deployments', deployments: 'deployments',
    svc: 'services', service: 'services', services: 'services', ep: 'endpoints', endpoints: 'endpoints',
    netpol: 'networkpolicies', networkpolicy: 'networkpolicies', networkpolicies: 'networkpolicies',
    no: 'nodes', node: 'nodes', nodes: 'nodes', ev: 'events', event: 'events', events: 'events',
    ns: 'namespaces', namespace: 'namespaces', namespaces: 'namespaces', all: 'all',
    rs: 'replicasets', replicaset: 'replicasets', replicasets: 'replicasets',
  };
  const SINGULAR = { pods: 'pod', deployments: 'deployment.apps', services: 'service', endpoints: 'endpoints', networkpolicies: 'networkpolicy.networking.k8s.io', nodes: 'node', namespaces: 'namespace' };

  function parseArgs(argv) {
    const a = { pos: [], ns: null, all: false, out: null, sel: null, flags: {}, after: null };
    const verb = argv[1];
    for (let i = 2; i < argv.length; i++) {
      const t = argv[i];
      if (t === '--') { a.after = argv.slice(i + 1); break; }
      const kv = t.match(/^--([\w-]+)=(.*)$/);
      if (kv) {
        const [, k, v] = kv;
        if (k === 'namespace') a.ns = v; else if (k === 'output') a.out = v; else if (k === 'selector') a.sel = v; else a.flags[k] = v;
        continue;
      }
      if (t === '-n' || t === '--namespace') { a.ns = argv[++i]; continue; }
      if (/^-n\S+/.test(t) && !t.startsWith('--')) { a.ns = t.slice(2); continue; }
      if (t === '-A' || t === '--all-namespaces') { a.all = true; continue; }
      if (t === '-o' || t === '--output') { a.out = argv[++i]; continue; }
      if (/^-o\S+/.test(t)) { a.out = t.slice(2); continue; }
      if (t === '-l' || t === '--selector') { a.sel = argv[++i]; continue; }
      if (t === '-p' && verb === 'patch') { a.flags.patch = argv[++i]; continue; }
      if (t === '-p' || t === '--previous') { a.flags.previous = true; continue; }
      if (t === '-c' || t === '--container') { a.flags.container = argv[++i]; continue; }
      if (t === '--replicas') { a.flags.replicas = argv[++i]; continue; }
      if (t === '--type') { a.flags.type = argv[++i]; continue; }
      if (t === '-f' || t === '--filename') { a.flags.file = argv[++i] ?? ''; continue; }
      if (t === '--tail') { a.flags.tail = argv[++i]; continue; }
      if (t === '--image') { a.flags.image = argv[++i]; continue; }
      if (/^-[itwqF]+$/.test(t) || t === '--watch' || t === '--show-labels' || t === '--no-headers' || t === '--force' || t === '--now') { if (t === '--show-labels') a.flags.showLabels = true; if (t === '--no-headers') a.flags.noHeaders = true; continue; }
      a.pos.push(t);
    }
    return a;
  }

  function resolveTarget(a) {
    // returns {kind, names[]}
    let kind = null, names = [];
    const p = a.pos.slice();
    if (!p.length) return { kind: null, names };
    if (p[0].includes('/')) {
      for (const x of p) { const [k, n] = x.split('/'); kind = KINDS[k.toLowerCase()] || KINDS[k.toLowerCase().replace(/\.\w+.*$/, '')]; if (!kind) fail(`error: the server doesn't have a resource type "${k}"`); names.push(n); }
      return { kind, names };
    }
    const kinds = p[0].split(',');
    kind = KINDS[kinds[0].toLowerCase()];
    if (!kind) fail(`error: the server doesn't have a resource type "${p[0]}"`);
    return { kind, names: p.slice(1), multi: kinds.length > 1 ? kinds.map((k) => KINDS[k]) : null };
  }

  const nsOf = (a) => a.ns || 'default';

  function podObj(c, p) {
    const d = p.dep, b = p.bare;
    const lim = (d && d.memLimit) || (b && b.memLimit);
    const policy = norm(p.image).endsWith(':latest') ? 'Always' : 'IfNotPresent';
    const st = {};
    if (p.state === 'Running') st.state = { running: { startedAt: '2026-10-03T07:12:44Z' } };
    else if (p.state === 'ImagePullBackOff') st.state = { waiting: { reason: 'ImagePullBackOff', message: `Back-off pulling image "${p.image}"` } };
    else if (p.state === 'CrashLoopBackOff') { st.state = { waiting: { reason: 'CrashLoopBackOff' } }; st.lastState = { terminated: { exitCode: 137, reason: 'OOMKilled' } }; }
    return {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: p.name, namespace: p.ns, labels: p.labels },
      spec: {
        containers: [{ name: p.container, image: p.image, imagePullPolicy: policy, ...(lim ? { resources: { limits: { memory: lim } } } : {}), ...((d && d.cmd) || (b && b.cmd) ? { command: (d && d.cmd) || b.cmd } : {}) }],
        nodeName: p.state === 'Pending' ? undefined : c.node.name,
        restartPolicy: b && b.restartPolicy ? b.restartPolicy : 'Always',
      },
      status: {
        phase: p.state === 'Running' || p.state === 'CrashLoopBackOff' ? 'Running' : p.state === 'Evicted' ? 'Failed' : 'Pending',
        ...(p.evicted ? { reason: 'Evicted', message: p.evicted.msg } : {}),
        podIP: p.state === 'Pending' || p.state === 'Evicted' ? undefined : p.ip,
        containerStatuses: p.state === 'Pending' || p.state === 'Evicted' ? undefined : [{ name: p.container, image: p.image, ready: p.state === 'Running', restartCount: p.state === 'CrashLoopBackOff' ? 7 : 0, ...st }],
      },
    };
  }
  const clean = (o) => JSON.parse(JSON.stringify(o));

  function podEvents(c, p) {
    if (p.state === 'Running' && !p.fresh) return [];
    const ev = [];
    const cn = p.container;
    if (p.state === 'Pending') {
      ev.push(['Warning', 'FailedScheduling', '3m (x4 over 4m)', 'default-scheduler', '0/1 nodes are available: 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }. preemption: 0/1 nodes are available: 1 Preemption is not helpful for scheduling.']);
      return ev;
    }
    ev.push(['Normal', 'Scheduled', '6m', 'default-scheduler', `Successfully assigned ${p.ns}/${p.name} to ${c.node.name}`]);
    if (p.state === 'ImagePullBackOff') {
      const n = norm(p.image); const [repo, tag] = splitTag(n); const path = repo.replace('docker.io/', '');
      ev.push(['Normal', 'Pulling', '3m (x5 over 6m)', 'kubelet', `Pulling image "${p.image}"`]);
      ev.push(['Warning', 'Failed', '3m (x5 over 6m)', 'kubelet', `Failed to pull image "${p.image}": failed to pull and unpack image "${n}": failed to resolve reference "${n}": failed to do request: Head "https://registry-1.docker.io/v2/${path}/manifests/${tag}": dial tcp: lookup registry-1.docker.io on 10.0.2.3:53: server misbehaving`]);
      ev.push(['Warning', 'Failed', '3m (x5 over 6m)', 'kubelet', 'Error: ErrImagePull']);
      ev.push(['Normal', 'BackOff', '62s (x21 over 6m)', 'kubelet', `Back-off pulling image "${p.image}"`]);
      ev.push(['Warning', 'Failed', '62s (x21 over 6m)', 'kubelet', 'Error: ImagePullBackOff']);
      return ev;
    }
    ev.push(['Normal', 'Pulled', p.state === 'CrashLoopBackOff' ? '2m (x8 over 9m)' : '6m', 'kubelet', `Container image "${p.image}" already present on machine`]);
    ev.push(['Normal', 'Created', p.state === 'CrashLoopBackOff' ? '2m (x8 over 9m)' : '6m', 'kubelet', `Created container: ${cn}`]);
    ev.push(['Normal', 'Started', p.state === 'CrashLoopBackOff' ? '2m (x8 over 9m)' : '6m', 'kubelet', `Started container ${cn}`]);
    if (p.state === 'CrashLoopBackOff') ev.push(['Warning', 'BackOff', '12s (x31 over 8m)', 'kubelet', `Back-off restarting failed container ${cn} in pod ${p.name}_${p.ns}(${hash(p.name, 8)}-${hash(p.name + 'u', 4)})`]);
    return ev;
  }

  function eventsTable(ev, header = true) {
    if (!ev.length) return 'Events:                      <none>';
    return 'Events:\n' + T([['  Type', 'Reason', 'Age', 'From', 'Message'], ['  ----', '------', '----', '----', '-------'], ...ev.map((e) => ['  ' + e[0], e[1], e[2], e[3], e[4]])]);
  }

  function describePod(c, p) {
    const o = podObj(c, p); const cs = (o.status.containerStatuses || [])[0];
    const lim = o.spec.containers[0].resources;
    const L = [];
    L.push(`Name:             ${p.name}`, `Namespace:        ${p.ns}`, 'Priority:         0', 'Service Account:  default');
    L.push(`Node:             ${p.state === 'Pending' ? '<none>' : c.node.name + '/' + c.node.ip}`);
    L.push(`Labels:           ${Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join('\n                  ') || '<none>'}`);
    L.push(`Status:           ${p.state === 'Evicted' ? 'Failed' : o.status.phase}`);
    if (p.evicted) L.push('Reason:           Evicted', `Message:          ${p.evicted.msg}`);
    L.push(`IP:               ${o.status.podIP || ''}`);
    if (p.dep) L.push(`Controlled By:    ReplicaSet/${p.name.split('-').slice(0, -1).join('-')}`);
    L.push('Containers:', `  ${p.container}:`, `    Image:          ${p.image}`);
    if (o.spec.containers[0].command) L.push('    Command:', ...o.spec.containers[0].command.map((x) => '      ' + x));
    if (p.state === 'Running') L.push('    State:          Running', '      Started:      Sat, 03 Oct 2026 07:12:44 +0000', '    Ready:          True', '    Restart Count:  0');
    else if (p.state === 'ImagePullBackOff') L.push('    State:          Waiting', '      Reason:       ImagePullBackOff', '    Ready:          False', '    Restart Count:  0');
    else if (p.state === 'CrashLoopBackOff') L.push('    State:          Waiting', '      Reason:       CrashLoopBackOff', '    Last State:     Terminated', '      Reason:       OOMKilled', '      Exit Code:    137', '      Started:      Sat, 03 Oct 2026 09:58:41 +0000', '      Finished:     Sat, 03 Oct 2026 09:58:47 +0000', '    Ready:          False', '    Restart Count:  7');
    else if (p.state === 'Pending') L.push('    State:          Waiting', '      Reason:       ContainerCreating', '    Ready:          False', '    Restart Count:  0');
    else L.push('    State:          Terminated', '      Reason:       ContainerStatusUnknown', '      Exit Code:    137', '    Ready:          False');
    if (lim) L.push('    Limits:', `      memory:  ${lim.limits.memory}`, '    Requests:', `      memory:     ${lim.limits.memory}`);
    L.push(`    Environment:    <none>`);
    L.push('Conditions:', '  Type                        Status');
    const rdy = p.state === 'Running' ? 'True' : 'False';
    L.push(`  PodScheduled                ${p.state === 'Pending' ? 'False' : 'True'}`, `  Initialized                 True`, `  Ready                       ${rdy}`, `  ContainersReady             ${rdy}`);
    L.push(`QoS Class:                   ${lim ? 'Burstable' : 'BestEffort'}`);
    L.push('Tolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s', '                             node.kubernetes.io/unreachable:NoExecute op=Exists for 300s');
    if (p.evicted) L.push(eventsTable([['Warning', 'Evicted', '9m', 'kubelet', p.evicted.msg], ['Normal', 'Killing', '9m', 'kubelet', `Stopping container ${p.container}`]]));
    else L.push(eventsTable(podEvents(c, p)));
    return L.join('\n');
  }

  function describeNode(c) {
    const pr = c.node.pressure;
    const L = [`Name:               ${c.node.name}`, 'Roles:              control-plane,master', 'Labels:             kubernetes.io/hostname=lab-node', '                    node-role.kubernetes.io/control-plane=true',
      `CreationTimestamp:  Mon, 28 Sep 2026 08:01:12 +0000`, `Taints:             ${pr ? 'node.kubernetes.io/disk-pressure:NoSchedule' : '<none>'}`, 'Unschedulable:      false', 'Conditions:',
      T([['  Type', 'Status', 'LastHeartbeatTime', 'Reason', 'Message'], ['  ----', '------', '-----------------', '------', '-------'],
        ['  MemoryPressure', 'False', 'Sat, 03 Oct 2026 10:01:02 +0000', 'KubeletHasSufficientMemory', 'kubelet has sufficient memory available'],
        ['  DiskPressure', pr ? 'True' : 'False', 'Sat, 03 Oct 2026 10:01:02 +0000', pr ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure', pr ? 'kubelet has disk pressure' : 'kubelet has no disk pressure'],
        ['  PIDPressure', 'False', 'Sat, 03 Oct 2026 10:01:02 +0000', 'KubeletHasSufficientPID', 'kubelet has sufficient PID available'],
        ['  Ready', 'True', 'Sat, 03 Oct 2026 10:01:02 +0000', 'KubeletReady', 'kubelet is posting ready status']]),
      'Addresses:', `  InternalIP:  ${c.node.ip}`, '  Hostname:    lab-node', 'Capacity:', '  cpu:                2', '  ephemeral-storage:  20403592Ki', '  memory:             4005016Ki', '  pods:               110',
      'System Info:', '  OS Image:                   Ubuntu 24.04.3 LTS', '  Container Runtime Version:  containerd://2.0.5-k3s2', `  Kubelet Version:            ${c.node.version}`];
    const pods = podsOf(c).filter((p) => p.state !== 'Pending' && p.state !== 'Evicted');
    L.push(`Non-terminated Pods:          (${pods.length} in total)`);
    L.push(T([['  Namespace', 'Name', 'Memory Limits', 'Age'], ['  ---------', '----', '-------------', '---'], ...pods.map((p) => ['  ' + p.ns, p.name, (p.dep && p.dep.memLimit) || (p.bare && p.bare.memLimit) || '0 (0%)', p.age])]));
    const ev = pr ? [
      ['Warning', 'FreeDiskSpaceFailed', '8m', 'kubelet', 'Failed to garbage collect required amount of images. Attempted to free 3214983168 bytes, but only found 0 bytes eligible to free.'],
      ['Warning', 'EvictionThresholdMet', '8m', 'kubelet', 'Attempting to reclaim ephemeral-storage'],
      ['Normal', 'NodeHasDiskPressure', '8m', 'kubelet', 'Node lab-node status is now: NodeHasDiskPressure'],
    ] : c.nodeEvents;
    L.push(eventsTable(ev));
    return L.join('\n');
  }

  function describeNetpol(p) {
    const s = p.spec; const L = [`Name:         ${p.metadata.name}`, `Namespace:    ${p.metadata.namespace}`, 'Created on:   2026-10-03 07:58:12 +0000 UTC', 'Labels:       <none>', 'Annotations:  <none>', 'Spec:'];
    L.push(`  PodSelector:     ${labelStr(s.podSelector && s.podSelector.matchLabels) === '<none>' ? '<none> (Allowing the specific traffic to all pods in this namespace)' : labelStr(s.podSelector.matchLabels)}`);
    const types = s.policyTypes || [];
    L.push(types.includes('Ingress') ? '  Allowing ingress traffic:\n    <none> (Selected pods are isolated for ingress connectivity)' : '  Not affecting ingress traffic');
    if (types.includes('Egress')) {
      L.push('  Allowing egress traffic:');
      const eg = s.egress || [];
      if (!eg.length) L.push('    <none> (Selected pods are isolated for egress connectivity)');
      eg.forEach((r, i) => {
        if (i) L.push('    ----------');
        if (!r.ports || !r.ports.length) L.push('    To Port: <any> (traffic allowed to all ports)');
        else r.ports.forEach((pt) => L.push(`    To Port: ${pt.port}/${pt.protocol || 'TCP'}`));
        if (!r.to || !r.to.length) L.push('    To: <any> (traffic not restricted by destination)');
        else { L.push('    To:'); r.to.forEach((peer) => { if (peer.namespaceSelector) L.push(`      NamespaceSelector: ${labelStr(peer.namespaceSelector.matchLabels)}`); if (peer.podSelector) L.push(`      PodSelector: ${labelStr(peer.podSelector.matchLabels)}`); }); }
      });
    }
    L.push(`  Policy Types: ${types.join(', ')}`);
    return L.join('\n');
  }

  function findPods(c, a, ns, names) {
    let pods = podsOf(c).filter((p) => a.all || p.ns === ns);
    if (a.sel) { const s = parseSel(a.sel); pods = pods.filter((p) => matchSel(s, p.labels)); }
    if (a.flags['field-selector']) { const m = a.flags['field-selector'].match(/status\.phase(!?=+)(\w+)/); if (m) pods = pods.filter((p) => { const ph = p.state === 'Evicted' ? 'Failed' : p.state === 'Pending' || p.state === 'ImagePullBackOff' ? 'Pending' : 'Running'; return m[1].startsWith('!') ? ph !== m[2] : ph === m[2]; }); }
    if (names && names.length) {
      return names.map((n) => { const p = pods.find((x) => x.name === n); if (!p) fail(`Error from server (NotFound): pods "${n}" not found`); return p; });
    }
    return pods;
  }

  function podFromRef(c, a, ref) {
    const ns = nsOf(a);
    if (ref.includes('/')) {
      const [k, n] = ref.split('/'); const kind = KINDS[k];
      if (kind === 'deployments') { const p = podsOf(c).find((x) => x.ns === ns && x.dep && x.dep.name === n && x.state === 'Running') || podsOf(c).find((x) => x.ns === ns && x.dep && x.dep.name === n); if (!p) fail(`Error from server (NotFound): deployments.apps "${n}" not found`); return p; }
      if (kind === 'pods') ref = n; else fail(`error: cannot attach to ${k}`);
    }
    const p = podsOf(c).find((x) => x.ns === ns && x.name === ref);
    if (!p) fail(`Error from server (NotFound): pods "${ref}" not found` + (ns === 'default' && podsOf(c).some((x) => x.name === ref) ? '\n(Hint: that pod lives in another namespace. Add -n <namespace>.)' : ''));
    return p;
  }

  function getList(c, a, kind, names) {
    const ns = nsOf(a); const all = a.all; const wide = a.out === 'wide';
    const nsCol = (row, item) => (all ? [item.ns || item.metadata.namespace, ...row] : row);
    const head = (row) => (all ? ['NAMESPACE', ...row] : row);
    const objFmt = a.out && /^(json|yaml|name)$/.test(a.out);
    const notFound = (what) => (all ? 'No resources found' : `No resources found in ${ns} namespace.`);
    switch (kind) {
      case 'pods': {
        const pods = findPods(c, a, ns, names);
        if (objFmt) return pods.map((p) => clean(podObj(c, p)));
        if (!pods.length) return notFound();
        const hdr = ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : []), ...(a.flags.showLabels ? ['LABELS'] : [])];
        const rows = pods.map((p) => nsCol([p.name, READY[p.state], p.state, restarts(p), p.age, ...(wide ? [p.state === 'Pending' || p.state === 'Evicted' ? '<none>' : p.ip, p.state === 'Pending' ? '<none>' : c.node.name, '<none>', '<none>'] : []), ...(a.flags.showLabels ? [labelStr(p.labels)] : [])], p));
        return T(a.flags.noHeaders ? rows : [head(hdr), ...rows]);
      }
      case 'deployments': case 'replicasets': {
        let ds = c.deps.filter((d) => all || d.ns === ns);
        if (names.length) ds = names.map((n) => { const d = ds.find((x) => x.name === n); if (!d) fail(`Error from server (NotFound): deployments.apps "${n}" not found`); return d; });
        if (a.sel) { const s = parseSel(a.sel); ds = ds.filter((d) => matchSel(s, d.labels)); }
        const pods = podsOf(c);
        const ready = (d) => pods.filter((p) => p.dep === d && p.state === 'Running').length;
        if (objFmt) return ds.map((d) => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: d.name, namespace: d.ns, labels: d.labels }, spec: { replicas: d.replicas, selector: { matchLabels: d.labels }, template: { metadata: { labels: d.labels }, spec: { containers: [{ name: cname(d.image), image: d.image, ...(d.memLimit ? { resources: { limits: { memory: d.memLimit } } } : {}) }] } } }, status: { replicas: d.replicas, readyReplicas: ready(d) } }));
        if (!ds.length) return notFound();
        if (kind === 'replicasets') return T([head(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE']), ...ds.map((d) => nsCol([`${d.name}-${hash(d.name + '|' + d.image, 10)}`, d.replicas, d.replicas, ready(d), d.changed ? '4m' : d.age], d))]);
        return T([head(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])]), ...ds.map((d) => {
          const r = ready(d); const upd = d.prevImage && !Lab.pullable(c, d.image) ? 1 : pods.filter((p) => p.dep === d && p.state === 'Running').length;
          return nsCol([d.name, `${r}/${d.replicas}`, upd, r, d.age, ...(wide ? [cname(d.image), d.image, labelStr(d.labels)] : [])], d);
        })]);
      }
      case 'services': {
        let ss = c.svcs.filter((s) => all || s.ns === ns);
        if (names.length) ss = names.map((n) => { const s = ss.find((x) => x.name === n); if (!s) fail(`Error from server (NotFound): services "${n}" not found`); return s; });
        if (objFmt) return ss.map((s) => ({ apiVersion: 'v1', kind: 'Service', metadata: { name: s.name, namespace: s.ns }, spec: { type: 'ClusterIP', clusterIP: s.ip, ports: [{ port: s.port, protocol: s.proto || 'TCP', targetPort: s.targetPort || s.port }], selector: s.selector || undefined } }));
        if (!ss.length) return notFound();
        return T([head(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : [])]), ...ss.map((s) => nsCol([s.name, 'ClusterIP', s.ip, '<none>', `${s.port}/${s.proto || 'TCP'}${s.name === 'kube-dns' ? ',53/TCP,9153/TCP' : ''}`, s.age, ...(wide ? [labelStr(s.selector)] : [])], s))]);
      }
      case 'endpoints': {
        let ss = c.svcs.filter((s) => all || s.ns === ns);
        if (names.length) ss = names.map((n) => { const s = ss.find((x) => x.name === n); if (!s) fail(`Error from server (NotFound): endpoints "${n}" not found`); return s; });
        if (objFmt) return ss.map((s) => ({ apiVersion: 'v1', kind: 'Endpoints', metadata: { name: s.name, namespace: s.ns }, subsets: endpoints(c, s).length ? [{ addresses: endpoints(c, s).map((e) => ({ ip: e.split(':')[0] })) }] : undefined }));
        const out = T([head(['NAME', 'ENDPOINTS', 'AGE']), ...ss.map((s) => nsCol([s.name, endpoints(c, s).join(',') || '<none>', s.age], s))]);
        return 'Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice\n' + out;
      }
      case 'networkpolicies': {
        let ps = c.netpols.filter((p) => all || p.metadata.namespace === ns);
        if (names.length) ps = names.map((n) => { const p = ps.find((x) => x.metadata.name === n); if (!p) fail(`Error from server (NotFound): networkpolicies.networking.k8s.io "${n}" not found`); return p; });
        if (objFmt) return ps.map((p) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', ...clean(p) }));
        if (!ps.length) return notFound();
        return T([head(['NAME', 'POD-SELECTOR', 'AGE']), ...ps.map((p) => nsCol([p.metadata.name, labelStr(p.spec.podSelector && p.spec.podSelector.matchLabels), p.age || '2h'], p))]);
      }
      case 'nodes':
        if (objFmt) return [{ apiVersion: 'v1', kind: 'Node', metadata: { name: c.node.name }, spec: c.node.pressure ? { taints: [{ key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule' }] } : {}, status: { conditions: [{ type: 'DiskPressure', status: c.node.pressure ? 'True' : 'False' }, { type: 'Ready', status: 'True' }] } }];
        return T([['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'] : [])], [c.node.name, 'Ready', 'control-plane,master', '5d', c.node.version, ...(wide ? [c.node.ip, '<none>', 'Ubuntu 24.04.3 LTS', '6.8.0-79-generic', 'containerd://2.0.5-k3s2'] : [])]]);
      case 'namespaces':
        return T([['NAME', 'STATUS', 'AGE'], ['app', 'Active', '3h'], ['default', 'Active', '5d'], ['kube-node-lease', 'Active', '5d'], ['kube-public', 'Active', '5d'], ['kube-system', 'Active', '5d']]);
      case 'events': {
        const rows = [];
        podsOf(c).filter((p) => all || p.ns === ns).forEach((p) => podEvents(c, p).forEach((e) => rows.push({ ns: p.ns, row: [e[2].split(' ')[0], e[0], e[1], 'pod/' + p.name, e[4]] })));
        if (c.node.pressure && (all || ns === 'default')) rows.push({ ns: 'default', row: ['8m', 'Warning', 'EvictionThresholdMet', 'node/lab-node', 'Attempting to reclaim ephemeral-storage'] });
        c.evicted.filter((e) => all || e.ns === ns).forEach((e) => rows.push({ ns: e.ns, row: ['9m', 'Warning', 'Evicted', 'pod/' + e.name, e.msg] }));
        if (!rows.length) return notFound();
        return T([head(['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE']), ...rows.map((r) => (all ? [r.ns, ...r.row] : r.row))]);
      }
      case 'all': {
        const parts = [getList(c, a, 'pods', []), getList(c, a, 'services', []), getList(c, a, 'deployments', [])];
        return parts.filter((x) => typeof x === 'string' && !x.startsWith('No resources')).join('\n\n') || notFound();
      }
    }
    fail(`error: the server doesn't have a resource type "${kind}"`);
  }

  function render(a, list, kind, single) {
    if (typeof list === 'string') return list;
    if (a.out === 'name') return list.map((o) => `${(SINGULAR[kind] || kind)}/${o.metadata.name}`).join('\n');
    const obj = single && list.length === 1 ? list[0] : { apiVersion: 'v1', kind: 'List', items: list, metadata: { resourceVersion: '' } };
    return a.out === 'json' ? JSON.stringify(obj, null, 4) : toYaml(obj);
  }

  function applyPatch(target, a) {
    const raw = a.flags.patch;
    if (!raw) fail('error: must specify -p to patch');
    let p; try { p = JSON.parse(raw); } catch (e) { fail('error: unable to parse "' + raw.slice(0, 40) + '": yaml: did not find expected node content\n(Check your quotes. Wrap the whole patch in single quotes.)'); }
    if ((a.flags.type || '') === 'json') {
      if (!Array.isArray(p)) fail('error: unable to parse JSON patch: expected an array of operations');
      for (const op of p) {
        const parts = op.path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
        let o = target;
        for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] === undefined) fail(`The request is invalid: the server rejected our request due to an error in our request (path ${op.path} doesn't exist)`); o = o[parts[i]]; }
        const last = parts[parts.length - 1];
        if (op.op === 'add') { if (Array.isArray(o)) { if (last === '-') o.push(op.value); else o.splice(+last, 0, op.value); } else o[last] = op.value; }
        else if (op.op === 'replace') o[last] = op.value;
        else if (op.op === 'remove') { if (Array.isArray(o)) o.splice(+last, 1); else delete o[last]; }
        else fail(`error: op "${op.op}" isn't supported here`);
      }
      return;
    }
    const merge = (t, s) => { for (const [k, v] of Object.entries(s)) { if (v === null) delete t[k]; else if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) merge(t[k], v); else t[k] = v; } };
    merge(target, p);
  }

  function execInPod(c, p, cmd) {
    if (p.state !== 'Running') fail(`error: unable to upgrade connection: container not found ("${p.container}")`);
    if (!cmd || !cmd.length) fail('error: you must specify at least one command for the container');
    let argv = cmd.slice();
    if ((argv[0] === 'sh' || argv[0] === '/bin/sh' || argv[0] === 'bash') && argv[1] === '-c') argv = Lab.tokenize(argv.slice(2).join(' '));
    if (argv[0] === 'sh' || argv[0] === 'bash' || argv[0] === '/bin/sh') return '(Interactive shells aren\'t supported in the browser. Run single commands: kubectl exec client -- wget -qO- web)';
    if (argv[0] === 'bash') fail('OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown\ncommand terminated with exit code 126');
    const from = p.ns;
    const errMsg = (r, host, tool) => {
      if (r.err === 'dns') return tool === 'nslookup' ? ';; connection timed out; no servers could be reached\n\ncommand terminated with exit code 1' : `wget: bad address '${host}'\ncommand terminated with exit code 1`;
      if (r.err === 'nxdomain') return tool === 'nslookup' ? `Server:\t\t10.43.0.10\nAddress:\t10.43.0.10:53\n\n** server can't find ${host}.${from}.svc.cluster.local: NXDOMAIN\n\ncommand terminated with exit code 1` : `wget: bad address '${host}'\ncommand terminated with exit code 1`;
      if (r.err === 'refused') return `wget: can't connect to remote host (${r.ip}): Connection refused\ncommand terminated with exit code 1`;
      return 'wget: download timed out\ncommand terminated with exit code 1';
    };
    switch (argv[0]) {
      case 'wget': case 'curl': {
        const url = argv.slice(1).filter((x) => !x.startsWith('-') && x !== '-' && !/^\d+$/.test(x)).pop();
        if (!url) fail('BusyBox v1.36.1 multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-T SEC] URL...');
        if (argv[0] === 'curl' && p.container === 'busybox') return 'sh: curl: not found\ncommand terminated with exit code 127';
        const m = url.replace(/^https?:\/\//, '').match(/^([^/:]+)(?::(\d+))?/);
        const host = m[1], port = m[2] ? +m[2] : 80;
        if (/\.(com|io|org|net)$/.test(host)) return `wget: bad address '${host}'\ncommand terminated with exit code 1\n(Air-gapped: there is no route or DNS to the internet from this site.)`;
        const r = connect(c, from, host, port);
        if (!r.ok) return errMsg(r, host, 'wget');
        if (argv.includes('--spider')) return `Connecting to ${host} (${r.ip}:${port})\nremote file exists`;
        const q = argv.some((x) => /^-q/.test(x) || x === '-qO-' || x === '-qO');
        return (q ? '' : `Connecting to ${host} (${r.ip}:${port})\nwriting to stdout\n`) + NGINX_HTML + '\n...' + (q ? '' : '\nwritten to stdout');
      }
      case 'nslookup': {
        const host = argv[1]; if (!host) fail('Usage: nslookup HOST [DNS_SERVER]');
        if (!dnsOk(c, from)) return errMsg({ err: 'dns' }, host, 'nslookup');
        const parts = host.split('.'); const name = parts[0]; const ns = parts[1] && parts[1] !== 'svc' ? parts[1] : from;
        const s = c.svcs.find((x) => x.name === name && x.ns === ns);
        if (!s) return errMsg({ err: 'nxdomain' }, host, 'nslookup');
        return `Server:\t\t10.43.0.10\nAddress:\t10.43.0.10:53\n\nName:\t${s.name}.${s.ns}.svc.cluster.local\nAddress: ${s.ip}\n`;
      }
      case 'nc': {
        const pos = argv.slice(1).filter((x) => !x.startsWith('-'));
        const [host, port] = pos; if (!host || !port) fail('Usage: nc [-zv] HOST PORT');
        if (!/^\d+\.\d+/.test(host) && !dnsOk(c, from)) return `nc: bad address '${host}'\ncommand terminated with exit code 1`;
        const r = connect(c, from, host, +port);
        if (r.err === 'nxdomain') return `nc: bad address '${host}'\ncommand terminated with exit code 1`;
        if (!r.ok) return r.err === 'refused' ? `nc: ${host} (${r.ip}:${port}): Connection refused\ncommand terminated with exit code 1` : `nc: ${host} (${r.ip}:${port}): Connection timed out\ncommand terminated with exit code 1`;
        return `${host} (${r.ip}:${port}) open`;
      }
      case 'ping': return `PING ${argv[1]} (${argv[1]}): 56 data bytes\n\n--- ${argv[1]} ping statistics ---\n4 packets transmitted, 0 packets received, 100% packet loss\ncommand terminated with exit code 1\n(ClusterIPs never answer ping. Use wget or nc to test a service.)`;
      case 'cat':
        if (argv[1] === '/etc/resolv.conf') return `search ${from}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.43.0.10\noptions ndots:5`;
        if (argv[1] === '/etc/hosts') return `127.0.0.1\tlocalhost\n${p.ip}\t${p.name}`;
        return `cat: can't open '${argv[1]}': No such file or directory\ncommand terminated with exit code 1`;
      case 'env': return `HOSTNAME=${p.name}\nKUBERNETES_SERVICE_HOST=10.43.0.1\nKUBERNETES_SERVICE_PORT=443\nWEB_SERVICE_HOST=10.43.112.40\nWEB_SERVICE_PORT=80`;
      case 'hostname': return p.name;
      case 'ls': return 'bin   dev   etc   home  lib   proc  root  sys   tmp   usr   var';
      case 'ip': return `2: eth0@if14: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 1450 qdisc noqueue\n    inet ${p.ip}/24 brd 10.42.0.255 scope global eth0`;
    }
    return `OCI runtime exec failed: exec failed: unable to start container process: exec: "${argv[0]}": executable file not found in $PATH: unknown\ncommand terminated with exit code 127`;
  }

  function logsOf(c, p, a) {
    if (p.state === 'ImagePullBackOff') fail(`Error from server (BadRequest): container "${p.container}" in pod "${p.name}" is waiting to start: trying and failing to pull image`);
    if (p.state === 'Pending') fail(`Error from server (BadRequest): container "${p.container}" in pod "${p.name}" is waiting to start: ContainerCreating`);
    if (p.state === 'Evicted') fail(`Error from server (BadRequest): container "${p.container}" in pod "${p.name}" is terminated`);
    const own = (p.dep && p.dep.logs) || (p.bare && p.bare.logs);
    if (own) return typeof own === 'function' ? own(a) : own;
    if (a.flags.previous) fail(`Error from server (BadRequest): previous terminated container "${p.container}" in pod "${p.name}" not found`);
    if (p.container === 'nginx') return [
      '/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration',
      '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh',
      '/docker-entrypoint.sh: Configuration complete; ready for start up',
      '2026/10/03 07:12:44 [notice] 1#1: nginx/1.27.5', '2026/10/03 07:12:44 [notice] 1#1: start worker processes',
      '10.42.0.1 - - [03/Oct/2026:09:41:17 +0000] "GET / HTTP/1.1" 200 615 "-" "kube-probe/1.33" "-"',
    ].join('\n');
    if (p.container === 'coredns') return '.:53\n[INFO] plugin/reload: Running configuration SHA512 = b941b080e5322f6519009bb49349462c7ddb6317425b0f6a83e5451175b720703949e3f3b454a24e77f3ffe57fd5e9c6130e528a5a1dd00d9000e4afd6c1108d\nCoreDNS-1.12.3\nlinux/amd64, go1.24.4, 6f1e6c5';
    return '';
  }

  Lab.kubectl = function (argv, c) {
    // move global flags that come before the verb (kubectl -n app get pods) to the end
    const lead = [];
    let i = 1;
    while (i < argv.length && argv[i].startsWith('-')) {
      if (argv[i] === '-n' || argv[i] === '--namespace' || argv[i] === '--context' || argv[i] === '--kubeconfig') { lead.push(argv[i], argv[i + 1]); i += 2; }
      else { lead.push(argv[i]); i++; }
    }
    if (lead.length) {
      const rest = argv.slice(i); const dd = rest.indexOf('--');
      argv = [argv[0], ...(dd < 0 ? [...rest, ...lead] : [...rest.slice(0, dd), ...lead, ...rest.slice(dd)])];
    }
    const verb = argv[1];
    if (!verb || verb === '--help' || verb === 'help') return 'Supported here: get, describe, logs, exec, set image, scale, patch, delete, rollout, top, cluster-info, version.\nFor anything else, use the real cluster in the Codespace.';
    const a = parseArgs(argv);
    const ns = nsOf(a);
    switch (verb) {
      case 'version': return `Client Version: v1.33.4\nKustomize Version: v5.6.0\nServer Version: ${c.node.version}`;
      case 'cluster-info': return 'Kubernetes control plane is running at https://127.0.0.1:6443\nCoreDNS is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\nMetrics-server is running at https://127.0.0.1:6443/api/v1/namespaces/kube-system/services/https:metrics-server:https/proxy';
      case 'config': return 'current-context: default';
      case 'api-resources': return 'pods (po), deployments (deploy), services (svc), endpoints (ep), networkpolicies (netpol), nodes (no), events (ev), namespaces (ns)';
      case 'get': {
        const t = resolveTarget(a);
        if (!t.kind) fail('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.');
        if (a.out && /jsonpath|custom-columns|go-template/.test(a.out)) fail(`(-o ${a.out.split('=')[0]} isn't simulated. Use -o json and pipe to jq instead.)`);
        if (t.multi) return t.multi.map((k) => getList(c, a, k, [])).join('\n\n');
        return render(a, getList(c, a, t.kind, t.names), t.kind, t.names.length === 1);
      }
      case 'describe': {
        const t = resolveTarget(a);
        if (!t.kind) fail('error: You must specify the type of resource to describe.');
        const out = [];
        if (t.kind === 'pods') { const pods = findPods(c, a, ns, t.names); if (!pods.length) return `No resources found in ${ns} namespace.`; pods.forEach((p) => out.push(describePod(c, p))); }
        else if (t.kind === 'nodes') out.push(describeNode(c));
        else if (t.kind === 'networkpolicies') { let ps = c.netpols.filter((p) => a.all || p.metadata.namespace === ns); if (t.names.length) ps = ps.filter((p) => t.names.includes(p.metadata.name)); if (!ps.length) return t.names.length ? `Error from server (NotFound): networkpolicies.networking.k8s.io "${t.names[0]}" not found` : `No resources found in ${ns} namespace.`; ps.forEach((p) => out.push(describeNetpol(p))); }
        else if (t.kind === 'services') {
          let ss = c.svcs.filter((s) => s.ns === ns && (!t.names.length || t.names.includes(s.name)));
          if (!ss.length) fail(`Error from server (NotFound): services "${t.names[0]}" not found`);
          ss.forEach((s) => out.push([`Name:              ${s.name}`, `Namespace:         ${s.ns}`, `Selector:          ${labelStr(s.selector)}`, 'Type:              ClusterIP', `IP:                ${s.ip}`, `Port:              <unset>  ${s.port}/${s.proto || 'TCP'}`, `TargetPort:        ${s.targetPort || s.port}/${s.proto || 'TCP'}`, `Endpoints:         ${endpoints(c, s).join(',')}`, 'Session Affinity:  None', 'Events:            <none>'].join('\n')));
        } else if (t.kind === 'deployments') {
          let ds = c.deps.filter((d) => d.ns === ns && (!t.names.length || t.names.includes(d.name)));
          if (!ds.length) fail(`Error from server (NotFound): deployments.apps "${t.names[0]}" not found`);
          const pods = podsOf(c);
          ds.forEach((d) => { const r = pods.filter((p) => p.dep === d && p.state === 'Running').length; out.push([`Name:                   ${d.name}`, `Namespace:              ${d.ns}`, `Selector:               ${labelStr(d.labels)}`, `Replicas:               ${d.replicas} desired | ${d.replicas} updated | ${d.replicas} total | ${r} available | ${d.replicas - r} unavailable`, 'StrategyType:           RollingUpdate', 'Pod Template:', `  Labels:  ${labelStr(d.labels)}`, '  Containers:', `   ${cname(d.image)}:`, `    Image:      ${d.image}`, ...(d.memLimit ? ['    Limits:', `      memory:  ${d.memLimit}`] : []), 'Conditions:', '  Type           Status  Reason', '  ----           ------  ------', `  Available      ${r >= 1 ? 'True' : 'False'}    ${r >= 1 ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable'}`, `  Progressing    True    ${d.prevImage && !Lab.pullable(c, d.image) ? 'ReplicaSetUpdated' : 'NewReplicaSetAvailable'}`].join('\n')); });
        } else fail(`(describe ${t.kind} isn't simulated here)`);
        return out.join('\n\n\n');
      }
      case 'logs': {
        let ref = a.pos[0];
        if (!ref && a.sel) { const pods = findPods(c, a, ns, []); if (!pods.length) return `No resources found in ${ns} namespace.`; return pods.map((p) => logsOf(c, p, a)).join('\n'); }
        if (!ref) fail('error: expected POD or TYPE/NAME is a required argument for the logs command');
        const p = podFromRef(c, a, ref);
        let out = logsOf(c, p, a);
        if (a.flags.tail) out = out.split('\n').slice(-(+a.flags.tail)).join('\n');
        return out;
      }
      case 'exec': {
        const ref = a.pos[0]; if (!ref) fail('error: pod, type/name or --filename must be specified');
        if (!a.after) fail(`error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead`);
        return execInPod(c, podFromRef(c, a, ref), a.after);
      }
      case 'set': {
        const what = a.pos[0];
        if (what === 'image') {
          const tgt = a.pos[1]; const pairs = a.pos.slice(2);
          if (!tgt || !pairs.length) fail('error: you must specify resources and container=image pairs. Example: kubectl set image deploy/web nginx=nginx:1.27-alpine');
          const [k, n] = tgt.includes('/') ? tgt.split('/') : [tgt, pairs.shift()];
          if (KINDS[k] === 'pods') fail('(In real life you can\'t change a bare pod\'s image safely. Fix the deployment instead.)');
          const d = c.deps.find((x) => x.ns === ns && x.name === n);
          if (!d) fail(`Error from server (NotFound): deployments.apps "${n}" not found`);
          const out = [];
          for (const pr of pairs) {
            const [cn, img] = pr.split('=');
            if (!img) fail(`error: invalid image pair "${pr}". Expected container=image`);
            if (cn !== '*' && cn !== cname(d.image)) fail(`error: unable to find container named "${cn}"\n(Hint: the container is called "${cname(d.image)}". Check with kubectl describe deploy ${d.name}.)`);
            if (img === d.image) { out.push(`deployment.apps/${d.name} image updated`); continue; }
            d.prevImage = Lab.pullable(c, d.image) ? d.image : d.prevImage || null; d.image = img; d.changed = true; d.gen = (d.gen || 0) + 1;
            if (Lab.pullable(c, img)) d.prevImage = null;
            out.push(`deployment.apps/${d.name} image updated`);
          }
          return out.join('\n');
        }
        if (what === 'resources') {
          const tgt = a.pos[1] || ''; const [k, n] = tgt.includes('/') ? tgt.split('/') : [tgt, a.pos[2]];
          if (KINDS[k] === 'pods') fail(`The Pod "${n}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`, \`spec.initContainers[*].image\`, \`spec.activeDeadlineSeconds\`, \`spec.tolerations\` (only additions to existing tolerations), \`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)\n(Bare pods are immutable. In real life the fix goes into the Deployment or Helm values.)`);
          const d = c.deps.find((x) => x.ns === ns && x.name === n); if (!d) fail(`Error from server (NotFound): deployments.apps "${n}" not found`);
          const m = (a.flags.limits || '').match(/memory=(\w+)/); if (m) { d.memLimit = m[1]; d.oom = false; d.changed = true; }
          return `deployment.apps/${d.name} resource requirements updated`;
        }
        fail(`(kubectl set ${what} isn't simulated here)`);
      }
      case 'scale': {
        const tgt = a.pos[0] || ''; const [k, n] = tgt.includes('/') ? tgt.split('/') : [tgt, a.pos[1]];
        if (KINDS[k] !== 'deployments') fail('error: scale only works on deployments here, e.g. kubectl scale deploy/web --replicas=3');
        const d = c.deps.find((x) => x.ns === ns && x.name === n);
        if (!d) fail(`Error from server (NotFound): deployments.apps "${n}" not found`);
        const r = parseInt(a.flags.replicas, 10); if (isNaN(r)) fail('error: The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
        d.baseReplicas = c.node.pressure ? Math.min(d.baseReplicas ?? d.replicas, r) : r;
        d.replicas = r;
        return `deployment.apps/${d.name} scaled`;
      }
      case 'rollout': {
        const sub = a.pos[0]; const tgt = a.pos[1] || ''; const [k, n] = tgt.includes('/') ? tgt.split('/') : [tgt, a.pos[2]];
        const d = c.deps.find((x) => x.ns === ns && x.name === n);
        if (!d) fail(`Error from server (NotFound): deployments.apps "${n}" not found`);
        if (sub === 'status') return d.prevImage && !Lab.pullable(c, d.image) ? `Waiting for deployment "${d.name}" rollout to finish: 1 old replicas are pending termination...\n(A real terminal would keep waiting here. The new pods never become ready.)` : `deployment "${d.name}" successfully rolled out`;
        if (sub === 'undo') { if (!d.prevImage) return `deployment.apps/${d.name} skipped rollback (current template already matches revision 1)`; d.image = d.prevImage; d.prevImage = null; return `deployment.apps/${d.name} rolled back`; }
        if (sub === 'history') return `deployment.apps/${d.name}\nREVISION  CHANGE-CAUSE\n1         <none>${d.prevImage || d.changed ? '\n2         <none>' : ''}`;
        if (sub === 'restart') { d.gen = (d.gen || 0) + 1; return `deployment.apps/${d.name} restarted`; }
        fail('error: rollout supports status, undo, history and restart here');
      }
      case 'patch': {
        const t = resolveTarget(a); const name = t.names[0];
        if (t.kind === 'services') { const s = c.svcs.find((x) => x.ns === ns && x.name === name); if (!s) fail(`Error from server (NotFound): services "${name}" not found`); const obj = { spec: { selector: { ...(s.selector || {}) }, ports: [{ port: s.port }] } }; applyPatch(obj, a); s.selector = obj.spec.selector; return `service/${name} patched`; }
        if (t.kind === 'networkpolicies') { const p = c.netpols.find((x) => x.metadata.namespace === ns && x.metadata.name === name); if (!p) fail(`Error from server (NotFound): networkpolicies.networking.k8s.io "${name}" not found`); const obj = JSON.parse(JSON.stringify({ spec: p.spec })); applyPatch(obj, a); p.spec = obj.spec; return `networkpolicy.networking.k8s.io/${name} patched`; }
        if (t.kind === 'deployments') {
          const d = c.deps.find((x) => x.ns === ns && x.name === name); if (!d) fail(`Error from server (NotFound): deployments.apps "${name}" not found`);
          const obj = { spec: { replicas: d.replicas, template: { metadata: { labels: { ...d.labels } }, spec: { containers: [{ name: cname(d.image), image: d.image }] } } } };
          applyPatch(obj, a);
          if (obj.spec.replicas !== d.replicas) d.replicas = obj.spec.replicas;
          const ci = obj.spec.template.spec.containers[0]; if (ci && ci.image !== d.image) { d.prevImage = Lab.pullable(c, d.image) ? d.image : null; d.image = ci.image; if (Lab.pullable(c, d.image)) d.prevImage = null; }
          return `deployment.apps/${name} patched`;
        }
        fail(`(patching ${t.kind} isn't simulated here)`);
      }
      case 'delete': {
        const t = resolveTarget(a);
        if (!t.kind) fail('error: You must provide one or more resources by argument or filename.');
        const out = [];
        if (t.kind === 'pods') {
          const pods = t.names.length ? t.names.map((n) => { const p = podsOf(c).find((x) => (a.all || x.ns === ns) && x.name === n); if (!p) { if (a.flags['ignore-not-found']) return null; fail(`Error from server (NotFound): pods "${n}" not found`); } return p; }).filter(Boolean) : findPods(c, a, ns, []);
          if (!t.names.length && !a.flags['field-selector'] && !a.sel && !a.flags.all) fail('error: resource(s) were provided, but no name was specified');
          for (const p of pods) {
            out.push(`pod "${p.name}" deleted`);
            if (p.evicted) c.evicted = c.evicted.filter((e) => e !== p.evicted);
            else if (p.bare) { c.bare = c.bare.filter((b) => b !== p.bare); c.deletedBare = (c.deletedBare || []).concat(p.bare); }
            else if (p.dep) p.dep.gen = (p.dep.gen || 0) + 1;
          }
          return out.join('\n') || `No resources found`;
        }
        if (t.kind === 'networkpolicies') { for (const n of t.names) { const i = c.netpols.findIndex((x) => x.metadata.namespace === ns && x.metadata.name === n); if (i < 0) { if (a.flags['ignore-not-found']) continue; fail(`Error from server (NotFound): networkpolicies.networking.k8s.io "${n}" not found`); } c.netpols.splice(i, 1); out.push(`networkpolicy.networking.k8s.io "${n}" deleted`); } return out.join('\n'); }
        if (t.kind === 'deployments') { for (const n of t.names) { const i = c.deps.findIndex((x) => x.ns === ns && x.name === n); if (i < 0) fail(`Error from server (NotFound): deployments.apps "${n}" not found`); c.deps.splice(i, 1); out.push(`deployment.apps "${n}" deleted`); } return out.join('\n'); }
        if (t.kind === 'services') fail('(Let\'s not delete the service. Try patching it instead.)');
        fail(`(deleting ${t.kind} isn't simulated here)`);
      }
      case 'top': {
        const what = KINDS[a.pos[0]];
        if (what === 'nodes') return T([['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)'], [c.node.name, '212m', '10%', '1803Mi', '46%']]);
        if (what === 'pods') {
          const pods = findPods(c, a, ns, a.pos.slice(1)).filter((p) => p.state === 'Running' || p.state === 'CrashLoopBackOff');
          if (!pods.length) return `No resources found in ${ns} namespace.`;
          const mem = (p) => (p.state === 'CrashLoopBackOff' ? '46Mi' : p.container === 'nginx' ? '3Mi' : p.container === 'coredns' ? '14Mi' : p.container === 'metrics-server' ? '19Mi' : '1Mi');
          return T([[...(a.all ? ['NAMESPACE'] : []), 'NAME', 'CPU(cores)', 'MEMORY(bytes)'], ...pods.map((p) => [...(a.all ? [p.ns] : []), p.name, '1m', mem(p)])]);
        }
        fail('error: kubectl top pod | node');
      }
      case 'edit': fail('(kubectl edit opens an editor, which the browser terminal can\'t do. Use kubectl set image, scale or patch. The Codespace has the real thing.)');
      case 'apply': case 'create': case 'run': case 'expose':
        fail(`(kubectl ${verb} with multi-line YAML isn't supported in the browser terminal. Use patch, set, scale or delete here, or practice ${verb} in the Codespace.)`);
      case 'cordon': case 'uncordon': case 'drain': case 'taint': fail(`(Single-node lab: ${verb} would take down everything. Not simulated.)`);
    }
    fail(`error: unknown command "${verb}" for "kubectl"`);
  };

  /* ---------- the node's own shell ---------- */
  Lab.nodeShell = function (argv, c, sc) {
    const cmd = argv[0];
    const pr = c.disk.blob;
    switch (cmd) {
      case 'kubectl': return Lab.kubectl(argv, c);
      case 'df': {
        if (argv.includes('-i')) return T([['Filesystem', 'Inodes', 'IUsed', 'IFree', 'IUse%', 'Mounted on'], ['/dev/sda1', '1310720', '182204', '1128516', '14%', '/'], ['tmpfs', '501127', '1', '501126', '1%', '/dev/shm']]);
        const h = argv.some((x) => /h/.test(x));
        return T([['Filesystem', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'], ['/dev/sda1', h ? '20G' : '20403592', pr ? (h ? '19G' : '19663872') : (h ? '8.1G' : '8461216'), pr ? (h ? '392M' : '401408') : (h ? '12G' : '11942376'), pr ? '98%' : '41%', '/'], ['tmpfs', h ? '1.9G' : '2002508', '0', h ? '1.9G' : '2002508', '0%', '/dev/shm'], ['/dev/sda15', h ? '105M' : '106858', h ? '6.1M' : '6186', h ? '99M' : '100672', '6%', '/boot/efi']]);
      }
      case 'du': {
        const rows = [['4.0K', '/home/ubuntu'], ['12M', '/etc'], ['48M', '/root'], ['1.2G', '/usr/lib'], ['1.9G', '/usr'], ['2.6G', '/var/lib/rancher/k3s/agent/containerd'], ['3.1G', '/var/lib/rancher/k3s'], ['3.2G', '/var/lib/rancher'], ['3.4G', '/var/lib'], ['412M', '/var/log']];
        if (pr) rows.push(['11G', '/var/tmp']);
        rows.push([pr ? '15G' : '3.9G', '/var'], [pr ? '19G' : '8.1G', '/']);
        return rows.map((r) => r.join('\t')).join('\n');
      }
      case 'find': {
        if (argv.includes('-size') && pr) return '/var/tmp/.cache-blob';
        return '';
      }
      case 'ls': {
        const path = argv.slice(1).find((x) => !x.startsWith('-')) || '~';
        const long = argv.some((x) => /^-\w*l/.test(x)); const all = argv.some((x) => /^-\w*a/.test(x));
        if (path.startsWith('/var/tmp')) {
          const items = [['drwxrwxrwt', '4.0K', '.'], ['drwxr-xr-x', '4.0K', '..'], ...(pr ? [['-rw-r--r--', '11G', '.cache-blob']] : []), ['drwx------', '4.0K', 'systemd-private-3f0c9a']];
          const vis = items.filter((i) => all || !i[2].startsWith('.'));
          return long ? `total ${pr ? '11G' : '12K'}\n` + vis.map((i) => `${i[0]} 1 root root ${i[1].padStart(5)} Oct  3 09:51 ${i[2]}`).join('\n') : vis.map((i) => i[2]).join('  ');
        }
        if (path.startsWith('/opt/offline-bundle')) { const f = Object.keys(c.offline); return f.length ? (long ? f.map((x) => `-rw-r--r-- 1 root root  ${c.offline[x].size} Sep 30 14:02 ${x}`).join('\n') : f.join('  ')) : ''; }
        if (path === '/opt') return Object.keys(c.offline).length ? 'offline-bundle' : '';
        const home = Object.keys(sc.files || {});
        return home.join('  ');
      }
      case 'rm': {
        const files = argv.slice(1).filter((x) => !x.startsWith('-'));
        if (!files.length) fail('rm: missing operand');
        const out = [];
        for (const f of files) {
          if (/\/var\/tmp\/\.cache-blob$/.test(f) || (f === '.cache-blob')) { if (!c.disk.blob) out.push(`rm: cannot remove '${f}': No such file or directory`); c.disk.blob = false; c.node.pressure = false; continue; }
          if (/^\/(var\/lib|etc|usr|var\/log)?\/?$|rancher|containerd/.test(f)) fail(`(Stop. Deleting ${f} on a customer node would cause a much bigger incident. Find the specific file first.)`);
          out.push(`rm: cannot remove '${f}': No such file or directory`);
        }
        return out.join('\n');
      }
      case 'dmesg': {
        const base = ['[Sat Oct  3 07:12:01 2026] Linux version 6.8.0-79-generic (buildd@lcy02-amd64-012)', '[Sat Oct  3 07:12:09 2026] EXT4-fs (sda1): mounted filesystem with ordered data mode', '[Sat Oct  3 07:12:31 2026] cni0: port 1(veth3a1c2b4e) entered forwarding state'];
        return base.concat(c.dmesgExtra).join('\n');
      }
      case 'free': return T([['', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'], ['Mem:', '3911', '1803', '412', '3', '1934', '2108'], ['Swap:', '0', '0', '0']]);
      case 'uptime': return ' 10:01:14 up 2:49,  1 user,  load average: 0.31, 0.27, 0.22';
      case 'date': return 'Sat Oct  3 10:01:14 UTC 2026';
      case 'hostname': return 'lab-node';
      case 'whoami': return 'ubuntu';
      case 'timedatectl': return '               Local time: Sat 2026-10-03 10:01:14 UTC\n           Universal time: Sat 2026-10-03 10:01:14 UTC\n                Time zone: Etc/UTC (UTC, +0000)\nSystem clock synchronized: yes\n              NTP service: active';
      case 'crictl': {
        const sub = argv[1];
        if (sub === 'images') return T([['IMAGE', 'TAG', 'IMAGE ID', 'SIZE'], ...[...c.images].sort().map((i) => { const [r, t] = splitTag(i); return [r, t, hash(i, 13).replace(/[^a-f0-9]/g, 'a').slice(0, 13), r.includes('nginx') ? '20.6MB' : r.includes('busybox') ? '2.16MB' : '18.4MB']; })]);
        if (sub === 'ps') return T([['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'POD'], ...podsOf(c).filter((p) => p.state === 'Running').map((p) => [hash(p.name, 13).slice(0, 13), hash(p.image, 13), 'About an hour ago', 'Running', p.container, p.name])]);
        if (sub === 'pull') return `E1003 10:01:20.118221   41822 log.go:32] "PullImage from image service failed" err="rpc error: code = Unknown desc = failed to pull and unpack image \\"${norm(argv[2] || '')}\\": failed to resolve reference: dial tcp: lookup registry-1.docker.io on 10.0.2.3:53: server misbehaving"\nFATA[0000] pulling image: failed to pull and unpack image\n(Air-gapped site: there's no registry to pull from.)`;
        fail('crictl: try "crictl images" or "crictl ps"');
      }
      case 'ctr': {
        const rest = argv.slice(1).filter((x) => x !== '-n' && x !== 'k8s.io' && !x.startsWith('--namespace'));
        if (rest[0] === 'images' && (rest[1] === 'ls' || rest[1] === 'list')) return [...c.images].sort().join('\n');
        if (rest[0] === 'images' && rest[1] === 'import') {
          const f = rest[2]; if (!f) fail('ctr: expected a file to import');
          const key = f.split('/').pop(); const entry = c.offline[key];
          if (!entry || (!f.includes('/opt/offline-bundle') && !f.startsWith('/') && sc.cwd !== '/opt/offline-bundle')) {
            if (entry && !f.startsWith('/')) return `ctr: open ${f}: no such file or directory\n(Hint: use the full path, /opt/offline-bundle/${key})`;
            fail(`ctr: open ${f}: no such file or directory`);
          }
          c.images.add(entry.image);
          return `unpacking ${entry.image} (sha256:${hash(entry.image, 20)}...)...done`;
        }
        fail('ctr: try "ctr images ls" or "ctr images import <file>"');
      }
      case 'systemctl':
        if (argv.includes('--failed')) return '  UNIT LOAD ACTIVE SUB DESCRIPTION\n0 loaded units listed.';
        return '● k3s.service - Lightweight Kubernetes\n     Loaded: loaded (/etc/systemd/system/k3s.service; enabled; preset: enabled)\n     Active: active (running) since Sat 2026-10-03 07:12:20 UTC; 2h 49min ago';
      case 'journalctl': return c.journal || '-- No entries --';
      case 'ss': return T([['Netid', 'State', 'Recv-Q', 'Send-Q', 'Local Address:Port', 'Peer Address:Port', 'Process'], ['tcp', 'LISTEN', '0', '4096', '127.0.0.1:10248', '0.0.0.0:*', 'users:(("k3s-server",pid=1022))'], ['tcp', 'LISTEN', '0', '4096', '*:6443', '*:*', 'users:(("k3s-server",pid=1022))'], ['tcp', 'LISTEN', '0', '4096', '*:10250', '*:*', 'users:(("k3s-server",pid=1022))']]);
      case 'curl': case 'wget': case 'ping': return `${cmd}: could not resolve host or no route: the site is air-gapped.`;
      case 'cd': { const p = argv[1] || '~'; if (p === '/opt/offline-bundle' || p === 'offline-bundle') { sc.cwd = '/opt/offline-bundle'; return ''; } sc.cwd = p; return ''; }
      case 'pwd': return sc.cwd || '/home/ubuntu';
      case 'cat': {
        const f = argv[1];
        if (f && f.endsWith('release-notes.txt') && c.offline['release-notes.txt']) return c.offline['release-notes.txt'].text;
        return undefined; // fall through to the text tool (files in sc.files)
      }
    }
    return undefined;
  };

  Lab.norm = norm;
  Lab.toYaml = toYaml;
})(typeof window !== 'undefined' ? window : globalThis);
