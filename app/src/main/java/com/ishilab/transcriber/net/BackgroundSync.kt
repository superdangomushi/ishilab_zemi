package com.ishilab.transcriber.net

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.ishilab.transcriber.MainActivity
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * バックグラウンドでの「定期アップロード」と「リマインドのローカル通知」を担う。
 *
 * - moneybot.jp にログイン済みのときだけ動く。
 * - 一定間隔で transcripts/ の更新済みファイルをサーバーへ送信する
 *   （サーバー側は同名ファイルを上書き保存し、Gemini で課題/予定を抽出する）。
 * - あわせてサーバーの未読リマインドを取得し、端末のローカル通知として表示する。
 *
 * 追加ライブラリを増やさないため単純な Thread + sleep で実装する。
 * 通信はブロッキングなので専用スレッドで回す。
 */
class BackgroundSync(private val context: Context) {

    private val accountStore = AccountStore(context)
    private val client = MoneybotClient()

    @Volatile private var thread: Thread? = null
    private val running = AtomicBoolean(false)
    @Volatile private var lastUploadAt: Long = 0L

    fun start() {
        if (running.getAndSet(true)) return
        ensureChannel()
        thread = Thread({ loop() }, "moneybot-sync").also { it.start() }
        Log.i(TAG, "background sync started")
    }

    fun stop() {
        running.set(false)
        thread?.interrupt()
        thread = null
    }

    private fun loop() {
        while (running.get()) {
            try {
                if (accountStore.loggedIn) {
                    uploadUpdatedFiles()
                    pollReminders()
                }
            } catch (_: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "sync cycle error: ${e.message}")
            }
            try {
                Thread.sleep(INTERVAL_MS)
            } catch (_: InterruptedException) {
                break
            }
        }
        Log.i(TAG, "background sync stopped")
    }

    /** 前回以降に更新された文字起こしファイルを送信する（毎時ファイルの追記に追従）。 */
    private fun uploadUpdatedFiles() {
        val dir = File(context.filesDir, "transcripts")
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".txt") } ?: return
        // 初回はすべて、以降は前回サイクル以降に更新されたものだけ送る。
        val threshold = lastUploadAt - 60_000 // 取りこぼし防止に1分のマージン
        var sent = 0
        for (file in files.sortedBy { it.name }) {
            if (lastUploadAt != 0L && file.lastModified() < threshold) continue
            when (client.upload(accountStore.baseUrl, accountStore.email, accountStore.token, file)) {
                is MoneybotClient.Result.Ok -> sent++
                is MoneybotClient.Result.Error -> { /* 次サイクルで再送される */ }
            }
        }
        lastUploadAt = System.currentTimeMillis()
        if (sent > 0) Log.i(TAG, "auto-uploaded $sent file(s)")
    }

    /** サーバーの未読リマインドをローカル通知として表示し、既読化する。 */
    private fun pollReminders() {
        val reminders = client.fetchReminders(accountStore.baseUrl, accountStore.email, accountStore.token)
        if (reminders.isEmpty()) return
        val nm = context.getSystemService(NotificationManager::class.java)
        val acked = ArrayList<Long>(reminders.size)
        for (r in reminders) {
            nm.notify(NOTIF_BASE + (r.id % 100000).toInt(), buildReminderNotification(r.message))
            acked.add(r.id)
        }
        client.ackReminders(accountStore.baseUrl, accountStore.email, accountStore.token, acked)
        Log.i(TAG, "showed ${reminders.size} reminder notification(s)")
    }

    private fun buildReminderNotification(message: String): android.app.Notification {
        val contentIntent = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val title = message.lineSequence().firstOrNull()?.take(40) ?: "リマインド"
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
    }

    private fun ensureChannel() {
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "締切・予定リマインド",
            NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "課題や予定の締切が近いときの通知" }
        nm.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "BackgroundSync"
        private const val CHANNEL_ID = "reminders"
        private const val NOTIF_BASE = 2000
        // 送信/リマインド確認の間隔（既定 15 分）。
        private const val INTERVAL_MS = 15 * 60 * 1000L
    }
}
