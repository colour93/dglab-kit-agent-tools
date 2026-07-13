# DG-LAB Kit Agent Tools

本仓库提供两套彼此独立的 Codex Skill：一套通过 MCP 直接控制设备，另一套用于在项目中使用 `dglab-kit` SDK 开发集成。

## 安装前先选择使用场景

安装者或 LLM 不应默认同时安装两套 Skill，也不应让它们互相依赖。用户未说明场景时，先询问：

> 你希望让 Codex 直接连接并控制 DG-LAB 设备，还是希望让 Codex 帮你在项目中使用 dglab-kit SDK 编写集成代码？

| 使用场景 | 安装内容 | 额外依赖 |
| --- | --- | --- |
| 通过自然语言直接连接、配对和控制设备 | `skills/dglab-control` | 配置本仓库的 `mcp/` Server |
| 在 TypeScript / JavaScript 项目中安装和使用 SDK | `skills/dglab-kit-sdk` | 目标项目自行安装 `dglab-kit`；不需要本仓库 MCP |
| 两种场景都需要 | 两套分别安装 | 分别配置，仍不共享状态或产生依赖 |

- MCP Server：维护 V4 Relay、设备连接、目标选择和安全限制。
- `dglab-control`：把自然语言转换为明确、受限的 MCP 工具调用。
- `dglab-kit-sdk`：指导 Agent 使用 SDK 实现连接、配对、状态管理、命令边界和清理等最佳实践。
- Relay：可连接远端服务，也可由 Bun 启动内置服务。

> Agent / LLM 集成请直接阅读 [README_llm.md](README_llm.md)，其中包含安装分流、MCP 工具约定、参数和安全规则。

## 直接控制设备

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
DGLAB_RELAY = "wss://trex.dungeon-lab.cn/v4"
```

再将 `skills/dglab-control` 复制或链接到 Codex skills 目录，即可通过 `$dglab-control` 使用。该 Skill 不依赖 `dglab-kit-sdk`。

Node.js 22+ 也能连接远端 Relay：

```toml
command = "npm"
args = ["--prefix", "/absolute/path/to/dglab-kit-skill/mcp", "run", "start:node"]
```

内置 Relay 使用 `Bun.serve()`，因此不支持 Node.js 模式。

完整使用示例：

```text
创建一个 dglab socket 控制客户端，使用内置服务器 v4 协议，当我再次发送 测试 消息时，临时输出 5s 挤压波形到 A 通道，强度 5。
```

## 使用 SDK 开发

只需将 `skills/dglab-kit-sdk` 复制或链接到 Codex skills 目录，通过 `$dglab-kit-sdk` 让 Agent 在目标项目中安装并使用 `dglab-kit`：

```text
使用 $dglab-kit-sdk 为这个 TypeScript 项目实现 V4 配对、设备选择和安全清理。
```

该 Skill 不调用本仓库 MCP，也不依赖 `dglab-control`。SDK 依赖应由 Agent 按目标项目使用的 Bun、pnpm、Yarn 或 npm 单独安装。

## 使用方式

配置完成后，可以直接对 Agent 说：

- “使用官方服务器连接。”
- “查看设备并选择 A 通道。”
- “A 通道增加 2。”
- “强度设为 10，持续 2 秒。”
- “播放 V3 自定义波形 `0A0A0A0A00000000`、`0A0A0A0A64646464`，持续 2 秒。”
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
| 自定义波形帧数 | `50` |

可分别通过 `DGLAB_MAX_DELTA`、`DGLAB_MAX_INTENSITY` 和 `DGLAB_MAX_DURATION_MS` 设置更严格的值。

`dglab_stop` 会优先取消当前通道中尚未执行的操作；断开连接时，MCP 会尽力清理本进程控制过的通道。

## 项目结构

```text
mcp/                         TypeScript stdio MCP Server
  src/controller.ts          会话、设备、队列与安全限制
  src/relay/                 内置 Bun V4 Relay
skills/dglab-control/        Codex Skill 与协议/安全参考
skills/dglab-kit-sdk/        使用 dglab-kit SDK 开发集成的最佳实践 Skill
README_llm.md                Agent / LLM 集成手册
```

## 开发

```bash
cd mcp
bun run typecheck
```
