import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// 强制验证登录状态，防止未授权用户盗用代理
router.use(requireAuth);

// 私有/内网地址黑名单
const BLOCKED_HOSTNAMES = [
  'localhost', '127.0.0.1', '[::1]', '0.0.0.0',
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '169.254.0.0/16', 'fc00::/7', 'fe80::/10'
];

function isPrivateHost(hostname) {
  // Direct matches
  if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(hostname)) return true;
  // IPv4 private ranges
  const ipv4 = hostname.split('.').map(Number);
  if (ipv4.length === 4 && ipv4.every(n => !isNaN(n))) {
    if (ipv4[0] === 10) return true;
    if (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) return true;
    if (ipv4[0] === 192 && ipv4[1] === 168) return true;
    if (ipv4[0] === 169 && ipv4[1] === 254) return true;
  }
  return false;
}

/**
 * /api/ai-proxy — AI 接口代理（开放模式 + 内网防护）
 *
 * 客户端设置以下请求头：
 *   x-target-url       — 目标 API 完整地址（如 https://api.openai.com/v1/chat/completions）
 *   x-user-api-key     — 用户的 API Key（内存中短暂存在，用完即焚）
 *   x-api-key-header   — 注入 Key 的请求头名称（默认 Authorization，Claude 用 x-api-key）
 *
 * 所有流量经 HTTPS 传输，API Key 仅在服务端内存短暂驻留，不落盘不记录。
 */
router.all('/', async (req, res) => {
  const targetUrl = req.headers['x-target-url'];
  const apiKey = req.headers['x-user-api-key'];
  const apiKeyHeaderName = req.headers['x-api-key-header'] || 'Authorization';

  if (!targetUrl) {
    return res.status(400).json({ error: '缺少目标代理地址 x-target-url' });
  }
  if (!apiKey) {
    return res.status(401).json({ error: '缺少 API 密钥 x-user-api-key' });
  }

  // 安全校验 1：只允许 HTTPS
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: '无效的目标 URL' });
  }
  if (parsed.protocol !== 'https:') {
    return res.status(403).json({ error: '仅允许 HTTPS 目标' });
  }

  // 安全校验 2：禁止代理到内网地址
  if (isPrivateHost(parsed.hostname)) {
    console.warn(`[AI PROXY] Blocked internal target: ${targetUrl}`);
    return res.status(403).json({ error: '禁止代理到内网地址' });
  }

  try {
    // 准备转发请求头（仅复制安全的请求头）
    const forwardHeaders = {};
    const safeHeaders = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent'];
    for (const key of safeHeaders) {
      if (req.headers[key]) forwardHeaders[key] = req.headers[key];
    }

    // 注入用户的 API Key
    if (apiKeyHeaderName.toLowerCase() === 'authorization') {
      forwardHeaders['Authorization'] = `Bearer ${apiKey}`;
    } else {
      forwardHeaders[apiKeyHeaderName] = apiKey;
    }

    const fetchOptions = { method: req.method, headers: forwardHeaders };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const upstreamResponse = await fetch(targetUrl, fetchOptions);
    res.status(upstreamResponse.status);

    // 复制安全响应头
    for (const key of ['content-type', 'cache-control']) {
      const val = upstreamResponse.headers.get(key);
      if (val) res.setHeader(key, val);
    }

    // 流式响应（SSE）
    const contentType = upstreamResponse.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') || (req.headers['accept'] || '').includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = upstreamResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (e) {
        console.error('[AI PROXY] Stream error:', e.message);
      }
      res.end();
    } else {
      const data = await upstreamResponse.arrayBuffer();
      res.send(Buffer.from(data));
    }
  } catch (error) {
    console.error('[AI PROXY] Upstream failed:', error.message, error.cause || '');
    res.status(502).json({ error: `AI 代理请求上游失败: ${error.message} ${error.cause ? error.cause.message : ''}`.trim() });
  }
});

export default router;
