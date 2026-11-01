# syntax=docker/dockerfile:1
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
FROM ${DEBIAN_IMAGE} AS builder
ARG BUILD_JOBS=4
ARG SOURCE_REVISION=unknown
COPY neon/packaging/docker/shared/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config bison flex perl python3 libipc-run-perl \
    libreadline-dev zlib1g-dev libssl-dev libicu-dev liblz4-dev libzstd-dev \
    libxml2-dev libxslt1-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY . /source
WORKDIR /build
ARG SOURCE_PATCH_SHA256=none
RUN bash /source/configure --prefix=/opt/postgres --enable-tap-tests \
       --with-openssl --with-icu --with-lz4 --with-zstd --with-libxml --with-libxslt \
    && make -j"${BUILD_JOBS}" world-bin \
    && make install-world-bin \
    && python3 /source/dev/checks/postgres/check-libraries.py /opt/postgres \
    && mkdir -p /opt/postgres/share/qualification \
    && mkdir -p /opt/postgres/share/licenses/neon_rmgr \
    && cp /source/src/backend/access/neon/LICENSE /source/src/backend/access/neon/NOTICE /opt/postgres/share/licenses/neon_rmgr/ \
    && printf '%s\n' "$SOURCE_REVISION" > /opt/postgres/share/qualification/source-revision \
    && printf '%s\n' "$SOURCE_PATCH_SHA256" > /opt/postgres/share/qualification/source-patch-sha256 \
    && sha256sum /opt/postgres/bin/postgres > /opt/postgres/share/qualification/postgres.sha256 \
    && dpkg-query -W > /opt/postgres/share/qualification/builder-packages.txt

FROM ${DEBIAN_IMAGE} AS runtime
ARG SOURCE_REVISION=unknown
ARG PG_VERSION=18.2
LABEL org.opencontainers.image.title="Klustr PostgreSQL" \
      org.opencontainers.image.description="Standalone PostgreSQL built from the Klustr Neon fork" \
      org.opencontainers.image.source="https://github.com/klustr-io/postgres" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.version="$PG_VERSION" \
      org.opencontainers.image.licenses="PostgreSQL AND Apache-2.0"
COPY neon/packaging/docker/shared/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libreadline8 zlib1g libssl3 libicu72 liblz4-1 libzstd1 \
    libxml2 libxslt1.1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 postgres \
    && useradd --uid 10001 --gid 10001 --home-dir /var/lib/postgresql --no-create-home postgres \
    && mkdir -p /var/lib/postgresql/data /var/run/postgresql \
    && chown -R postgres:postgres /var/lib/postgresql /var/run/postgresql
ARG SOURCE_PATCH_SHA256=none
LABEL io.klustr.source.patch-sha256="$SOURCE_PATCH_SHA256"
COPY --from=builder /opt/postgres /opt/postgres
COPY --chmod=755 neon/packaging/docker/postgres/entrypoint.sh /usr/local/bin/pg-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/pg-entrypoint \
    && dpkg-query -W > /opt/postgres/share/qualification/runtime-packages.txt \
    && find /opt/postgres/bin /opt/postgres/lib -type f -exec sh -c \
       'for f do case "$(head -c 4 "$f")" in *ELF*) ldd "$f";; esac; done' sh {} + > /tmp/ldd.txt \
    && ! grep 'not found' /tmp/ldd.txt
ENV PATH="/opt/postgres/bin:${PATH}" \
    PGDATA=/var/lib/postgresql/data/pgdata \
    LANG=C.UTF-8
USER 10001:10001
VOLUME ["/var/lib/postgresql/data"]
EXPOSE 5432
STOPSIGNAL SIGINT
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
    CMD test "$(cat /proc/1/comm)" = postgres && pg_isready -h 127.0.0.1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"
ENTRYPOINT ["/usr/local/bin/pg-entrypoint"]
CMD ["postgres"]
