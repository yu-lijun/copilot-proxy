# GitHub Copilot API 代理

> 让 Claude Code、Cursor 等工具通过 OpenAI 兼容接口接入 GitHub Copilot

## 📋 概述

`copilot-proxy` 是一个 GitHub Copilot API 代理服务，通过模拟 OpenAI 和 Anthropic 兼容接口，让第三方 AI 客户端（如 Claude Code、Cursor、VS Code 等）可以直接使用 GitHub Copilot。

### 核心功能

- 🔐 **OAuth 授权** - 支持 GitHub Device Flow 安全授权
- 🌐 **OpenAI 兼容** - `/v1/chat/completions` 端点
- 🦦 **Anthropic 兼容** - `/v1/messages` 端点
- 💻 **人性化 CLI** - 简洁的命令行工具
- 🔄 **自动 Token 刷新** - 登录一次，持久化使用

### 技术栈

- **Runtime**: Node.js + TypeScript
- **Web Framework**: Express.js
- **HTTP Client**: Axios
- **CLI**: Yargs

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

### 关键点

1. **OAuth Client**: 使用 GitHub 官方 Copilot OAuth App (`Iv1.b507a08c87ecfe98`)
2. **Scope**: `read:user copilot` - 需要 Copilot 访问权限
3. **Token 类型**: `ghu_xxx` - GitHub OAuth token
4. **认证方式**: 直接将 OAuth token 作为 Bearer Token 使用

---

## 📡 API 端点

### 1. 健康检查

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

### 2. 登录授权

```bash
GET /login
```

打开此页面会触发 OAuth 流程，返回验证码页面。

### 3. 轮询 Token

```bash
GET /poll
```

授权成功后自动跳转，保存 token。

### 4. OpenAI 兼容 - Chat Completions

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

### 5. Anthropic 兼容 - Messages

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

### 6. 模型列表

```bash
GET /v1/models
```

---

## 🚀 使用说明

### 1. 安装

```bash
cd copilot-proxy
npm install
npm run build
```

### 2. 启动服务

```bash
# 方式一：使用 npm 命令（推荐）
npm start

# 方式二：直接运行
node dist/cli.js

# 方式三：开发模式
npm run dev
```

### 3. 登录 GitHub

```bash
# 命令行登录
copilot-cli login

# 或者访问 Web 界面
open http://localhost:4141/login
```

登录流程：
1. 自动打开浏览器
2. 输入验证码（如 `8A7F-3F4F`）
3. 点击"授权"
4. 授权成功后自动跳转

### 4. 使用代理 API

```bash
# 测试 Chat Completions
curl -X POST http://localhost:4141/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }'

# 测试 Anthropic 兼容端点
curl -X POST http://localhost:4141/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 50
  }'

# 查看可用模型
curl http://localhost:4141/v1/models
```

### 5. CLI 命令

```bash
copilot-cli login      # 登录 GitHub
copilot-cli status     # 查看连接状态
copilot-cli models     # 查看可用模型
copilot-cli logout     # 退出登录
copilot-cli            # 启动服务（默认）
```

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
- `getDeviceCode()` - 获取设备验证码
- `pollAccessToken()` - 轮询获取 Access Token

#### 3. Copilot Token 获取 (`cli.ts:112-151`)
- 尝试调用 `copilot_internal/v2/token` 获取专用 token
- 失败时回退使用 GitHub OAuth token

#### 4. HTTP 服务 (`cli.ts:240-515`)
- Web UI (`/`, `/login`, `/poll`)
- API 代理 (`/v1/chat/completions`, `/v1/messages`)
- 模型列表 (`/v1/models`)

---

## 🔧 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 4141 | 服务端口 |
| `GITHUB_TOKEN` | - | 可直接设置 GitHub PAT（可选） |

### 配置文件

首次登录成功后，token 会保存到 `dist/config.json`：

```json
{
  "githubToken": "ghu_xxx..."
}
```

---

## ⚠️ 注意事项

1. **Copilot 订阅**: 使用本服务需要拥有 GitHub Copilot 订阅
2. **Token 有效期**: OAuth token 通常有效期较长，但某些情况下可能失效
3. **速率限制**: 遵守 GitHub Copilot API 的速率限制
4. **安全**: 妥善保管 token，不要提交到 GitHub

---

## 🐛 常见问题

### Q: 403 Forbidden 错误
**A**: 检查是否正确获取了 Copilot 授权，确认 GitHub 账号有 Copilot 订阅

### Q: 登录后仍提示未授权
**A**: 检查 `dist/config.json` 是否正确保存了 token，可尝试重新登录

### Q: API 调用超时
**A**: 网络问题，检查到 `api.githubcopilot.com` 的连接

### Q: 如何更新 token？
**A**: 运行 `copilot-cli logout` 清除后重新登录

---

## 📝 更新日志

### v1.0.0
- 初始版本
- 支持 OAuth Device Flow
- OpenAI + Anthropic 兼容接口
- 人性化 CLI 工具

---

## 📄 许可证

MIT License
