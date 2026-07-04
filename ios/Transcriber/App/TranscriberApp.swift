import SwiftUI
import AVFoundation
import UserNotifications
import BackgroundTasks

@main
struct TranscriberApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var viewModel = MainViewModel()
    @StateObject private var service = AudioCaptureService.shared
    @StateObject private var alertCenter = ReminderAlertCenter.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(viewModel)
                .environmentObject(service)
                .tint(AppTheme.primary)
                // Android は lightColorScheme 固定。iOS もライト固定にして配色を揃える
                //（端末がダークモードのとき、固定ライトの AppTheme 色と反転した
                //  systemBackground/.primary が混在して配色が崩れるのを防ぐ）。
                .preferredColorScheme(.light)
                // 締切リマインドの全画面アラート（Android の ReminderAlertActivity 相当）。
                .fullScreenCover(isPresented: .constant(alertCenter.isPresenting)) {
                    ReminderAlertView()
                }
        }
        .onChange(of: scenePhase) { phase in
            switch phase {
            case .active:
                viewModel.startForegroundSync()
                viewModel.refreshGoogle()
                // 設定済みの「1日のまとめ通知」を貼り直す（最新の内容に更新）。
                DailyDigestScheduler.scheduleAll()
            case .background:
                viewModel.stopForegroundSync()
                AppDelegate.scheduleAppRefresh()
            default:
                break
            }
        }
    }
}

/// 権限要求・通知ハンドリング・バックグラウンド更新の登録（Android の MainActivity.onCreate ＋
/// ReminderReceiver.schedule に相当）。
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    static let refreshTaskId = "com.ishilab.transcriber.refresh"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // マイク・通知の権限を要求する。
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        UNUserNotificationCenter.current().delegate = self
        ReminderNotifier.ensureCategory()

        // 録音していないときでも「締切が近い予定・課題」を定期取得する（iOS が間隔を決める）。
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskId, using: nil) { task in
            Self.handleAppRefresh(task: task as! BGAppRefreshTask)
        }
        Self.scheduleAppRefresh()
        return true
    }

    /// 約15分後のバックグラウンド更新を予約する（Android の ReminderReceiver の15分ポーリング相当。
    /// 実際の実行タイミングは iOS が決めるため保証はない）。
    static func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func handleAppRefresh(task: BGAppRefreshTask) {
        scheduleAppRefresh() // 次回分を予約し直す
        let work = DispatchWorkItem {
            // リマインド取得＋未送信ファイル/音声の再送＋まとめ通知の内容更新。
            ReminderNotifier.poll()
            BackgroundSync().runOnce()
            DailyDigestScheduler.scheduleAll()
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
        DispatchQueue.global().async(execute: work)
    }

    // フォアグラウンドでも通知バナーを表示する。
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    // 通知タップ/「了解」アクション。
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.identifier
        if response.notification.request.content.categoryIdentifier == ReminderNotifier.categoryId {
            if response.actionIdentifier == ReminderNotifier.ackActionId {
                // 通知上の「了解」: その場で消すだけ（Android の ReminderAckReceiver 相当）。
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
            } else {
                // タップでアプリが開いたら全画面アラートを表示する。
                ReminderAlertCenter.shared.add(
                    message: response.notification.request.content.body, notifId: id
                )
            }
        }
        completionHandler()
    }
}

/// アプリ全体の配色（Web と揃えたインディゴ基調。Android の AppColorScheme 相当）。
enum AppTheme {
    static let primary = Color(red: 0x4F / 255.0, green: 0x46 / 255.0, blue: 0xE5 / 255.0)          // #4F46E5
    static let primaryContainer = Color(red: 0xE0 / 255.0, green: 0xE7 / 255.0, blue: 0xFF / 255.0) // #E0E7FF
    static let onPrimaryContainer = Color(red: 0x1E / 255.0, green: 0x1B / 255.0, blue: 0x4B / 255.0) // #1E1B4B
    static let secondary = Color(red: 0x08 / 255.0, green: 0x91 / 255.0, blue: 0xB2 / 255.0)        // #0891B2
    static let tertiary = Color(red: 0x7C / 255.0, green: 0x3A / 255.0, blue: 0xED / 255.0)         // #7C3AED
    static let background = Color(red: 0xF6 / 255.0, green: 0xF7 / 255.0, blue: 0xFB / 255.0)       // #F6F7FB
    static let surfaceVariant = Color(red: 0xEE / 255.0, green: 0xF2 / 255.0, blue: 0xF7 / 255.0)   // #EEF2F7
}
