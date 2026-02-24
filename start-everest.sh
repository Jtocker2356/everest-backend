#!/bin/bash
# Ultimate smart server starter - auto-updates iOS app for PHYSICAL iPhone

cd ~/Desktop/everest-backend

echo "🏔️  EVEREST - ULTIMATE SMART START (Physical iPhone)"
echo "======================================================"
echo ""

# Get current IP
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | grep -v "169.254" | awk '{print $2}' | head -1)

if [ -z "$IP" ]; then
    echo "❌ Could not detect network IP address"
    echo "Please check your WiFi connection"
    exit 1
fi

echo "📡 Current Mac IP: $IP"

# Auto-find and update APIConfig.swift
echo "🔍 Looking for APIConfig.swift..."
APICONFIG=$(find ~/Downloads ~/Desktop ~/Documents -name "APIConfig.swift" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -1)

if [ -n "$APICONFIG" ]; then
    echo "📝 Found: $APICONFIG"
    
    # Backup
    cp "$APICONFIG" "$APICONFIG.backup" 2>/dev/null
    
    # Update to current IP for physical iPhone
    sed -i '' "s|static let baseURL = \"http://[^\"]*\"|static let baseURL = \"http://$IP:3000\"|g" "$APICONFIG"
    
    echo "✅ Auto-updated APIConfig.swift to use http://$IP:3000"
    echo ""
    echo "⚠️  IMPORTANT: Rebuild your app in Xcode for changes to take effect!"
else
    echo "❌ APIConfig.swift not found"
    echo ""
    echo "Please manually create APIConfig.swift with:"
    echo ""
    echo "struct APIConfig {"
    echo "    static let baseURL = \"http://$IP:3000\""
    echo "}"
    echo ""
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

echo "🚀 Starting Everest backend..."
echo ""

# Start server in background
nohup node server-ultimate.js > everest.log 2>&1 &
echo $! > everest.pid

# Wait a moment for server to start
sleep 2

# Check if it started successfully
if ps -p $(cat everest.pid) > /dev/null; then
    echo "✅ Everest backend is running!"
    echo ""
    echo "📱 Your iPhone should connect to:"
    echo "   http://$IP:3000"
    echo ""
    echo "🖥️  Admin Panel (on this Mac):"
    echo "   http://localhost:4000"
    echo ""
    echo "📋 View logs: tail -f ~/Desktop/everest-backend/everest.log"
    echo "🛑 To stop: ./stop-everest.sh"
    echo ""
    echo "⚡ NEXT STEP: Build and run your app in Xcode (Cmd+B then Cmd+R)"
    echo ""
    echo "💡 Make sure your iPhone and Mac are on the SAME WiFi network!"
else
    echo "❌ Server failed to start. Check everest.log for errors:"
    tail -20 everest.log
    exit 1
fi
