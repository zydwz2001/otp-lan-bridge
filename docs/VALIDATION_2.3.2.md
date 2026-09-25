# Chrome 2.3.2 首次授权修复

用户在 Chrome 153.0.8010.53 点击“连接手机”后，没有获得设备授权，连接页进入 Wi-Fi 探测并超时。电脑能够识别手机，未发现 adb 占用，浏览器落盘配置中没有该扩展的 USB 授权记录。

原因是连接页使用 `chrome.windows.create({type: "popup"})`。Chrome 的扩展设备选择器需要扩展工具栏；没有工具栏的弹窗直接结束选择请求，表现为 `NotFoundError`，被原有流程当成取消选择并回退 Wi-Fi。对应版本的实现见 [Chromium 153 chooser_bubble_ui.cc](https://github.com/chromium/chromium/blob/153.0.8010.53/chrome/browser/ui/views/permissions/chooser_bubble_ui.cc)，`ShowDeviceChooserDialogForExtension` 在取不到扩展工具栏时直接返回。

修复：同一连接页改在 `normal` 窗口打开，保留全部页内 HTML/CSS、App 和网页面板布局；只关闭授权标签页，避免影响该窗口内用户另开的页面。浏览器权限异常会明确报错，不再一律吞掉并转入 Wi-Fi。

验证：TypeScript 检查、42 项扩展测试通过，包含权限失败不回退网络、普通授权窗口及只关闭对应标签页的检查。使用独立 Chromium 151.0.7922.34、未预授权 USB 的浏览器配置进行真实 API 回归：旧 popup 立即得到 `NotFoundError`；新后台创建 normal 窗口，实际连接页的请求保持 pending，设备选择没有被立即取消。

该回归检查没有替用户选择设备或确认手机调试授权。Chrome 153 上的完整交互仍需用户在新窗口选择手机，并完成手机系统授权；数据通道的实机验证见 [2.3.0 验证记录](VALIDATION_2.3.0.md)。
