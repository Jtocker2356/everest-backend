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

# Search for APIConfig.swift more broadly
echo "🔍 Searching for APIConfig.swift..."
APICONFIG=$(find ~ -name "APIConfig.swift" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -1)

if [ -z "$APICONFIG" ]; then
    echo "⚠️  Could not find APIConfig.swift automatically"
    echo ""
    echo "Please manually update APIConfig.swift with:"
    echo ""
    echo "struct APIConfig {"
    echo "    static let baseURL = \"http://localhost:3000\"  // For simulator"
    echo "    // static let baseURL = \"http://$IP:3000\"  // For physical iPhone"
    echo "}"
    echo ""
    exit 1
fi

echo "📝 Found: $APICONFIG"
echo ""

# Backup first
cp "$APICONFIG" "$APICONFIG.backup"

# Update the baseURL to use localhost
sed -i '' 's|static let baseURL = "http://[^"]*"|static let baseURL = "http://localhost:3000"|g' "$APICONFIG"

echo "✅ Updated APIConfig.swift to use http://localhost:3000"
echo ""
echo "💡 Now rebuild your iOS app in Xcode (Cmd+B)!"
echo ""
echo "📝 Note: Using localhost works for simulator."
echo "   For physical iPhone, change to: http://$IP:3000"
