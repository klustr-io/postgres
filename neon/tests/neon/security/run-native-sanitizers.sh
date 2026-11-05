#!/bin/sh
set -eu
repo=${1:-/work}
pg=${PG_INSTALL:-/opt/postgres/v18}
for test in native_quorum_membership native_copy_lifecycle; do
    if [ "$test" = native_quorum_membership ]; then
        source="$repo/neon/tests/neon/compute/$test.c"
    else
        source="$repo/neon/tests/neon/security/$test.c"
    fi
    cc -no-pie -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined \
        -ffunction-sections -fdata-sections -Wl,--gc-sections \
        -I"$pg/include/server" -I"$pg/include" -I"$repo/neon/runtime/pgxn/neon" \
        "$source" -L"$pg/lib" -Wl,-rpath,"$pg/lib" -lpq -lpgport -o "/tmp/$test"
    echo "Running sanitizers: $test"
    ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
        UBSAN_OPTIONS=halt_on_error=1 timeout 15s "/tmp/$test"
done
