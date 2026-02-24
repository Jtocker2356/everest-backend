#!/bin/bash
# Auto-update iOS app with current Mac IP address

echo "🔍 Detecting current IP address..."

# Get the active network IP (not localhost)
IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | grep -v "169.254" | awk '{print $2}' | head -1)

if [ -z "$IP" ]; then
    echo "❌ Could not detect IP address"
    exit 1
fi

echo "✅ Found IP: $IP"
echo ""

# Find APIConfig.swift in TradePro project
APICONFIG=$(find ~/Desktop -name "APIConfig.swift" 2>/dev/null | head -1)

if [ -z "$APICONFIG" ]; then
    echo "⚠️  Could not find APIConfig.swift"
    echo "Please manually update APIConfig.swift with:"
    echo "    static let baseURL = \"http://$IP:3000\""
    exit 1
fi

echo "📝 Updating $APICONFIG..."

# Backup first
cp "$APICONFIG" "$APICONFIG.backup"

# Update the baseURL
sed -i '' "s|http://[0-9]*\.[0-9]*\.[0-9]*\.[0-9]*:3000|http://$IP:3000|g" "$APICONFIG"
sed -i '' "s|http://localhost:3000|http://$IP:3000|g" "$APICONFIG"

echo "✅ Updated APIConfig.swift to use http://$IP:3000"
echo ""
echo "💡 Now rebuild your iOS app in Xcode!"
