#!/bin/bash
# ============================================================================
# EVEREST - STOP SERVER
# ============================================================================

cd ~/Desktop/everest-backend

if [ -f everest.pid ]; then
    PID=$(cat everest.pid)
    echo "🛑 Stopping Everest (PID: $PID)..."
    kill $PID 2>/dev/null
    rm everest.pid
    echo "✅ Everest stopped"
else
    echo "⚠️  Everest is not running (no PID file found)"
    echo "Checking for any running node processes..."
    pkill -f "node server-ultimate.js"
    echo "✅ Cleaned up any orphaned processes"
fi
