#!/usr/bin/env bash
# One-time Codespace setup: tools, k3d, the vendor's offline bundle. Runs on create.
set -euo pipefail
LAB_DIR="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "wireshark-common wireshark-common/install-setuid boolean false" | sudo debconf-set-selections
sudo apt-get update -qq
sudo apt-get install -y -qq jq tcpdump tshark faketime openssl dnsutils iptables >/dev/null

if ! command -v k3d >/dev/null; then
  curl -sSfL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | TAG=v5.8.3 bash
fi
sudo ln -sf "$LAB_DIR/lab" /usr/local/bin/lab
chmod +x "$LAB_DIR/lab" "$LAB_DIR/triage.sh"

for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
mkdir -p "$HOME/lab-work/offline-bundle"
docker pull -q nginx:1.25-alpine >/dev/null
docker save nginx:1.25-alpine -o "$HOME/lab-work/offline-bundle/nginx_1.25-alpine.tar"
docker rmi nginx:1.25-alpine >/dev/null
cat > "$HOME/lab-work/offline-bundle/release-notes.txt" <<'NOTES'
Reporting module 4.2
====================
Images (offline bundle):
  reporter  nginx:1.25-alpine
  helper    busybox

Install:
  1. Import every .tar in this folder:
       sudo k3s ctr images import <file>
  2. kubectl -n app create deployment reporter --image=nginx:1.25-alpine
  3. kubectl -n app create deployment helper --image=busybox -- sleep 1d
NOTES
echo "Setup done. The cluster starts next (lab up)."
