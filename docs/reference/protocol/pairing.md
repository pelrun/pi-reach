# Pi Reach Protocol v2 配对契约

本文件描述 Browser/PWA Owner 与单台当前在线 Pi Reach 设备的配对流程。配对作用域是 `device_id`：同一 Owner 可分别配对多台电脑，每台电脑独立授权、独立撤销，不存在跨设备 membership 传播。

## 配对码

用户在当前 Pi 执行：

```text
/pi-reach pair
```

Extension 生成八位 Crockford Base32 配对码，显示为 ASCII QR 和文字。QR 固定黑白配色并保留 4 模块静区，不随终端主题反色；配对成功、配对码过期或 Relay 连接关闭后自动收起。默认有效期为 5 分钟；`--ttl` 可在 10 至 300 秒间指定，低于或高于范围的数值分别 clamp 到 10 或 300 秒。PWA 可扫描二维码或手工输入。手工输入允许显示分隔符和空白，例如 `K7MP-4Q2D` 会规范化为 `K7MP4Q2D`。

配对码只存在于当前 Extension 进程与 Relay 的内存 pairing offer 中。新码替换该 endpoint 的旧 offer；Pi 退出、endpoint/runtime 被替换、Relay 重启或 TTL 到期都会使该码失效。它不是 URL、长期 token、device identity 或 ACL。

## 外层 target 解析

当前 Pi 向 Relay 发布：

```json
{
  "type": "pairing_offer",
  "code": "K7MP4Q2D",
  "endpoint_id": "<endpoint_id>",
  "runtime_instance_id": "<runtime_instance_id>",
  "expires_at": 1788010000000
}
```

`expires_at` 由 Extension 按本机时钟写入绝对时间戳；Relay 不要求两端时钟同步，也不因时间戳超出上限而拒绝 offer。真实到期取主机声明时间戳与 Relay 接收窗口（收到 offer 起本机时钟 300 秒）中较早者，因此主机时钟偏差只会让配对码早于界面显示时间失效，不会延长有效期。

PWA 完成 Owner hello/auth 后发送：

```json
{
  "type": "resolve_pairing_code",
  "request_id": "<request-id>",
  "code": "K7MP4Q2D"
}
```

Relay 仅在 code 尚未到期、当前 endpoint/runtime 仍在线且未超过解析速率限制时返回：

```json
{
  "type": "pairing_target",
  "in_reply_to": "<request-id>",
  "code": "K7MP4Q2D",
  "device_id": "<device_id>",
  "endpoint_id": "<endpoint_id>",
  "runtime_instance_id": "<runtime_instance_id>"
}
```

稳定失败原因是：

```text
unknown_code
expired_code
stale_target
rate_limited
```

Owner 必须把返回的 device/endpoint/runtime 当作一次性 route target，不能从输入码、cwd 或缓存 metadata 猜测。未配对 Owner 不在 Host ACL 中，因此不能先依赖 endpoint discovery。

## 配对流程

```text
Browser/PWA                         Relay                         Pi Extension
    | owner hello + Ed25519 auth      |                                |
    |-------------------------------->|                                |
    | resolve_pairing_code            |                                |
    |-------------------------------->| validate offer                 |
    |<--------------------------------| pairing_target                 |
    | pairing route(pair_request)     |                                |
    |-------------------------------->| inject source_owner_id ------->|
    |                                 |                  reserve code  |
    |                                 |               persist Owner ACL|
    |                                 |<----- endpoint_update ACL -----|
    |<--------------------------------|<---- pairing route(pair_ok) ---|
    | subscribe_endpoints(device_id)  |                                |
    |-------------------------------->|                                |
    |<------------------------------- | endpoint snapshot              |
    | session route(session_hello)    |                                |
    |-------------------------------->|------------------------------->|
    |<------------------------------- |<----- session_ready -----------|
```

### `pair_request`

inner frame：

```json
{
  "protocol_version": 2,
  "type": "pair_request",
  "id": "<request-id>",
  "code": "K7MP4Q2D",
  "device_name": "My Browser"
}
```

Extension 必须：

1. 使用 Relay 注入的 `source_owner_id` 作为 Owner 身份；
2. 为 `(code, source_owner_id, pair_request.id)` 建立当前进程内 reservation；
3. 把 Owner 记录写入设备本地 `~/.pi/pi-reach/peers.json`；
4. 通过 `endpoint_update.authorized_owner_ids` 同步 Relay ACL；
5. 记录该请求对应的 `pair_ok` 结果并向 Owner 返回；
6. 在每个异步边界后确认 Relay、endpoint/runtime 和 Owner binding 仍属于本次 pairing attempt。

同一 Owner 使用同一 code 和 `pair_request.id` 重试时，Extension 可以继续原 attempt 或重放已记录的相同 `pair_ok`。committed 结果在当前 code 被替换或清除前可重放，即使原 TTL 已到期；未提交 reservation 仍受 TTL 限制。不同 Owner 或不同 request 不能取得已 reservation/committed 的 code。reservation 和完成结果仅在当前 Pi Extension 进程内；Pi 退出后用户必须生成新码。

### `pair_ok`

```json
{
  "protocol_version": 2,
  "type": "pair_ok",
  "in_reply_to": "<request-id>",
  "session_name": "project",
  "session_started_at": 1788010000000,
  "endpoint_id": "<endpoint_id>",
  "harness": { "name": "Pi coding agent", "version": "<extension-version>" },
  "hostname": "<host-name>"
}
```

`endpoint_id` 必须与 target/route endpoint 一致。PWA 将 pairing 保存为 device-scoped record，再独立维护 device 下的当前 endpoint records。

### `pair_error`

```json
{
  "protocol_version": 2,
  "type": "pair_error",
  "in_reply_to": "<request-id>",
  "code": "token_expired",
  "message": "Pairing code is invalid or expired"
}
```

稳定 code：

```text
token_expired
token_consumed
token_unknown
internal_error
```

错误响应后不得为该 Owner 开放 session route。

## 本地授权存储

### Host

Host identity：

- 已有 `~/.pi/pi-reach/identity.json` 时优先读取该身份；没有文件身份时仅读取 `dev.pireach.pi` 平台 keyring 服务（macOS Keychain、Linux secret service、Windows Credential Manager），不读取或迁移旧品牌身份。
- 首次生成优先写入 keyring；允许的 headless/degraded fallback 使用身份文件，文件权限 `0600`，父目录 `0700`，以同目录临时文件原子替换方式发布。
- 初始化通过 `~/.pi/pi-reach/identity.lock` 跨进程互斥，取得锁后重新读取身份。等待有上限，不按锁龄强抢；普通结束释放锁，keyring 写入超时则先报错，并保留锁直到底层操作真正结束。
- 已有 pairing 但 identity 不可读时不得静默生成新 identity，否则会使全部 pairing 失效；应上报确定性 failure。身份文件损坏或不可读也不能被当成首次运行覆盖。

进程异常退出可能留下初始化锁。遇到锁等待超时，先检查并结束同一用户下正在初始化 Pi Reach 的进程，处理系统 keyring 尚未完成的授权或写入；确认没有初始化者或未完成操作后，才可精确删除 `~/.pi/pi-reach/identity.lock` 并重试。不能在另一个 Pi 仍初始化时删除锁，也不要删除 `identity.json`、`peers.json` 或整个 `~/.pi/pi-reach` 来恢复。

Owner ACL：

```json
{
  "peers": [
    {
      "name": "My Browser",
      "remote_epk": "<canonical-or-normalizable Owner Ed25519 public key>",
      "paired_at": "2026-09-14T00:00:00.000Z"
    }
  ]
}
```

该文件只属于这一台设备，不由 Relay 复制到其他设备。

### Browser/PWA

IndexedDB 保存：

- 一个 Owner Ed25519 identity；
- device-scoped pairing record：`deviceId`、Relay URL、pairedAt、nickname/hostname/harness；
- device+endpoint record 及最近 runtime metadata；
- endpoint/session/generation scoped 正式 timeline。

Owner 私钥不得写入日志、URL、route metadata、配对码或 Relay control frame。

## 重连与 endpoint discovery

已配对 Owner 重连时：

1. 读取本地 Owner identity 与 device records；
2. 使用 Owner identity 对 Relay challenge 签名；
3. `subscribe_endpoints([device_id...])`；
4. Relay 只返回当前 Host ACL 仍包含该 Owner 的在线 endpoints；
5. PWA 对用户选择或唯一自动选择的 endpoint/runtime 创建 session channel，发送 `session_hello`；
6. 收到 `session_ready` 后才能发送业务请求。

没有在线 Pi 不影响已保存 pairing。Relay 断线时 Extension/PWA 后台重连，但不通过启动或重启 Pi 恢复远程控制。

## 撤销

Host 本地撤销 Owner 时必须：

1. 从 `peers.json` 删除该 Owner；
2. 关闭该 Owner 的活动 endpoint binding；
3. 立即发送 `endpoint_update.authorized_owner_ids`；
4. Relay 对被撤销 Owner 发 `endpoint_ended`，并拒绝其后续 `purpose=session` route。

撤销只影响当前 `device_id`。其他电脑上的同一个 Owner pairing 不变。

PWA 用户移除一个 pairing 时，删除该 device 的 pairing、endpoint metadata 和本地正式 timeline；它不会删除 Host identity、其他电脑的 peer/ACL 或 Pi session。

## 安全不变量

- Relay 对 Owner->Host 只信认证连接并自行注入的 `source_owner_id`。
- Owner 不能在 route 中自带 source/target Owner 字段。
- Host->Owner 必须指定 `target_owner_id`，且 session route 必须命中 Host 当前 ACL。
- pairing route 绕过 ACL 仅用于 code 验证，不意味着 session 授权。
- code 绑定当前在线 endpoint/runtime；旧 code、旧 target 和迟到 route fail closed。
- 不提供旧 QR URI、旧路由字段或旧本地数据库的兼容迁移。
