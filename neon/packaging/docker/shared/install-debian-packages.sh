#!/bin/sh
# Resolve against signed, dated indexes; fetch identical package bytes from
# Debian's CDN first to avoid slow snapshot pool lookups. Never change versions.
set -eu
test "$#" -gt 0
sources=/etc/apt/sources.list.d/debian.sources
source_copy=$(mktemp)
uris=$(mktemp)
packages=$(mktemp)
trap 'rm -f "$source_copy" "$uris" "$packages"' 0
cp "$sources" "$source_copy"

apt_snapshot() {
    apt-get -o Acquire::Retries=1 -o Acquire::ForceHash=SHA256 \
        -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 \
        -o Acquire::http::Pipeline-Depth=0 -o Acquire::https::Pipeline-Depth=0 "$@"
}

indexed=false
for mirror in snapshot-cloudflare.debian.org snapshot.debian.org; do
    sed -e "s|https://snapshot-cloudflare.debian.org/|https://$mirror/|g" \
        -e "s|https://snapshot.debian.org/|https://$mirror/|g" \
        "$source_copy" > "$sources"
    echo "Resolving pinned Debian packages through $mirror"
    if apt_snapshot -o APT::Update::Error-Mode=any update; then
        indexed=true
        break
    fi
done
if test "$indexed" != true; then
    echo 'Both signed snapshot index endpoints failed; refusing unpinned packages.' >&2
    exit 100
fi

apt_snapshot --print-uris --download-only install -y --no-install-recommends "$@" > "$uris"
# APT emits destination names, sizes and hashes from authenticated indexes.
sed -n "s/^'\([^']*\)' \([^ ]*\) \([0-9]*\) SHA256:\([0-9a-f]*\)$/\1 \2 \3 \4/p" "$uris" > "$packages"
expected=$(grep -c "^'" "$uris" || true)
actual=$(wc -l < "$packages")
test "$expected" -eq "$actual" || { echo 'Missing SHA-256 in APT download plan' >&2; exit 100; }
mkdir -p /var/cache/apt/archives/partial
while read -r uri filename size digest; do
    case "$filename" in ''|*/*|*\\*|.|..) echo 'Invalid APT cache filename' >&2; exit 100;; esac
    test "${#digest}" -eq 64 || exit 100
    case "$uri" in
        https://snapshot-cloudflare.debian.org/archive/*|https://snapshot.debian.org/archive/*) ;;
        *) echo 'Unexpected package origin in pinned APT plan' >&2; exit 100;;
    esac
    archive_path=${uri#*/archive/}
    archive=${archive_path%%/*}
    pool_path=${archive_path#*/}
    pool_path=${pool_path#*/}
    case "$archive" in
        debian) cdn="https://deb.debian.org/debian/$pool_path";;
        debian-security) cdn="https://security.debian.org/debian-security/$pool_path";;
        *) echo 'Unexpected Debian archive' >&2; exit 100;;
    esac
    destination="/var/cache/apt/archives/$filename"
    temporary="/var/cache/apt/archives/partial/$filename.neon"
    verified=false
    for candidate in "$cdn" "$uri"; do
        if curl --fail --location --silent --show-error --connect-timeout 10 --max-time 30 \
            --output "$temporary" "$candidate" \
            && test "$(wc -c < "$temporary")" -eq "$size" \
            && printf '%s  %s\n' "$digest" "$temporary" | sha256sum --check --status; then
            mv "$temporary" "$destination"
            verified=true
            break
        fi
    done
    if test "$verified" != true; then
        echo "Could not obtain checksum-verified pinned package: $filename" >&2
        exit 100
    fi
done < "$packages"

# Installation cannot silently fall back to another download or index.
apt_snapshot --no-download install -y --no-install-recommends "$@"
rm -rf /var/lib/apt/lists/*
