#!/usr/bin/env bash
if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <command> [args...]"
    exit 1
fi

command="$1"
shift
while true; do
    echo "$(date '+%Y-%m-%d %H:%M:%S') - Executing command: $command $@"
    "$command" "$@" 1>&1 2>&2
    exit_code=$?
    if [ $exit_code -ne 1 ]; then
        break
    fi
    sleep 5
done
