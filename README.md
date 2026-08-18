# 验证码传递

> 手机收到短信验证码后，传到电脑浏览器填写。手机和电脑只需连接同一个 Wi‑Fi。

[![Android 8+](https://img.shields.io/badge/Android-8%2B-3DDC84?logo=android&logoColor=white)](#运行要求)
[![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white)](#运行要求)
[![CI](https://github.com/zydwz2001/otp-lan-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/zydwz2001/otp-lan-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

仓库只保留当前的“验证码传递”Android App 和 Chrome 插件。

## 这个版本有什么不同

| 项目 | 验证码传递 2.2.1 |
| --- | --- |
| 连接方式 | 只支持手机与电脑所在的同一 Wi‑Fi |
| VPN / Tailscale | 不需要，也不会创建或启动 VPN |
| USB / ADB | 不需要，不支持回环转发 |
| Android 应用 ID | `io.github.zydwz2001.wifiotprelay` |
| App 监听端口 | App 当前显示的端口（当前版本通常为 `42871`） |
| 产品界面 | Android App、扩展设置页、网页悬浮面板均为全新设计 |
| 协议身份 | 使用独立的 v2 本地存储名称、密钥别名和 HKDF 域分离字符串 |

## 运行要求

- Android 8.0（API 26）或更高版本。
- Chrome 116 或更高版本；Chrome 142+ 首次连接时可能询问“访问本地网络”，请选择允许。
- 手机与电脑必须连接同一个可互访的 Wi‑Fi。宾馆、学校、公司访客网如果开启了“客户端隔离”，即使 Wi‑Fi 名称相同也可能无法直连。

## 下载与安装

最简单的方式是在仓库的 [Releases](https://github.com/zydwz2001/otp-lan-bridge/releases) 页面下载两个文件：

- `verification-code-transfer-android.apk`：安装到 Android 手机。
- `verification-code-transfer-chrome.zip`：解压后加载到 Chrome。

如果当前还没有 Release，可按下面的“从源码构建”生成相同内容。

### 安装 Android App

1. 把 APK 发送到手机并打开。
2. Android 若提示“禁止安装未知应用”，只为当前文件管理器临时允许。
3. 安装后桌面会出现“验证码传递”。

### 安装 Chrome 插件

1. 解压 `verification-code-transfer-chrome.zip`，不要直接选择 ZIP。
2. Chrome 打开 `chrome://extensions`。
3. 打开右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择解压后的目录（目录中应直接看到 `manifest.json`）。
5. 打开扩展详情，点击“扩展程序选项”进入设置页。

完整图文式操作顺序见 [Chrome 插件使用方法](docs/EXTENSION_GUIDE.md) 和 [Android App 使用方法](docs/ANDROID_APP.md)。

## 首次连接

1. 手机和电脑连接同一个 Wi‑Fi；关闭 VPN 不是硬性要求，但本项目不会使用 VPN 地址。
2. 打开手机 App，点“通知读取设置”，开启“验证码传递 · 通知读取”。
3. 点“防止后台断开”，允许 App 自启动。
4. 点“配对电脑”，在网页浮窗分别输入手机地址、端口和配对码。
5. Chrome 首次询问“访问本地网络中的其他设备”时选择“允许”；如果以前已允许过，Chrome 不会重复弹窗，会直接继续连接。
6. 配对成功后选择短信 App，再点“开始传递”。
7. 在扩展中填写常用手机号并保存。

配对完成后，两端会各自保存一份配对材料。正常重启、关闭浏览器或切换网页都不需要重新配对。手机 Wi-Fi 地址发生变化时，插件会在旧地址连接失败后自动搜索原 Wi-Fi 网段；只有能通过原配对密钥验证的手机才会被接受，找到后会自动保存新地址并重新连接。

点击“开始传递”后可以退出 App 或锁屏。Android 常驻通知负责维持手机端服务，Chrome 后台负责心跳和断线重连；App 无需一直停留在前台。手机重启或 App 更新后，若之前处于“正在传递”，App 会自动恢复服务。小米 / Redmi / POCO 用户可点 App 中的“防止后台断开”，一次性允许“验证码传递”自启动。

电脑关机或浏览器暂时离线时，手机会显示“等待电脑连接”，但不会关闭传递。手机端会监听 Wi-Fi 地址变化，并在长时间离线时自动重启传递服务；也可以在 App 或常驻通知中点“重新启动传递”，不需要重新配对。

## 日常使用

1. 确认手机 App 显示“正在传递”。
2. 在网页点击手机号输入框，再点右侧悬浮面板的“一键填充并等待”。
3. 自己点击网站的“发送验证码”。
4. 短信到达后，手机只解析所选短信 App 的新通知，并把验证码候选通过加密 WebSocket 发给当前等待标签页。
5. 无需点击验证码输入框，直接点悬浮面板的“写入验证码并登录”。
6. 插件仅在能明确识别同一表单的登录按钮时自动点击；否则只填入验证码，由你确认提交。

验证码会保留到本次 5 分钟等待结束，填写一次后不会立刻消失。验证码页面可点“返回填充”，需要重试时再点“查看验证码”返回，不必重新发送短信。

## 权限与安全边界

- Android 不申请 `READ_SMS` 或 `RECEIVE_SMS`，只使用系统“通知使用权”读取所选短信 App 的新通知。
- 服务只绑定 Android 的 Wi‑Fi IPv4 地址，并拒绝回环、链路本地、Tailscale CGNAT 和公网来源。
- 首次配对使用 P‑256 ECDH、HKDF 和 6 位临时码；会话消息使用 AES‑256‑GCM、单调序号、时间窗和重放保护。
- 完整短信正文不会落盘或写入日志；Chrome 中的验证码只存于 `chrome.storage.session`，并随本次 5 分钟等待结束而清除。
- 银行、支付、付款、钱包、转账和交易等高风险通知会在 Android 端直接拦截。
- 扩展需要普通网页访问权限来识别用户最后点击的输入框，可在设置中配置允许/排除域名。

更完整的威胁边界见 [安全设计](docs/SECURITY.md)。

## 常见问题

### 同一个 Wi‑Fi 仍然无法配对

- 确认输入的是 App 当前显示的地址，不是电脑地址。
- 保持 App 配对页在前台，配对码过期后点击“换一个配对码”。
- Chrome 142+ 若询问本地网络访问，必须选择允许。
- 没出现权限弹窗不一定是错误：Chrome 已经记住“允许”时不会重复询问。若配对长时间没有结果，在手机 App 中先“停止传递”，再“开始传递”后重试。
- 不要使用 `127.0.0.1`、`100.x.x.x` 或公网 IP；本版本会主动拒绝。
- 路由器若开启 AP/客户端隔离，请改用普通家庭 Wi‑Fi；本版本有意不提供 VPN/USB 绕过路径。

### 浏览器在线，但真实短信没出现

- 手机状态页应同时显示“通知使用权已允许”和“系统监听已连接”。
- App 会自动恢复偶发断开的系统通知监听。通常等待一分钟即可，不必关闭再开启权限；也可回到 App 点击“立即重新连接”。
- 选择的短信 App 包名必须与真实通知来源一致。
- 手机锁屏通知不能隐藏正文，否则 App 无法从通知中读取数字。
- 必须先点网页面板“一键填充并等待”，然后再让网站发送短信。

更多排查步骤见 [故障排查](docs/TROUBLESHOOTING.md)。

## 从源码构建

### Android

需要 JDK 17 和 Android SDK Platform 35：

```powershell
cd android
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

### Chrome 插件

需要 Node.js 20 或更高版本：

```powershell
cd extension
npm ci
npm run check
npm test
npm run build
```

加载 `extension/dist`，或运行根目录的发布脚本生成 APK 与 ZIP：

```powershell
.\tools\build-release.ps1
```

输出文件位于 `release/`。

## GitHub 发布

- 每次 push / pull request 会运行 Android 单元测试、Lint、APK 构建和扩展检查。
- 推送形如 `v2.1.0` 的标签会自动创建 GitHub Release，并附上可安装 APK 与扩展 ZIP。
- 自动生成的 APK 使用 Android 调试签名，适合个人侧载；要长期稳定升级或上架应用商店，应换成自己的固定发布签名。

## 项目结构

```text
android/                 Android App
extension/               “验证码传递”Chrome 插件
docs/                    App、插件、安全与排查文档
tools/build-release.ps1  本地一键打包脚本
.github/workflows/       GitHub CI 与 Release 自动化
```

## License

[MIT](LICENSE)
