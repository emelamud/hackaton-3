#!/bin/sh
set -e

echo "Running database migrations..."
node dist/db/migrate.js

echo "Starting backend server..."
exec node dist/index.js
