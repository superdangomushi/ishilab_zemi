package com.ishilab.transcriber

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.ishilab.transcriber.google.GoogleCalendarClient
import com.ishilab.transcriber.model.WhisperModel
import com.ishilab.transcriber.net.AiHelperClient
import com.ishilab.transcriber.service.AudioCaptureService
import com.ishilab.transcriber.service.ServiceState
import com.ishilab.transcriber.ui.MainViewModel
import com.ishilab.transcriber.ui.TranscriptItem
import com.ishilab.transcriber.ui.UiState
import java.io.File

/** アプリ全体の配色（Web と揃えたインディゴ基調）。 */
private val AppColorScheme = lightColorScheme(
    primary = Color(0xFF4F46E5),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFE0E7FF),
    onPrimaryContainer = Color(0xFF1E1B4B),
    secondary = Color(0xFF0891B2),
    tertiary = Color(0xFF7C3AED),
    background = Color(0xFFF6F7FB),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFEEF2F7),
)

class MainActivity : ComponentActivity() {

    private val viewModel: MainViewModel by viewModels()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNeededPermissions()
        // 録音していないときでも「締切が近い予定・課題」を定期通知する。
        com.ishilab.transcriber.service.ReminderReceiver.schedule(this)
        setContent {
            MaterialTheme(colorScheme = AppColorScheme) {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val ui by viewModel.ui.collectAsState()
                    val service by AudioCaptureService.state.collectAsStateWithLifecycle()
                    val signInClient = remember {
                        GoogleSignIn.getClient(this@MainActivity, GoogleCalendarClient.signInOptions())
                    }
                    val googleLauncher = rememberLauncherForActivityResult(
                        ActivityResultContracts.StartActivityForResult()
                    ) { result -> viewModel.onGoogleSignInResult(result.data) }
                    MainScreen(
                        ui = ui,
                        service = service,
                        onDownload = viewModel::download,
                        onSelectModel = viewModel::selectModel,
                        onSetServerTranscribe = viewModel::setServerTranscribe,
                        onStart = { AudioCaptureService.start(this) },
                        onStop = { AudioCaptureService.stop(this) },
                        onRefresh = viewModel::refresh,
                        onLogin = viewModel::login,
                        onRegister = viewModel::register,
                        onLogout = viewModel::logout,
                        onSend = viewModel::sendToServer,
                        onAsk = viewModel::ask,
                        onLoadTasks = { viewModel.loadTasks() },
                        onToggleTask = viewModel::toggleTaskDone,
                        onSetShowDone = { viewModel.loadTasks(it) },
                        onLoadSummary = viewModel::loadSummary,
                        onGenerateSummary = viewModel::generateSummary,
                        onConnectGoogle = { googleLauncher.launch(signInClient.signInIntent) },
                        onDisconnectGoogle = {
                            signInClient.signOut()
                            viewModel.onGoogleDisconnected()
                        },
                        onLoadCalendar = viewModel::loadCalendar,
                        onAddToCalendar = viewModel::addTaskToCalendar,
                        onLoadMoodle = viewModel::loadMoodle,
                        onSaveMoodleUrl = viewModel::saveMoodleUrl,
                        onSyncMoodle = viewModel::syncMoodle,
                        onLoadWaseda = viewModel::loadWaseda,
                        onSaveWaseda = viewModel::saveWaseda,
                        onSyncWaseda = viewModel::syncWaseda,
                        onLoadDaySummary = viewModel::loadDaySummary,
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refresh()
        viewModel.refreshGoogle()
    }

    private fun requestNeededPermissions() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed += Manifest.permission.POST_NOTIFICATIONS
        }
        val toRequest = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (toRequest.isNotEmpty()) permissionLauncher.launch(toRequest.toTypedArray())
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainScreen(
    ui: UiState,
    service: ServiceState,
    onDownload: (WhisperModel) -> Unit,
    onSelectModel: (WhisperModel) -> Unit,
    onSetServerTranscribe: (Boolean) -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    onLogin: (String, String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onLogout: () -> Unit,
    onSend: (TranscriptItem) -> Unit,
    onAsk: (String) -> Unit,
    onLoadTasks: () -> Unit,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onSetShowDone: (Boolean) -> Unit,
    onLoadSummary: () -> Unit,
    onGenerateSummary: () -> Unit,
    onConnectGoogle: () -> Unit,
    onDisconnectGoogle: () -> Unit,
    onLoadCalendar: () -> Unit,
    onAddToCalendar: (AiHelperClient.Task) -> Unit,
    onLoadMoodle: () -> Unit,
    onSaveMoodleUrl: (String) -> Unit,
    onSyncMoodle: () -> Unit,
    onLoadWaseda: () -> Unit,
    onSaveWaseda: (String, String) -> Unit,
    onSyncWaseda: () -> Unit,
    onLoadDaySummary: (String) -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(0) }
    Box(modifier = Modifier.fillMaxSize()) {
        Scaffold(
            topBar = { TopAppBar(title = { Text("常時録音・ローカル文字起こし") }) }
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
            ) {
                TabRow(selectedTabIndex = tab) {
                    Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("録音") })
                    Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("記録") })
                    Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("予定") })
                    Tab(selected = tab == 3, onClick = { tab = 3 }, text = { Text("秘書") })
                }
                when (tab) {
                    0 -> RecordingTab(ui, service, onDownload, onSelectModel, onSetServerTranscribe, onStart, onStop)
                    1 -> RecordsTab(ui, onRefresh, onSend)
                    2 -> CalendarTab(ui, onLoadDaySummary)
                    else -> SecretaryTab(
                        ui, onLogin, onRegister, onLogout, onAsk, onLoadTasks, onToggleTask, onSetShowDone,
                        onLoadSummary, onGenerateSummary,
                        onConnectGoogle, onDisconnectGoogle, onLoadCalendar, onAddToCalendar,
                        onLoadMoodle, onSaveMoodleUrl, onSyncMoodle, onLoadWaseda, onSaveWaseda, onSyncWaseda
                    )
                }
            }
        }
        // 音声→テキスト変換中は右上に小さく表示（操作は妨げない）。どの区間かと進捗も出す。
        if (service.transcribing) {
            TranscribingBadge(service)
        }
    }
}

/** 文字起こし処理中を右上にちょこんと示す小さなインジケータ（画面操作はブロックしない）。 */
@Composable
private fun BoxScope.TranscribingBadge(service: ServiceState) {
    val pct = (service.transcribeProgress * 100).toInt()
    val label = service.transcribeLabel
    Surface(
        shape = RoundedCornerShape(50),
        tonalElevation = 6.dp,
        shadowElevation = 4.dp,
        modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(top = 10.dp, end = 10.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
            Text(
                if (label != null) "$label 処理中 $pct%" else "処理中 $pct%",
                style = MaterialTheme.typography.labelMedium
            )
        }
    }
}

/** 録音・文字起こし関連（状態 / 操作 / 受信ファイル）をまとめたタブ。 */
@Composable
private fun RecordingTab(
    ui: UiState,
    service: ServiceState,
    onDownload: (WhisperModel) -> Unit,
    onSelectModel: (WhisperModel) -> Unit,
    onSetServerTranscribe: (Boolean) -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
) {
    // タブ内は単一の LazyColumn にして全体をスクロール可能に保つ。
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { StatusCard(service) }

        item { TranscribeModeCard(ui, onSetServerTranscribe) }

        if (!ui.serverTranscribe) {
            item { ModelCard(ui, onDownload, onSelectModel) }
        }

        if (ui.anyModelReady || ui.serverTranscribe) {
            item { ControlRow(service, onStart, onStop) }
        }

        service.error?.let { err ->
            item { Text("エラー: $err", color = MaterialTheme.colorScheme.error) }
        }

        ui.sendMessage?.let { msg ->
            item { Text(msg, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** 文字起こし記録を「日付 → 時刻 → 本文」の階層で辿るタブ。 */
@Composable
private fun RecordsTab(
    ui: UiState,
    onRefresh: () -> Unit,
    onSend: (TranscriptItem) -> Unit,
) {
    val context = LocalContext.current
    var openDate by rememberSaveable { mutableStateOf<String?>(null) }
    var openFile by rememberSaveable { mutableStateOf<String?>(null) }

    // ファイル名 "yyyy-MM-dd_HH.txt" を日付・時でグループ化。
    fun dateOf(name: String) = if (name.length >= 10) name.take(10) else name
    fun hourOf(name: String) = if (name.length >= 13) name.substring(11, 13) else "--"

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // ヘッダー（パンくず＋更新）
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                val crumb = when {
                    openFile != null -> "記録 › $openDate › ${hourOf(openFile!!)}時台"
                    openDate != null -> "記録 › $openDate"
                    else -> "記録（日付一覧）"
                }
                Text(crumb, style = MaterialTheme.typography.titleMedium)
                OutlinedButton(onClick = onRefresh) { Text("更新") }
            }
        }

        if (ui.transcripts.isEmpty()) {
            item { Text("まだ記録がありません。", style = MaterialTheme.typography.bodySmall) }
            return@LazyColumn
        }

        when {
            // ---- 第3階層: 本文表示 ----
            openFile != null -> {
                val item = ui.transcripts.firstOrNull { it.name == openFile }
                item { TextButton(onClick = { openFile = null }) { Text("← ${openDate} の時刻一覧へ") } }
                if (item == null) {
                    item { Text("ファイルが見つかりません。", style = MaterialTheme.typography.bodySmall) }
                } else {
                    item { TranscriptDetail(item, ui, onSend, context) }
                }
            }
            // ---- 第2階層: 選択した日付の時刻一覧 ----
            openDate != null -> {
                item { TextButton(onClick = { openDate = null }) { Text("← 日付一覧へ") } }
                val hours = ui.transcripts
                    .filter { dateOf(it.name) == openDate }
                    .sortedByDescending { it.name }
                items(hours) { item ->
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { openFile = item.name }
                    ) {
                        Row(
                            modifier = Modifier.padding(14.dp).fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text("${hourOf(item.name)}時台", style = MaterialTheme.typography.bodyLarge)
                            Text("${item.sizeBytes} bytes ›", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            // ---- 第1階層: 日付一覧 ----
            else -> {
                val byDate = ui.transcripts.groupBy { dateOf(it.name) }
                    .toSortedMap(compareByDescending { it })
                byDate.forEach { (date, files) ->
                    item {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { openDate = date }
                        ) {
                            Row(
                                modifier = Modifier.padding(14.dp).fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(date, style = MaterialTheme.typography.bodyLarge)
                                Text("${files.size} 件 ›", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** 本文と操作（共有・送信）をまとめた詳細表示。 */
@Composable
private fun TranscriptDetail(
    item: TranscriptItem,
    ui: UiState,
    onSend: (TranscriptItem) -> Unit,
    context: android.content.Context,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(item.name, style = MaterialTheme.typography.titleSmall)
            val content by produceState<String?>(null, item.path, item.sizeBytes) {
                value = withContext(Dispatchers.IO) {
                    runCatching { File(item.path).readText() }.getOrElse { "読み込み失敗: ${it.message}" }
                }
            }
            if (content == null) {
                Text("読み込み中…", style = MaterialTheme.typography.bodySmall)
            } else {
                Text(
                    content!!.ifBlank { "（空です）" },
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 420.dp)
                        .verticalScroll(rememberScrollState())
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { shareFile(context, item.path) }) { Text("共有") }
                val sending = ui.sendingFile == item.name
                val sent = item.name in ui.sentFiles
                Button(
                    onClick = { onSend(item) },
                    enabled = ui.account.loggedIn && ui.sendingFile == null && !sent
                ) {
                    Text(when { sending -> "送信中…"; sent -> "送信済み"; else -> "サーバーへ送信" })
                }
            }
        }
    }
}

private data class CalItem(val date: LocalDate, val time: String, val title: String)

/** 月カレンダー。日付をタップするとその日の予定・時間・（あれば）要約を表示。 */
@Composable
private fun CalendarTab(ui: UiState, onLoadDaySummary: (String) -> Unit) {
    var ymStr by rememberSaveable { mutableStateOf(YearMonth.now().toString()) }
    var selectedStr by rememberSaveable { mutableStateOf(LocalDate.now().toString()) }
    val ym = runCatching { YearMonth.parse(ymStr) }.getOrDefault(YearMonth.now())
    val selected = runCatching { LocalDate.parse(selectedStr) }.getOrDefault(LocalDate.now())

    // 課題・予定 + Google カレンダー予定を日付ごとにまとめる。
    val byDate = remember(ui.tasks, ui.calendarEvents) {
        val list = mutableListOf<CalItem>()
        ui.tasks.forEach { t ->
            val dl = t.deadline
            if (!dl.isNullOrBlank()) {
                val d = runCatching { LocalDate.parse(dl.take(10)) }.getOrNull()
                if (d != null) {
                    val norm = dl.replace('T', ' ')
                    val time = if (!t.dateOnly && norm.length >= 16) norm.substring(11, 16) else ""
                    val label = if (t.type == "yotei") "予定" else "課題"
                    list.add(CalItem(d, time, "[$label] ${t.content}"))
                }
            }
        }
        ui.calendarEvents.forEach { ev ->
            if (ev.startMillis > 0) {
                val d = Instant.ofEpochMilli(ev.startMillis).atZone(ZoneId.systemDefault()).toLocalDate()
                val norm = ev.whenText.replace('T', ' ')
                val time = if (norm.length >= 16) norm.substring(11, 16) else ""
                list.add(CalItem(d, time, "[カレンダー] ${ev.title}"))
            }
        }
        list.groupBy { it.date }
    }

    LaunchedEffect(selectedStr) { onLoadDaySummary(selectedStr) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                TextButton(onClick = { ymStr = ym.minusMonths(1).toString() }) { Text("‹ 前月") }
                Text("${ym.year}年${ym.monthValue}月", style = MaterialTheme.typography.titleMedium)
                TextButton(onClick = { ymStr = ym.plusMonths(1).toString() }) { Text("翌月 ›") }
            }
        }
        item {
            Row(modifier = Modifier.fillMaxWidth()) {
                listOf("日", "月", "火", "水", "木", "金", "土").forEach {
                    Text(
                        it, modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
        // 週ごとの行
        val lead = ym.atDay(1).dayOfWeek.value % 7 // 月=1..日=7 → 日=0 起点
        val cells = buildList<LocalDate?> {
            repeat(lead) { add(null) }
            for (d in 1..ym.lengthOfMonth()) add(ym.atDay(d))
            while (size % 7 != 0) add(null)
        }
        items(cells.chunked(7)) { week ->
            Row(modifier = Modifier.fillMaxWidth()) {
                week.forEach { date ->
                    if (date == null) {
                        Box(modifier = Modifier.weight(1f).height(44.dp))
                    } else {
                        val isSel = date == selected
                        val has = byDate.containsKey(date)
                        Box(
                            modifier = Modifier
                                .weight(1f).height(44.dp).padding(2.dp)
                                .background(
                                    if (isSel) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
                                    RoundedCornerShape(8.dp)
                                )
                                .clickable { selectedStr = date.toString() },
                            contentAlignment = Alignment.Center
                        ) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("${date.dayOfMonth}", style = MaterialTheme.typography.bodyMedium)
                                if (has) {
                                    Box(
                                        modifier = Modifier.size(5.dp).background(
                                            MaterialTheme.colorScheme.primary, RoundedCornerShape(50)
                                        )
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        // 選択日の詳細
        item {
            Text(
                "${selected.monthValue}月${selected.dayOfMonth}日 の予定",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(top = 4.dp)
            )
        }
        val dayItems = (byDate[selected] ?: emptyList()).sortedBy { it.time.ifBlank { "99:99" } }
        if (dayItems.isEmpty()) {
            item { Text("予定はありません。", style = MaterialTheme.typography.bodySmall) }
        } else {
            items(dayItems) { it2 ->
                Card(modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(it2.time.ifBlank { "終日" }, style = MaterialTheme.typography.labelLarge)
                        Text(it2.title, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        // その日の要約（あれば）
        if (ui.daySummaryDay == selectedStr && !ui.daySummary.isNullOrBlank()) {
            item {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("この日の要約", style = MaterialTheme.typography.titleSmall)
                        Text(ui.daySummary!!, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

/** AIHelper 連携（ログイン）・予定/課題の確認・秘書チャットをまとめたタブ。 */
@Composable
private fun SecretaryTab(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onLogout: () -> Unit,
    onAsk: (String) -> Unit,
    onLoadTasks: () -> Unit,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onSetShowDone: (Boolean) -> Unit,
    onLoadSummary: () -> Unit,
    onGenerateSummary: () -> Unit,
    onConnectGoogle: () -> Unit,
    onDisconnectGoogle: () -> Unit,
    onLoadCalendar: () -> Unit,
    onAddToCalendar: (AiHelperClient.Task) -> Unit,
    onLoadMoodle: () -> Unit,
    onSaveMoodleUrl: (String) -> Unit,
    onSyncMoodle: () -> Unit,
    onLoadWaseda: () -> Unit,
    onSaveWaseda: (String, String) -> Unit,
    onSyncWaseda: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item { AiHelperCard(ui, onLogin, onRegister, onLogout) }

        // Google 連携は端末側サインインなので AIHelper ログイン前でも表示する。
        item { GoogleCalendarCard(ui, onConnectGoogle, onDisconnectGoogle, onLoadCalendar) }

        if (!ui.account.loggedIn) {
            item {
                Text(
                    "AIHelper にログインすると、Moodle 連携や予定・課題の確認、秘書チャットが使えます。",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            return@LazyColumn
        }

        // ---- 連携（アカウントに紐付く） ----
        item { MoodleCard(ui, onLoadMoodle, onSaveMoodleUrl, onSyncMoodle) }
        item { WasedaCard(ui, onLoadWaseda, onSaveWaseda, onSyncWaseda) }

        // ---- 今日の要約 ----
        item { SummaryCard(ui, onLoadSummary, onGenerateSummary) }

        // ---- 予定・課題 ----
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("予定・課題", style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { onSetShowDone(!ui.showDoneTasks) }) {
                        Text(if (ui.showDoneTasks) "未完了のみ" else "完了も表示")
                    }
                    OutlinedButton(onClick = onLoadTasks) { Text("更新") }
                }
            }
        }

        ui.tasksError?.let { err ->
            item { Text("取得エラー: $err", color = MaterialTheme.colorScheme.error) }
        }

        when {
            ui.tasksLoading && ui.tasks.isEmpty() -> item {
                Text("読み込み中…", style = MaterialTheme.typography.bodySmall)
            }
            ui.tasks.isEmpty() -> item {
                Text("表示できる予定・課題はありません。", style = MaterialTheme.typography.bodySmall)
            }
            else -> items(ui.tasks) { task ->
                TaskCard(task, onToggleTask, if (ui.googleConnected) onAddToCalendar else null)
            }
        }

        ui.googleMessage?.let { msg ->
            item { Text(msg, style = MaterialTheme.typography.bodySmall) }
        }

        // ---- 秘書チャット ----
        item { SecretaryCard(ui, onAsk) }
    }
}

/** Google カレンダー連携カード。未連携なら接続ボタン、連携済みなら直近の予定を表示。 */
@Composable
private fun GoogleCalendarCard(
    ui: UiState,
    onConnectGoogle: () -> Unit,
    onDisconnectGoogle: () -> Unit,
    onLoadCalendar: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Google カレンダー", style = MaterialTheme.typography.titleMedium)
                if (ui.googleConnected) {
                    OutlinedButton(onClick = onLoadCalendar, enabled = !ui.googleBusy) { Text("更新") }
                }
            }
            if (!ui.googleConnected) {
                Text(
                    "連携すると、課題・予定の締切をカレンダーに登録したり、直近の予定を表示できます。",
                    style = MaterialTheme.typography.bodySmall
                )
                Button(onClick = onConnectGoogle) { Text("Google と連携") }
                // サインイン失敗の理由（OAuth 設定不備・キャンセル等）をここに表示する。
                ui.googleMessage?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            } else {
                Text("連携中: ${ui.googleEmail}", style = MaterialTheme.typography.bodySmall)
                if (ui.calendarEvents.isEmpty()) {
                    Text(
                        if (ui.googleBusy) "読み込み中…" else "直近の予定はありません。",
                        style = MaterialTheme.typography.bodySmall
                    )
                } else {
                    ui.calendarEvents.take(8).forEach { ev ->
                        Text("・${ev.whenText}  ${ev.title}", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                TextButton(onClick = onDisconnectGoogle) { Text("連携を解除") }
            }
        }
    }
}

/** Moodle（iCal）連携カード。URL を保存し、提出物・予定を取り込む。 */
@Composable
private fun MoodleCard(
    ui: UiState,
    onLoadMoodle: () -> Unit,
    onSaveMoodleUrl: (String) -> Unit,
    onSyncMoodle: () -> Unit,
) {
    LaunchedEffect(ui.account.email) { onLoadMoodle() }
    var url by rememberSaveable(ui.moodleUrl) { mutableStateOf(ui.moodleUrl) }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Moodle 連携", style = MaterialTheme.typography.titleMedium)
            Text(
                "Moodle のカレンダー → 書き出し →「カレンダーのURLを取得」で得た iCal URL を貼り付けてください。提出物・予定が課題一覧に取り込まれます。",
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Moodle iCal URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onSaveMoodleUrl(url) }, enabled = !ui.moodleBusy) { Text("保存") }
                OutlinedButton(onClick = onSyncMoodle, enabled = !ui.moodleBusy && url.isNotBlank()) {
                    Text("課題・予定を取り込む")
                }
            }
            if (ui.moodleBusy) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            ui.moodleMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Waseda アカウント連携カード。各ユーザーが自分の Waseda ID・パスワードを保存する。 */
@Composable
private fun WasedaCard(
    ui: UiState,
    onLoadWaseda: () -> Unit,
    onSaveWaseda: (String, String) -> Unit,
    onSyncWaseda: () -> Unit,
) {
    LaunchedEffect(ui.account.email) { onLoadWaseda() }
    var user by rememberSaveable(ui.wasedaUser) { mutableStateOf(ui.wasedaUser) }
    var password by rememberSaveable { mutableStateOf("") }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Waseda アカウント連携", style = MaterialTheme.typography.titleMedium)
            Text(
                "MyWaseda のログイン情報を保存すると、科目登録（時間割）を自動取得できます。" +
                    "パスワードは暗号化して保存され、時間割取得にのみ使われます。",
                style = MaterialTheme.typography.bodySmall
            )
            OutlinedTextField(
                value = user,
                onValueChange = { user = it },
                label = { Text("Waseda ID（例: xxxx@akane.waseda.jp）") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text(if (ui.wasedaHasPassword) "パスワード（変更時のみ入力）" else "パスワード") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth()
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(
                    onClick = { onSaveWaseda(user, password); password = "" },
                    enabled = !ui.wasedaBusy && user.isNotBlank() &&
                        (password.isNotEmpty() || ui.wasedaHasPassword)
                ) { Text("保存") }
                OutlinedButton(
                    onClick = onSyncWaseda,
                    enabled = ui.wasedaHasPassword && !ui.wasedaSyncRunning
                ) { Text("時間割を取り込む") }
                if (ui.wasedaHasPassword) {
                    Text("パスワード保存済み", style = MaterialTheme.typography.bodySmall)
                }
            }
            ui.wasedaMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            // 取り込み実行中のステータスバー（サーバー側スクレイパの進行状況を表示）。
            if (ui.wasedaSyncRunning) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            ui.wasedaSyncMessage?.let {
                Text(
                    if (ui.wasedaSyncRunning) "取り込み中: $it" else it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (ui.wasedaSyncRunning) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** 今日の要約カード。サーバーの日次要約を表示し、更新/生成し直しができる。 */
@Composable
private fun SummaryCard(
    ui: UiState,
    onLoadSummary: () -> Unit,
    onGenerateSummary: () -> Unit,
) {
    // ログイン直後に一度取得する（ログインで既に取得済みでも安全）。
    LaunchedEffect(ui.account.email) { onLoadSummary() }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("今日の要約", style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onGenerateSummary, enabled = !ui.summaryLoading) {
                        Text("生成")
                    }
                    OutlinedButton(onClick = onLoadSummary, enabled = !ui.summaryLoading) {
                        Text("更新")
                    }
                }
            }
            ui.summaryError?.let {
                Text("エラー: $it", color = MaterialTheme.colorScheme.error)
            }
            when {
                ui.summaryLoading && ui.summary.isNullOrBlank() ->
                    Text("読み込み中…", style = MaterialTheme.typography.bodySmall)
                ui.summary.isNullOrBlank() ->
                    Text(
                        "まだ今日の要約はありません。録音がたまるか「生成」で作成できます。",
                        style = MaterialTheme.typography.bodySmall
                    )
                else -> Text(ui.summary, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** 予定・課題1件のカード。チェックで完了/未完了を切替。onAddToCalendar があれば登録ボタンを出す。 */
@Composable
private fun TaskCard(
    task: AiHelperClient.Task,
    onToggleTask: (AiHelperClient.Task) -> Unit,
    onAddToCalendar: ((AiHelperClient.Task) -> Unit)? = null,
) {
    val isYotei = task.type == "yotei"
    val label = if (isYotei) "予定" else "課題"
    val labelColor = if (isYotei) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
            verticalAlignment = Alignment.Top
        ) {
            Checkbox(checked = task.done, onCheckedChange = { onToggleTask(task) })
            Column(modifier = Modifier.padding(start = 4.dp)) {
                Text("[$label]", color = labelColor, style = MaterialTheme.typography.labelMedium)
                Text(
                    task.content,
                    style = MaterialTheme.typography.bodyLarge,
                    textDecoration = if (task.done) TextDecoration.LineThrough else null
                )
                Text("期限: ${formatDeadline(task.deadline, task.dateOnly)}", style = MaterialTheme.typography.bodySmall)
                if (task.details.isNotBlank()) {
                    Text(
                        task.details,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (onAddToCalendar != null && !task.deadline.isNullOrBlank()) {
                    TextButton(
                        onClick = { onAddToCalendar(task) },
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)
                    ) { Text("カレンダーに追加") }
                }
            }
        }
    }
}

/** サーバーの deadline 文字列を "YYYY-MM-DD HH:MM"（日付のみなら日付）へ整形。 */
private fun formatDeadline(deadline: String?, dateOnly: Boolean): String {
    if (deadline.isNullOrBlank()) return "未定"
    val s = deadline.replace('T', ' ')
    return if (dateOnly) s.take(10) else s.take(16)
}

@Composable
private fun StatusCard(service: ServiceState) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            val status = when {
                service.draining -> "送信待ち（未送信を送信中）"
                service.transcribing -> "音声を文字起こし中"
                !service.active -> "停止中"
                service.paused -> "一時停止中（マイク解放中）"
                else -> "録音中"
            }
            Text("状態: $status", style = MaterialTheme.typography.titleMedium)
            if (service.active && !service.transcribing) {
                val elapsedMs = rememberRecordingElapsed(service)
                Text("録音時間: ${formatDuration(elapsedMs)}")
                Text(
                    "※ 文字起こしは1時間ごと、または終了時にまとめて実行します。",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            // 現在どの区間を処理しているかと進捗。
            if (service.transcribing) {
                val pct = (service.transcribeProgress * 100).toInt()
                Text("処理中の音声: ${service.transcribeLabel ?: "-"}")
                LinearProgressIndicator(
                    progress = { service.transcribeProgress },
                    modifier = Modifier.fillMaxWidth()
                )
                Text("$pct%", style = MaterialTheme.typography.bodySmall)
            }
            service.modelName?.let { Text("モデル: $it") }
            Text("処理済: ${service.chunksDone} 区間  待機: ${service.queueSize} 区間")
            service.currentFile?.let { Text("最新の出力: $it") }
            if (service.lastText.isNotBlank()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "直近: ${service.lastText}",
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

/**
 * 録音の合計継続時間(ms)を返し、録音中は毎秒再計算してカウントアップさせる。
 * 一時停止中は積算値で止まる。
 */
@Composable
private fun rememberRecordingElapsed(service: ServiceState): Long {
    var now by remember { mutableStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(service.active, service.recordingStartedElapsed) {
        while (service.active) {
            now = SystemClock.elapsedRealtime()
            delay(1000)
        }
    }
    val running = if (service.recordingStartedElapsed > 0L) {
        (now - service.recordingStartedElapsed).coerceAtLeast(0L)
    } else 0L
    return service.accumulatedRecordMs + running
}

private fun formatDuration(ms: Long): String {
    val totalSec = ms / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

@Composable
private fun ControlRow(service: ServiceState, onStart: () -> Unit, onStop: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = onStart, enabled = !service.active) { Text("録音開始") }
        OutlinedButton(onClick = onStop, enabled = service.active) { Text("終了") }
    }
    Text(
        "※ 一時停止/再開は通知バーのボタンから行えます。",
        style = MaterialTheme.typography.bodySmall
    )
}

/**
 * 文字起こし方法の選択カード。
 * 端末処理(Whisper)は遅い端末だと時間がかかるため、音声をサーバーへアップロードして
 * サーバー側で文字起こしするモードを選べる（AIHelper ログインが必要）。
 */
@Composable
private fun TranscribeModeCard(ui: UiState, onSetServerTranscribe: (Boolean) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("文字起こしの方法", style = MaterialTheme.typography.titleMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = !ui.serverTranscribe, onClick = { onSetServerTranscribe(false) })
                Column {
                    Text("端末で処理（オフライン）", style = MaterialTheme.typography.bodyMedium)
                    Text("Whisper モデルで端末内処理。通信不要だが時間がかかる。",
                        style = MaterialTheme.typography.bodySmall)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                RadioButton(
                    selected = ui.serverTranscribe,
                    onClick = { onSetServerTranscribe(true) },
                    enabled = ui.account.loggedIn
                )
                Column {
                    Text("サーバーで処理（音声をアップロード）", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        if (ui.account.loggedIn)
                            "録音区間の音声をサーバーへ送り、サーバー側で文字起こし。処理状況はダッシュボードで確認できます。"
                        else "利用するには先に「秘書」タブで AIHelper にログインしてください。",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
            Text(
                "※ 切り替えは次回の録音開始から反映されます。",
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

/**
 * 文字起こしモデルのカード。ダウンロード済みモデルはラジオで選び直せ、
 * 未ダウンロードのモデルはこの場でダウンロードできる。
 */
@Composable
private fun ModelCard(
    ui: UiState,
    onDownload: (WhisperModel) -> Unit,
    onSelectModel: (WhisperModel) -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("文字起こしモデル", style = MaterialTheme.typography.titleMedium)
            if (!ui.anyModelReady) {
                Text(
                    "初回はモデルのダウンロードが必要です。DL後はオフラインで動作。日本語は base 以上を推奨。",
                    style = MaterialTheme.typography.bodySmall
                )
            }

            WhisperModel.entries.forEach { model ->
                val downloaded = model in ui.downloadedModels
                val selected = ui.selectedModel == model
                val isDownloading = ui.downloading == model
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(model.displayName, style = MaterialTheme.typography.bodyLarge)
                        Text("約${model.approxMb}MB", style = MaterialTheme.typography.bodySmall)
                    }
                    when {
                        isDownloading -> CircularProgressIndicator(
                            modifier = Modifier.height(20.dp),
                            strokeWidth = 2.dp
                        )
                        downloaded -> Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(
                                selected = selected,
                                onClick = { onSelectModel(model) }
                            )
                            Text(
                                if (selected) "使用中" else "使用",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        else -> Button(
                            onClick = { onDownload(model) },
                            enabled = ui.downloading == null
                        ) { Text("ダウンロード") }
                    }
                }
                if (isDownloading) {
                    if (ui.downloadProgress >= 0f) {
                        LinearProgressIndicator(
                            progress = { ui.downloadProgress },
                            modifier = Modifier.fillMaxWidth()
                        )
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            }

            ui.downloadError?.let {
                Text("ダウンロード失敗: $it", color = MaterialTheme.colorScheme.error)
            }
            Text(
                "※ 録音中に変更した場合は次回の録音開始から反映されます。",
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

/** AIHelper.jp のログイン / アカウント表示。 */
@Composable
private fun AiHelperCard(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
    onLogout: () -> Unit,
) {
    val account = ui.account
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("AIHelper.jp 連携", style = MaterialTheme.typography.titleMedium)
            if (account.loggedIn) {
                Text("ログイン中: ${account.email}")
                Text(account.baseUrl, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = onLogout) { Text("ログアウト") }
            } else {
                AiHelperLoginForm(ui, onLogin, onRegister)
            }
        }
    }
}

@Composable
private fun AiHelperLoginForm(
    ui: UiState,
    onLogin: (String, String, String) -> Unit,
    onRegister: (String, String, String) -> Unit,
) {
    var baseUrl by rememberSaveable { mutableStateOf(ui.account.baseUrl) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }

    OutlinedTextField(
        value = baseUrl,
        onValueChange = { baseUrl = it },
        label = { Text("サーバーURL") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("メールアドレス") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedTextField(
        value = password,
        onValueChange = { password = it },
        label = { Text("パスワード") },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        modifier = Modifier.fillMaxWidth()
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        Button(
            onClick = { onLogin(baseUrl, email, password) },
            enabled = !ui.loginInProgress,
            modifier = Modifier.weight(1f)
        ) {
            if (ui.loginInProgress) {
                CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
            } else {
                Text("ログイン")
            }
        }
        OutlinedButton(
            onClick = { onRegister(baseUrl, email, password) },
            enabled = !ui.loginInProgress,
            modifier = Modifier.weight(1f)
        ) { Text("新規登録") }
    }
    ui.loginError?.let {
        Text("認証失敗: $it", color = MaterialTheme.colorScheme.error)
    }
}

/** 秘書チャット: 「今日の予定は？」と聞けば回答、「予定入れといて」で登録まで実行。 */
@Composable
private fun SecretaryCard(ui: UiState, onAsk: (String) -> Unit) {
    var question by rememberSaveable { mutableStateOf("") }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("秘書に聞く / 頼む", style = MaterialTheme.typography.titleMedium)
            if (ui.chatLog.isEmpty()) {
                Text(
                    "例) 今日の予定は？ / 来週月曜10時にゼミ入れといて / 数学の宿題が出てるらしい",
                    style = MaterialTheme.typography.bodySmall
                )
            }
            ui.chatLog.takeLast(8).forEach { msg ->
                val prefix = if (msg.fromUser) "あなた: " else "秘書: "
                Text(
                    "$prefix${msg.text}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (msg.fromUser) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface
                )
            }
            OutlinedTextField(
                value = question,
                onValueChange = { question = it },
                label = { Text("メッセージ") },
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { onAsk(question); question = "" },
                enabled = !ui.askInProgress && question.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) {
                if (ui.askInProgress) {
                    CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                } else {
                    Text("送信")
                }
            }
        }
    }
}

private fun shareFile(context: android.content.Context, path: String) {
    val file = File(path)
    val uri = FileProvider.getUriForFile(
        context, "${context.packageName}.fileprovider", file
    )
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "共有").apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    })
}
