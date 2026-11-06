# Standalone validation client; the server image remains free of Python/pytest.
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3
COPY neon/packaging/docker/shared/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pytest python3-psycopg \
    && rm -rf /var/lib/apt/lists/*
COPY neon/tests/integration /source/tests/integration
WORKDIR /source
