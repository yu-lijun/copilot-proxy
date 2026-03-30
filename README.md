# GitHub Copilot API 代理

> 让 Claude Code、Codex 等工具通过 OpenAI 兼容接口接入 GitHub Copilot

## 概述

`copilot-proxy` 是一个 GitHub Copilot API 代理服务，通过模拟 OpenAI 和 Anthropic 兼容接口，让第三方 AI 客户端（如 Claude Code、Codex 等）可以直接使用 GitHub Copilot。

### 核心功能

- **OAuth 授权** - 支持 GitHub Device Flow 安全授权
- **OpenAI 兼容** - `http://localhost:4141/v1/chat/completions`
- **Anthropic 兼容** - `http://localhost:4141/v1/messages`
- **人性化 CLI** - 简洁的命令行工具
- **自动 Token 刷新** - 登录一次，持久化使用

> 系统架构、API 端点、代码结构等技术细节请参阅 [TECHNICAL.md](./TECHNICAL.md)

---

## 快速开始

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

## 更新日志

### v1.0.0
- 初始版本
- 支持 OAuth Device Flow
- OpenAI + Anthropic 兼容接口
- 人性化 CLI 工具

---

## 许可证

MIT License
