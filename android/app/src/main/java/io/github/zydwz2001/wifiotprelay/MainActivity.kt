package io.github.zydwz2001.wifiotprelay

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
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
    private lateinit var notificationButton: Button
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
            .withMargins(top = 4, bottom = 14))

        listenerWarningCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = rounded(WARNING_BACKGROUND, 14, WARNING_BORDER)
            listenerWarningTitle = text("通知读取未连接，真实短信无法传递", 15f, ERROR, true)
                .also(::addView)
            listenerWarningHelp = text(
                "在系统页面先关闭再重新开启“验证码传递 · 通知读取”，然后返回本页等待几秒。",
                12f,
                TEXT
            ).withMargins(top = 5).also(::addView)
            listenerRepairButton = button("立即修复通知读取", PRIMARY, Color.WHITE) {
                openNotificationAccessSettings()
            }.withMargins(top = 9).also(::addView)
        }.withMargins(bottom = 10).also(root::addView)

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
        addressStatus = text("开启后显示", 18f, TEXT, true).apply { setTextIsSelectable(true) }
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

        mainCard.addView(text("短信应用", 11f, MUTED))
        smsSpinner = Spinner(this).apply {
            backgroundTintList = ColorStateList.valueOf(PRIMARY)
        }.also { mainCard.addView(it, matchWrap()) }

        notificationStatus = text("通知权限：检查中", 12f, MUTED).withMargins(top = 8)
            .also(mainCard::addView)
        root.addView(mainCard, matchWrap())

        serviceButton = primaryButton("开始传递") { toggleService() }.withMargins(top = 12)
            .also(root::addView)

        val firstActions = horizontalRow()
        notificationButton = secondaryButton("第一步：开启通知读取") {
            if (coordinator.hasNotificationAccess()) {
                openNotificationAccessSettings()
            } else {
                showNotificationAccessGuideIfNeeded(force = true)
            }
        }.also { firstActions.addView(it, weightedButtonParams()) }
        pairingButton = secondaryButton("生成新配对码") { handlePairingAction() }
            .also { firstActions.addView(it, weightedButtonParams(left = 8)) }
        root.addView(firstActions, matchWrap().apply { topMargin = dp(8) })

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
        guide.addView(text("1  开启通知读取，确认状态显示“已连接”", 13f, TEXT).withMargins(top = 10))
        guide.addView(text("2  点击“开始传递”，查看 Wi-Fi 地址和配对码", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("3  在电脑浏览器安装“验证码传递”插件", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("4  在插件中分别填写地址、端口和配对码", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("5  浏览器询问访问本地网络设备时，点击“允许”", 13f, TEXT).withMargins(top = 7))
        guide.addView(text("6  网页输入手机号后，用插件等待并写入验证码", 13f, TEXT).withMargins(top = 7))
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

    private fun handlePairingAction() {
        val snapshot = coordinator.snapshot()
        if (!snapshot.paired) {
            if (!snapshot.enabled) {
                Toast.makeText(this, "请先开始传递", Toast.LENGTH_SHORT).show()
                return
            }
            coordinator.regeneratePairCode()
            renderState()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("重新配对电脑？")
            .setMessage("当前电脑会断开，之后需要在插件中重新输入配对码。")
            .setNegativeButton("取消", null)
            .setPositiveButton("重新配对") { _, _ ->
                coordinator.unpair()
                renderState()
            }
            .show()
    }

    private fun renderState() {
        val snapshot = coordinator.snapshot()
        val notificationGranted = coordinator.hasNotificationAccess()
        serviceStatus.text = when {
            snapshot.enabled && !notificationGranted -> "⚠  请开启通知读取"
            snapshot.enabled && !snapshot.notificationListenerConnected -> "⚠  通知读取未连接"
            snapshot.running -> "●  正在传递"
            snapshot.enabled -> "正在恢复连接"
            else -> "尚未开始"
        }
        serviceStatus.setTextColor(when {
            snapshot.enabled && (!notificationGranted || !snapshot.notificationListenerConnected) -> ERROR
            snapshot.running -> SUCCESS
            else -> MUTED
        })
        addressStatus.text = snapshot.boundAddress ?: "开启后显示"
        portStatus.text = snapshot.port.toString()
        pairCodeStatus.text = when {
            snapshot.paired -> "已配对"
            snapshot.enabled && snapshot.pairCode != null -> snapshot.pairCode
            else -> "------"
        }
        pairCodeStatus.letterSpacing = if (snapshot.paired) 0f else .12f
        browserStatus.text = when {
            snapshot.clientOnline -> "浏览器在线"
            snapshot.paired -> "浏览器离线"
            else -> "浏览器未配对"
        }
        notificationStatus.text = when {
            !notificationGranted -> "通知读取：未开启，无法接收短信"
            snapshot.notificationListenerConnected -> "通知读取：已连接，可以接收短信"
            else -> "通知读取：未连接，真实短信无法传递"
        }
        listenerWarningCard.visibility = if (notificationGranted && snapshot.notificationListenerConnected) View.GONE else View.VISIBLE
        if (notificationGranted) {
            listenerWarningTitle.text = "通知读取未连接，真实短信无法传递"
            listenerWarningHelp.text = "点击下方按钮，在系统页面先关闭再重新开启“验证码传递 · 通知读取”，然后返回本页等待几秒。"
            listenerRepairButton.text = "立即修复通知读取"
        } else {
            listenerWarningTitle.text = "请先开启通知读取，否则无法接收短信"
            listenerWarningHelp.text = "点击下方按钮，在系统页面打开“验证码传递 · 通知读取”，然后返回本页。"
            listenerRepairButton.text = "立即开启通知读取"
        }
        notificationButton.text = when {
            !notificationGranted -> "开启通知读取"
            !snapshot.notificationListenerConnected -> "修复通知读取"
            else -> "管理通知读取"
        }
        serviceButton.text = if (snapshot.enabled) "停止传递" else "开始传递"
        serviceButton.isEnabled = snapshot.enabled || notificationGranted
        pairingButton.text = if (snapshot.paired) "更换配对电脑" else "生成新配对码"
        pairingButton.isEnabled = snapshot.enabled
        detailStatus.text = snapshot.diagnostic
        recentStatus.text = snapshot.lastCode?.let { code ->
            "最近验证码：$code  ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(snapshot.lastCodeAt ?: 0))}"
        } ?: "最近验证码：暂无"
    }

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

    private fun horizontalRow(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
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

    private fun weightedButtonParams(left: Int = 0) = LinearLayout.LayoutParams(
        0,
        LinearLayout.LayoutParams.WRAP_CONTENT,
        1f
    ).apply { leftMargin = dp(left) }

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
        private val BACKGROUND = Color.rgb(246, 248, 251)
        private val TEXT = Color.rgb(26, 35, 49)
        private val MUTED = Color.rgb(102, 112, 133)
        private val BORDER = Color.rgb(222, 227, 234)
        private val PRIMARY = Color.rgb(37, 99, 235)
        private val SUCCESS = Color.rgb(5, 150, 105)
        private val ERROR = Color.rgb(180, 35, 24)
        private val WARNING_BACKGROUND = Color.rgb(255, 247, 237)
        private val WARNING_BORDER = Color.rgb(253, 186, 116)
    }
}
