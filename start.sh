#!/bin/sh
set -e

# Start Flask sheets service in background
cd /app/sheets-service
python app.py &

# Wait for Flask to be ready
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:${SHEETS_SERVICE_PORT:-5050}/health > /dev/null 2>&1; then
    echo "Flask service ready"
    break
  fi
  sleep 1
done

# Start Node server (foreground — Cloud Run health checks this)
cd /app/server
exec node index.js
