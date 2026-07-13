# DG-LAB Kit Skill

供 Codex 使用的 DG-LAB 设备控制 skill：基于 `dglab-kit` 将自然语言请求映射为设备控制命令，并生成可扫描的配对二维码。

默认使用 V4 与官方中继 `wss://ws.dungeon-lab.cn/`；支持自定义中继和显式 V3 兼容模式。Bun 为首选运行时，Node.js 为备选。

## 目录

- `dglab-control/`：可安装的 skill。
  - `SKILL.md`：V4 校验、配对、会话与控制短流程。
  - `scripts/generate-pairing-qr.mjs`：使用 `qrcode` 生成配对 PNG，并可通过 `qrcode-terminal` 输出 CLI 二维码。
  - `references/intent-contract.md`：聊天触发和会话选择规则。
  - `references/safety.md`：限幅、时长、断开清理与设备状态校验。
  - `references/transport.md`：V4 单次指令的 HTTP/WS 路由与鉴权规则。
  - `references/protocol.md`：V3/V4 连接、配对、设备筛选与 API 参考。

## 使用

将 `dglab-control` 安装或复制到 Codex skills 目录后，以 `$dglab-control` 调用。目标控制项目安装依赖：

```bash
bun add dglab-kit qrcode qrcode-terminal
```

在没有 Bun 时，改用：

```bash
npm install dglab-kit qrcode qrcode-terminal
```
