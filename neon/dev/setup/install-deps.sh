#!/usr/bin/env bash
# Ubuntu 24.04 / Debian 12 native build and test prerequisites. Run as root.
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential git pkg-config bison flex perl \
    libreadline-dev zlib1g-dev libssl-dev libicu-dev liblz4-dev libzstd-dev \
    libxml2-dev libxslt1-dev libipc-run-perl \
    python3 python3-pytest python3-psycopg python3-yaml ca-certificates
