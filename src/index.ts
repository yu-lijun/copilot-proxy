import express from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

// ============ 配置 ============
// 使用 GitHub 官方 Copilot OAuth App
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const PORT = parseInt(process.env.PORT || '4141');

// Token 存储
let githubToken: string | null = process.env.GITHUB_TOKEN || null;
let copilotToken: string | null = null;
let copilotTokenExpiry: number = 0;

// Copilot API 端点 - 和 opencode 一样
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions';

// 模型映射
const MODEL_MAP: Record<string, string> = {
  'claude-opus-4': 'claude-4-opus',
  'claude-sonnet-4': 'claude-4-sonnet',
  'claude-3.7-sonnet': 'claude-sonnet-3-7',
  'claude-3.5-sonnet': 'claude-sonnet-3-5',
  'claude-3-opus': 'claude-3-opus',
  'claude-3-sonnet': 'claude-3-sonnet',
};

// 直接使用 GitHub OAuth token（和 opencode 完全一样）
function getCopilotToken(): string {
  if (!githubToken) {
    throw new Error('请先通过 OAuth 授权');
  }
  return githubToken;
}

// ============ OAuth Device Flow ============

// 获取 Device Code
async function getDeviceCode(): Promise<{ device_code: string, user_code: string, verification_uri: string, interval: number }> {
  const response = await axios.post(
    'https://github.com/login/device/code',
    {
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user copilot'
    },
    {
      headers: {
        'Accept': 'application/json'
      }
    }
  );
  return response.data;
}

// 轮询获取 Access Token
async function pollAccessToken(device_code: string, interval: number): Promise<string> {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    
    try {
      const response = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: GITHUB_CLIENT_ID,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        {
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      if (response.data.access_token) {
        return response.data.access_token;
      }
      
      if (response.data.error === 'expired_token') {
        throw new Error('Device code expired');
      }
    } catch (error: any) {
      if (error.response?.data?.error === 'expired_token') {
        throw new Error('Device code expired');
      }
    }
  }
}

// 存储 OAuth 状态
let pendingOAuth: { device_code: string, user_code: string, verification_uri: string, interval: number } | null = null;
let oauthResolver: ((token: string) => void) | null = null;

// OAuth 授权 - 返回授权信息给用户
async function startOAuthFlow(): Promise<{ user_code: string, verification_uri: string }> {
  console.log('🚀 开始 OAuth 授权流程...');
  
  const { device_code, user_code, verification_uri, interval } = await getDeviceCode();
  
  pendingOAuth = { device_code, user_code, verification_uri, interval };
  
  // 打开浏览器
  const { exec } = require('child_process');
  exec(`open "${verification_uri}?client_id=${GITHUB_CLIENT_ID}"`);
  
  // 返回给用户
  return { user_code, verification_uri: verification_uri + '?client_id=' + GITHUB_CLIENT_ID };
}

// 轮询 token（供用户触发）
async function pollOAuthToken(): Promise<string> {
  if (!pendingOAuth) {
    throw new Error('请先调用 /auth 获取授权码');
  }
  
  return await pollAccessToken(pendingOAuth.device_code, pendingOAuth.interval || 5);
}

// ============ 中间件 ============
function checkAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!githubToken) {
    res.status(401).json({ error: '请先进行 OAuth 授权或设置 GITHUB_TOKEN 环境变量' });
    return;
  }
  next();
}

// ============ API 端点 ============

// 健康检查
app.get('/health', async (req, res) => {
  let tokenStatus = 'no';
  try {
    if (githubToken) {
      await getCopilotToken();
      tokenStatus = copilotToken ? 'ok' : 'failed';
    }
  } catch (e: any) {
    tokenStatus = 'error: ' + e.message;
  }
  
  res.json({ 
    status: 'ok', 
    auth: githubToken ? (githubToken.startsWith('gho_') ? 'oauth' : 'pat') : 'none',
    copilotToken: tokenStatus
  });
});

// 触发 OAuth 授权 - 第一步：获取授权码
app.get('/auth', async (req, res) => {
  try {
    const { user_code, verification_uri } = await startOAuthFlow();
    
    res.json({
      success: true,
      message: '请在浏览器中授权',
      user_code: user_code,
      verification_url: verification_uri,
      instruction: `请在打开的页面中输入验证码: ${user_code}`
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 轮询获取 OAuth Token
app.get('/auth/poll', async (req, res) => {
  try {
    const token = await pollOAuthToken();
    githubToken = token;
    pendingOAuth = null;
    res.json({ success: true, tokenPrefix: token.substring(0, 10) + '...' });
  } catch (error: any) {
    if (error.message.includes('expired')) {
      res.status(408).json({ error: '授权码已过期，请重新访问 /auth' });
    } else if (error.message.includes('authorization_pending')) {
      res.status(202).json({ error: '等待授权中，请先在浏览器中输入验证码' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Anthropic Messages API 兼容端点
app.post('/v1/messages', checkAuth, async (req, res) => {
  try {
    const { model, messages, max_tokens, system } = req.body;

    const copilotModel = MODEL_MAP[model] || 'claude-4-sonnet';
    const copilotTokenValue = await getCopilotToken();

    // 转换消息格式
    const openAIMessages: any[] = [];
    if (system) {
      openAIMessages.push({ role: 'system', content: system });
    }
    for (const msg of messages) {
      openAIMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }

    // 调用 GitHub Copilot API
    const response = await axios.post(
      COPILOT_CHAT_URL,
      {
        model: copilotModel,
        messages: openAIMessages,
        max_tokens: max_tokens || 4096,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${copilotTokenValue}`,
          'Content-Type': 'application/json',
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'vscode/1.99.1',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'x-github-api-version': '2025-04-01',
          'x-request-id': randomUUID()
        },
        timeout: 120000
      }
    );

    // 转换响应格式
    const anthropicResponse = {
      id: response.data.id,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: response.data.choices?.[0]?.message?.content || ''
        }
      ],
      model: model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: response.data.usage?.prompt_tokens || 0,
        output_tokens: response.data.usage?.completion_tokens || 0
      }
    };

    res.json(anthropicResponse);
  } catch (error: any) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({
      error: {
        type: 'error',
        message: error.response?.data?.message || error.message
      }
    });
  }
});

// OpenAI Chat Completions 兼容端点
app.post('/v1/chat/completions', checkAuth, async (req, res) => {
  try {
    const { model, messages, max_tokens, stream } = req.body;

    const copilotModel = MODEL_MAP[model] || model;
    const copilotTokenValue = await getCopilotToken();

    const response = await axios.post(
      COPILOT_CHAT_URL,
      {
        model: copilotModel,
        messages,
        max_tokens: max_tokens || 4096,
        stream: stream || false
      },
      {
        headers: {
          'Authorization': `Bearer ${copilotTokenValue}`,
          'Content-Type': 'application/json',
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'vscode/1.99.1',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'x-github-api-version': '2025-04-01',
          'x-request-id': randomUUID(),
          'Accept': stream ? 'text/event-stream' : 'application/json'
        },
        timeout: 120000,
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      (response.data as any).pipe(res);
    } else {
      res.json(response.data);
    }
  } catch (error: any) {
    console.error('Error:', error.response?.data || error.message);
    res.status(500).json({
      error: {
        message: error.response?.data?.message || error.message
      }
    });
  }
});

// 获取可用模型列表
app.get('/v1/models', checkAuth, async (req, res) => {
  res.json({
    data: [
      { id: 'claude-4-opus', object: 'model', created: 1700000000, owned_by: 'github' },
      { id: 'claude-4-sonnet', object: 'model', created: 1700000000, owned_by: 'github' },
      { id: 'claude-sonnet-3-7', object: 'model', created: 1700000000, owned_by: 'github' },
      { id: 'claude-3-5-sonnet', object: 'model', created: 1700000000, owned_by: 'github' },
      { id: 'claude-3-opus', object: 'model', created: 1700000000, owned_by: 'github' },
      { id: 'claude-3-sonnet', object: 'model', created: 1700000000, owned_by: 'github' }
    ]
  });
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         GitHub Copilot 代理服务已启动               ║
╠═══════════════════════════════════════════════════╣
║  端口: ${PORT}                                        ║
║  Auth: ${githubToken ? (githubToken.startsWith('gho_') ? 'OAuth ✓' : 'PAT ✓') : '✗ 未授权'}                      ║
╠═══════════════════════════════════════════════════╣
║  可用端点:                                          ║
║    GET  /health        - 健康检查                  ║
║    GET  /auth          - 触发 OAuth 授权           ║
║    POST /v1/messages   - Anthropic 兼容            ║
║    POST /v1/chat/completions - OpenAI 兼容         ║
║    GET  /v1/models     - 模型列表                  ║
╚═══════════════════════════════════════════════════╝
  `);
  
  // 如果没有 token，提示用户进行 OAuth
  if (!githubToken) {
    console.log(`
⚠️  未检测到授权，请访问 http://localhost:${PORT}/auth 进行 OAuth 授权
  `);
  }
});
