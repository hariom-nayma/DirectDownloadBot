#!/bin/bash

echo "🚀 Setting up FileToLink-style Bot in Node.js..."

# Create backup of current setup
echo "📦 Creating backup of current setup..."
mkdir -p backup
cp index.js backup/index_old.js 2>/dev/null || echo "No old index.js found"
cp .env backup/.env_old 2>/dev/null || echo "No old .env found"
cp package.json backup/package_old.json 2>/dev/null || echo "No old package.json found"

# Install MongoDB if not present
echo "🗄️ Checking MongoDB installation..."
if ! command -v mongod &> /dev/null; then
    echo "📦 Installing MongoDB..."
    
    # For Ubuntu/Debian
    if command -v apt &> /dev/null; then
        sudo apt update
        sudo apt install -y mongodb
        sudo systemctl start mongodb
        sudo systemctl enable mongodb
    # For CentOS/RHEL
    elif command -v yum &> /dev/null; then
        sudo yum install -y mongodb-server
        sudo systemctl start mongod
        sudo systemctl enable mongod
    else
        echo "⚠️ Please install MongoDB manually"
        echo "Visit: https://docs.mongodb.com/manual/installation/"
    fi
else
    echo "✅ MongoDB already installed"
fi

# Setup new package.json
echo "📋 Setting up new package.json..."
cp package_new.json package.json

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Setup environment
echo "⚙️ Setting up environment..."
cp .env.new .env

# Get public IP for domain setup
PUBLIC_IP=$(curl -s ifconfig.me)
echo "🌐 Your server IP: $PUBLIC_IP"

# Update domain in .env
read -p "🔧 Enter your domain (e.g., download.hariom.site) or press Enter for IP: " DOMAIN_INPUT
if [ -z "$DOMAIN_INPUT" ]; then
    DOMAIN_INPUT="http://$PUBLIC_IP:3000"
else
    DOMAIN_INPUT="https://$DOMAIN_INPUT"
fi

sed -i "s|https://download.hariom.site|$DOMAIN_INPUT|g" .env

echo "📝 Updated domain to: $DOMAIN_INPUT"

# Create storage channel instructions
echo ""
echo "📋 IMPORTANT: Create Storage Channel"
echo "=================================="
echo "1. Create a new private Telegram channel"
echo "2. Add your bot as an administrator"
echo "3. Get the channel ID (use @userinfobot)"
echo "4. Update BIN_CHANNEL in .env file"
echo ""
echo "Example channel ID: -1001234567890"
echo ""

# Setup PM2 configuration
echo "🔧 Setting up PM2 configuration..."
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'filetolink-bot',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    }
  }]
};
EOF

echo ""
echo "🎉 Setup Complete!"
echo ""
echo "📋 Next Steps:"
echo "1. Create a private Telegram channel for file storage"
echo "2. Add your bot as admin to the channel"
echo "3. Get channel ID and update BIN_CHANNEL in .env"
echo "4. Start the bot: npm start"
echo "5. Or use PM2: pm2 start ecosystem.config.js"
echo ""
echo "🔧 Configuration file: .env"
echo "🌐 Your bot will run on: $DOMAIN_INPUT"
echo ""
echo "✨ Features:"
echo "• Permanent file links"
echo "• Built-in streaming server"
echo "• MongoDB database"
echo "• Professional URLs"
echo "• No Docker required"