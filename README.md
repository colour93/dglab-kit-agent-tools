# DG-LAB Kit Agent Tools

让 Codex 通过自然语言安全地连接和控制 DG-LAB 设备。

- MCP Server：维护 V4 Relay、设备连接、目标选择和安全限制。
- Codex Skill：把自然语言转换为明确、受限的 MCP 工具调用。
- Relay：可连接远端服务，也可由 Bun 启动内置服务。

> Agent / LLM 集成请直接阅读 [README_llm.md](README_llm.md)，其中包含完整工具约定、参数和安全规则。

## 快速开始

推荐使用 [Bun](https://bun.sh/)：

```bash
cd mcp
bun install
```

在 Codex 的 `config.toml` 中添加 MCP Server，并将路径换成仓库的绝对路径：

```toml
[mcp_servers.dglab]
command = "bun"
args = ["run", "/absolute/path/to/dglab-kit-skill/mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "remote"
DGLAB_RELAY = "wss://ws.dungeon-lab.cn/"
```

再将 `skills/dglab-control` 复制或链接到 Codex skills 目录，即可通过 `$dglab-control` 使用。

Node.js 22+ 也能连接远端 Relay：

```toml
command = "npm"
args = ["--prefix", "/absolute/path/to/dglab-kit-skill/mcp", "run", "start:node"]
```

内置 Relay 使用 `Bun.serve()`，因此不支持 Node.js 模式。

## 使用方式

配置完成后，可以直接对 Agent 说：

- “使用官方服务器连接。”
- “查看设备并选择 A 通道。”
- “A 通道增加 2。”
- “强度设为 10，持续 2 秒。”
- “停止。”

完整流程为：连接 Relay → APP 扫码 → 查看设备 → 明确选择设备和通道 → 执行控制。

## 内置 Relay

需要在同一局域网内配对手机时，可让 Agent 列出可用地址并启动内置 Relay。示例配置：

```toml
[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "embedded"
DGLAB_EMBEDDED_BIND_HOST = "0.0.0.0"
DGLAB_EMBEDDED_PORT = "9998"
DGLAB_EMBEDDED_PREFIX = "/v4"
DGLAB_EMBEDDED_CONTROLLER_URL = "ws://127.0.0.1:9998/v4"
DGLAB_EMBEDDED_ADVERTISED_URL = "ws://192.168.1.20:9998/v4"
DGLAB_EMBEDDED_ALLOW_NETWORK_EXPOSURE = "true"
```

将 `192.168.1.20` 换成运行 MCP 的电脑地址。手机和电脑需在互通的网络中，防火墙也需放行对应端口。

不要将内置 Relay 直接暴露到公网。非回环监听必须由用户明确允许，并提供手机可访问的 `advertisedUrl`。

## 默认安全限制

| 项目 | 默认上限 |
| --- | ---: |
| 单次强度变化 | `5` |
| 临时强度 | `20` |
| 临时强度或波形时长 | `5000 ms` |

可分别通过 `DGLAB_MAX_DELTA`、`DGLAB_MAX_INTENSITY` 和 `DGLAB_MAX_DURATION_MS` 设置更严格的值。

`dglab_stop` 会优先取消当前通道中尚未执行的操作；断开连接时，MCP 会尽力清理本进程控制过的通道。

## 项目结构

```text
mcp/                         TypeScript stdio MCP Server
  src/controller.ts          会话、设备、队列与安全限制
  src/relay/                 内置 Bun V4 Relay
skills/dglab-control/        Codex Skill 与协议/安全参考
README_llm.md                Agent / LLM 集成手册
```

## 开发

```bash
cd mcp
bun run typecheck
```
