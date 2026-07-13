# DG-LAB Kit MCP & Skill

基于 `dglab-kit` 的本地 DG-LAB 控制方案：MCP 持有设备连接和会话状态，Skill 负责自然语言意图、安全策略与工具调用。

支持两种 V4 Relay：

- `remote`：连接官方或用户指定的公网/自建 Socket Server。
- `embedded`：由 MCP 进程启动内置 Bun V4 Relay，可选择本机或局域网可访问地址。

MCP 本身通过 stdio 运行，不监听 HTTP 端口；只有用户选择 `embedded` 时才会启动 Relay 监听。

## 目录

- `mcp/`：TypeScript 编写、Bun 优先的本地 stdio MCP Server。
  - `src/controller.ts`：`dglab-kit` 会话、设备状态、安全限制和控制队列。
  - `src/relay/v4-relay.ts`：可嵌入、可停止的 Bun V4 Relay。
  - `src/relay/manager.ts`：监听地址、对外地址与 Relay 生命周期管理。
- `skills/dglab-control/`：供 Codex 使用的自然语言控制 Skill。

## 安装

推荐使用 Bun：

```bash
cd mcp
bun install
```

Node.js 22+ 可作为远端 Relay 模式的备选：

```bash
cd mcp
npm install
```

Bun 直接运行 TypeScript；Node.js 通过 `tsx` 加载同一份源码。内置 Relay 使用 `Bun.serve()`，因此 `embedded` 模式只支持 Bun，Node 模式仍可连接任意远端 Relay。

## Codex 配置

将示例中的路径替换为仓库绝对路径。

### Bun + 默认远端 Relay

```toml
[mcp_servers.dglab]
command = "bun"
args = ["run", "/absolute/path/to/repo/mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "remote"
DGLAB_RELAY = "wss://ws.dungeon-lab.cn/"
```

### Bun + 默认内置 Relay

下面示例允许同一局域网中的手机连接。`192.168.1.20` 必须替换为运行 MCP 的电脑地址。

```toml
[mcp_servers.dglab]
command = "bun"
args = ["run", "/absolute/path/to/repo/mcp/src/index.ts"]
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "embedded"
DGLAB_EMBEDDED_BIND_HOST = "0.0.0.0"
DGLAB_EMBEDDED_PORT = "9998"
DGLAB_EMBEDDED_CONTROLLER_URL = "ws://127.0.0.1:9998/"
DGLAB_EMBEDDED_ADVERTISED_URL = "ws://192.168.1.20:9998/"
DGLAB_EMBEDDED_ALLOW_NETWORK_EXPOSURE = "true"
```

### Node.js 备选

```toml
[mcp_servers.dglab]
command = "npm"
args = ["--prefix", "/absolute/path/to/repo/mcp", "run", "start:node"]
startup_timeout_sec = 20
tool_timeout_sec = 30

[mcp_servers.dglab.env]
DGLAB_RELAY_MODE = "remote"
DGLAB_RELAY = "wss://ws.dungeon-lab.cn/"
```

## 自然语言配置

这些会话参数都可以由 Agent 从自然语言转换为 MCP 工具参数，例如：

- “使用官方公网服务器连接。”
- “连接 `wss://relay.example.com/ws`。”
- “列出这台电脑可以让手机访问的 Relay 地址。”
- “启动内置服务器，端口 9998，仅本机访问。”
- “启动内置服务器，监听所有网卡，二维码使用 `ws://192.168.1.20:9998/`。”
- “停止内置 Relay。”

典型的局域网工具调用等价于：

```json
{
  "mode": "embedded",
  "bindHost": "0.0.0.0",
  "port": 9998,
  "controllerUrl": "ws://127.0.0.1:9998/",
  "advertisedUrl": "ws://192.168.1.20:9998/",
  "allowNetworkExposure": true
}
```

Agent 不得自行猜测或开放非回环监听。使用 `0.0.0.0`、`::` 或具体局域网地址时，必须由用户明确要求，并传入 `allowNetworkExposure: true`。

## MCP 工具

### Relay 与连接

- `dglab_list_relay_addresses`：列出回环与本机私有 IPv4 地址候选，不修改网络状态。
- `dglab_start_relay`：启动内置 Relay；非回环监听需要显式允许和 `advertisedUrl`。
- `dglab_stop_relay`：清理控制连接并停止内置 Relay。
- `dglab_connect`：选择 `remote` 或 `embedded`，连接后返回配对二维码。
- `dglab_status`：查看控制连接、内置 Relay、设备、选择和事件状态。
- `dglab_disconnect`：清理控制过的通道并断开；默认同时停止内置 Relay。

### 设备控制

- `dglab_select_target`：显式选择 APP、设备和通道。
- `dglab_increase` / `dglab_decrease`：相对调整强度。
- `dglab_set_temporary`：设置有时限的临时强度。
- `dglab_play_waveform`：播放设备兼容波形。
- `dglab_stop`：优先取消排队并清理当前通道。

## Relay 参数

`dglab_connect` 支持以下参数：

| 参数 | 模式 | 说明 |
| --- | --- | --- |
| `mode` | 全部 | `remote` 或 `embedded`；未提供时使用环境变量。 |
| `relay` | remote | 公网或自建 V4 Relay 的 `ws://` / `wss://` URL。 |
| `bindHost` | embedded | 实际监听网卡；默认 `127.0.0.1`。 |
| `port` | embedded | 监听端口；默认 `9998`。 |
| `controllerUrl` | embedded | 本机 MCP 控制端连接地址。监听所有网卡时通常使用 `ws://127.0.0.1:<port>/`。 |
| `advertisedUrl` | embedded | 写入二维码、供 DG-LAB APP 访问的地址。开放非回环监听时必填。 |
| `allowNetworkExposure` | embedded | 是否明确允许非回环监听；默认 `false`。 |

地址含义：

- `bindHost` 决定服务器在哪些网卡监听。
- `controllerUrl` 只供同一台电脑上的 MCP 连接。
- `advertisedUrl` 供手机 APP 连接，必须从手机网络可达。
- `127.0.0.1` 只代表当前设备；二维码使用它时，手机会连接手机自身而不是电脑。

配置优先级：

```text
本次 MCP 工具参数 > MCP 环境变量 > 安全默认值
```

同一 MCP 进程会保留当前 Relay 选择。切换 Relay 或重启内置 Relay 时，会使旧二维码和会话失效。

## 环境变量

### Relay 选择

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DGLAB_RELAY_MODE` | `remote` | 默认模式：`remote` / `embedded`。 |
| `DGLAB_RELAY` | `wss://ws.dungeon-lab.cn/` | remote 模式默认 V4 Relay。 |
| `DGLAB_EMBEDDED_BIND_HOST` | `127.0.0.1` | 内置 Relay 监听地址。 |
| `DGLAB_EMBEDDED_PORT` | `9998` | 内置 Relay 端口。 |
| `DGLAB_EMBEDDED_CONTROLLER_URL` | 自动生成 | MCP 控制端连接地址。 |
| `DGLAB_EMBEDDED_ADVERTISED_URL` | 回环模式下等于 controller URL | 二维码和 APP 使用的地址。非回环监听时必须显式设置。 |
| `DGLAB_EMBEDDED_ALLOW_NETWORK_EXPOSURE` | `false` | 是否允许内置 Relay 监听回环之外的网卡。 |

### 设备安全限制

| 变量 | 默认值 | 可配置范围 |
| --- | --- | --- |
| `DGLAB_MAX_DELTA` | `5` | `1..5` |
| `DGLAB_MAX_INTENSITY` | `20` | `0..20` |
| `DGLAB_MAX_DURATION_MS` | `5000` | `0..5000` |

环境变量用于持久默认值。Agent 可以在获得文件修改授权后帮助写入 `config.toml`，但普通控制指令只改变当前 MCP 会话，不会擅自修改配置文件。

## 网络场景

### 仅本机

```text
bindHost: 127.0.0.1
controllerUrl: ws://127.0.0.1:9998/
advertisedUrl: ws://127.0.0.1:9998/
```

只适用于 APP 和 MCP 位于同一台设备的特殊场景，通常不适用于手机。

### 同一局域网

```text
bindHost: 0.0.0.0
controllerUrl: ws://127.0.0.1:9998/
advertisedUrl: ws://192.168.1.20:9998/
allowNetworkExposure: true
```

电脑防火墙必须允许对应端口，手机和电脑需要处于互通的局域网。

### 公网

不建议直接把内置 Relay 裸露到公网。推荐：

- 使用受控的远端 `wss://` Relay；或
- 内置 Relay 只监听回环地址，由反向代理提供 TLS、域名、限流和访问控制，`advertisedUrl` 使用代理后的 `wss://` 地址。

内置 Relay 的 HTTP API 使用当前控制连接产生的 secret 鉴权，但 WebSocket 建连本身不要求用户账户。公网部署仍需额外的网络层保护。

## 超时与生命周期

- MCP 启动超时由客户端的 `startup_timeout_sec` 控制；启动时不会自动连接 V4。
- 调用 `dglab_connect` 时，`dglab-kit` 默认等待 Relay `hello` 约 8 秒。
- MCP 工具调用受 `tool_timeout_sec` 控制，示例为 30 秒。
- 内置 Relay 在控制方没有 APP 接入时，默认 5 分钟后发送 `idle_timeout` 并断开控制连接。
- 内置 Relay 对 HTTP RPC 默认等待 30 秒。
- MCP 退出时会尽力清理本进程控制过的通道、断开控制连接并停止内置 Relay。

## 并发与安全

- 同一设备通道的普通控制指令按顺序执行。
- `dglab_stop` 不等待队列，会先使未执行指令失效，再发送清理请求。
- 内置 Relay 使用 128 位随机连接 ID，并限制单条 WS/HTTP 消息为约 1 MiB。
- `targetId`、二维码和 HTTP secret 都只属于当前连接；重连、切换服务器或 Relay 关闭后必须重新配对。
- 不要把 HTTP secret 写入 README、聊天消息、日志或持久配置。

## 安装 Skill

将 `skills/dglab-control` 复制或链接到 Codex skills 目录，然后通过 `$dglab-control` 使用。Skill 依赖 `dglab` MCP 已启用。
