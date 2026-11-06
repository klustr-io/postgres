# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
ARG TOOLCHAIN_IMAGE=klustr-neon-toolchain:18.6
ARG RUNTIME_BASE=gcr.io/distroless/base-nossl-debian12:nonroot@sha256:be40c00dfabd86576d92666e87e406714d5618342de1a0c213ad232de255172e
FROM ${TOOLCHAIN_IMAGE} AS engine
USER root
ARG BUILD_JOBS=8
ENV POSTGRES_INSTALL_DIR=/opt/postgres RUSTUP_TOOLCHAIN=1.99.1
COPY COPYRIGHT HISTORY README.md aclocal.m4 configure configure.ac GNUmakefile.in meson.build meson_options.txt /pgsource/v18/
COPY config/ /pgsource/v18/config/
COPY src/ /pgsource/v18/src/
COPY contrib/ /pgsource/v18/contrib/
COPY doc/ /pgsource/v18/doc/
RUN mkdir -p /pgbuild/monorepo /out/qualification \
    && cd /pgbuild/monorepo \
    && /pgsource/v18/configure --prefix=/opt/postgres/v18 --with-openssl --with-icu \
       --with-lz4 --with-zstd --with-libxml --with-libxslt --with-libseccomp --with-libcurl --without-readline --enable-tap-tests \
    && make -j${BUILD_JOBS} world-bin && make install-world-bin
RUN chown -R 10002:10002 /pgbuild/monorepo /pgsource/v18 /opt/postgres/v18
USER 10002:10002
RUN make -C /pgbuild/monorepo -j${BUILD_JOBS} check
COPY --chown=10002:10002 neon/tests/neon/compute/docb_migration.py /qualification/docb_migration.py
RUN DOCB_MIGRATION_TMPDIR=/tmp python3 -B /qualification/docb_migration.py
USER root

FROM engine AS extensions
COPY neon/packaging/docker/shared/install-debian-packages.sh /usr/local/libexec/neon/install-debian-packages.sh
RUN sh /usr/local/libexec/neon/install-debian-packages.sh libboost-dev
ENV RUSTUP_TOOLCHAIN=1.99.1
RUN rustup toolchain install ${RUSTUP_TOOLCHAIN} --profile minimal
COPY neon/packaging/neon/extensions.lock.json /extension-build/extensions.lock.json
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    cargo install --locked --version 0.19.3 cargo-pgrx
COPY --from=extension-inputs / /extension-archives/
COPY neon/packaging/neon/anonymizer/Cargo.lock /extension-build/anonymizer.Cargo.lock
COPY neon/packaging/neon/build-extensions.sh /extension-build/build-extensions.sh
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,id=neon-pg18-anonymizer,target=/extension-target,sharing=locked \
    BUILD_JOBS=${BUILD_JOBS} sh /extension-build/build-extensions.sh

FROM engine AS artifacts
RUN if [ -d /out/qualification/native ]; then mv /out/qualification/native /tmp/native-provenance; fi \
    && rm -rf /out/qualification && mkdir -p /out/qualification \
    && if [ -d /tmp/native-provenance ]; then mv /tmp/native-provenance /out/qualification/native; fi
COPY neon/runtime/ /source/
WORKDIR /source
COPY neon/tests/neon/compute/native_quorum_membership.c /security-source/neon/tests/neon/compute/
COPY neon/tests/neon/security/native_copy_lifecycle.c neon/tests/neon/security/run-native-sanitizers.sh /security-source/neon/tests/neon/security/
RUN ln -s /source /security-source/neon/runtime \
    && sh /security-source/neon/tests/neon/security/run-native-sanitizers.sh /security-source \
    && rm -rf /security-source /tmp/native_quorum_membership /tmp/native_copy_lifecycle
ARG SOURCE_REVISION=uncommitted
ARG RUST_CACHE_NAMESPACE=neon-monorepo
ENV GIT_VERSION=${SOURCE_REVISION} CARGO_BUILD_JOBS=${BUILD_JOBS}
RUN mkdir -p build/walproposer-lib \
    && make -C build/walproposer-lib -f /source/pgxn/neon/Makefile \
       PG_CONFIG=/opt/postgres/v18/bin/pg_config walproposer-lib \
    && cp /opt/postgres/v18/lib/libpgport.a /opt/postgres/v18/lib/libpgcommon.a build/walproposer-lib/ \
    && ar d build/walproposer-lib/libpgport.a pg_strong_random.o \
    && ar d build/walproposer-lib/libpgcommon.a checksum_helper.o cryptohash_openssl.o \
       hmac_openssl.o md5_common.o parse_manifest.o scram-common.o pg_crc32c.o
COPY neon/packaging/neon/refresh-cargo-inputs.py /usr/local/libexec/neon/refresh-cargo-inputs.py
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=shared \
    --mount=type=cache,id=${RUST_CACHE_NAMESPACE},target=/source/target,sharing=locked \
    python3 /usr/local/libexec/neon/refresh-cargo-inputs.py \
    && cargo build --locked --release --bin pageserver --bin safekeeper --bin storage_controller \
       --bin compute_ctl --bin storage_broker --bin proxy --bin neon_local --bin endpoint_storage \
    && cargo build --locked --release -p communicator \
    && mkdir -p /out/bin \
    && cp target/release/pageserver target/release/safekeeper target/release/storage_controller \
       target/release/compute_ctl target/release/storage_broker target/release/proxy \
       target/release/neon_local target/release/endpoint_storage /out/bin/ \
    && for extension in neon neon_rmgr neon_walredo neon_utils klustr_oauth; do \
       mkdir -p build/extensions/$extension; \
       make -C build/extensions/$extension -f /source/pgxn/$extension/Makefile \
       PG_CONFIG=/opt/postgres/v18/bin/pg_config NEON_CARGO_ARTIFACT_TARGET_DIR=/source/target/release \
       CARGO_BUILD_FLAGS=--locked CARGO_PROFILE=--release -j${BUILD_JOBS} all install; done \
    && cargo test --locked --release -p postgres-protocol2 authentication::sasl \
    && cargo test --locked --release -p http-utils --lib tls_provider_tests \
    && cargo test --locked --release -p tokio-postgres2 --lib security_tests \
    && cargo test --locked --release -p tokio-postgres --lib row::test \
    && cargo test --locked --release -p pq_proto --lib security_tests \
    && cargo test --locked --release -p postgres_backend --lib security_tests \
    && cargo test --locked --release -p utils --lib auth::tests \
    && cargo test --locked --release -p safekeeper --lib native_ \
    && cargo metadata --locked --format-version=1 > /out/qualification/dependency-resolution.json
RUN rm -rf /out/qualification/runtime-tests \
    && strip --strip-unneeded /out/bin/* /opt/postgres/v18/bin/postgres /opt/postgres/v18/lib/neon*.so /opt/postgres/v18/lib/klustr_oauth.so \
    && sha256sum /out/bin/* > /out/qualification/binaries.sha256 \
    && sha256sum /opt/postgres/v18/bin/postgres /opt/postgres/v18/lib/neon*.so /opt/postgres/v18/lib/klustr_oauth.so > /out/qualification/postgres-binaries.sha256
COPY --from=extensions /extension-install/opt/postgres/v18/ /opt/postgres/v18/
COPY --from=extensions /extension-qualification/ /out/qualification/extensions/
COPY --from=extensions /extension-licenses/ /out/licenses/extensions/
COPY neon/sources.json /out/qualification/sources.json
COPY neon/build-inputs.json /out/qualification/build-inputs.json
COPY neon/packaging/neon/native-dependencies.lock.json /out/qualification/native-dependencies.lock.json

FROM ${RUNTIME_BASE} AS minimal-base
FROM artifacts AS roots
COPY --from=minimal-base / /minimal-base/
COPY neon/packaging/neon/minimal-rootfs.py /usr/local/libexec/neon/minimal-rootfs.py
RUN NEON_RUNTIME_ROLE=all python3 /usr/local/libexec/neon/minimal-rootfs.py
FROM minimal-base AS runtime
ARG SOURCE_REVISION=uncommitted
USER 10001:10001
WORKDIR /var/lib/neon
ENV PATH=/opt/postgres/v18/bin:/usr/local/bin:/usr/bin:/bin \
    LD_LIBRARY_PATH=/opt/neon-native/lib SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    LANG=C.UTF-8 LC_ALL=C.UTF-8
STOPSIGNAL SIGTERM
LABEL org.opencontainers.image.source="https://github.com/klustr-io/postgres" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.klustr.release-status="single-checkout-source-candidate"
FROM runtime AS compute
LABEL io.klustr.native-oauth="OAUTHBEARER/klustr_oauth"
LABEL io.klustr.postgresql-extensions="pg_stat_statements,anon,datasketches,vector,timescaledb,pg_textsearch,docb"
COPY --from=roots /rootfs/compute/ /
EXPOSE 5432 3080
ENTRYPOINT ["/usr/local/bin/compute_ctl"]
FROM runtime AS pageserver
COPY --from=roots /rootfs/pageserver/ /
EXPOSE 6400 9898
ENTRYPOINT ["/usr/local/bin/pageserver"]
FROM runtime AS safekeeper
COPY --from=roots /rootfs/safekeeper/ /
EXPOSE 5454 7676
ENTRYPOINT ["/usr/local/bin/safekeeper"]
FROM runtime AS storage-controller
COPY --from=roots /rootfs/storage-controller/ /
EXPOSE 1234
ENTRYPOINT ["/usr/local/bin/storage_controller"]
FROM runtime AS storage-broker
COPY --from=roots /rootfs/storage-broker/ /
EXPOSE 50051
ENTRYPOINT ["/usr/local/bin/storage_broker"]
CMD ["--listen-addr=0.0.0.0:50051"]
FROM runtime AS proxy
LABEL io.klustr.native-oauth="OAUTHBEARER"
COPY --from=roots /rootfs/proxy/ /
EXPOSE 5432 7001
ENTRYPOINT ["/usr/local/bin/proxy"]
