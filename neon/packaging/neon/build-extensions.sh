#!/bin/sh
# Compile pinned upstream extensions against this checkout's installed PG18.
set -eu
export PG_CONFIG=/opt/postgres/v18/bin/pg_config
export PATH=/opt/postgres/v18/bin:$PATH
export PGRX_PG_CONFIG_PATH=$PG_CONFIG
export CARGO_TARGET_DIR=/extension-target
export CARGO_BUILD_JOBS=${BUILD_JOBS:-4}
mkdir -p /extension-src /extension-install /extension-qualification /extension-licenses
python3 - <<'PY'
import hashlib, json, os, pathlib, shutil, subprocess
lock = json.loads(pathlib.Path('/extension-build/extensions.lock.json').read_text())
assert os.environ['RUSTUP_TOOLCHAIN'] == lock['rust_toolchain']
assert lock['pgrx_version'] in subprocess.check_output(['cargo', 'pgrx', '--version'], text=True)
for source in lock['sources']:
    archive = pathlib.Path('/extension-archives') / source['archive']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == source['sha256'], source['name']
    target = pathlib.Path('/extension-src') / source['name']
    target.mkdir()
    subprocess.run(['tar', '-xf', str(archive), '-C', str(target),
                    *([] if 'repository' in source else ['--strip-components=1'])], check=True)
# Upstream 3.3.2 ships a 3.3.1 root-package entry; dependency versions are unchanged.
cargo_lock = pathlib.Path('/extension-build/anonymizer.Cargo.lock')
assert hashlib.sha256(cargo_lock.read_bytes()).hexdigest() == lock['anonymizer_cargo_lock_sha256']
shutil.copy2(cargo_lock, '/extension-src/postgresql-anonymizer/Cargo.lock')
PY

make -C /extension-src/pgvector PG_CONFIG="$PG_CONFIG" OPTFLAGS= -j"$CARGO_BUILD_JOBS"
make -C /extension-src/pgvector PG_CONFIG="$PG_CONFIG" DESTDIR=/extension-install install
make -C /extension-src/datasketches PG_CONFIG="$PG_CONFIG" BOOST=/usr/include \
    CORE=/extension-src/datasketches-cpp -j"$CARGO_BUILD_JOBS"
make -C /extension-src/datasketches PG_CONFIG="$PG_CONFIG" DESTDIR=/extension-install install
make -C /extension-src/pg_textsearch PG_CONFIG="$PG_CONFIG" -j"$CARGO_BUILD_JOBS"
make -C /extension-src/pg_textsearch PG_CONFIG="$PG_CONFIG" DESTDIR=/extension-install install

# TSL is excluded: these images are intended for use by a hosted database service.
cmake -S /extension-src/timescaledb -B /extension-build/timescaledb \
    -DPG_CONFIG="$PG_CONFIG" -DCMAKE_BUILD_TYPE=Release -DAPACHE_ONLY=ON \
    -DUSE_TELEMETRY=OFF -DSEND_TELEMETRY_DEFAULT=OFF -DREGRESS_CHECKS=OFF \
    -DTAP_CHECKS=OFF -DISOLATION_CHECKS=OFF
cmake --build /extension-build/timescaledb -j"$CARGO_BUILD_JOBS"
DESTDIR=/extension-install cmake --install /extension-build/timescaledb
test -z "$(find /extension-install -name '*-tsl*.so' -print)"

cd /extension-src/postgresql-anonymizer
# PGRX requires explicit fork support for Neon's FMGR_ABI_EXTRA. Bindings and
# module magic still come from this engine's pg_config/server headers.
cargo pgrx package --cargo=--locked --no-default-features --features pg18,pgrx/unsafe-postgres \
    --pg-config "$PG_CONFIG" --out-dir /extension-install
mkdir -p /extension-install/opt/postgres/v18/share/extension/anon
cp data/*.csv data/en_US/fake/*.csv /extension-install/opt/postgres/v18/share/extension/anon/
mkdir -p /extension-qualification/anonymizer
cp Cargo.lock /extension-qualification/anonymizer/Cargo.lock
cp /extension-build/extensions.lock.json /extension-qualification/extensions.lock.json
for name in postgresql-anonymizer datasketches datasketches-cpp pgvector timescaledb pg_textsearch; do
    mkdir -p "/extension-licenses/$name"
    find "/extension-src/$name" -maxdepth 1 -type f \
        \( -name 'LICENSE*' -o -name 'NOTICE*' -o -name 'COPYRIGHT*' \) \
        -exec cp '{}' "/extension-licenses/$name/" \;
done
cp /usr/share/doc/libboost1.74-dev/copyright /extension-licenses/boost-copyright
find /extension-install -name '*.so' -exec strip --strip-unneeded '{}' \;
cd /extension-install
find opt -type f -exec sha256sum '{}' \; | sort > /extension-qualification/files.sha256
