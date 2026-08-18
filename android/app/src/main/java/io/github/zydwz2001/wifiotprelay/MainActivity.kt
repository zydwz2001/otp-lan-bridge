package io.github.zydwz2001.wifiotprelay

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.provider.Telephony
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import java.text.DateFormat
import java.util.Date

@SuppressLint("SetTextI18n")
class MainActivity : Activity() {
    private val coordinator get() = (application as BridgeApplication).coordinator
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var serviceStatus: TextView
    private lateinit var listenerWarningCard: LinearLayout
    private lateinit var listenerWarningTitle: TextView
    private lateinit var listenerWarningHelp: TextView
    private lateinit var listenerRepairButton: Button
    private lateinit var addressStatus: TextView
    private lateinit var portStatus: TextView
    private lateinit var pairCodeStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var browserStatus: TextView
    private lateinit var detailStatus: TextView
    private lateinit var recentStatus: TextView
    private lateinit var smsSpinner: Spinner
    private lateinit var serviceButton: Button
    private lateinit var restartTransferButton: Button
    private lateinit var transferHint: TextView
    private lateinit var notificationButton: Button
    private lateinit var backgroundButton: Button
    private lateinit var pairingButton: Button
    private var smsPackages: List<SmsApp> = emptyList()
    private var loadingSmsSelection = true
    private var notificationGuideShown = false

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
    }

    override fun onResume() {
        super.onResume()
        if (coordinator.config.bridgeEnabled) {
            try {
                startForegroundService(
                    Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
                )
            } catch (_: Exception) {
                // The status area will show whether the service recovered.
            }
        }
        OtpNotificationListener.requestReconnect(this)
        coordinator.setActivityVisible(true)
        coordinator.onNotificationAccessMayHaveChanged()
        handler.post(refreshRunnable)
        handler.post { showNotificationAccessGuideIfNeeded() }
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRunnable)
        coordinator.setActivityVisible(false)
        super.onPause()
    }

    private fun buildContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(30))
            setBackgroundColor(BACKGROUND)
        }

        root.addView(text("验证码传递", 28f, TEXT, true))
        root.addView(text("手机收到验证码后，传到电脑浏览器填写。", 14f, MUTED)
            .withMargins(top = 4, bottom = 10))

        root.addView(text("第 1 步  完成系统设置", 14f, TEXT, true).withMargins(top = 8, bottom = 3))
        notificationButton = secondaryButton("通知读取设置") {
            if (coordinator.hasNotificationAccess()) {
                openNotificationAccessSettings()
            } else {
                showNotificationAccessGuideIfNeeded(force = true)
            }
        }.also(root::addView)
        backgroundButton = secondaryButton("防止后台断开") {
            showBackgroundReliabilityGuide()
        }.withMargins(top = 4).also(root::addView)

        listenerWarningCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = rounded(WARNING_BACKGROUND, 14, WARNING_BORDER)
            listenerWarningTitle = text("通知读取未连接，真实短信无法传递", 15f, ERROR, true)
                .also(::addView)
            listenerWarningHelp = text(
                "系统正在自动重新连接，不需要关闭权限，也不用让 App 保持在前台。",
                12f,
                TEXT
            ).withMargins(top = 5).also(::addView)
            listenerRepairButton = button("立即重新连接", PRIMARY, Color.WHITE) {
                handleNotificationAccessAction()
            }.withMargins(top = 9).also(::addView)
        }.withMargins(top = 4, bottom = 10).also(root::addView)

        root.addView(text("第 2 步  配对电脑", 14f, TEXT, true).withMargins(bottom = 3))
        pairingButton = secondaryButton("配对电脑") { handlePairingAction() }
            .withMargins(bottom = 6).also(root::addView)

        val mainCard = card()
        serviceStatus = text("准备中", 15f, MUTED, true).also(mainCard::addView)
        val connectionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }.withMargins(top = 12)
        val addressColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text("手机 Wi-Fi 地址", 11f, MUTED))
        }
        addressStatus = text("配对时显示", 18f, TEXT, true).apply { setTextIsSelectable(true) }
            .also(addressColumn::addView)
        connectionRow.addView(addressColumn, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val portColumn = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text("端口", 11f, MUTED))
        }
        portStatus = text(ConfigStore.DEFAULT_PORT.toString(), 18f, TEXT, true).apply { setTextIsSelectable(true) }
            .also(portColumn::addView)
        connectionRow.addView(portColumn, LinearLayout.LayoutParams(dp(82), LinearLayout.LayoutParams.WRAP_CONTENT))
        mainCard.addView(connectionRow)

        val codeRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(13), 0, dp(10))
        }
        val codeCopy = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text("浏览器配对码", 11f, MUTED))
        }
        pairCodeStatus = text("------", 30f, PRIMARY, true).apply {
            letterSpacing = .12f
            setTextIsSelectable(true)
        }.also(codeCopy::addView)
        codeRow.addView(codeCopy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        browserStatus = text("浏览器未配对", 12f, MUTED, true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(10), dp(7), dp(10), dp(7))
            background = rounded(BACKGROUND, 16)
        }.also(codeRow::addView)
        mainCard.addView(codeRow)

        root.addView(mainCard, matchWrap())

        root.addView(text("第 3 步  开始传递", 14f, TEXT, true).withMargins(top = 12, bottom = 3))
        val startCard = card()
        startCard.addView(text("短信应用", 11f, MUTED))
        smsSpinner = Spinner(this).apply {
            backgroundTintList = ColorStateList.valueOf(PRIMARY)
        }.also { startCard.addView(it, matchWrap()) }
        notificationStatus = text("通知读取：检查中", 12f, MUTED).withMargins(top = 5)
            .also(startCard::addView)
        serviceButton = primaryButton("开始传递") { toggleService() }
            .withMargins(top = 7).also(startCard::addView)
        restartTransferButton = secondaryButton("重新启动传递") { restartTransfer() }.apply {
            visibility = View.GONE
        }.withMargins(top = 5).also(startCard::addView)
        transferHint = text("请先完成上方配对", 12f, MUTED).withMargins(top = 5)
            .also(startCard::addView)
        root.addView(startCard, matchWrap())

        plainButton("发送测试验证码（可选）") {
            val ok = coordinator.sendSyntheticNotification()
            val listenerConnected = coordinator.snapshot().notificationListenerConnected
            Toast.makeText(
                this,
                when {
                    ok && !listenerConnected -> "测试码已发送；真实短信仍需先修复通知读取"
                    ok -> "测试码已发送"
                    else -> "请先在浏览器网页中开始等待验证码"
                },
                Toast.LENGTH_LONG
            ).show()
        }.withMargins(top = 4).also(root::addView)

        val guide = card().withMargins(top = 14)
        guide.addView(text("首次使用流程", 16f, TEXT, true))
        guide.addView(text("1  点“通知读取设置”，开启通知读取", 13f, TEXT).withMargins(top = 10))
        guide.addView(text("2  点“防止后台断开”，允许自启动", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("3  点“配对电脑”，按插件提示填写信息", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("4  浏览器询问访问本地网络时，点“允许”", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("5  选择短信应用，点“开始传递”", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("6  网页输入手机号，用插件填充并等待", 13f, TEXT).withMargins(top = 7))
        root.addView(guide)

        detailStatus = text("", 12f, MUTED).withMargins(top = 14).also(root::addView)
        recentStatus = text("最近验证码：暂无", 12f, MUTED).withMargins(top = 5).also(root::addView)

        return ScrollView(this).apply {
            setBackgroundColor(BACKGROUND)
            clipToPadding = false
            setOnApplyWindowInsetsListener { view, insets ->
                val (topInset, bottomInset) = if (Build.VERSION.SDK_INT >= 30) {
                    val bars = insets.getInsets(WindowInsets.Type.systemBars())
                    bars.top to bars.bottom
                } else {
                    @Suppress("DEPRECATION")
                    insets.systemWindowInsetTop to insets.systemWindowInsetBottom
                }
                view.setPadding(0, topInset, 0, bottomInset)
                insets
            }
            addView(root)
        }
    }

    private fun toggleService() {
        if (coordinator.config.bridgeEnabled) {
            startService(Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_STOP))
        } else {
            if (!coordinator.hasNotificationAccess()) {
                showNotificationAccessGuideIfNeeded(force = true)
                return
            }
            val selected = (smsSpinner.selectedItem as? SmsApp)?.packageName.orEmpty()
            if (selected.isBlank()) {
                Toast.makeText(this, "没有识别到短信应用", Toast.LENGTH_LONG).show()
                return
            }
            coordinator.config.selectedSmsPackage = selected
            requestNotificationPermissionIfNeeded()
            startForegroundService(
                Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_START)
            )
        }
        handler.postDelayed(::renderState, 300)
    }

    private fun restartTransfer() {
        startForegroundService(
            Intent(this, BridgeForegroundService::class.java).setAction(BridgeForegroundService.ACTION_RESTART)
        )
        Toast.makeText(this, "正在重新启动传递，无需重新配对", Toast.LENGTH_SHORT).show()
        handler.postDelayed(::renderState, 500)
    }

    private fun handlePairingAction() {
        val snapshot = coordinator.snapshot()
        if (!snapshot.paired) {
            if (!coordinator.hasNotificationAccess()) {
                showNotificationAccessGuideIfNeeded(force = true)
                return
            }
            if (!snapshot.running) coordinator.startServer()
            if (!coordinator.snapshot().running) {
                Toast.makeText(this, coordinator.snapshot().diagnostic, Toast.LENGTH_LONG).show()
                renderState()
                return
            }
            coordinator.regeneratePairCode()
            renderState()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("取消配对？")
            .setMessage("当前电脑会断开。以后使用时，需要重新配对。")
            .setNegativeButton("返回", null)
            .setPositiveButton("取消配对") { _, _ ->
                coordinator.unpair()
                renderState()
            }
            .show()
    }

    private fun renderState() {
        val snapshot = coordinator.snapshot()
        val notificationGranted = coordinator.hasNotificationAccess()
        serviceStatus.text = when {
            snapshot.paired && snapshot.clientOnline -> "●  已配对，浏览器在线"
            snapshot.paired && snapshot.enabled && snapshot.running -> "●  正在传递，等待电脑连接"
            snapshot.paired && snapshot.enabled -> "●  正在自动恢复传递"
            snapshot.paired -> "✓  已配对"
            snapshot.running -> "等待电脑配对"
            else -> "尚未配对"
        }
        serviceStatus.setTextColor(when {
            snapshot.paired && snapshot.clientOnline -> SUCCESS
            snapshot.paired && snapshot.enabled -> WARNING
            snapshot.paired -> SUCCESS
            snapshot.running -> PRIMARY
            else -> MUTED
        })
        addressStatus.text = snapshot.boundAddress ?: "配对时显示"
        portStatus.text = snapshot.port.toString()
        pairCodeStatus.text = when {
            snapshot.paired -> "已配对"
            snapshot.running && snapshot.pairCode != null -> snapshot.pairCode
            else -> "------"
        }
        pairCodeStatus.letterSpacing = if (snapshot.paired) 0f else .12f
        browserStatus.text = when {
            snapshot.clientOnline -> "浏览器在线"
            snapshot.paired && snapshot.enabled && snapshot.running -> "等待电脑连接"
            snapshot.paired && snapshot.enabled -> "正在恢复连接"
            snapshot.paired -> "传递未开始"
            else -> "浏览器未配对"
        }
        notificationStatus.text = when {
            !notificationGranted -> "通知读取：未开启，无法接收短信"
            snapshot.notificationListenerConnected -> "通知读取：已连接，可退出本页面"
            else -> "通知读取：正在自动重新连接"
        }
        listenerWarningCard.visibility = if (notificationGranted && snapshot.notificationListenerConnected) View.GONE else View.VISIBLE
        if (notificationGranted) {
            val recoveryTakingLong = OtpNotificationListener.disconnectedForMs() >= LISTENER_LONG_RECOVERY_MS
            listenerWarningTitle.text = if (recoveryTakingLong) "通知读取仍未连接" else "正在自动恢复通知读取"
            listenerWarningHelp.text = if (recoveryTakingLong) {
                if (isXiaomiDevice()) {
                    "澎湃 OS 可能拦截了后台连接。请先点“立即重新连接”，并允许本 App 后台自启动。"
                } else {
                    "已自动重试。请先点“立即重新连接”；若仍不恢复，再打开系统设置检查权限。"
                }
            } else {
                "通常会在一分钟内恢复，不需要关闭权限，也不用让 App 保持在前台。"
            }
            listenerRepairButton.text = "立即重新连接"
        } else {
            listenerWarningTitle.text = "请先开启通知读取，否则无法接收短信"
            listenerWarningHelp.text = "点击下方按钮，在系统页面打开“验证码传递 · 通知读取”，然后返回本页。"
            listenerRepairButton.text = "立即开启通知读取"
        }
        applyCompletedIcon(notificationButton, notificationGranted)
        applyCompletedIcon(backgroundButton, isBackgroundReliabilityEnabled())
        serviceButton.text = if (snapshot.enabled) "停止传递" else "开始传递"
        restartTransferButton.visibility = if (snapshot.enabled && snapshot.paired && !snapshot.clientOnline) {
            View.VISIBLE
        } else {
            View.GONE
        }
        pairingButton.text = if (snapshot.paired) "取消配对" else "配对电脑"
        pairingButton.backgroundTintList = ColorStateList.valueOf(if (snapshot.paired) DISABLED_BACKGROUND else Color.WHITE)
        pairingButton.setTextColor(if (snapshot.paired) MUTED else PRIMARY)
        pairingButton.isEnabled = notificationGranted || snapshot.paired
        serviceButton.isEnabled = snapshot.enabled || (notificationGranted && snapshot.paired)
        transferHint.text = when {
            snapshot.enabled && snapshot.clientOnline -> "已连接，可退出 App 或锁屏"
            snapshot.enabled && !snapshot.running -> "服务正在自动恢复，也可点“重新启动传递”"
            snapshot.enabled -> "等待电脑连接；后台会自动恢复，也可点“重新启动传递”"
            !notificationGranted -> "请先完成“通知读取设置”"
            !snapshot.paired -> "请先完成上方配对"
            else -> "准备完成，点击“开始传递”"
        }
        detailStatus.text = snapshot.diagnostic
        recentStatus.text = snapshot.lastCode?.let { code ->
            "最近验证码：$code  ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(snapshot.lastCodeAt ?: 0))}"
        } ?: "最近验证码：暂无"
    }

    private fun handleNotificationAccessAction() {
        if (!coordinator.hasNotificationAccess()) {
            openNotificationAccessSettings()
            return
        }
        requestImmediateNotificationReconnect()
    }

    private fun requestImmediateNotificationReconnect() {
        OtpNotificationListener.requestReconnect(this, force = true)
        Toast.makeText(this, "正在重新连接通知读取，不需要修改权限", Toast.LENGTH_SHORT).show()
        handler.postDelayed(::renderState, 1_500)
    }

    private fun showBackgroundReliabilityGuide() {
        AlertDialog.Builder(this)
            .setTitle("防止后台断开")
            .setMessage(if (isXiaomiDevice()) {
                "进入下一页，找到“验证码传递”并允许自启动。设置一次即可，不需要把 App 一直放在前台。"
            } else {
                "进入应用设置，允许后台运行；如果仍会断开，再将电池用量设为“不限制”。"
            })
            .setNegativeButton("稍后", null)
            .setPositiveButton("去设置") { _, _ -> openBackgroundReliabilitySettings() }
            .show()
    }

    private fun openBackgroundReliabilitySettings() {
        if (isXiaomiDevice()) {
            try {
                startActivity(Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT))
                return
            } catch (_: Exception) {
                // Fall through to the standard application settings page.
            }
        }
        try {
            startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:$packageName"))
            )
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }

    private fun applyCompletedIcon(target: Button, completed: Boolean) {
        if (!completed) {
            target.setCompoundDrawablesRelativeWithIntrinsicBounds(0, 0, 0, 0)
            return
        }
        target.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.ic_step_complete, 0, 0, 0)
        target.compoundDrawableTintList = ColorStateList.valueOf(SUCCESS)
        target.compoundDrawablePadding = dp(7)
    }

    private fun isBackgroundReliabilityEnabled(): Boolean {
        if (!isXiaomiDevice()) {
            return Build.VERSION.SDK_INT >= 28 &&
                !getSystemService(ActivityManager::class.java).isBackgroundRestricted
        }
        return try {
            val manager = getSystemService(AppOpsManager::class.java)
            val method = manager.javaClass.getMethod(
                "checkOpNoThrow",
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                String::class.java
            )
            method.invoke(manager, MIUI_AUTOSTART_OP, Process.myUid(), packageName) == AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) {
            false
        }
    }

    private fun isXiaomiDevice(): Boolean =
        Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true) ||
            Build.BRAND.equals("Xiaomi", ignoreCase = true) ||
            Build.BRAND.equals("Redmi", ignoreCase = true) ||
            Build.BRAND.equals("POCO", ignoreCase = true)

    private fun loadSmsPackages() {
        val found = linkedMapOf<String, SmsApp>()
        val defaultPackage = Telephony.Sms.getDefaultSmsPackage(this)
        packageManager.queryBroadcastReceivers(
            Intent("android.provider.Telephony.SMS_DELIVER"),
            PackageManager.MATCH_ALL
        ).forEach { info ->
            val packageName = info.activityInfo?.packageName ?: return@forEach
            found[packageName] = SmsApp(appLabel(packageName), packageName)
        }
        packageManager.queryIntentActivities(
            Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:")),
            PackageManager.MATCH_ALL
        ).forEach { info ->
            val packageName = info.activityInfo?.packageName ?: return@forEach
            found[packageName] = SmsApp(appLabel(packageName), packageName)
        }
        defaultPackage?.let { packageName ->
            found.putIfAbsent(packageName, SmsApp(appLabel(packageName), packageName))
        }
        smsPackages = found.values.toList().ifEmpty { listOf(SmsApp("未识别到短信应用", "")) }
        smsSpinner.adapter = object : ArrayAdapter<SmsApp>(this, android.R.layout.simple_spinner_item, smsPackages) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getView(position, convertView, parent) as TextView).apply {
                    setTextColor(TEXT)
                    textSize = 14f
                    setPadding(0, dp(7), 0, dp(7))
                }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View =
                (super.getDropDownView(position, convertView, parent) as TextView).apply {
                    setTextColor(TEXT)
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                }
        }
        val selected = coordinator.selectedSmsPackage()
        val selectedIndex = smsPackages.indexOfFirst { it.packageName == selected }.coerceAtLeast(0)
        smsSpinner.setSelection(selectedIndex)
        smsSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val packageName = smsPackages.getOrNull(position)?.packageName.orEmpty()
                if (packageName.isNotBlank()) {
                    coordinator.config.selectedSmsPackage = packageName
                    if (!loadingSmsSelection && coordinator.config.bridgeEnabled) coordinator.restartServer()
                }
                loadingSmsSelection = false
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
    }

    private fun appLabel(packageName: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(packageName, 0)).toString()
    } catch (_: Exception) {
        packageName
    }

    private fun showNotificationAccessGuideIfNeeded(force: Boolean = false) {
        if (coordinator.hasNotificationAccess()) return
        if (notificationGuideShown && !force) return
        notificationGuideShown = true
        AlertDialog.Builder(this)
            .setTitle("第一步：开启通知读取")
            .setMessage("验证码传递只有在获得通知读取权限后，才能识别手机收到的短信验证码。\n\n进入系统页面后，请找到“验证码传递 · 通知读取”并打开。")
            .setNegativeButton("稍后", null)
            .setPositiveButton("去开启") { _, _ -> openNotificationAccessSettings() }
            .show()
    }

    private fun openNotificationAccessSettings() {
        val component = ComponentName(this, OtpNotificationListener::class.java)
        val detailIntent = if (Build.VERSION.SDK_INT >= 30) {
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
                Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                component.flattenToString()
            )
        } else null
        try {
            startActivity(detailIntent ?: Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(15), dp(16), dp(15))
        background = rounded(Color.WHITE, 16, BORDER)
        elevation = dp(1).toFloat()
    }

    private fun primaryButton(label: String, action: () -> Unit): Button = button(label, PRIMARY, Color.WHITE, action).apply {
        minHeight = dp(50)
    }

    private fun secondaryButton(label: String, action: () -> Unit): Button = button(label, Color.WHITE, PRIMARY, action)

    private fun plainButton(label: String, action: () -> Unit): Button = button(label, Color.WHITE, PRIMARY, action)

    private fun button(label: String, backgroundColor: Int, textColor: Int, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(textColor)
        setTypeface(typeface, Typeface.BOLD)
        textSize = 13f
        backgroundTintList = ColorStateList.valueOf(backgroundColor)
        setOnClickListener { action() }
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
        setLineSpacing(0f, 1.12f)
    }

    private fun rounded(fill: Int, radiusDp: Int, stroke: Int? = null): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fill)
        cornerRadius = dp(radiusDp).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )

    private fun <T : View> T.withMargins(top: Int = 0, bottom: Int = 0): T {
        layoutParams = matchWrap().apply {
            topMargin = dp(top)
            bottomMargin = dp(bottom)
        }
        return this
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private data class SmsApp(val label: String, val packageName: String) {
        override fun toString(): String = label
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 10
        private const val LISTENER_LONG_RECOVERY_MS = 90_000L
        private const val MIUI_AUTOSTART_OP = 10_008
        private val BACKGROUND = Color.rgb(246, 248, 251)
        private val TEXT = Color.rgb(26, 35, 49)
        private val MUTED = Color.rgb(102, 112, 133)
        private val BORDER = Color.rgb(222, 227, 234)
        private val PRIMARY = Color.rgb(37, 99, 235)
        private val SUCCESS = Color.rgb(5, 150, 105)
        private val WARNING = Color.rgb(217, 119, 6)
        private val ERROR = Color.rgb(180, 35, 24)
        private val WARNING_BACKGROUND = Color.rgb(255, 247, 237)
        private val WARNING_BORDER = Color.rgb(253, 186, 116)
        private val DISABLED_BACKGROUND = Color.rgb(229, 233, 239)
    }
}
