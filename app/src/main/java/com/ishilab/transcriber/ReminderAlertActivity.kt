package com.ishilab.transcriber

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * 締切リマインドの全画面アラート。通知の fullScreenIntent から起動され、
 * ロック中でも画面を点けて表示し、10秒間バイブする。
 * 「了解」を押すまで閉じない（バックキー無効。通知もここで消す）。
 */
class ReminderAlertActivity : ComponentActivity() {

    companion object {
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_NOTIF_ID = "notif_id"
        private const val VIBRATE_TOTAL_MS = 10_000L
    }

    private val messages = androidx.compose.runtime.mutableStateListOf<String>()
    private val notifIds = mutableListOf<Int>()
    private val handler = Handler(Looper.getMainLooper())
    private var vibrator: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // ロック中でも画面を点けて最前面に出す。
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
        // 「了解」を押すまで閉じさせない。
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { /* 何もしない */ }
        })

        addFromIntent(intent)
        startVibration()

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(24.dp)
                            .verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Text("⏰ 締切リマインド", style = MaterialTheme.typography.headlineMedium)
                        Spacer(Modifier.height(24.dp))
                        messages.forEach { m ->
                            Text(m, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                            Spacer(Modifier.height(12.dp))
                        }
                        Spacer(Modifier.height(24.dp))
                        Button(
                            onClick = ::acknowledge,
                            modifier = Modifier.fillMaxWidth().height(56.dp)
                        ) { Text("了解", style = MaterialTheme.typography.titleMedium) }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        addFromIntent(intent)
        startVibration() // 表示中に新しいリマインドが来たら改めて振動する
    }

    private fun addFromIntent(intent: Intent?) {
        val msg = intent?.getStringExtra(EXTRA_MESSAGE)
        if (!msg.isNullOrBlank() && msg !in messages) messages += msg
        val id = intent?.getIntExtra(EXTRA_NOTIF_ID, -1) ?: -1
        if (id >= 0 && id !in notifIds) notifIds += id
    }

    private fun startVibration() {
        stopVibration()
        val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        } ?: return
        vibrator = v
        // 0.8秒振動 + 0.4秒休止 を繰り返し、10秒で止める。
        v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 400), 0))
        handler.postDelayed({ stopVibration() }, VIBRATE_TOTAL_MS)
    }

    private fun stopVibration() {
        handler.removeCallbacksAndMessages(null)
        vibrator?.cancel()
    }

    private fun acknowledge() {
        stopVibration()
        val nm = getSystemService(NotificationManager::class.java)
        notifIds.forEach { nm.cancel(it) }
        finish()
    }

    override fun onDestroy() {
        stopVibration()
        super.onDestroy()
    }
}
