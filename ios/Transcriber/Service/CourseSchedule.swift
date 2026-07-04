import Foundation

/// 授業の曜日・時限まわりの共有ヘルパー。
/// カレンダー画面と1日のまとめ通知の双方から使う。（CourseSchedule.kt の移植）

let DowJa = ["月", "火", "水", "木", "金", "土", "日"]

// 早稲田大学の公式時間割（100分授業）。1限〜6限＋夜間の7限。
let PeriodTimes: [Int: (String, String)] = [
    1: ("08:50", "10:30"),
    2: ("10:40", "12:20"),
    3: ("13:10", "14:50"),
    4: ("15:05", "16:45"),
    5: ("17:00", "18:40"),
    6: ("18:55", "20:35"),
    7: ("20:45", "22:25"),
]

/// 年月日のみの値（java.time.LocalDate 相当の比較のため）。
struct YMD: Comparable, Equatable, Hashable {
    let year: Int
    let month: Int
    let day: Int

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    init(_ date: Date, calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        year = c.year ?? 1970
        month = c.month ?? 1
        day = c.day ?? 1
    }

    /// "yyyy-MM-dd" をパースする。失敗時は nil。
    init?(string: String) {
        let parts = string.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        year = parts[0]; month = parts[1]; day = parts[2]
    }

    var isoString: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    var date: Date {
        var c = DateComponents()
        c.year = year; c.month = month; c.day = day
        return Calendar.current.date(from: c) ?? Date()
    }

    /// 月=1 .. 日=7（java.time の DayOfWeek.value と同じ）。
    var dayOfWeekValue: Int {
        let wd = Calendar.current.component(.weekday, from: date) // 日=1..土=7
        return wd == 1 ? 7 : wd - 1
    }

    static func < (lhs: YMD, rhs: YMD) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }
}

/// 学期表記（"2025春学期" 等）から開講期間のおおよその日付範囲を推定する。
func courseTermRange(_ term: String, ref: YMD) -> (YMD, YMD) {
    let ay = ref.month >= 4 ? ref.year : ref.year - 1
    func d(_ y: Int, _ m: Int, _ dd: Int) -> YMD { YMD(year: y, month: m, day: dd) }
    if term.contains("通年") { return (d(ay, 4, 1), d(ay + 1, 1, 31)) }
    if term.contains("春") && (term.contains("Q") || term.contains("クォーター")) { return (d(ay, 4, 1), d(ay, 6, 15)) }
    if term.contains("夏") { return (d(ay, 8, 1), d(ay, 9, 15)) }
    if term.contains("秋") && (term.contains("Q") || term.contains("クォーター")) { return (d(ay, 9, 1), d(ay, 11, 15)) }
    if term.contains("冬") { return (d(ay, 11, 16), d(ay + 1, 1, 31)) }
    if term.contains("春") { return (d(ay, 4, 1), d(ay, 7, 31)) }
    if term.contains("秋") { return (d(ay, 9, 1), d(ay + 1, 1, 31)) }
    return (d(ay, 4, 1), d(ay + 1, 1, 31))
}

/// その授業が指定日に開講されるか（曜日一致＋学期内）。
func courseOccursOn(_ course: AiHelperClient.Course, _ date: YMD) -> Bool {
    if course.day.isEmpty { return false }
    let (start, end) = courseTermRange(course.term, ref: date)
    return date >= start && date <= end && DowJa[date.dayOfWeekValue - 1] == course.day
}

/// 授業の時間帯を "08:50〜10:30" 形式で返す。
/// startTime/endTime は複数時限にまたがる授業の時限番号（"1"〜"7"）、
/// または "HH:MM" 形式。単一時限は period から引く。
func courseTime(_ course: AiHelperClient.Course) -> String {
    func timeOf(_ raw: String, end: Bool) -> String? {
        if raw.contains(":") { return String(raw.prefix(5)) }
        let p = Int(raw) ?? course.period ?? -1
        guard let t = PeriodTimes[p] else { return nil }
        return end ? t.1 : t.0
    }
    guard let start = timeOf(course.startTime, end: false) else { return "" }
    guard let end = timeOf(course.endTime, end: true) else { return start }
    return "\(start)〜\(end)"
}
