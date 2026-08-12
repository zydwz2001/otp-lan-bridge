package dev.otplanbridge

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.provider.Telephony
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import java.text.DateFormat
import java.util.Date

@SuppressLint("SetTextI18n") // This private APK intentionally ships a single Chinese UI.
class MainActivity : Activity() {
    private val coordinator get() = (application as BridgeApplication).coordinator
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var notificationStatus: TextView
    private lateinit var bridgeStatus: TextView
    private lateinit var addressStatus: TextView
    private lateinit var pairingStatus: TextView
    private lateinit var diagnosticStatus: TextView
    private lateinit var observedNotificationStatus: TextView
    private lateinit var recentStatus: TextView
    private lateinit var pairCodeStatus: TextView
    private lateinit var portInput: EditText
    private lateinit var smsSpinner: Spinner
    private lateinit var smsPackageInput: EditText
    private lateinit var serviceButton: Button
    private lateinit var unpairButton: Button
    private lateinit var regenerateButton: Button
    private var smsPackages: List<SmsApp> = emptyList()

    private val refreshRunnable = object : Runnable {
        override fun run() {
            renderState()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
        loadSmsPackages()
        portInput.setText(coordinator.config.port.toString())
    }

    override fun onResume() {
        super.onResume()
        if (coordinator.config.bridgeEnabled) {
            try {
                startForegroundService(
                    Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
                )
            } catch (_: Exception) {
                // The status area will show that the service still needs manual recovery.
            }
        }
        OtpNotificationListener.requestReconnect(this)
        coordinator.setActivityVisible(true)
        coordinator.onNotificationAccessMayHaveChanged()
        handler.post(refreshRunnable)
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRunnable)
        coordinator.setActivityVisible(false)
        super.onPause()
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(22), dp(20), dp(32))
            setBackgroundColor(Color.rgb(247, 248, 252))
        }
        root.addView(text("OTP LAN Bridge", 26f, true))
        root.addView(text("短信验证码只在有效等待窗口内通过当前 Wi-Fi 发送。", 14f).withMargins(bottom = 18))

        root.addView(sectionTitle("状态"))
        notificationStatus = statusText().also(root::addView)
        bridgeStatus = statusText().also(root::addView)
        addressStatus = statusText().also(root::addView)
        pairingStatus = statusText().also(root::addView)
        diagnosticStatus = statusText().also(root::addView)
        observedNotificationStatus = statusText().also(root::addView)
        recentStatus = statusText().also(root::addView)

        root.addView(sectionTitle("首次设置"))
        root.addView(text("短信应用", 13f, true))
        smsSpinner = Spinner(this).also { root.addView(it, matchWrap()) }
        root.addView(text("短信应用包名（未自动识别时手动填写）", 13f, true).withMargins(top = 10))
        smsPackageInput = EditText(this).apply {
            hint = "小米系统短信通常为 com.android.mms"
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
        }.also { root.addView(it, matchWrap()) }
        root.addView(text("监听端口（1024–65535）", 13f, true).withMargins(top = 10))
        portInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setSingleLine(true)
        }.also { root.addView(it, matchWrap()) }
        root.addView(button("保存设置") { saveSettings() })
        root.addView(button("授予通知使用权") {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        })
        root.addView(button("重新连接通知监听") {
            OtpNotificationListener.requestReconnect(this)
            Toast.makeText(this, "已请求系统重新连接通知监听", Toast.LENGTH_SHORT).show()
            handler.postDelayed(::renderState, 500)
        })
        root.addView(button("检查后台运行设置") {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        })

        serviceButton = button("启用桥接服务") { toggleService() }.also(root::addView)

        root.addView(sectionTitle("设备配对"))
        pairCodeStatus = text("启用服务后生成临时配对码", 22f, true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(16), dp(12), dp(16))
            setBackgroundColor(Color.WHITE)
        }.also { root.addView(it, matchWrap()) }
        regenerateButton = button("刷新配对码") {
            coordinator.regeneratePairCode()
            renderState()
        }.also(root::addView)
        unpairButton = button("解除当前配对") {
            coordinator.unpair()
            renderState()
        }.also(root::addView)

        root.addView(sectionTitle("诊断"))
        root.addView(button("发送本地模拟通知") {
            val ok = coordinator.sendSyntheticNotification()
            Toast.makeText(
                this,
                if (ok) "已生成随机测试验证码" else "请先在浏览器点击“填充手机号”进入等待状态",
                Toast.LENGTH_LONG
            ).show()
        })
        root.addView(text("真实短信正文不会落盘或写入调试日志。测试通知同样只在有效等待会话内发送。", 12f))

        return ScrollView(this).apply { addView(root) }
    }

    private fun saveSettings() {
        val port = portInput.text.toString().toIntOrNull()
        if (port == null || port !in 1024..65535) {
            Toast.makeText(this, "请输入 1024–65535 之间的端口", Toast.LENGTH_SHORT).show()
            return
        }
        coordinator.config.port = port
        val manualPackage = smsPackageInput.text.toString().trim()
        val detectedPackage = (smsSpinner.selectedItem as? SmsApp)?.packageName.orEmpty()
        val selectedPackage = manualPackage.ifBlank { detectedPackage }
        if (selectedPackage.isBlank() || !PACKAGE_NAME_PATTERN.matches(selectedPackage)) {
            Toast.makeText(this, "请填写有效的短信应用包名，例如 com.android.mms", Toast.LENGTH_LONG).show()
            return
        }
        coordinator.config.selectedSmsPackage = selectedPackage
        if (coordinator.config.bridgeEnabled) coordinator.restartServer()
        Toast.makeText(this, "设置已保存", Toast.LENGTH_SHORT).show()
        renderState()
    }

    private fun toggleService() {
        if (coordinator.config.bridgeEnabled) {
            startService(Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_STOP))
        } else {
            requestNotificationPermissionIfNeeded()
            startForegroundService(
                Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
            )
        }
        handler.postDelayed(::renderState, 300)
    }

    private fun renderState() {
        val snapshot = coordinator.snapshot()
        notificationStatus.text = "通知使用权：${if (coordinator.hasNotificationAccess()) "已授权" else "未授权"}" +
            "\n通知监听：${if (snapshot.notificationListenerConnected) "已连接" else "未连接"}"
        bridgeStatus.text = "桥接服务：${when {
            snapshot.running -> "已运行"
            snapshot.enabled -> "已启用，正在恢复"
            else -> "已暂停"
        }}"
        addressStatus.text = buildString {
            append("局域网地址：")
            append(snapshot.boundAddress?.let { "$it:${snapshot.port}" } ?: "不可用")
            if (snapshot.enabled) append("\nUSB 转发地址：127.0.0.1:${snapshot.port}")
        }
        pairingStatus.text = "浏览器：${when {
            snapshot.clientOnline -> "在线"
            snapshot.paired -> "已配对，当前离线"
            else -> "未配对"
        }}"
        diagnosticStatus.text = "最近状态：${snapshot.diagnostic}"
        observedNotificationStatus.text = "最近通知来源：${snapshot.lastObservedNotificationPackage ?: "无"}"
        recentStatus.text = snapshot.lastCode?.let { code ->
            "最近识别：$code（${DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(snapshot.lastCodeAt ?: 0))}）"
        } ?: "最近识别：无"
        pairCodeStatus.text = if (snapshot.paired) {
            "已配对"
        } else if (snapshot.enabled && snapshot.pairCode != null) {
            val remaining = ((snapshot.pairCodeExpiresAt!! - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
            "${snapshot.pairCode}\n${remaining / 60}:${(remaining % 60).toString().padStart(2, '0')} 后过期"
        } else {
            "启用服务后生成临时配对码"
        }
        serviceButton.text = if (snapshot.enabled) "暂停桥接服务" else "启用桥接服务"
        regenerateButton.isEnabled = snapshot.enabled && !snapshot.paired
        unpairButton.isEnabled = snapshot.paired
    }

    private fun loadSmsPackages() {
        val found = linkedMapOf<String, SmsApp>()
        val defaultPackage = Telephony.Sms.getDefaultSmsPackage(this)
        packageManager.queryBroadcastReceivers(
            Intent("android.provider.Telephony.SMS_DELIVER"),
            PackageManager.MATCH_ALL
        ).forEach { info ->
            val packageName = info.activityInfo?.packageName ?: return@forEach
            val label = try {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
            } catch (_: Exception) {
                packageName
            }
            found[packageName] = SmsApp(label, packageName)
        }
        packageManager.queryIntentActivities(
            Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:")),
            PackageManager.MATCH_ALL
        ).forEach { info ->
            val packageName = info.activityInfo?.packageName ?: return@forEach
            val label = try {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
            } catch (_: Exception) {
                packageName
            }
            found[packageName] = SmsApp(label, packageName)
        }
        defaultPackage?.let { packageName ->
            if (packageName !in found) {
                val label = try {
                    packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
                } catch (_: Exception) {
                    "系统短信"
                }
                found[packageName] = SmsApp(label, packageName)
            }
        }
        smsPackages = found.values.toList().ifEmpty { listOf(SmsApp("未自动检测到短信应用", "")) }
        smsSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, smsPackages)
        val selected = coordinator.selectedSmsPackage()
        val selectedIndex = smsPackages.indexOfFirst { it.packageName == selected }.coerceAtLeast(0)
        if (smsPackages.isNotEmpty()) smsSpinner.setSelection(selectedIndex)
        smsPackageInput.setText(selected.orEmpty())
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    private fun text(value: String, size: Float, bold: Boolean = false): TextView = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(Color.rgb(28, 31, 38))
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setLineSpacing(0f, 1.15f)
    }

    private fun statusText(): TextView = text("", 14f).apply { setPadding(0, dp(3), 0, dp(3)) }

    private fun sectionTitle(value: String): TextView = text(value, 18f, true).withMargins(top = 22, bottom = 8)

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { action() }
    }

    private fun matchWrap() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

    private fun <T : View> T.withMargins(top: Int = 0, bottom: Int = 0): T {
        layoutParams = matchWrap().apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }
        return this
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private data class SmsApp(val label: String, val packageName: String) {
        override fun toString(): String = "$label（$packageName）"
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 10
        private val PACKAGE_NAME_PATTERN = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+")
    }
}
