package com.ishilab.transcriber

import com.ishilab.transcriber.net.AiHelperClient
import java.time.LocalDate

/**
 * 授業の曜日・時限まわりの共有ヘルパー。
 * カレンダー画面（MainActivity）と1日のまとめ通知（DailyDigest）の双方から使う。
 */

internal val DowJa = listOf("月", "火", "水", "木", "金", "土", "日")

// 早稲田大学の公式時間割（100分授業）。1限〜6限＋夜間の7限。
internal val PeriodTimes = mapOf(
    1 to ("08:50" to "10:30"),
    2 to ("10:40" to "12:20"),
    3 to ("13:10" to "14:50"),
    4 to ("15:05" to "16:45"),
    5 to ("17:00" to "18:40"),
    6 to ("18:55" to "20:35"),
    7 to ("20:45" to "22:25"),
)

/** 学期表記（"2025春学期" 等）から開講期間のおおよその日付範囲を推定する。 */
internal fun courseTermRange(term: String, ref: LocalDate): Pair<LocalDate, LocalDate> {
    val ay = if (ref.monthValue >= 4) ref.year else ref.year - 1
    fun d(year: Int, month: Int, day: Int) = LocalDate.of(year, month, day)
    return when {
        term.contains("通年") -> d(ay, 4, 1) to d(ay + 1, 1, 31)
        term.contains("春") && (term.contains("Q") || term.contains("クォーター")) ->
            d(ay, 4, 1) to d(ay, 6, 15)
        term.contains("夏") -> d(ay, 8, 1) to d(ay, 9, 15)
        term.contains("秋") && (term.contains("Q") || term.contains("クォーター")) ->
            d(ay, 9, 1) to d(ay, 11, 15)
        term.contains("冬") -> d(ay, 11, 16) to d(ay + 1, 1, 31)
        term.contains("春") -> d(ay, 4, 1) to d(ay, 7, 31)
        term.contains("秋") -> d(ay, 9, 1) to d(ay + 1, 1, 31)
        else -> d(ay, 4, 1) to d(ay + 1, 1, 31)
    }
}

/** その授業が指定日に開講されるか（曜日一致＋学期内）。 */
internal fun courseOccursOn(course: AiHelperClient.Course, date: LocalDate): Boolean {
    if (course.day.isBlank()) return false
    val (start, end) = courseTermRange(course.term, date)
    return !date.isBefore(start) && !date.isAfter(end) && DowJa[date.dayOfWeek.value - 1] == course.day
}

/**
 * 授業の時間帯を "08:50〜10:30" 形式で返す。
 * startTime/endTime は複数時限にまたがる授業の時限番号（"1"〜"7"）、
 * または "HH:MM" 形式。単一時限は period から引く。
 */
internal fun courseTime(course: AiHelperClient.Course): String {
    fun timeOf(raw: String, end: Boolean): String? {
        if (raw.contains(':')) return raw.take(5)
        val p = raw.toIntOrNull() ?: course.period ?: return null
        val t = PeriodTimes[p] ?: return null
        return if (end) t.second else t.first
    }
    val start = timeOf(course.startTime, end = false) ?: return ""
    val end = timeOf(course.endTime, end = true) ?: return start
    return "$start〜$end"
}
