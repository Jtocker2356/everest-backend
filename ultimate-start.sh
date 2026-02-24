#!/bin/bash
# Ultimate smart server starter - auto-updates iOS app with localhost

cd ~/Desktop/everest-backend

echo "🏔️  EVEREST - ULTIMATE SMART START"
echo "===================================="
echo ""

# Get current IP
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | grep -v "169.254" | awk '{print $2}' | head -1)

if [ -z "$IP" ]; then
    echo "⚠️  Warning: Could not detect network IP"
    IP="localhost"
fi

echo "📡 Current IP: $IP"

# Auto-find and update APIConfig.swift
echo "🔍 Looking for APIConfig.swift..."
APICONFIG=$(find ~ -name "APIConfig.swift" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/Library/*" 2>/dev/null | head -1)

if [ -n "$APICONFIG" ]; then
    echo "📝 Found: $APICONFIG"
    
    # Backup
    cp "$APICONFIG" "$APICONFIG.backup" 2>/dev/null
    
    # Update to localhost (works for simulator automatically)
    sed -i '' 's|static let baseURL = "http://[^"]*"|static let baseURL = "http://localhost:3000"|g' "$APICONFIG"
    
    echo "✅ Auto-updated APIConfig.swift to use localhost:3000"
else
    echo "⚠️  APIConfig.swift not found - will need manual update"
fi

echo ""

# Stop any running instance
if [ -f everest.pid ]; then
    OLD_PID=$(cat everest.pid)
    echo "🛑 Stopping old server (PID: $OLD_PID)..."
    kill $OLD_PID 2>/dev/null
    rm everest.pid
fi

# Also kill any orphaned node processes
pkill -f "node server-ultimate.js" 2>/dev/null

echo "🚀 Starting Everest..."
echo ""

# Start server in background
nohup node server-ultimate.js > everest.log 2>&1 &
echo $! > everest.pid

# Wait a moment for server to start
sleep 2

# Check if it started successfully
if ps -p $(cat everest.pid) > /dev/null; then
    echo "✅ Everest is running!"
    echo ""
    echo "📱 iOS App:"
    echo "   - Simulator: http://localhost:3000 (auto-configured)"
    echo "   - Physical device: http://$IP:3000 (manual update needed)"
    echo ""
    echo "🖥️  Admin Panel:"
    echo "   - http://localhost:4000"
    echo ""
    echo "📋 View logs: tail -f ~/Desktop/everest-backend/everest.log"
    echo "🛑 To stop: ./stop-everest.sh"
    echo ""
    echo "💡 Your iOS app is ready to use! Just build and run in Xcode."
else
    echo "❌ Server failed to start. Check everest.log for errors:"
    tail -20 everest.log
    exit 1
fi
