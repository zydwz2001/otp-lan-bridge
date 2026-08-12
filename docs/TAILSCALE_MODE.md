# Tailscale 模式

Tailscale 模式适用于 Wi-Fi 开启客户端隔离且 USB、蓝牙直连均不可用的环境。桥接协议仍会在 Tailscale 的加密连接内执行自己的配对、认证和消息加密。

1. 在 Android 和 Windows 安装 Tailscale，并使用同一账号登录。
2. 在 Clash Verge 的 TUN“排除自定义网段”中添加 `100.64.0.0/10`，保存后重启 TUN。
3. 在手机 Tailscale 页面复制该手机的 `100.x.y.z` 地址。
4. 保持 OTP LAN Bridge 配对页在前台，在扩展中填写手机的 Tailscale 地址、端口和新配对码。

Tailscale 地址通常保持不变；更换 Wi-Fi 后一般无需修改扩展地址。不要启用 Tailscale 的“阻止传入连接/Shields up”，否则电脑无法连接手机服务。
