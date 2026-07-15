package com.ishilab.transcriber.service

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.ishilab.transcriber.MainActivity
import com.ishilab.transcriber.courseOccursOn
import com.ishilab.transcriber.courseTime
import com.ishilab.transcriber.google.GoogleAccountStore
import com.ishilab.transcriber.google.GoogleCalendarClient
import com.ishilab.transcriber.net.AccountStore
import com.ishilab.transcriber.net.AiHelperClient
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Calendar

/**
 * 「1日のまとめ」通知の時刻設定（"HH:MM"）。複数設定できる。
 */
class DigestTimeStore(context: Context) {

    private val prefs = context.getSharedPreferences("daily_digest", Context.MODE_PRIVATE)

    var times: List<String>
        get() = (prefs.getString(KEY_TIMES, "") ?: "").split(',').filter { it.isNotBlank() }.sorted()
        private set(value) = prefs.edit()
            .putString(KEY_TIMES, value.distinct().sorted().joinToString(","))
            .apply()

    fun add(time: String) { times = times + time }
    fun remove(time: String) { times = times - time }

    companion object {
        private const val KEY_TIMES = "times"
    }
}

/**
 * 設定された各時刻に DailyDigestReceiver を発火させる。
 * 発火後は翌日の同時刻を予約し直す（毎日繰り返し）。
 */
object DailyDigestScheduler {

    private const val TAG = "DailyDigest"
    const val CHANNEL_ID = "daily_digest"
    private const val ACTION = "com.ishilab.transcriber.DAILY_DIGEST"
    const val EXTRA_TIME = "time"
    // リマインド(2000台)・ポーリング(3001)と被らない番号帯。時刻ごとに一意。
    private const val REQUEST_BASE = 5000
    private const val KEY_SCHEDULED = "scheduled"

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID, "1日のまとめ通知", NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "設定した時刻に今日の授業・予定・課題の期限をまとめて通知する" }
        nm.createNotificationChannel(channel)
    }

    /** 設定済みの全時刻を仕掛け直す（アプリ起動時・設定変更時・端末再起動時に呼ぶ）。 */
    fun scheduleAll(context: Context) {
        ensureChannel(context)
        val prefs = context.getSharedPreferences("daily_digest", Context.MODE_PRIVATE)
        val am = context.getSystemService(AlarmManager::class.java)
        // 前回スケジュール分を消してから貼り直す（時刻の削除に追従するため）。
        (prefs.getString(KEY_SCHEDULED, "") ?: "").split(',').filter { it.isNotBlank() }
            .forEach { am.cancel(pendingIntent(context, it)) }
        val times = DigestTimeStore(context).times
        times.forEach { scheduleNext(context, it) }
        prefs.edit().putString(KEY_SCHEDULED, times.joinToString(",")).apply()
        Log.i(TAG, "scheduled digest times: $times")
    }

    /** 指定時刻の次の発火（今日まだ来ていなければ今日、過ぎていれば明日）を予約する。 */
    fun scheduleNext(context: Context, time: String) {
        val parts = time.split(':')
        val h = parts.getOrNull(0)?.toIntOrNull() ?: return
        val m = parts.getOrNull(1)?.toIntOrNull() ?: return
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, h)
            set(Calendar.MINUTE, m)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= System.currentTimeMillis()) add(Calendar.DAY_OF_MONTH, 1)
        }
        val am = context.getSystemService(AlarmManager::class.java)
        val pi = pendingIntent(context, time)
        // Android 12+ は正確なアラームに「アラームとリマインダー」の許可が要る。
        // 未許可なら 10 分幅の近似発火にフォールバックする。
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, cal.timeInMillis, pi)
        } else {
            am.setWindow(AlarmManager.RTC_WAKEUP, cal.timeInMillis, 10 * 60_000L, pi)
        }
    }

    private fun pendingIntent(context: Context, time: String): PendingIntent {
        // "08:30" → 830 のように時刻から一意な requestCode を作る（最大 5000+2359）。
        val code = REQUEST_BASE + (time.replace(":", "").toIntOrNull() ?: 0)
        val intent = Intent(context, DailyDigestReceiver::class.java)
            .setAction(ACTION)
            .putExtra(EXTRA_TIME, time)
        return PendingIntent.getBroadcast(
            context, code, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }
}

/** 設定時刻に発火し、まとめ通知を出して翌日分を再予約するレシーバ。 */
class DailyDigestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val time = intent.getStringExtra(DailyDigestScheduler.EXTRA_TIME) ?: ""
        val pending = goAsync()
        Thread {
            try {
                DailyDigest.show(context.applicationContext)
            } catch (e: Exception) {
                Log.w("DailyDigest", "digest failed: ${e.message}")
            } finally {
                // 設定から削除済みの時刻なら再予約しない。
                if (time.isNotBlank() && time in DigestTimeStore(context).times) {
                    DailyDigestScheduler.scheduleNext(context, time)
                }
                pending.finish()
            }
        }.start()
    }
}

/** 端末再起動後にリマインドとまとめ通知のアラームを貼り直す。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        ReminderReceiver.schedule(context)
        DailyDigestScheduler.scheduleAll(context)
    }
}

/**
 * 「1日のまとめ」の本体。サーバーの時間割・課題と Google カレンダーから
 * 今日の分を集めて1つの通知にする。ブロッキングなのでワーカースレッドから呼ぶ。
 */
object DailyDigest {

    private const val NOTIF_ID = 6000

    fun show(context: Context) {
        val store = AccountStore(context)
        if (!store.loggedIn) return
        // 通知OFF・おやすみモード中はまとめ通知も出さない。
        if (NotificationPrefs(context).shouldSuppressNow()) {
            Log.i("DailyDigest", "digest suppressed (notifications off or quiet hours)")
            return
        }
        val client = AiHelperClient()
        val today = LocalDate.now()
        val sb = StringBuilder()

        // 今日の授業（早稲田の時限で時刻表示）。
        val courses = client.fetchCourses(store.baseUrl, store.email, store.token)
            .getOrNull().orEmpty()
            .filter { courseOccursOn(it, today) }
            .sortedBy { courseTime(it).ifBlank { "99:99" } }
        if (courses.isNotEmpty()) {
            sb.appendLine("■ 今日の授業")
            courses.forEach { c ->
                val time = courseTime(c).ifBlank { "時刻未定" }
                val room = if (c.room.isNotBlank()) " (${c.room})" else ""
                sb.appendLine("・$time ${c.name}$room")
            }
        }

        // 今日の Google カレンダー予定（アカウント単位で失敗しても他は続ける。
        // バックグラウンドではトークン再認可が要る場合があり、そのときはスキップ）。
        run {
            val events = GoogleAccountStore(context).emails
                .flatMap { email ->
                    runCatching {
                        val token = GoogleCalendarClient.accessToken(context, email)
                        GoogleCalendarClient.listUpcomingEvents(token).getOrThrow()
                    }.getOrDefault(emptyList())
                }
                .filter {
                    it.startMillis > 0 && Instant.ofEpochMilli(it.startMillis)
                        .atZone(ZoneId.systemDefault()).toLocalDate() == today
                }
                .distinctBy { it.title to it.startMillis }
                .sortedBy { it.startMillis }
            if (events.isNotEmpty()) {
                sb.appendLine("■ 今日の予定（カレンダー）")
                events.forEach { ev ->
                    val norm = ev.whenText.replace('T', ' ')
                    val start = if (norm.length >= 16) norm.substring(11, 16) else "終日"
                    val endNorm = ev.endText.replace('T', ' ')
                    val end = if (endNorm.length >= 16) endNorm.substring(11, 16) else ""
                    val time = if (start != "終日" && end.isNotBlank()) "$start〜$end" else start
                    sb.appendLine("・$time ${ev.title}")
                }
            }
        }

        // 今日が期限の課題・予定、および期限切れの未完了。
        val tasks = client.fetchTasks(store.baseUrl, store.email, store.token, includeDone = false)
            .getOrNull().orEmpty()
        val todayStr = today.toString()
        fun timeOf(t: AiHelperClient.Task): String {
            val norm = t.deadline.orEmpty().replace('T', ' ')
            return if (!t.dateOnly && norm.length >= 16) norm.substring(11, 16) else "終日"
        }
        fun label(t: AiHelperClient.Task) = if (t.type == "yotei") "予定" else "課題"
        val dueToday = tasks.filter { it.deadline?.take(10) == todayStr }
            .sortedBy { if (it.dateOnly) "00:00" else timeOf(it) }
        if (dueToday.isNotEmpty()) {
            sb.appendLine("■ 今日が期限")
            dueToday.forEach { sb.appendLine("・${timeOf(it)} [${label(it)}] ${it.content}") }
        }
        val overdue = tasks.filter { (it.deadline?.take(10) ?: "9999-99-99") < todayStr }
        if (overdue.isNotEmpty()) {
            sb.appendLine("■ 期限切れ（未完了）")
            overdue.take(5).forEach { sb.appendLine("・${it.deadline?.take(10)} [${label(it)}] ${it.content}") }
            if (overdue.size > 5) sb.appendLine("　ほか${overdue.size - 5}件")
        }

        val body = sb.toString().trimEnd()
            .ifBlank { "今日の授業・予定・期限はありません。" }

        DailyDigestScheduler.ensureChannel(context)
        val open = PendingIntent.getActivity(
            context, NOTIF_ID,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(context, DailyDigestScheduler.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_agenda)
            .setContentTitle("今日のまとめ（${today.monthValue}/${today.dayOfMonth}）")
            .setContentText(body.lineSequence().firstOrNull().orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(NOTIF_ID, notification)
        Log.i("DailyDigest", "digest notification shown")
    }
}
