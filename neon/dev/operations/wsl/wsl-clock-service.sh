#!/usr/bin/env bash
# Explicit administrative control; never invoked automatically by build/tests.
set -euo pipefail
service=systemd-timesyncd.service
case "${1:-status}" in
    status)
        systemctl show "$service" --property=ActiveState,SubState,UnitFileState
        timedatectl show --property=NTP,NTPSynchronized,Timezone
        ;;
    stop)
        systemctl stop "$service"
        test "$(systemctl show "$service" --property=ActiveState --value)" = inactive
        ;;
    disable)
        systemctl disable --now "$service"
        test "$(systemctl show "$service" --property=ActiveState --value)" = inactive
        test "$(systemctl show "$service" --property=UnitFileState --value)" = disabled
        ;;
    restore)
        systemctl enable --now "$service"
        test "$(systemctl show "$service" --property=ActiveState --value)" = active
        ;;
    *) echo 'Expected status, stop, disable or restore' >&2; exit 2 ;;
esac
systemctl show "$service" --property=ActiveState,SubState,UnitFileState
