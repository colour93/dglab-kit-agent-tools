# DG-LAB Kit Agent Tools
基于 `dglab-kit` 的本地 DG-LAB 设备控制 MCP & Skill。

## 目录

- `mcp/`：TypeScript 编写、Bun 优先的本地 stdio MCP Server。
- `skills/dglab-control/`：供 Codex 使用的控制 Skill。
  - `SKILL.md`：配对、设备选择和 MCP 调用流程。
  - `references/intent-contract.md`：自然语言意图映射。
  - `references/safety.md`：限幅、时长和断开清理规则。
  - `references/protocol.md`：`dglab-kit` V3/V4 协议参考。
  - `references/transport.md`：扩展传输方式时使用的 V4 HTTP/WS 参考。

## 安装 MCP

```bash
cd mcp
bun install
```

没有 Bun 时可使用 Node.js 22+：

```bash
cd mcp
npm install
```

Codex 的 `config.toml` 可添加本地 stdio MCP。将路径替换为仓库的绝对路径：

```toml
[mcp_servers.dglab]
command = "bun"
args = ["run", "/absolute/path/to/dglab-kit-mcp/mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 30
```

Node.js 备选配置：

```toml
[mcp_servers.dglab]
command = "npm"
args = ["--prefix", "/absolute/path/to/dglab-kit-mcp/mcp", "run", "start:node"]
startup_timeout_sec = 20
tool_timeout_sec = 30
```

Bun 会直接运行 TypeScript；Node.js 备选通过 `tsx` 加载同一份源码，不需要维护单独的 JavaScript 构建产物。

重启 MCP 客户端后，应能看到以下工具：

- `dglab_connect`：连接 V4 中继并返回配对二维码。
- `dglab_status`：查看 APP、设备、波形、选择与安全上限。
- `dglab_select_target`：显式选择 APP、设备和通道。
- `dglab_increase` / `dglab_decrease`：相对调整强度。
- `dglab_set_temporary`：设置有时限的临时强度。
- `dglab_play_waveform`：播放兼容波形。
- `dglab_stop`：优先取消排队并清理当前通道。
- `dglab_disconnect`：清理本进程操作过的通道并断开。

## 安装 Skill

将 `skills/dglab-control` 复制或链接到 Codex skills 目录，然后通过 `$dglab-control` 使用。Skill 依赖上面的 `dglab` MCP 已启用。

## 安全与并发

默认安全上限：单次相对变化 `5`、临时强度 `20`、持续时间 `5000ms`。可以通过环境变量设置更严格的值：

- `DGLAB_MAX_DELTA`
- `DGLAB_MAX_INTENSITY`
- `DGLAB_MAX_DURATION_MS`
- `DGLAB_RELAY`

同一设备通道的普通控制指令按顺序执行；`dglab_stop` 不等待队列，会先使未执行指令失效，再向当前通道发送清理请求。MCP 退出或主动断开时，会尽力清理本进程操作过的通道。
