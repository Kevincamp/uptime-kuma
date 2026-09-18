#!/bin/bash
set -e

OUTPUT_PATH=""
MODE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --output_path)
            OUTPUT_PATH="$2"
            shift 2
            ;;
        base|new)
            MODE="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done

OUTPUT_PATH=${OUTPUT_PATH:-/tmp/test-output.xml}

if [ "$MODE" = "base" ]; then
    # No baseline tests exist yet for Prometheus
    echo '<?xml version="1.0" encoding="UTF-8"?><testsuites></testsuites>' > "$OUTPUT_PATH"
elif [ "$MODE" = "new" ]; then
    # Run tests with JUnit XML reporter.
    # --import=tsx is required: server/prometheus.js requires ../src/util,
    # which is a .ts file that plain node cannot resolve without it.
    node --import=tsx --test \
        --test-reporter=junit \
        --test-reporter-destination="$OUTPUT_PATH" \
        test/backend-test/test-prometheus_7a3996.js
else
    echo "Usage: $0 --output_path <path> <base|new>"
    exit 1
fi
