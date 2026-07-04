import Foundation
import UserNotifications

/// 「1日のまとめ」通知の時刻設定（"HH:MM"）。複数設定できる。
final class DigestTimeStore {

    private let prefs = UserDefaults.standard
    private static let keyTimes = "daily_digest.times"

    private(set) var times: [String] {
        get {
            (prefs.string(forKey: Self.keyTimes) ?? "")
                .split(separator: ",").map(String.init).filter { !$0.isEmpty }.sorted()
        }
        set {
            prefs.set(Array(Set(newValue)).sorted().joined(separator: ","), forKey: Self.keyTimes)
        }
    }

    func add(_ time: String) { times = times + [time] }
    func remove(_ time: String) { times = times.filter { $0 != time } }
}

/// 設定された各時刻に「今日のまとめ」通知を予約する。
///
/// Android 版は AlarmManager で発火時に内容を生成するが、iOS は任意時刻にコードを
/// 実行できないため、**予約時点の最新データ**で通知本文を作って
/// UNCalendarNotificationTrigger に載せる。アプリ起動時・フォアグラウンド同期・
/// バックグラウンド更新（BGAppRefresh）のたびに貼り直して内容を新しくする。
enum DailyDigestScheduler {

    private static let idPrefix = "daily-digest-"

    /// 設定済みの全時刻を仕掛け直す（アプリ起動時・設定変更時・同期時に呼ぶ）。
    /// ブロッキング（サーバー通信を含む）なのでワーカースレッドから呼ぶこと。
    static func scheduleAll() {
        let center = UNUserNotificationCenter.current()
        // 前回スケジュール分を消してから貼り直す（時刻の削除に追従するため）。
        center.getPendingNotificationRequests { requests in
            let old = requests.map(\.identifier).filter { $0.hasPrefix(idPrefix) }
            center.removePendingNotificationRequests(withIdentifiers: old)

            DispatchQueue.global().async {
                let times = DigestTimeStore().times
                guard !times.isEmpty else { return }
                guard let body = DailyDigest.buildBody() else { return } // 未ログインなら何もしない
                let today = Calendar.current.dateComponents([.month, .day], from: Date())
                for time in times {
                    let parts = time.split(separator: ":").compactMap { Int($0) }
                    guard parts.count == 2 else { continue }
                    let content = UNMutableNotificationContent()
                    content.title = "今日のまとめ（\(today.month ?? 0)/\(today.day ?? 0)）"
                    content.body = body
                    content.sound = .default
                    var trigger = DateComponents()
                    trigger.hour = parts[0]
                    trigger.minute = parts[1]
                    let request = UNNotificationRequest(
                        identifier: idPrefix + time,
                        content: content,
                        trigger: UNCalendarNotificationTrigger(dateMatching: trigger, repeats: true)
                    )
                    center.add(request)
                }
                NSLog("DailyDigest: scheduled digest times: %@", times.joined(separator: ","))
            }
        }
    }
}

/// 「1日のまとめ」の本体。サーバーの時間割・課題と Google カレンダーから
/// 今日の分を集めて1つの通知本文にする。ブロッキングなのでワーカースレッドから呼ぶ。
enum DailyDigest {

    /// まとめ本文を生成する。未ログインなら nil。
    static func buildBody() -> String? {
        let store = AccountStore()
        if !store.loggedIn { return nil }
        let client = AiHelperClient()
        let today = YMD(Date())
        var sb = ""

        // 今日の授業（早稲田の時限で時刻表示）。
        let courses = ((try? client.fetchCourses(baseUrl: store.baseUrl, email: store.email, token: store.token).get()) ?? [])
            .filter { courseOccursOn($0, today) }
            .sorted { (courseTime($0).isEmpty ? "99:99" : courseTime($0)) < (courseTime($1).isEmpty ? "99:99" : courseTime($1)) }
        if !courses.isEmpty {
            sb += "■ 今日の授業\n"
            for c in courses {
                let time = courseTime(c).isEmpty ? "時刻未定" : courseTime(c)
                let room = c.room.isEmpty ? "" : " (\(c.room))"
                sb += "・\(time) \(c.name)\(room)\n"
            }
        }

        // 今日の Google カレンダー予定（アカウント単位で失敗しても他は続ける）。
        do {
            let googleStore = GoogleAccountStore()
            var events: [CalendarEvent] = []
            for email in googleStore.emails {
                guard let token = try? GoogleCalendarClient.accessToken(googleStore, email: email) else { continue }
                if case .success(let list) = GoogleCalendarClient.listUpcomingEvents(token: token) {
                    events += list
                }
            }
            var seen = Set<String>()
            let todays = events
                .filter { $0.startMillis > 0 && YMD(Date(timeIntervalSince1970: Double($0.startMillis) / 1000)) == today }
                .filter { seen.insert("\($0.title)-\($0.startMillis)").inserted }
                .sorted { $0.startMillis < $1.startMillis }
            if !todays.isEmpty {
                sb += "■ 今日の予定（カレンダー）\n"
                for ev in todays {
                    let norm = ev.whenText.replacingOccurrences(of: "T", with: " ")
                    let start = norm.count >= 16 ? String(norm.dropFirst(11).prefix(5)) : "終日"
                    let endNorm = ev.endText.replacingOccurrences(of: "T", with: " ")
                    let end = endNorm.count >= 16 ? String(endNorm.dropFirst(11).prefix(5)) : ""
                    let time = (start != "終日" && !end.isEmpty) ? "\(start)〜\(end)" : start
                    sb += "・\(time) \(ev.title)\n"
                }
            }
        }

        // 今日が期限の課題・予定、および期限切れの未完了。
        let tasks = (try? client.fetchTasks(baseUrl: store.baseUrl, email: store.email, token: store.token, includeDone: false).get()) ?? []
        let todayStr = today.isoString
        func timeOf(_ t: AiHelperClient.Task) -> String {
            let norm = (t.deadline ?? "").replacingOccurrences(of: "T", with: " ")
            return (!t.dateOnly && norm.count >= 16) ? String(norm.dropFirst(11).prefix(5)) : "終日"
        }
        func label(_ t: AiHelperClient.Task) -> String { t.type == "yotei" ? "予定" : "課題" }
        let dueToday = tasks
            .filter { ($0.deadline ?? "").prefix(10) == todayStr }
            .sorted { ($0.dateOnly ? "00:00" : timeOf($0)) < ($1.dateOnly ? "00:00" : timeOf($1)) }
        if !dueToday.isEmpty {
            sb += "■ 今日が期限\n"
            for t in dueToday { sb += "・\(timeOf(t)) [\(label(t))] \(t.content)\n" }
        }
        let overdue = tasks.filter { String(($0.deadline ?? "9999-99-99").prefix(10)) < todayStr }
        if !overdue.isEmpty {
            sb += "■ 期限切れ（未完了）\n"
            for t in overdue.prefix(5) { sb += "・\((t.deadline ?? "").prefix(10)) [\(label(t))] \(t.content)\n" }
            if overdue.count > 5 { sb += "　ほか\(overdue.count - 5)件\n" }
        }

        let body = sb.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? "今日の授業・予定・期限はありません。" : body
    }
}
