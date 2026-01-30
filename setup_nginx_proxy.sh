#!/bin/bash

echo "🔒 Setting up Nginx Reverse Proxy for Secure Access..."

# Install nginx if not present
if ! command -v nginx &> /dev/null; then
    echo "📦 Installing Nginx..."
    sudo apt update
    sudo apt install -y nginx
fi

# Create nginx configuration
echo "📝 Creating Nginx configuration..."
sudo tee /etc/nginx/sites-available/telegram-bot-api > /dev/null <<EOF
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;
    
    # Only allow file downloads, block API access
    location /file/ {
        proxy_pass http://localhost:8081;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        
        # Security headers
        add_header X-Content-Type-Options nosniff;
        add_header X-Frame-Options DENY;
        
        # Rate limiting
        limit_req zone=download burst=10 nodelay;
    }
    
    # Block all other API endpoints
    location / {
        return 403;
    }
}

# Rate limiting zone
limit_req_zone \$binary_remote_addr zone=download:10m rate=10r/s;
EOF

# Enable the site
sudo ln -sf /etc/nginx/sites-available/telegram-bot-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

echo "✅ Nginx proxy configured!"
echo "🌍 Files will be accessible via: http://YOUR_DOMAIN_OR_IP/file/..."
echo "🔒 API endpoints are blocked for security"