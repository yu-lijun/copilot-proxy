# copilot-proxy 技术文档

> 系统架构、认证流程、API 端点、代码结构与配置参考

---

## 🏗 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户客户端                                │
│   (Claude Code / Cursor / curl / 任何 AI 客户端)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (OpenAI/Anthropic 协议)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    copilot-proxy (本服务)                       │
│                                                                 │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│   │  Web UI      │    │  OAuth Flow  │    │  API Proxy   │   │
│   │  /           │    │  /auth       │    │  /v1/*       │   │
│   │  /login      │    │  /auth/poll  │    │              │   │
│   └──────────────┘    └──────────────┘    └──────────────┘   │
│                                                                 │
│                      Token Store (config.json)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Bearer Token
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GitHub Copilot API                          │
│                                                                 │
│   https://api.githubcopilot.com/chat/completions               │
│                                                                 │
│   需要: GitHub Copilot 订阅 + OAuth token (copilot scope)       │
└─────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 层级 | 技术 |
|------|------|
| Runtime | Node.js + TypeScript |
| Web Framework | Express.js |
| HTTP Client | Axios |
| CLI | Yargs |

---

## 🔐 认证流程

### OAuth Device Flow

由于是服务端应用，无法直接使用用户名密码，采用 GitHub Device Flow 进行授权：

```
┌─────────────┐                           ┌─────────────┐
│   用户      │                           │  GitHub     │
│  (浏览器)   │                           │  OAuth      │
└──────┬──────┘                           └──────┬──────┘
       │                                         │
       │  1. 请求 Device Code                    │
       ├────────────────────────────────────────►│
       │                                         │
       │  2. 返回 user_code + verification_uri   │
       │◄────────────────────────────────────────┤
       │                                         │
       │  3. 打开 verification_uri                │
       │  输入 user_code                         │
       │────────────────────────────────────────►│
       │                                         │
       │  4. 用户在 GitHub 点击"授权"             │
       │                                         │
       │  5. 轮询 access_token                   │
       ├────────────────────────────────────────►│
       │                                         │
       │  6. 返回 access_token (ghu_xxx)         │
       │◄────────────────────────────────────────┤
       │                                         │
       ▼                                         ▼
```

### 关键参数

| 参数 | 值 |
|------|----|
| OAuth Client ID | `Iv1.b507a08c87ecfe98` (GitHub 官方 Copilot OAuth App) |
| Scope | `read:user copilot` |
| Token 类型 | `ghu_xxx` (GitHub OAuth token) |
| 认证方式 | OAuth token 直接作为 Bearer Token 使用 |

---

## 📡 API 端点

### GET `/health` — 健康检查

```bash
GET /health
```

响应:
```json
{
  "status": "ok",
  "auth": "connected",
  "url": "http://localhost:4141"
}
```

### GET `/login` — 登录授权

触发 OAuth Device Flow，返回包含验证码的页面。

### GET `/poll` — 轮询 Token

授权成功后自动跳转，将 token 保存到本地。

### POST `/v1/chat/completions` — OpenAI 兼容

```bash
POST /v1/chat/completions
Content-Type: application/json

{
  "model": "claude-sonnet-4.5",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 100
}
```

### POST `/v1/messages` — Anthropic 兼容

```bash
POST /v1/messages
Content-Type: application/json

{
  "model": "claude-sonnet-4.5",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "max_tokens": 100
}
```

### GET `/v1/models` — 模型列表

返回当前可用的模型列表。

---

## 💻 代码结构

```
copilot-proxy/
├── src/
│   ├── cli.ts          # 人性化 CLI 版本（含 Web UI）
│   └── index.ts        # 纯 API 版本
├── dist/               # 编译输出
├── package.json
├── tsconfig.json
└── README.md
```

### 核心模块

#### 1. 配置管理 (`cli.ts:31-55`)

- 从 `config.json` 加载/保存配置
- 支持 GitHub Token 持久化

#### 2. OAuth Device Flow (`cli.ts:57-88`)

- `getDeviceCode()` — 获取设备验证码
- `pollAccessToken()` — 轮询获取 Access Token

#### 3. Copilot Token 获取 (`cli.ts:112-151`)

- 尝试调用 `copilot_internal/v2/token` 获取专用 token
- 失败时回退使用 GitHub OAuth token

#### 4. HTTP 服务 (`cli.ts:240-515`)

- Web UI：`/`、`/login`、`/poll`
- API 代理：`/v1/chat/completions`、`/v1/messages`
- 模型列表：`/v1/models`

---

## 🔧 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4141` | 服务监听端口 |
| `GITHUB_TOKEN` | — | 可直接设置 GitHub PAT（可选，替代 OAuth 流程） |

### 配置文件

首次登录成功后，token 会持久化到 `dist/config.json`：

```json
{
  "githubToken": "ghu_xxx..."
}
```

> ⚠️ 请勿将此文件提交到版本控制系统。

---

## ⚠️ 注意事项

1. **Copilot 订阅**: 使用本服务需要拥有有效的 GitHub Copilot 订阅
2. **Token 有效期**: OAuth token 通常有效期较长，但某些情况下可能失效，需重新登录
3. **速率限制**: 遵守 GitHub Copilot API 的速率限制，避免触发封禁
4. **安全**: 妥善保管 `config.json` 中的 token，不要提交到 GitHub

---

## 🐛 常见问题

### Q: 403 Forbidden 错误
**A**: 检查是否正确获取了 Copilot 授权，确认 GitHub 账号拥有 Copilot 订阅。

### Q: 登录后仍提示未授权
**A**: 检查 `dist/config.json` 是否正确保存了 token，可尝试重新运行 `copilot-cli logout` 后再次登录。

### Q: API 调用超时
**A**: 网络问题，检查本机到 `api.githubcopilot.com` 的连通性。

### Q: 如何更新 token？
**A**: 运行 `copilot-cli logout` 清除后重新执行登录流程。
