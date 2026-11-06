#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
source_dir=${BUILD_SOURCE:-$root}
mode=${BUILD_MODE:-debug}
case "$mode" in
    debug) mode_flags=(--enable-debug --enable-cassert --enable-injection-points) ;;
    release) mode_flags=() ;;
    *) echo 'BUILD_MODE must be debug or release' >&2; exit 2 ;;
esac
build_root=${BUILD_ROOT:-$root/build}
mkdir -p "$build_root/$mode"
build_dir=$(cd "$build_root/$mode" && pwd)
prefix=${INSTALL_PREFIX:-$build_dir/install}
available_mb=$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
jobs=$(( available_mb / 2048 ))
(( jobs >= 1 )) || jobs=1
(( jobs <= 8 )) || jobs=8
cpus=$(getconf _NPROCESSORS_ONLN)
(( jobs <= cpus )) || jobs=$cpus
jobs=${BUILD_JOBS:-$jobs}
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid BUILD_JOBS' >&2; exit 2; }
printf 'source=%s\nbuild=%s\nprefix=%s\nmode=%s\njobs=%s\n' "$source_dir" "$build_dir" "$prefix" "$mode" "$jobs"
cd "$build_dir"
case "${1:-build}" in
    build)
        bash "$source_dir/configure" --prefix="$prefix" \
            --enable-tap-tests --with-openssl --with-icu --with-lz4 --with-zstd \
            --with-libxml --with-libxslt "${mode_flags[@]}"
        make -j"$jobs" world-bin
        make install-world-bin
        "$prefix/bin/postgres" --version
        "$prefix/bin/pg_config" --version
        "$prefix/bin/pg_config" --configure
        "$prefix/bin/pg_config" --bindir
        # Check every dynamically linked executable/module, not only postgres.
        python3 "$root/dev/checks/postgres/check-libraries.py" "$prefix"
        ;;
    check) make -j"$jobs" check ;;
    check-world) PG_TEST_EXTRA=${PG_TEST_EXTRA:-ssl} make -j"$jobs" check-world ;;
    *) echo 'Expected build, check or check-world' >&2; exit 2 ;;
esac
