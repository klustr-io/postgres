#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -* ]]; then set -- postgres "$@"; fi
if [[ "${1:-}" != postgres ]] || [[ " ${*} " == *" --version "* ]] || [[ " ${*} " == *" --help "* ]]; then
    exec "$@"
fi
if [[ $(id -u) == 0 ]]; then
    echo 'PostgreSQL must run as a non-root user.' >&2
    exit 1
fi
: "${PGDATA:?PGDATA is required}"
if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
    if [[ -d "$PGDATA" ]] && [[ -n $(find "$PGDATA" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
        echo 'Refusing to initialize a nonempty directory without PG_VERSION.' >&2
        exit 1
    fi
    user=${POSTGRES_USER:-postgres}
    database=${POSTGRES_DB:-$user}
    if [[ -n ${POSTGRES_PASSWORD_FILE:-} ]]; then
        [[ -z ${POSTGRES_PASSWORD:-} ]] || { echo 'Set PASSWORD or PASSWORD_FILE, not both.' >&2; exit 1; }
        POSTGRES_PASSWORD=$(cat "$POSTGRES_PASSWORD_FILE")
    fi
    if [[ -z ${POSTGRES_PASSWORD:-} ]]; then
        echo 'POSTGRES_PASSWORD or POSTGRES_PASSWORD_FILE is required for initialization.' >&2
        exit 1
    fi
    mkdir -p "$PGDATA"
    chmod 700 "$PGDATA"
    password_file=$(mktemp)
    chmod 600 "$password_file"
    trap 'rm -f "$password_file"' EXIT
    printf '%s\n' "$POSTGRES_PASSWORD" > "$password_file"
    initdb -D "$PGDATA" --username="$user" --pwfile="$password_file" \
        --auth-local=peer --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
    rm -f "$password_file"
    trap - EXIT
    # Temporary initialization server accepts only authenticated loopback TCP.
    pg_ctl -D "$PGDATA" -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/var/run/postgresql" -w start
    trap 'pg_ctl -D "$PGDATA" -m fast -w stop' EXIT
    if [[ "$database" != postgres ]]; then
        PGPASSWORD="$POSTGRES_PASSWORD" createdb -h 127.0.0.1 -U "$user" -- "$database"
    fi
    pg_ctl -D "$PGDATA" -m fast -w stop
    trap - EXIT
    # initdb's local-only rules stay intact; exposed TCP requires SCRAM.
    printf '\nhost all all all scram-sha-256\nhost replication all all scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
    echo 'Database initialization complete.'
fi
unset POSTGRES_PASSWORD
exec "$@" -D "$PGDATA" -c listen_addresses='*' -c unix_socket_directories=/var/run/postgresql
