#!/usr/bin/with-contenv bashio
# shellcheck shell=bash

bashio::log.info "Starting Volt Load Manager..."

# Export supervisor token for HA API access
export SUPERVISOR_TOKEN="${SUPERVISOR_TOKEN}"

# Start the server
cd /app
exec node server.js
