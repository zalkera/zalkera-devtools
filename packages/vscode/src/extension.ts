import * as vscode from "vscode";
import {
    DevtoolsError,
    diagnose,
    diagnoseClientUsage,
    ensureAgentDocs,
    fetchHandshake,
    fetchSiteSource,
    findProjectRoot,
    getAccessToken,
    login,
    logout,
    precheck,
    protectedPathWarning,
    publish,
    registerMcpServer,
    runDoctor,
    startFromPreset,
    startPreview,
    stripCredentials,
    ZalkeraApi,
    type DevServer,
    type FetchSourceResult,
    type Handshake,
    type PreviewSession,
    type PublishResult,
    type StartFromPresetResult,
} from "@zalkera/devtools-core";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SecretTokenStore } from "./secretStore.ts";
import { embeddedNodeRuntime } from "./runtime.ts";
import { ZalkeraSidebar } from "./sidebar.ts";

/**
 * 잘커라 확장(T3 MVP · memo146 §5).
 *
 * **확장이 하는 일은 넷뿐이다**: 런타임 배달 · 자격증명 배달 · MCP 등록 대행(T4) · 프로세스 관리.
 * 로직은 전부 `@zalkera/devtools-core` 에 있고 이 파일은 **얇은 껍데기**다 — 두꺼워지면 CLI·데스크톱이
 * 같은 것을 재사용하지 못한다(§W-5).
 *
 * 표면도 넷뿐이다: 상태바 1칸 · 출력 채널 1 · 명령 팔레트 · (T5) 사이드바.
 */

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let session: { server: DevServer; projectDir: string; keyId: number } | null = null;
/** 프리뷰 시작 재진입 가드 — 첫 실행은 수 분짜리 설치라 사용자가 반드시 두 번 누른다(심의 경고). */
let previewStarting = false;
let store: SecretTokenStore;
let handshake: Handshake | null = null;
let sidebar: ZalkeraSidebar;
/** 동봉 자원(npm)을 찾으려면 확장 설치 경로가 필요하다. */
let extensionPath: string;
let renewTimer: NodeJS.Timeout | null = null;
let diagnostics: vscode.DiagnosticCollection;
/** 보호 경로 경고를 파일마다 한 번만 — 저장할 때마다 같은 말을 반복하면 사람은 그것을 끄고 만다. */
const warnedPaths = new Set<string>();

const EXTENSION_VERSION = "0.1.0";

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("잘커라");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = "zalkera.preview.start";
    setStatus("$(zap) 잘커라");
    status.show();
    store = new SecretTokenStore(context);
    extensionPath = context.extensionPath;
    sidebar = new ZalkeraSidebar();
    void refreshSidebar();

    diagnostics = vscode.languages.createDiagnosticCollection("zalkera");

    context.subscriptions.push(
        output,
        status,
        diagnostics,
        // F2 — 저장할 때와 열 때 본다. 타이핑마다 돌리지 않는다(계약 위반은 저장 시점에 확인해도 늦지 않다).
        vscode.workspace.onDidSaveTextDocument((doc) => refreshDiagnostics(doc)),
        vscode.workspace.onDidOpenTextDocument((doc) => refreshDiagnostics(doc)),
        // F1 — 되돌리기 어려운 자리를 **막지 않고 알린다**(고객 소스는 고객 것이다).
        vscode.workspace.onDidOpenTextDocument((doc) => warnProtectedPath(doc)),
        vscode.window.registerTreeDataProvider("zalkera.sidebar", sidebar),
        register("zalkera.signIn", signIn),
        register("zalkera.signOut", signOut),
        register("zalkera.site.create", startFromExample),
        register("zalkera.site.open", openSite),
        register("zalkera.site.link", linkFolder),
        register("zalkera.preview.start", startPreviewCommand),
        register("zalkera.preview.stop", stopPreview),
        register("zalkera.preview.restart", async () => {
            await stopPreview();
            await startPreviewCommand();
        }),
        register("zalkera.publish", publishCommand),
        register("zalkera.rollback", rollback),
        register("zalkera.history", showHistory),
        register("zalkera.precheck", precheckCommand),
        register("zalkera.agent.connect", connectAgent),
        register("zalkera.doctor", doctor),
    );
}

export async function deactivate(): Promise<void> {
    clearRenewal();
    // 프리뷰를 켜 둔 채 창을 닫으면 dev 서버가 고아로 남는다 — 사용자는 그것을 볼 수도 끌 수도 없다.
    await session?.server.stop();
}

/** 모든 명령을 한 자리에서 감싼다 — 오류를 **사람 말로** 보여 주는 곳이 여기 하나여야 한다. */
function register(command: string, handler: () => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(command, async () => {
        try {
            await handler();
        } catch (error) {
            const message = error instanceof DevtoolsError ? error.humanMessage : String(error);
            log(`오류: ${message}`);
            const choice = await vscode.window.showErrorMessage(message, "자세히 보기");
            if (choice === "자세히 보기") output.show();
        }
    });
}

// ── 인증 ────────────────────────────────────────────────────────────────

async function signIn(): Promise<void> {
    const config = await ensureHandshake();
    // **취소할 수 있어야 한다.** 이 대기는 사람의 브라우저 행동에 달려 있어, 그만두면 아무것도 오지
    // 않는다. 취소 경로가 없으면 알림이 기본 5분(코어 타임아웃)을 그대로 매달린다 — 실사용 신고.
    const cancelled = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "잘커라 로그인 — 브라우저에서 계속하세요",
            cancellable: true,
        },
        async (_progress, token) => {
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() => controller.abort());
            try {
                await login(config.auth, store, {
                    // 브라우저를 여는 방법만 확장이 안다 — 나머지 흐름은 코어가 갖는다.
                    openBrowser: async (url) => {
                        await vscode.env.openExternal(vscode.Uri.parse(url));
                    },
                    signal: controller.signal,
                });
                return false;
            } catch (error) {
                // 사람이 스스로 그만둔 것은 실패가 아니다 — 오류 창을 띄우지 않고 조용히 되돌린다.
                if (error instanceof DevtoolsError && error.code === "CANCELLED") return true;
                throw error;
            } finally {
                subscription.dispose();
            }
        },
    );
    if (cancelled) {
        // **토스트로 끝을 알린다.** 조용히 사라지면 "취소가 먹은 건가"를 남긴다 — 그 불확실이
        // 사용자를 다시 누르게 만든다. 오류 창(showErrorMessage)이 아닌 것은 실패가 아니어서다.
        log("로그인을 취소했습니다.");
        void vscode.window.showInformationMessage("로그인을 취소했습니다.");
        return;
    }
    log("로그인했습니다.");
    await refreshSidebar();
    void vscode.window.showInformationMessage("잘커라에 로그인했습니다.");
}

async function signOut(): Promise<void> {
    // ⚠ **로그아웃이 반쪽이었다**(심의 경고): 도는 프리뷰를 안 끄고 서버 키도 안 지웠다. 이미 뜬 dev 서버는
    // 부팅 때 읽은 키로 **최대 12시간 상용 데이터를 계속 읽는다** — "로그아웃했다"는 화면과 실제가 어긋난다.
    // 순서가 중요하다: 서버를 먼저 멈추고(그 키를 쓰는 프로세스를 없앤 뒤) 키를 지운다.
    const running = session;
    await stopPreview();
    if (running) {
        await revokeKeyQuietly(running.keyId);
    }

    await logout(store);
    // 로컬 자격증명도 함께 지운다(A4) — **키 줄만** 지우고 고객이 넣은 값은 남긴다.
    const dir = workspaceDir();
    if (dir) {
        const envPath = join(dir, ".env.local");
        if (existsSync(envPath)) {
            await writeFile(envPath, stripCredentials(await readFile(envPath, "utf8")), "utf8");
            log(".env.local 의 프리뷰 키를 지웠습니다(다른 설정은 그대로).");
        }
    }
    await refreshSidebar();
    void vscode.window.showInformationMessage("로그아웃했습니다.");
}

/**
 * 키 폐기는 **실패해도 로그아웃을 막지 않는다** — 사용자가 원한 것은 로그아웃이고, 서버가 잠깐 안 되는 것이
 * 그것을 되돌릴 이유가 되지 않는다. 대신 남은 키가 있다는 사실은 로그로 남긴다.
 */
async function revokeKeyQuietly(keyId: number): Promise<void> {
    try {
        const config = await ensureHandshake();
        const api = new ZalkeraApi({
            apiBase: apiBase(),
            accessToken: () => getAccessToken(config.auth, store),
            tenantCode: () => tenantCode(),
        });
        await api.revokeStorefrontKey(keyId);
        log("프리뷰 자격증명을 서버에서 폐기했습니다.");
    } catch (error) {
        log(`프리뷰 자격증명 폐기 실패(만료까지 유효할 수 있습니다): ${error instanceof Error ? error.message : error}`);
    }
}

// ── 사이트 가져오기 ──────────────────────────────────────────────────────

/** B2 — **MVP 절단선의 핵심**. 이미 있는 사이트를 로컬로 받아야 체크리스트 ③ 이 선다. */
async function openSite(): Promise<void> {
    const api = await ensureApi();
    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "여기에 받기",
        title: "내 사이트 소스를 받을 빈 폴더를 고르세요",
    });
    const target = picked?.[0]?.fsPath;
    if (!target) return;

    const result = await vscode.window.withProgress<FetchSourceResult>(
        { location: vscode.ProgressLocation.Notification, title: "사이트 소스를 받는 중" },
        () => fetchSiteSource({ api, targetDir: target, onProgress: log }),
    );

    const root = await findProjectRoot(target);
    log(`버전 ${result.revisionNo} · 파일 ${result.fileCount}개를 받았습니다.`);
    const open = await vscode.window.showInformationMessage(
        `사이트 소스를 받았습니다(버전 ${result.revisionNo}).`,
        "이 폴더 열기",
    );
    if (open === "이 폴더 열기") {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: false });
    }
}

/**
 * B1「예제로 시작」 — 시작 소스 팩을 골라 빈 폴더에 푼다.
 *
 * 목록에 **공개된 팩만** 온다(서버 판정). 고를 수 없는 것을 보여 주지 않는 편이 정직하다.
 */
async function startFromExample(): Promise<void> {
    const api = await ensureApi();
    const presets = await api.listPresets();
    if (presets.length === 0) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "지금 고를 수 있는 시작 소스가 없습니다.",
            "잘커라 콘솔에서 시작 소스를 확인해 주세요.",
        );
    }

    const choice = await vscode.window.showQuickPick(
        presets.map((p) => ({ label: p.name, description: `${p.code} · ${p.version}`, detail: p.description })),
        { title: "어떤 시작 소스로 시작할까요?" },
    );
    const preset = presets.find((p) => `${p.code} · ${p.version}` === choice?.description);
    if (!preset) return;

    const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "여기에 받기",
        title: "시작 소스를 풀 빈 폴더를 고르세요",
    });
    const target = picked?.[0]?.fsPath;
    if (!target) return;

    const result = await vscode.window.withProgress<StartFromPresetResult>(
        { location: vscode.ProgressLocation.Notification, title: `${preset.name} 를 받는 중` },
        () => startFromPreset({ api, presetCode: preset.code, targetDir: target, onProgress: log }),
    );
    log(`시작 소스 ${result.presetCode}@${result.version} · 파일 ${result.fileCount}개.`);

    const open = await vscode.window.showInformationMessage(
        `${preset.name} 를 받았습니다(${result.fileCount}개 파일).`,
        "이 폴더 열기",
    );
    if (open === "이 폴더 열기") {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), { forceNewWindow: false });
    }
}

/**
 * D4「이전 버전으로」 — 버전 이력에서 골라 되돌린다. 백엔드 신작이 없다(activate 가 이미 있다).
 *
 * **확인을 modal 로 받는다** — 되돌리기는 사이트가 바로 바뀌는 동작이고, 잘못 누르면 손님이 다른 화면을 본다.
 */
async function rollback(): Promise<void> {
    const api = await ensureApi();
    const revisions = await api.listRevisions();
    const candidates = revisions.filter((r) => !r.isActive);
    if (candidates.length === 0) {
        void vscode.window.showInformationMessage("되돌릴 이전 버전이 없습니다.");
        return;
    }

    const choice = await vscode.window.showQuickPick(
        candidates.map((r) => ({
            label: `버전 ${r.revisionNo}`,
            description: new Date(r.createdAt).toLocaleString("ko-KR"),
            detail: r.status,
        })),
        { title: "어느 버전으로 되돌릴까요?" },
    );
    const target = candidates.find((r) => `버전 ${r.revisionNo}` === choice?.label);
    if (!target) return;

    const confirm = await vscode.window.showWarningMessage(
        `버전 ${target.revisionNo} 로 되돌립니다. 지금 배포 중인 화면이 바뀝니다.`,
        { modal: true },
        "되돌리기",
    );
    if (confirm !== "되돌리기") return;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `버전 ${target.revisionNo} 로 되돌리는 중` },
        () => api.activateRevision(target.revisionNo),
    );
    log(`버전 ${target.revisionNo} 로 되돌렸습니다.`);
    void vscode.window.showInformationMessage(`버전 ${target.revisionNo} 로 되돌렸습니다.`);
}

/**
 * D1「배포 전 검사」 — **조언이지 차단이 아니다.** 결과가 무엇이든 발행을 막지 않는다. 서버가 받아 줄 것을
 * 확장이 먼저 막으면 소스 재업로드 경로를 우리 손으로 좁히는 것이 된다(memo138 §3.3).
 */
async function precheckCommand(): Promise<void> {
    const dir = requireWorkspace();
    const config = handshake ?? (await ensureHandshake());
    const findings = await precheck({ projectDir: dir, minClientVersion: config.minClientVersion });

    output.show();
    log("── 배포 전 검사(조언) ──");
    for (const finding of findings) {
        log(`${finding.level === "warn" ? "⚠" : "·"} ${finding.message}`);
        if (finding.hint) log(`   → ${finding.hint}`);
    }
    const warnings = findings.filter((f) => f.level === "warn").length;
    log(warnings === 0 ? "· 걸리는 것이 없습니다." : `⚠ 짚을 것 ${warnings}건 — 그래도 발행은 할 수 있습니다.`);
}

/** B3 — 이미 가진 폴더를 이 테넌트에 붙인다. 지금은 테넌트 코드를 설정에 적는 것이 전부다. */
async function linkFolder(): Promise<void> {
    const api = await ensureApi();
    const tenants = await api.listMyTenants();
    const choice = await vscode.window.showQuickPick(
        tenants.map((t) => ({ label: t.name, description: t.code })),
        { title: "이 폴더를 어느 사이트로 연결할까요?" },
    );
    if (!choice?.description) return;
    await vscode.workspace.getConfiguration("zalkera").update("tenant", choice.description, false);
    log(`이 작업 공간을 ${choice.label}(${choice.description}) 에 연결했습니다.`);
}

// ── 프리뷰 ──────────────────────────────────────────────────────────────

async function startPreviewCommand(): Promise<void> {
    if (session) {
        await vscode.env.openExternal(vscode.Uri.parse(session.server.url));
        return;
    }
    // 두 번 누르면 키가 2회 발급돼 **두 번째가 첫 번째를 폐기**하고, dev 서버 2개가 뜨고, 첫 서버는 UI 에서
    // 끌 수 없는 고아가 된다(심의 경고). 첫 실행이 수 분짜리 설치라 실제로 자주 밟힌다.
    if (previewStarting) {
        void vscode.window.showInformationMessage("프리뷰를 준비하는 중입니다. 잠시만 기다려 주세요.");
        return;
    }
    previewStarting = true;
    const dir = requireWorkspace();
    const api = await ensureApi();
    const config = await ensureHandshake();
    const runtime = embeddedNodeRuntime(extensionPath);

    setStatus("$(sync~spin) 프리뷰 준비 중");
    const started = await withStartGuard(() => vscode.window.withProgress<PreviewSession>(
        { location: vscode.ProgressLocation.Notification, title: "프리뷰를 준비하는 중" },
        () =>
            startPreview({
                projectDir: dir,
                api,
                apiBase: apiBase(),
                tenantCode: tenantCode(),
                nodePath: runtime.nodePath,
                extraEnv: runtime.env,
                // 동봉한 npm 을 넘긴다 — 없으면 코어가 PATH 의 npm 으로 떨어진다(개발자 기계 전용 경로).
                ...(runtime.npmCommand ? { npmCommand: runtime.npmCommand, npmEnv: runtime.env } : {}),
                label: `${vscode.env.appName} · ${process.platform}`,
                onProgress: log,
                onLog: log,
            }),
    ));

    previewStarting = false;
    session = { server: started.server, projectDir: dir, keyId: started.keyId };
    sidebar.update({ previewUrl: started.server.url, keyExpiresAt: started.expiresAt });
    started.server.onExit((code) => {
        session = null;
        sidebar.update({ previewUrl: null });
        setStatus("$(zap) 잘커라");
        if (code !== 0 && code !== null) log(`프리뷰가 종료되었습니다(코드 ${code}).`);
    });

    setStatus(`$(browser) 프리뷰 ${new URL(started.server.url).port}`);
    status.command = "zalkera.preview.stop";

    if (started.revokedPrevious > 0) {
        // 말 없이 끊기면 다른 기계의 사용자는 그것을 고장으로 읽는다.
        void vscode.window.showWarningMessage(
            `다른 기계에서 켜 둔 프리뷰 ${started.revokedPrevious}개가 해제되었습니다(프리뷰 자격증명은 한 번에 하나입니다).`,
        );
    }
    if (started.expiresAt) {
        log(`프리뷰 자격증명 만료: ${new Date(started.expiresAt).toLocaleString("ko-KR")}`);
        scheduleRenewal(started.expiresAt, config.previewKeyTtlSeconds);
    }

    // **웹뷰가 아니라 실제 브라우저로 연다**(§3.5) — 웹뷰는 쿠키·CSP 가 실제 탭과 달라
    // "로컬에선 됐는데 배포하니 다르다"를 만드는 정확한 자리다.
    await vscode.env.openExternal(vscode.Uri.parse(started.server.url));
}

/**
 * C6「키 만료 자동 갱신」 — 만료 5분 전에 프리뷰를 스스로 다시 세운다(재발급 → env 갱신 → dev 재기동).
 *
 * **왜 자동인가**: 만료는 12시간마다 반드시 온다. 그때 사용자가 보는 것은 "갑자기 데이터가 안 나온다"이고,
 * 원인이 자격증명이라는 것을 알 방법이 없다. 조용한 실패를 예약해 두는 셈이라 자동 갱신이 기본이어야 한다.
 *
 * 재기동은 알린다 — 말없이 서버가 재시작되면 그것도 고장으로 읽힌다.
 */
function scheduleRenewal(expiresAt: string, ttlSeconds: number): void {
    clearRenewal();
    // ⚠ 초판은 lead 가 5분 하드코딩이고 서버가 준 TTL(`previewKeyTtlSeconds`)을 **받아만 놓고 안 썼다**.
    // TTL 을 5분 이하로 줄이면 `Math.max(delay, 1_000)` 때문에 **매초 재기동 루프**가 된다 — 매초 키 재발급
    // (직전 키 폐기)에 브라우저 탭까지 다시 열린다. lead 를 TTL 에서 유도하고 **하한을 건다**(심의 경고).
    const leadMs = Math.min(5 * 60_000, Math.max(30_000, (ttlSeconds * 1000) / 10));
    const delay = new Date(expiresAt).getTime() - Date.now() - leadMs;
    if (!Number.isFinite(delay)) return;
    if (delay < MIN_RENEW_DELAY_MS) {
        // 시계 오차나 아주 짧은 TTL 이면 즉시 재기동으로 달려들지 않는다 — 사람에게 말하고 멈춘다.
        log("프리뷰 자격증명 만료가 임박했습니다. 필요하면 프리뷰를 다시 시작해 주세요.");
        return;
    }

    renewTimer = setTimeout(
        () => {
            void (async () => {
                if (!session) return;
                log("프리뷰 자격증명이 곧 만료되어 다시 세웁니다…");
                void vscode.window.showInformationMessage("프리뷰 자격증명을 갱신하려고 프리뷰를 다시 시작합니다.");
                await vscode.commands.executeCommand("zalkera.preview.restart");
            })();
        },
        delay,
    );
    renewTimer.unref?.();
}

/** 시작이 실패해도 가드를 반드시 푼다 — 안 그러면 "준비 중" 에 영원히 갇힌다. */
async function withStartGuard<T>(run: () => Thenable<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
        previewStarting = false;
        setStatus("$(zap) 잘커라");
        throw error;
    }
}

const MIN_RENEW_DELAY_MS = 60_000;

function clearRenewal(): void {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
}

async function stopPreview(): Promise<void> {
    clearRenewal();
    if (!session) return;
    await session.server.stop();
    session = null;
    sidebar.update({ previewUrl: null });
    setStatus("$(zap) 잘커라");
    status.command = "zalkera.preview.start";
    log("프리뷰를 멈췄습니다.");
}

// ── 발행 ────────────────────────────────────────────────────────────────

async function publishCommand(): Promise<void> {
    const dir = requireWorkspace();
    const api = await ensureApi();

    const confirm = await vscode.window.showWarningMessage(
        "지금 소스를 잘커라에 올립니다. 올린 뒤 콘솔에서 새 버전으로 전환할 수 있습니다.",
        { modal: true },
        "올리기",
    );
    if (confirm !== "올리기") return;

    const result = await vscode.window.withProgress<PublishResult>(
        { location: vscode.ProgressLocation.Notification, title: "발행하는 중" },
        () => publish({ projectDir: dir, api, onProgress: log }),
    );
    log(`발행 접수 — 파일 ${result.fileCount}개 · ${Math.round(result.byteSize / 1024)}KB`);
    void vscode.window.showInformationMessage(`발행이 접수되었습니다(파일 ${result.fileCount}개).`);
}

/**
 * E1·E2 — 에이전트가 이 사이트를 도구로 다룰 수 있게 설정 파일에 한 줄 적어 준다.
 *
 * **우리가 대신 로그인해 주지 않는다.** 첫 사용 때 에이전트가 브라우저로 직접 로그인한다(그 편이 정직하고,
 * 우리가 남의 에이전트의 토큰을 들고 있지 않게 된다).
 */
async function connectAgent(): Promise<void> {
    const dir = requireWorkspace();
    const config = await ensureHandshake();
    if (!config.mcp) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "이 서버는 아직 에이전트 연결을 열지 않았습니다.",
            "잘커라에 문의해 주세요.",
        );
    }
    await ensureApi(); // 테넌트를 고르게 한다(아직 안 골랐다면).
    const tenant = tenantCode();

    const result = await registerMcpServer(dir, {
        serverName: config.mcp.serverName,
        url: config.mcp.sourceUrlTemplate.replace("{tenantCode}", encodeURIComponent(tenant)),
        clientId: config.mcp.clientId,
        authServerMetadataUrl: config.mcp.authServerMetadataUrl,
    });
    const docs = await ensureAgentDocs(dir);

    log(`.mcp.json ${result.action === "created" ? "생성" : result.action === "updated" ? "갱신" : "변경 없음"} — ${result.path}`);
    if (docs.agents === "created") log("AGENTS.md 스텁을 만들었습니다(규약 정본은 llms.txt 를 가리킵니다).");
    if (docs.claude === "created") log("CLAUDE.md 를 만들었습니다(AGENTS.md 를 참조하는 한 줄).");

    void vscode.window.showInformationMessage(
        "에이전트 설정을 적었습니다. 에이전트를 다시 열면 이 사이트 도구가 보이고, 처음 쓸 때 브라우저 로그인이 한 번 필요합니다.",
    );
}

/**
 * D5「이력」 — 버전 목록을 읽기 전용으로 보여 준다. 되돌리기는 별도 명령(D4)이라 **여기서는 아무것도 바뀌지
 * 않는다** — 보러 들어왔다가 실수로 라이브를 바꾸는 일이 없어야 한다.
 */
async function showHistory(): Promise<void> {
    const api = await ensureApi();
    const revisions = await api.listRevisions();
    if (revisions.length === 0) {
        void vscode.window.showInformationMessage("아직 올린 버전이 없습니다.");
        return;
    }

    output.show();
    log("── 버전 이력 ──");
    for (const r of revisions) {
        const when = new Date(r.createdAt).toLocaleString("ko-KR");
        log(`${r.isActive ? "▶" : " "} 버전 ${r.revisionNo} · ${r.status} · ${when}${r.note ? ` · ${r.note}` : ""}`);
    }
    log(`(총 ${revisions.length}개 · 되돌리려면 「이전 버전으로」를 쓰세요)`);
}

/** F2 — 문서 하나를 보고 진단을 갱신한다. 우리 프로젝트 밖 파일은 보지 않는다. */
function refreshDiagnostics(doc: vscode.TextDocument): void {
    const dir = workspaceDir();
    if (!dir || doc.uri.scheme !== "file" || !doc.uri.fsPath.startsWith(dir)) return;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(doc.uri.fsPath)) return;

    const text = doc.getText();
    const found = [
        ...diagnose(doc.uri.fsPath, text),
        ...diagnoseClientUsage(text, clientExports(dir)),
    ];
    diagnostics.set(
        doc.uri,
        found.map((f) => {
            const range = new vscode.Range(f.line, f.column, f.line, f.column + f.length);
            const severity =
                f.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
            const diagnostic = new vscode.Diagnostic(range, f.message, severity);
            diagnostic.source = "잘커라";
            diagnostic.code = f.rule;
            return diagnostic;
        }),
    );
}

/**
 * 설치된 `@zalkera/client` 가 **실제로 내보내는 이름**을 읽는다. 목록을 우리가 들고 있으면 client 가 성장할
 * 때마다 어긋나고, 그 어긋남이 고객에게는 "잘커라 도구가 틀렸다"로 보인다. 못 읽으면 빈 배열 — 아무 말도 안 한다.
 */
function clientExports(projectDir: string): string[] {
    const cached = clientExportCache.get(projectDir);
    if (cached) return cached;
    try {
        const dts = join(projectDir, "node_modules", "@zalkera", "client", "dist", "index.d.ts");
        if (!existsSync(dts)) return [];
        const text = readFileSync(dts, "utf8");
        const names = new Set<string>();
        for (const match of text.matchAll(/export\s+(?:declare\s+)?(?:type|interface|class|function|const)\s+(\w+)/g)) {
            if (match[1]) names.add(match[1]);
        }
        for (const match of text.matchAll(/export\s*\{([^}]+)\}/g)) {
            for (const raw of (match[1] ?? "").split(",")) {
                const name = raw.split(" as ").pop()?.trim().replace(/^type\s+/, "");
                if (name) names.add(name);
            }
        }
        const list = [...names];
        clientExportCache.set(projectDir, list);
        return list;
    } catch {
        return [];
    }
}

const clientExportCache = new Map<string, string[]>();

/** F1 — 되돌리기 어려운 자리를 연 사람에게 한 번 알린다. */
function warnProtectedPath(doc: vscode.TextDocument): void {
    const dir = workspaceDir();
    if (!dir || doc.uri.scheme !== "file" || !doc.uri.fsPath.startsWith(dir)) return;
    const relative = doc.uri.fsPath.slice(dir.length + 1);
    const warning = protectedPathWarning(relative);
    if (!warning || warnedPaths.has(doc.uri.fsPath)) return;
    warnedPaths.add(doc.uri.fsPath);
    void vscode.window.showWarningMessage(`${relative} — ${warning}`);
}

// ── 진단 ────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
    const dir = workspaceDir();
    const checks = await runDoctor({
        apiBase: apiBase(),
        extensionVersion: EXTENSION_VERSION,
        ...(dir ? { projectDir: dir } : {}),
    });
    const runtime = embeddedNodeRuntime(extensionPath);
    output.show();
    log("── 진단 ──");
    log(
        runtime.npmCommand
            ? "✅ 동봉 npm: 있음(의존성 설치에 이것을 씁니다)"
            : "❌ 동봉 npm: 없음 — 이 기계에 npm 이 따로 없으면 의존성 준비가 실패합니다(확장 재설치 필요)",
    );
    for (const check of checks) {
        log(`${check.ok ? "✅" : "❌"} ${check.name}: ${check.detail}`);
        if (check.hint) log(`   → ${check.hint}`);
    }
}

// ── 공통 ────────────────────────────────────────────────────────────────

/**
 * 핸드셰이크를 한 번 받아 캐시한다(F3). **로그인·API 호출보다 먼저** — 계약이 깨졌으면 여기서 끊어야
 * 사용자가 엉뚱한 원인(로그인 실패)을 쫓지 않는다.
 */
async function ensureHandshake(): Promise<Handshake> {
    if (handshake) return handshake;
    handshake = await fetchHandshake(apiBase(), EXTENSION_VERSION);
    if (handshake.verdict === "UPGRADE_RECOMMENDED" && handshake.message) {
        void vscode.window.showInformationMessage(handshake.message);
    }
    return handshake;
}

async function ensureApi(): Promise<ZalkeraApi> {
    const config = await ensureHandshake();
    if (!(await store.read())) await signIn();

    let tenant = tenantCode();
    if (!tenant) {
        const api = new ZalkeraApi({
            apiBase: apiBase(),
            accessToken: () => getAccessToken(config.auth, store),
            tenantCode: () => "",
        });
        const tenants = await api.listMyTenants();
        if (tenants.length === 0) {
            throw new DevtoolsError(
                "FORBIDDEN",
                "이 계정에 연결된 사이트가 없습니다.",
                "잘커라 콘솔에서 사이트에 초대되었는지 확인해 주세요.",
            );
        }
        const picked =
            tenants.length === 1
                ? tenants[0]
                : await vscode.window
                      .showQuickPick(
                          tenants.map((t) => ({ label: t.name, description: t.code })),
                          { title: "어느 사이트로 작업할까요?" },
                      )
                      .then((choice) => tenants.find((t) => t.code === choice?.description));
        if (!picked) throw new DevtoolsError("NOT_A_SITE", "사이트를 고르지 않았습니다.");
        tenant = picked.code;
        await vscode.workspace.getConfiguration("zalkera").update("tenant", tenant, false);
    }

    return new ZalkeraApi({
        apiBase: apiBase(),
        accessToken: () => getAccessToken(config.auth, store),
        tenantCode: () => tenant,
    });
}

function apiBase(): string {
    return vscode.workspace.getConfiguration("zalkera").get<string>("apiBase") ?? "https://api.zalkera.com";
}

function tenantCode(): string {
    return vscode.workspace.getConfiguration("zalkera").get<string>("tenant") ?? "";
}

function workspaceDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function requireWorkspace(): string {
    const dir = workspaceDir();
    if (!dir) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "열린 폴더가 없습니다.",
            "사이트 소스 폴더를 먼저 여세요(파일 → 폴더 열기).",
        );
    }
    return dir;
}

/** 사이드바가 보여 줄 사실만 다시 읽는다 — 판정이 아니라 표시다. */
async function refreshSidebar(): Promise<void> {
    const dir = workspaceDir();
    sidebar.update({
        signedIn: (await store.read()) !== null,
        tenant: tenantCode(),
        site: dir && existsSync(join(dir, "package.json")) ? dir : null,
    });
}

function setStatus(text: string): void {
    status.text = text;
    status.tooltip = session ? `프리뷰 실행 중 — ${session.server.url}` : "잘커라 프리뷰 시작";
}

function log(message: string): void {
    output.appendLine(message);
}
