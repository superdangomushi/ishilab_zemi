import Foundation
import UserNotifications
import UIKit

/// サーバーの未読リマインド（締切が近い課題・予定）を取得して端末のローカル通知を出す。
///
/// Android 版は全画面アラート（ReminderAlertActivity）＋10秒バイブだが、iOS は
/// バックグラウンドから画面を起動できないため:
///  - アプリ使用中: そのまま全画面アラート（ReminderAlertView）＋バイブを表示する。
///  - それ以外: Time Sensitive のローカル通知（「了解」アクション付き）を出し、
///    通知タップでアプリが開いたときに全画面アラートを表示する。
enum ReminderNotifier {

    static let categoryId = "REMINDER"
    static let ackActionId = "REMINDER_ACK"

    /// 通知カテゴリ（「了解」ボタン）を登録する。起動時に一度呼ぶ。
    static func ensureCategory() {
        let ack = UNNotificationAction(identifier: ackActionId, title: "了解", options: [])
        let category = UNNotificationCategory(
            identifier: categoryId, actions: [ack], intentIdentifiers: [], options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// 未読リマインドを取得し、通知/全画面アラートとして表示して既読化する。ブロッキング。
    static func poll() {
        let store = AccountStore()
        if !store.loggedIn { return }
        let client = AiHelperClient()
        let reminders = client.fetchReminders(baseUrl: store.baseUrl, email: store.email, token: store.token)
        if reminders.isEmpty { return }
        ensureCategory()

        var acked: [Int64] = []
        for r in reminders {
            show(message: r.message, id: r.id)
            acked.append(r.id)
        }
        client.ackReminders(baseUrl: store.baseUrl, email: store.email, token: store.token, ids: acked)
        NSLog("ReminderNotifier: showed %d reminder notification(s)", reminders.count)
    }

    private static func show(message: String, id: Int64) {
        // ローカル通知（バックグラウンド・ロック中向け）。
        let content = UNMutableNotificationContent()
        content.title = message.split(separator: "\n").first.map { String($0.prefix(40)) } ?? "リマインド"
        content.body = message
        content.sound = .default
        content.categoryIdentifier = categoryId
        if #available(iOS 15.0, *) {
            content.interruptionLevel = .timeSensitive
        }
        let request = UNNotificationRequest(
            identifier: "reminder-\(id)", content: content,
            trigger: nil // 即時
        )
        UNUserNotificationCenter.current().add(request)

        // アプリ使用中なら全画面アラートも直接出す（Android の fullScreenIntent 相当）。
        DispatchQueue.main.async {
            if UIApplication.shared.applicationState == .active {
                ReminderAlertCenter.shared.add(message: message, notifId: "reminder-\(id)")
            }
        }
    }
}

/// 全画面リマインドアラートの表示状態。通知タップ・フォアグラウンド受信の双方から積まれる。
final class ReminderAlertCenter: ObservableObject {
    static let shared = ReminderAlertCenter()

    @Published private(set) var messages: [String] = []
    private(set) var notifIds: [String] = []

    var isPresenting: Bool { !messages.isEmpty }

    func add(message: String, notifId: String) {
        if !message.isEmpty && !messages.contains(message) {
            messages.append(message)
        }
        if !notifIds.contains(notifId) {
            notifIds.append(notifId)
        }
    }

    /// 「了解」: 表示中の通知も消してすべてクリアする。
    func acknowledge() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: notifIds)
        messages = []
        notifIds = []
    }
}
