#!/bin/sh
# Keep signed, dated snapshot inputs while tolerating one unavailable endpoint.
set -eu
test "$#" -gt 0
sources=/etc/apt/sources.list.d/debian.sources
source_copy=$(mktemp)
trap 'rm -f "$source_copy"' 0
cp "$sources" "$source_copy"

apt_snapshot() {
    apt-get -o Acquire::Retries=3 \
        -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::http::Pipeline-Depth=0 -o Acquire::https::Pipeline-Depth=0 "$@"
}

for mirror in snapshot-cloudflare.debian.org snapshot.debian.org; do
    sed -e "s|https://snapshot-cloudflare.debian.org/|https://$mirror/|g" \
        -e "s|https://snapshot.debian.org/|https://$mirror/|g" \
        "$source_copy" > "$sources"
    echo "Installing pinned Debian packages through $mirror"
    if apt_snapshot -o APT::Update::Error-Mode=any update \
        && apt_snapshot install -y --no-install-recommends "$@"; then
        rm -rf /var/lib/apt/lists/*
        exit 0
    fi
done
echo 'Both Debian snapshot endpoints failed; refusing unpinned packages.' >&2
exit 100
