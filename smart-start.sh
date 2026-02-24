#!/bin/bash
# Smart server starter - handles IP changes automatically

cd ~/Desktop/everest-backend

echo "🏔️  EVEREST - SMART START"
echo "========================="
echo ""

# Get current IP
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | grep -v "169.254" | awk '{print $2}' | head -1)

if [ -z "$IP" ]; then
    echo "⚠️  Warning: Could not detect network IP"
    IP="localhost"
fi

echo "📡 Current IP: $IP"
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
    echo "   - Simulator: http://localhost:3000"
    echo "   - Physical device: http://$IP:3000"
    echo ""
    echo "🖥️  Admin Panel:"
    echo "   - http://localhost:4000"
    echo ""
    echo "📋 View logs: tail -f ~/Desktop/everest-backend/everest.log"
    echo "🛑 To stop: ./stop-everest.sh"
    echo ""
    echo "💡 TIP: If testing on physical iPhone, update APIConfig.swift to use: http://$IP:3000"
else
    echo "❌ Server failed to start. Check everest.log for errors:"
    tail -20 everest.log
    exit 1
fi
