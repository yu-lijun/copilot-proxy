#!/usr/bin/env node

import express from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
app.use(express.json());

// ============ 配置 ============
const CONFIG_FILE = path.join(__dirname, 'config.json');
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // GitHub 官方 Copilot OAuth App
const PORT = parseInt(process.env.PORT || '4141');
const COPILOT_CHAT_URL = 'https://api.githubcopilot.com/chat/completions';

// 模型列表
const MODELS = [
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic' },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', provider: 'Anthropic' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'claude-opus-4', name: 'Claude Opus 4', provider: 'Anthropic' },
  { id: 'gpt-5', name: 'GPT-5', provider: 'OpenAI' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'Google' },
];

// ============ 配置管理 ============
interface Config {
  githubToken?: string | null;
  copilotToken?: string | null;
  copilotTokenExpiry?: number;
}

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) { }
  return {};
}

function saveConfig(config: Config): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Token 存储
let githubToken: string | null = config.githubToken || null;
let copilotToken: string | null = config.copilotToken || null;
let copilotTokenExpiry: number = config.copilotTokenExpiry || 0;

// ============ OAuth Device Flow ============
let pendingOAuth: { device_code: string; user_code: string; verification_uri: string; interval: number } | null = null;

async function getDeviceCode(): Promise<{ device_code: string; user_code: string; verification_uri: string; interval: number }> {
  const response = await axios.post(
    'https://github.com/login/device/code',
    { client_id: GITHUB_CLIENT_ID, scope: 'read:user copilot' },
    { headers: { Accept: 'application/json' } }
  );
  return response.data;
}

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
        { headers: { Accept: 'application/json' } }
      );
      if (response.data.access_token) return response.data.access_token;
      if (response.data.error === 'expired_token') throw new Error('授权码已过期');
    } catch (e: any) {
      if (e.response?.data?.error === 'expired_token') throw new Error('授权码已过期');
    }
  }
}

// ============ 彩色输出 ============
const colors = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
};

function printBanner(): void {
  console.clear();
  console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ${colors.green}🚀 GitHub Copilot API 代理${colors.cyan}                              ║
║   ${colors.dim}让 Claude Code / Codex 等工具接入 Copilot${colors.cyan}            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝${colors.reset}

${colors.yellow}📋 可用模型:${colors.reset}`);
  MODELS.forEach(m => console.log(`   ${colors.green}•${colors.reset} ${m.id.padEnd(22)} ${colors.dim}(${m.provider})${colors.reset}`));
  console.log('');
}

// ============ Copilot Token 获取 ============
async function getCopilotToken(): Promise<string> {
  if (copilotToken && Date.now() < copilotTokenExpiry - 5 * 60 * 1000) {
    return copilotToken;
  }

  if (!githubToken) {
    throw new Error('请先运行登录命令: copilot-cli login');
  }

  // 尝试用 copilot_internal 获取专用 token
  try {
    const response = await axios.post(
      'https://api.github.com/copilot_internal/v2/token',
      {},
      {
        headers: {
          Authorization: `token ${githubToken}`,
          'Editor-Version': 'vscode/1.99.1',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
        }
      }
    );
    copilotToken = response.data.token;
    copilotTokenExpiry = Date.now() + (response.data.refresh_in - 60) * 1000;

    // 保存到配置
    config.copilotToken = copilotToken;
    config.copilotTokenExpiry = copilotTokenExpiry;
    saveConfig(config);

    console.log(`${colors.green}✓${colors.reset} Copilot Token 刷新成功`);
    return copilotToken!;
  } catch (e) {
    // 如果失败，直接用 GitHub OAuth token（部分账号可以）
    console.log(`${colors.yellow}⚠${colors.reset} 专用 Token 获取失败，使用 GitHub Token`);
    return githubToken;
  }
}

// ============ CLI 命令 ============
import yargs from 'yargs';

const argv = yargs
  .option('daemon', {
    alias: 'd',
    type: 'boolean',
    description: '后台运行服务',
    default: false
  })
  .command('login', '登录 GitHub 账号', {}, async () => {
    printBanner();
    console.log(`${colors.yellow}🔐 正在发起授权请求...${colors.reset}\n`);

    const { device_code, user_code, verification_uri, interval } = await getDeviceCode();
    pendingOAuth = { device_code, user_code, verification_uri, interval };

    console.log(`${colors.green}┌─────────────────────────────────────────────────────────┐${colors.reset}`);
    console.log(`${colors.green}│${colors.reset}  ${colors.bright}请在浏览器中授权${colors.reset}                                  ${colors.green}│${colors.reset}`);
    console.log(`${colors.green}├─────────────────────────────────────────────────────────┤${colors.reset}`);
    console.log(`${colors.green}│${colors.reset}  打开: ${colors.cyan}${verification_uri}${colors.reset}`);
    console.log(`${colors.green}│${colors.reset}  输入验证码: ${colors.magenta}${colors.bright}${user_code}${colors.reset}`);
    console.log(`${colors.green}└─────────────────────────────────────────────────────────┘${colors.reset}\n`);

    // 自动打开浏览器
    exec(`open "${verification_uri}"`);

    console.log(`${colors.yellow}⏳ 等待授权中... (按 Ctrl+C 取消)${colors.reset}\n`);

    try {
      const token = await pollAccessToken(device_code, interval || 5);
      githubToken = token;
      config.githubToken = token;
      saveConfig(config);

      console.log(`\n${colors.green}✅ 登录成功！${colors.reset}\n`);
      await testConnection();
    } catch (e: any) {
      console.log(`\n${colors.red}❌ 授权失败: ${e.message}${colors.reset}`);
    }
  })
  .command('logout', '退出登录', {}, () => {
    githubToken = null;
    copilotToken = null;
    config = {};
    saveConfig({});
    console.log(`${colors.green}✅ 已退出登录${colors.reset}`);
  })
  .command('status', '查看连接状态', {}, async () => {
    printBanner();

    if (!githubToken) {
      console.log(`${colors.red}❌ 未登录${colors.reset}\n`);
      console.log(`   运行 ${colors.cyan}copilot-cli login${colors.reset} 登录\n`);
      return;
    }

    const tokenType = githubToken.startsWith('gho_') ? 'OAuth Token' : 'PAT';
    console.log(`${colors.green}✓${colors.reset} 已登录 (${tokenType})`);
    console.log(`   Token: ${colors.dim}${githubToken.substring(0, 12)}...${colors.reset}\n`);

    try {
      await getCopilotToken();
      console.log(`${colors.green}✓${colors.reset} Copilot API 连接正常\n`);
    } catch (e: any) {
      console.log(`${colors.red}❌${colors.reset} Copilot API: ${e.message}\n`);
    }

    console.log(`${colors.yellow}📡 服务地址:${colors.reset}`);
    console.log(`   OpenAI 兼容: ${colors.cyan}http://localhost:${PORT}/v1/chat/completions${colors.reset}`);
    console.log(`   Anthropic 兼容: ${colors.cyan}http://localhost:${PORT}/v1/messages${colors.reset}`);
    console.log(`   健康检查: ${colors.cyan}http://localhost:${PORT}/health${colors.reset}\n`);
  })
  .command('models', '查看可用模型', {}, () => {
    printBanner();
    console.log(`${colors.yellow}📋 可用模型:${colors.reset}\n`);
    MODELS.forEach(m => {
      console.log(`   ${colors.green}•${colors.reset} ${colors.bright}${m.id}${colors.reset}`);
      console.log(`     ${colors.dim}${m.provider}${colors.reset}\n`);
    });
  })
  .command('$0', '启动代理服务', {}, (argv) => {
    // 后台启动
    if ((argv as any).daemon) {
      const logFile = '/tmp/copilot-proxy.log';

      // 使用当前进程 fork 方式后台运行
      const daemon = spawn('node', [path.join(__dirname, 'cli.js')], {
        detached: true,
        stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]
      });

      daemon.unref();

      // 等待服务启动
      setTimeout(() => {
        console.log(`${colors.green}✅${colors.reset} 服务已在后台启动`);
        console.log(`${colors.cyan}http://localhost:${PORT}${colors.reset}`);
        console.log(`${colors.dim}日志: tail -f ${logFile}${colors.reset}`);
      }, 1000);

      process.exit(0);
    }

    // 启动 HTTP 服务器
    startServer();
  })
  .recommendCommands()
  .help()
  .alias('h', 'help')
  .version('1.0.0')
  .alias('v', 'version')
  .parse();

// ============ HTTP 服务器 ============
function startServer(): void {
  // 检查认证
  function checkAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!githubToken) {
      res.status(401).json({ error: '请先登录，运行: copilot-cli login' });
      return;
    }
    next();
  }

  // 健康检查
  app.get('/health', async (req, res) => {
    let status = 'ok';
    if (githubToken) {
      try {
        await getCopilotToken();
      } catch (e: any) {
        status = 'error: ' + e.message;
      }
    }
    res.json({
      status,
      auth: githubToken ? 'connected' : 'none',
      url: `http://localhost:${PORT}`
    });
  });

  // 登录页面（HTML）
  app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitHub Copilot API 代理</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .container { text-align: center; color: white; padding: 40px; }
    h1 { font-size: 2.5rem; margin-bottom: 10px; }
    .subtitle { color: #888; margin-bottom: 40px; }
    .status { 
      background: rgba(255,255,255,0.1); border-radius: 12px; padding: 20px 40px;
      display: inline-block; margin: 20px 0;
    }
    .status.connected { border: 2px solid #4ade80; }
    .status.disconnected { border: 2px solid #f87171; }
    .btn {
      background: #2563eb; color: white; border: none; padding: 12px 30px;
      border-radius: 8px; font-size: 1rem; cursor: pointer; text-decoration: none;
      display: inline-block; margin: 10px;
    }
    .btn:hover { background: #1d4ed8; }
    .endpoints { 
      text-align: left; background: rgba(0,0,0,0.3); border-radius: 12px; 
      padding: 20px; margin-top: 30px; font-family: monospace; font-size: 0.9rem;
    }
    .endpoints code { color: #67e8f9; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 GitHub Copilot API 代理</h1>
    <p class="subtitle">让 Claude Code / Codex 等工具接入 Copilot</p>
    
    ${githubToken
        ? `<div class="status connected">✅ 已连接</div>`
        : `<div class="status disconnected">❌ 未登录</div>
         <br><a class="btn" href="/login">🔐 登录 GitHub</a>`
      }
    
    <div class="endpoints">
      <div><strong>📡 API 端点:</strong></div>
      <br>
      <div><code>POST /v1/chat/completions</code> - OpenAI 兼容</div>
      <div><code>POST /v1/messages</code> - Anthropic 兼容</div>
      <div><code>GET  /health</code> - 健康检查</div>
      <br>
      <div><strong>📋 可用模型:</strong></div>
      <div style="color: #888; margin-top: 5px;">claude-sonnet-4.5, gpt-5, gemini-2.5-pro, ...</div>
    </div>
  </div>
</body>
</html>
    `);
  });

  // 登录
  app.get('/login', async (req, res) => {
    try {
      const { device_code, user_code, verification_uri, interval } = await getDeviceCode();
      pendingOAuth = { device_code, user_code, verification_uri, interval };

      res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>登录 - GitHub Copilot</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white;
    }
    .container { text-align: center; }
    h1 { margin-bottom: 20px; }
    .code { 
      font-size: 3rem; letter-spacing: 8px; color: #67e8f9; 
      background: rgba(255,255,255,0.1); padding: 20px 40px; 
      border-radius: 12px; margin: 20px 0;
    }
    .btn { 
      background: #2563eb; color: white; padding: 15px 40px; 
      border-radius: 8px; text-decoration: none; font-size: 1.1rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 GitHub 授权</h1>
    <p>请在打开的页面中输入:</p>
    <div class="code">${user_code}</div>
    <a class="btn" href="${verification_uri}" target="_blank">打开授权页面</a>
    <p style="margin-top: 20px; color: #888;" id="status-msg">等待授权中，请在浏览器中完成操作...</p>
  </div>
  <script>
    function poll() {
      fetch('/poll')
        .then(r => r.json())
        .then(data => {
          if (data.status === 'done') {
            window.location.href = '/';
          } else if (data.status === 'error') {
            document.getElementById('status-msg').textContent = '授权失败: ' + data.message;
          } else {
            // pending，继续轮询
            setTimeout(poll, 3000);
          }
        })
        .catch(() => setTimeout(poll, 3000));
    }
    setTimeout(poll, 3000);
  </script>
</body>
</html>
      `);
    } catch (e: any) {
      res.status(500).send('错误: ' + e.message);
    }
  });

  // 轮询 token（每次只尝试一次，由前端定时轮询，避免长连接阻塞）
  app.get('/poll', async (req, res) => {
    if (!pendingOAuth) {
      return res.json({ status: 'done' });
    }

    try {
      const response = await axios.post(
        'https://github.com/login/oauth/access_token',
        {
          client_id: GITHUB_CLIENT_ID,
          device_code: pendingOAuth.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        { headers: { Accept: 'application/json' } }
      );

      if (response.data.access_token) {
        githubToken = response.data.access_token;
        config.githubToken = githubToken;
        saveConfig(config);
        pendingOAuth = null;
        return res.json({ status: 'done' });
      }

      if (response.data.error === 'expired_token') {
        pendingOAuth = null;
        return res.json({ status: 'error', message: '授权码已过期' });
      }

      // authorization_pending / slow_down → 继续等待
      return res.json({ status: 'pending' });
    } catch (e: any) {
      return res.json({ status: 'error', message: e.message });
    }
  });

  // Chat Completions
  app.post('/v1/chat/completions', checkAuth, async (req, res) => {
    try {
      const { model, messages, max_tokens, stream } = req.body;
      const copilotTokenValue = await getCopilotToken();

      const response = await axios.post(
        COPILOT_CHAT_URL,
        { model, messages, max_tokens: max_tokens || 4096, stream: stream || false },
        {
          headers: {
            Authorization: `Bearer ${copilotTokenValue}`,
            'Content-Type': 'application/json',
            'Copilot-Integration-Id': 'vscode-chat',
            'Editor-Version': 'vscode/1.99.1',
            'Editor-Plugin-Version': 'copilot-chat/0.26.7',
            'User-Agent': 'GitHubCopilotChat/0.26.7',
            'x-github-api-version': '2025-04-01',
            'x-request-id': randomUUID(),
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
      res.status(500).json({ error: { message: error.response?.data?.message || error.message } });
    }
  });

  // Anthropic 兼容
  app.post('/v1/messages', checkAuth, async (req, res) => {
    try {
      const { model, messages, max_tokens, system } = req.body;
      const copilotModel = model || 'claude-sonnet-4.5'; // 使用传入的 model，默认 claude-sonnet-4.5
      const copilotTokenValue = await getCopilotToken();

      const openAIMessages: any[] = [];
      if (system) openAIMessages.push({ role: 'system', content: system });
      openAIMessages.push(...messages.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      })));

      const response = await axios.post(
        COPILOT_CHAT_URL,
        { model: copilotModel, messages: openAIMessages, max_tokens: max_tokens || 4096, stream: false },
        {
          headers: {
            Authorization: `Bearer ${copilotTokenValue}`,
            'Content-Type': 'application/json',
            'Copilot-Integration-Id': 'vscode-chat',
            'Editor-Version': 'vscode/1.99.1',
            'Editor-Plugin-Version': 'copilot-chat/0.26.7',
            'User-Agent': 'GitHubCopilotChat/0.26.7',
            'x-github-api-version': '2025-04-01',
            'x-request-id': randomUUID(),
          }
        }
      );

      res.json({
        id: response.data.id,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: response.data.choices?.[0]?.message?.content || '' }],
        model,
        stop_reason: 'end_turn',
        usage: { input_tokens: response.data.usage?.prompt_tokens || 0, output_tokens: response.data.usage?.completion_tokens || 0 }
      });
    } catch (error: any) {
      res.status(500).json({ error: { type: 'error', message: error.response?.data?.message || error.message } });
    }
  });

  // 模型列表
  app.get('/v1/models', (req, res) => {
    res.json({
      data: MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: 1700000000,
        owned_by: m.provider.toLowerCase()
      }))
    });
  });

  // 启动
  app.listen(PORT, () => {
    printBanner();

    if (!githubToken) {
      console.log(`${colors.red}❌ 未登录${colors.reset}\n`);
      console.log(`   ${colors.cyan}copilot-cli login${colors.reset}  - 登录 GitHub 账号`);
      console.log(`   ${colors.cyan}copilot-cli status${colors.reset} - 查看状态\n`);
    } else {
      console.log(`${colors.green}✅ 已连接${colors.reset}\n`);
    }

    console.log(`${colors.yellow}🌐 Web 界面:${colors.reset} http://localhost:${PORT}`);
    console.log(`${colors.yellow}📡 API 端点:${colors.reset}`);
    console.log(`   OpenAI:     POST http://localhost:${PORT}/v1/chat/completions`);
    console.log(`   Anthropic:  POST http://localhost:${PORT}/v1/messages`);
    console.log(`   模型列表:   GET  http://localhost:${PORT}/v1/models\n`);
  });
}

async function testConnection(): Promise<void> {
  try {
    await getCopilotToken();
    console.log(`${colors.green}✓${colors.reset} Copilot API 测试成功\n`);
  } catch (e: any) {
    console.log(`${colors.yellow}⚠${colors.reset} Copilot API: ${e.message}\n`);
  }
}
