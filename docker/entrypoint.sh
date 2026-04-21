#!/bin/sh
set -e

echo "Running database migrations..."
node dist/backend/src/db/migrate.js

echo "Starting backend server..."
exec node dist/backend/src/index.js
