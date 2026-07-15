package com.ishilab.transcriber.service

import android.content.Context
import java.time.LocalTime

/**
 * 通知の受け取り設定。
 *  - [enabled]: 通知のマスタースイッチ。false ならリマインド・まとめ通知を一切出さない。
 *  - [quietEnabled] / [quietStart] / [quietEnd]: おやすみモード。指定した時間帯は通知しない。
 *    （寝ている間に通知が鳴り響かないようにするための機能）。開始 > 終了なら日をまたぐ
 *    夜間帯（例: 23:00〜07:00）として扱う。
 *
 * 録音サービスの常駐通知は対象外（サービス継続に必須のため）。ここでゲートするのは
 * 締切リマインド（ReminderNotifier）と1日のまとめ（DailyDigest）だけ。
 */
class NotificationPrefs(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    var quietEnabled: Boolean
        get() = prefs.getBoolean(KEY_QUIET_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_QUIET_ENABLED, value).apply()

    /** "HH:MM"。既定はおやすみモードの一般的な就寝〜起床帯。 */
    var quietStart: String
        get() = prefs.getString(KEY_QUIET_START, "23:00") ?: "23:00"
        set(value) = prefs.edit().putString(KEY_QUIET_START, value).apply()

    var quietEnd: String
        get() = prefs.getString(KEY_QUIET_END, "07:00") ?: "07:00"
        set(value) = prefs.edit().putString(KEY_QUIET_END, value).apply()

    /** 今この瞬間、通知を抑制すべきか。マスターOFF、またはおやすみ時間帯なら true。 */
    fun shouldSuppressNow(now: LocalTime = LocalTime.now()): Boolean {
        if (!enabled) return true
        if (quietEnabled && isQuietAt(now)) return true
        return false
    }

    /** 指定時刻がおやすみ時間帯に入るか。開始 > 終了なら日またぎ（夜間）とみなす。 */
    fun isQuietAt(now: LocalTime): Boolean {
        val start = parse(quietStart) ?: return false
        val end = parse(quietEnd) ?: return false
        if (start == end) return false
        return if (start < end) {
            now >= start && now < end            // 同日内（例: 13:00〜15:00）
        } else {
            now >= start || now < end            // 日またぎ（例: 23:00〜07:00）
        }
    }

    private fun parse(hhmm: String): LocalTime? {
        val p = hhmm.split(':')
        val h = p.getOrNull(0)?.toIntOrNull() ?: return null
        val m = p.getOrNull(1)?.toIntOrNull() ?: return null
        return runCatching { LocalTime.of(h, m) }.getOrNull()
    }

    companion object {
        private const val PREFS = "notif_prefs"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_QUIET_ENABLED = "quiet_enabled"
        private const val KEY_QUIET_START = "quiet_start"
        private const val KEY_QUIET_END = "quiet_end"
    }
}
