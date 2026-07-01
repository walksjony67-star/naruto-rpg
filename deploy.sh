#!/bin/bash
# ==============================================
#  忍者手记 - 一键上线部署脚本
#  用法: bash deploy.sh
#  只上传代码，不含大图片（图片单独传）
# ==============================================
set -e

SERVER="root@8.162.24.147"
SSH_KEY="$HOME/.ssh/id_ed25519"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAR_FILE="/tmp/naruto-rpg-deploy.tar.gz"
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")

echo "========================================"
echo "  忍者手记 一键部署"
echo "  $TIMESTAMP  →  $SERVER"
echo "========================================"

cd "$PROJECT_DIR"

# 1. 打包（仅代码，不含图片/隐私/临时文件）
echo "[1/4] 打包..."
tar czf "$TAR_FILE" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='*.png' --exclude='*.jpg' \
  --exclude='server/db/*.db*' \
  --exclude='.playwright-mcp' --exclude='.claude' \
  --exclude='dist' --exclude='archive-scripts' \
  --exclude='test*' --exclude='temp*' --exclude='fix*' \
  --exclude='find*' --exclude='patch*' --exclude='search*' \
  --exclude='discord-proxy-worker.js' \
  --exclude='*.bat' --exclude='deploy.sh' \
  index.html manifest.json sw.js \
  css/ js/ server/ public/ \
  package.json package-lock.json .env.example \
  2>/dev/null

echo "  ✓ $(du -h "$TAR_FILE" | cut -f1)"

# 2. 上传
echo "[2/4] 上传..."
scp $SSH_OPTS "$TAR_FILE" "$SERVER:/tmp/" || { echo "  ✗ 上传失败"; exit 1; }
echo "  ✓ 完成"

# 3. 部署
echo "[3/4] 部署..."
ssh $SSH_OPTS "$SERVER" << 'ENDSSH'
set -e

# 静态文件 → /var/www/naruto-rpg
cd /var/www/naruto-rpg
tar xzf /tmp/naruto-rpg-deploy.tar.gz 2>/dev/null
chown -R www-data:www-data /var/www/naruto-rpg/

# 后端文件 → /opt/naruto-rpg（保留 .env）
cd /opt/naruto-rpg
tar xzf /tmp/naruto-rpg-deploy.tar.gz \
  server/ js/ public/ package.json package-lock.json .env.example \
  2>/dev/null || true

# 装依赖（如有新增）
npm install --omit=dev --silent 2>&1 | tail -1

chmod 600 .env 2>/dev/null || true
chown -R www-data:www-data . 2>/dev/null || true

rm -f /tmp/naruto-rpg-deploy.tar.gz
echo "  ✓ 部署完成"
ENDSSH

# 4. 重启
echo "[4/4] 重启..."
ssh $SSH_OPTS "$SERVER" '
systemctl restart naruto-rpg && sleep 2
systemctl reload nginx
echo ""
systemctl status naruto-rpg --no-pager -l | head -4
echo ""
curl -skI https://localhost/ 2>&1 | head -2
'

echo ""
echo "========================================"
echo "  ✅ 上线完成  https://www.qiwu.asia/"
echo "========================================"
