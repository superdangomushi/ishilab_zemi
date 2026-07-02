package com.ishilab.transcriber.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.ishilab.transcriber.ReminderAlertActivity

/**
 * サーバーの未読リマインド（締切が近い課題・予定）を取得して端末のローカル通知を出す。
 * 通知は全画面アラート（ReminderAlertActivity）＋10秒バイブ付きで、
 * 「了解」を押すまで消えない。
 * 録音サービスと定期アラームの双方から使えるよう、単独オブジェクトに切り出している。
 */
object ReminderNotifier {

    private const val TAG = "ReminderNotifier"

    // 通知チャンネルは作成後にバイブ設定を変えられないため、v2 に移行した。
    private const val OLD_CHANNEL_ID = "reminders"
    const val CHANNEL_ID = "reminders_v2"
    private const val NOTIF_BASE = 2000

    // 0.7秒振動 + 0.3秒休止 ×10回 = 10秒（全画面が出ない場合でもこのパターンで振動する）。
    private val VIBRATE_PATTERN = LongArray(21).also {
        for (i in 0 until 10) { it[i * 2 + 1] = 700; it[i * 2 + 2] = 300 }
    }

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.deleteNotificationChannel(OLD_CHANNEL_ID)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "締切・予定リマインド",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "課題や予定の締切が近いときの通知（全画面表示＋バイブ）"
            enableVibration(true)
            vibrationPattern = VIBRATE_PATTERN
        }
        nm.createNotificationChannel(channel)
    }

    /** 未読リマインドを取得し、ローカル通知として表示して既読化する。ブロッキング。 */
    fun poll(context: Context) {
        val store = AccountStore(context)
        if (!store.loggedIn) return
        val client = AiHelperClient()
        val reminders = client.fetchReminders(store.baseUrl, store.email, store.token)
        if (reminders.isEmpty()) return
        ensureChannel(context)
        val nm = context.getSystemService(NotificationManager::class.java)
        val acked = ArrayList<Long>(reminders.size)
        for (r in reminders) {
            val notifId = NOTIF_BASE + (r.id % 100000).toInt()
            nm.notify(notifId, build(context, r.message, notifId))
            acked.add(r.id)
        }
        client.ackReminders(store.baseUrl, store.email, store.token, acked)
        Log.i(TAG, "showed ${reminders.size} reminder notification(s)")
    }

    private fun build(context: Context, message: String, notifId: Int): Notification {
        // 全画面アラート。ロック中・画面OFFでも起動される（タップ時も同じ画面を開く）。
        val alertIntent = Intent(context, ReminderAlertActivity::class.java)
            .putExtra(ReminderAlertActivity.EXTRA_MESSAGE, message)
            .putExtra(ReminderAlertActivity.EXTRA_NOTIF_ID, notifId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val fullScreen = PendingIntent.getActivity(
            context, notifId, alertIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        // 通知上の「了解」ボタン（全画面を開かずにその場で消せる）。
        val ack = PendingIntent.getBroadcast(
            context, notifId,
            Intent(context, ReminderAckReceiver::class.java)
                .putExtra(ReminderAlertActivity.EXTRA_NOTIF_ID, notifId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val title = message.lineSequence().firstOrNull()?.take(40) ?: "リマインド"
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVibrate(VIBRATE_PATTERN)
            .setOngoing(true)      // スワイプで消えにくくする（了解で消す運用）
            .setAutoCancel(false)
            .addAction(0, "了解", ack)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
    }
}

/** 通知の「了解」ボタン用。対象の通知を消すだけ。 */
class ReminderAckReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(ReminderAlertActivity.EXTRA_NOTIF_ID, -1)
        if (id >= 0) context.getSystemService(NotificationManager::class.java).cancel(id)
    }
}
