#!/usr/bin/env bash
set -euo pipefail
pwd
id
git status --short --branch
git remote -v
git rev-parse HEAD
git branch --show-current
git rev-parse --is-shallow-repository
grep AC_INIT configure.ac
uname -a
cat /etc/os-release
uname -m
nproc
free -h
df -h . /home
findmnt -T "$PWD"
gcc --version
make --version
python3 --version
for package in bison flex libreadline-dev zlib1g-dev libssl-dev libicu-dev liblz4-dev libzstd-dev libxml2-dev libxslt1-dev libipc-run-perl python3-pytest python3-psycopg; do
    if dpkg-query -W -f='${Package} ${Version} ${Status}\n' "$package"; then
        :
    else
        printf 'MISSING: %s\n' "$package"
    fi
done
