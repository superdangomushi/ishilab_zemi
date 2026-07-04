import SwiftUI

private struct CalItem: Identifiable {
    let id = UUID()
    let date: YMD
    let time: String
    let title: String
    var task: AiHelperClient.Task? = nil
}

/// 月カレンダー。日付をタップするとその日の予定・時間・（あれば）要約を表示。
struct CalendarTabView: View {
    @EnvironmentObject var viewModel: MainViewModel

    @State private var yearMonth: (Int, Int) = {
        let c = Calendar.current.dateComponents([.year, .month], from: Date())
        return (c.year ?? 2026, c.month ?? 1)
    }()
    @State private var selected = YMD(Date())
    @State private var editingTaskId: Int64? = nil

    var body: some View {
        let byDate = buildByDate()
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // 月移動
                HStack {
                    Button("‹ 前月") { moveMonth(-1) }
                    Spacer()
                    Text("\(String(yearMonth.0))年\(yearMonth.1)月").font(.headline)
                    Spacer()
                    Button("翌月 ›") { moveMonth(1) }
                }
                // 曜日ヘッダー
                HStack {
                    ForEach(["日", "月", "火", "水", "木", "金", "土"], id: \.self) { d in
                        Text(d)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
                // 週ごとの行
                ForEach(weeks(), id: \.self) { week in
                    HStack(spacing: 0) {
                        ForEach(week.indices, id: \.self) { i in
                            if let day = week[i] {
                                let date = YMD(year: yearMonth.0, month: yearMonth.1, day: day)
                                let isSel = date == selected
                                let has = byDate[date] != nil
                                Button {
                                    selected = date
                                    viewModel.loadDaySummary(date.isoString)
                                } label: {
                                    VStack(spacing: 2) {
                                        Text("\(day)")
                                            .font(.subheadline)
                                            .foregroundColor(.primary)
                                        Circle()
                                            .fill(has ? AppTheme.primary : .clear)
                                            .frame(width: 5, height: 5)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .background(isSel ? AppTheme.primaryContainer : .clear)
                                    .cornerRadius(8)
                                }
                                .buttonStyle(.plain)
                            } else {
                                Color.clear.frame(maxWidth: .infinity, minHeight: 44)
                            }
                        }
                    }
                }
                // 選択日の詳細
                Text("\(selected.month)月\(selected.day)日 の予定")
                    .font(.headline)
                    .padding(.top, 4)
                if viewModel.ui.coursesLoading {
                    Text("時間割を読み込み中…").font(.caption)
                }
                if let err = viewModel.ui.coursesError {
                    Text("時間割の取得エラー: \(err)").foregroundColor(.red)
                }
                let dayItems = (byDate[selected] ?? []).sorted {
                    ($0.time.isEmpty ? "99:99" : $0.time) < ($1.time.isEmpty ? "99:99" : $1.time)
                }
                if dayItems.isEmpty {
                    Text("予定はありません。").font(.caption)
                } else {
                    ForEach(dayItems) { item in
                        Button {
                            if let task = item.task { editingTaskId = task.id }
                        } label: {
                            CardView {
                                HStack(spacing: 10) {
                                    Text(item.time.isEmpty ? "終日" : item.time)
                                        .font(.caption.bold())
                                    Text(item.title)
                                        .font(.subheadline)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    if item.task != nil {
                                        Text("編集")
                                            .font(.caption)
                                            .foregroundColor(AppTheme.primary)
                                    }
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(item.task == nil)
                    }
                }
                // その日の要約（あれば）
                if viewModel.ui.daySummaryDay == selected.isoString,
                   let summary = viewModel.ui.daySummary, !summary.isEmpty {
                    CardView {
                        Text("この日の要約").font(.subheadline.bold())
                        Text(summary)
                    }
                }
            }
            .padding(16)
        }
        .onAppear { viewModel.loadDaySummary(selected.isoString) }
        .sheet(item: editingTaskBinding) { task in
            TaskEditView(
                task: task,
                saving: viewModel.ui.taskActionInProgressId == task.id,
                onSave: { type, content, details, deadline in
                    viewModel.updateTask(task, type: type, content: content, details: details, deadline: deadline)
                    editingTaskId = nil
                },
                onDelete: {
                    viewModel.deleteTask(task)
                    editingTaskId = nil
                },
                onDismiss: { editingTaskId = nil }
            )
        }
    }

    private var editingTaskBinding: Binding<AiHelperClient.Task?> {
        Binding(
            get: { editingTaskId.flatMap { id in viewModel.ui.tasks.first { $0.id == id } } },
            set: { if $0 == nil { editingTaskId = nil } }
        )
    }

    private func moveMonth(_ delta: Int) {
        var (y, m) = yearMonth
        m += delta
        if m < 1 { m = 12; y -= 1 }
        if m > 12 { m = 1; y += 1 }
        yearMonth = (y, m)
    }

    private func daysInMonth() -> Int {
        var c = DateComponents()
        c.year = yearMonth.0
        c.month = yearMonth.1
        let date = Calendar.current.date(from: c) ?? Date()
        return Calendar.current.range(of: .day, in: .month, for: date)?.count ?? 30
    }

    /// 週ごとのセル（nil は空セル）。日曜始まり。
    private func weeks() -> [[Int?]] {
        let first = YMD(year: yearMonth.0, month: yearMonth.1, day: 1)
        let lead = first.dayOfWeekValue % 7 // 月=1..日=7 → 日=0 起点
        var cells: [Int?] = Array(repeating: nil, count: lead)
        cells += (1...daysInMonth()).map { Optional($0) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<$0 + 7]) }
    }

    /// 課題・予定 + Google カレンダー予定 + Waseda 授業予定を日付ごとにまとめる。
    private func buildByDate() -> [YMD: [CalItem]] {
        var list: [CalItem] = []
        for t in viewModel.ui.tasks {
            guard let dl = t.deadline, !dl.isEmpty, let d = YMD(string: dl) else { continue }
            let norm = dl.replacingOccurrences(of: "T", with: " ")
            let time = (!t.dateOnly && norm.count >= 16) ? String(norm.dropFirst(11).prefix(5)) : ""
            let label = t.type == "yotei" ? "予定" : "課題"
            list.append(CalItem(date: d, time: time, title: "[\(label)] \(t.content)", task: t))
        }
        for ev in viewModel.ui.calendarEvents where ev.startMillis > 0 {
            let d = YMD(Date(timeIntervalSince1970: Double(ev.startMillis) / 1000))
            let norm = ev.whenText.replacingOccurrences(of: "T", with: " ")
            let start = norm.count >= 16 ? String(norm.dropFirst(11).prefix(5)) : ""
            let endNorm = ev.endText.replacingOccurrences(of: "T", with: " ")
            let end = endNorm.count >= 16 ? String(endNorm.dropFirst(11).prefix(5)) : ""
            let time = (!start.isEmpty && !end.isEmpty) ? "\(start)〜\(end)" : start
            list.append(CalItem(date: d, time: time, title: "[カレンダー] \(ev.title)"))
        }
        for day in 1...daysInMonth() {
            let date = YMD(year: yearMonth.0, month: yearMonth.1, day: day)
            for c in viewModel.ui.courses where courseOccursOn(c, date) {
                let room = c.room.isEmpty ? "" : " (\(c.room))"
                let period = c.period.map { "\($0)限 " } ?? ""
                list.append(CalItem(date: date, time: courseTime(c), title: "[授業] \(period)\(c.name)\(room)"))
            }
        }
        return Dictionary(grouping: list) { $0.date }
    }
}
