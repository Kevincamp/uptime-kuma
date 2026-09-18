#!/bin/bash
set -e

MODE=${1:-base}
OUTPUT_PATH=${2:-/tmp/test-output.xml}

npm test -- test/backend-test/test-prometheus_7a3996.js 2>&1 | tee "$OUTPUT_PATH"
