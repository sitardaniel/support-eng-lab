#!/usr/bin/env bash
# triage.sh - read-only. Collects a first-look bundle from a node.
OUT="triage-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
run(){ echo "\$ $2" > "$OUT/$1.txt"; bash -c "$2" >> "$OUT/$1.txt" 2>&1 || true; }
run 01-uptime    "uptime; nproc"
run 02-disk      "df -h; echo; df -i"
run 03-memory    "free -m"
run 04-oom       "dmesg -T | grep -iE 'oom|killed process' | tail -50"
run 05-systemd   "systemctl --failed --no-pager"
run 06-errors    "journalctl -p err --since '1 hour ago' --no-pager | tail -200"
run 07-ports     "ss -tulpn"
run 08-time      "date -u; timedatectl"
run 09-nodes     "kubectl get nodes -o wide; kubectl describe nodes | grep -A8 Conditions"
run 10-pods      "kubectl get pods -A -o wide | grep -v -E 'Running|Completed'"
run 11-events    "kubectl get events -A --sort-by=.lastTimestamp | tail -80"
tar czf "$OUT.tgz" "$OUT" && rm -rf "$OUT"
echo "Please send us: $OUT.tgz"
