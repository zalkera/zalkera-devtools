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
    waitForBuild,
    captureTenant,
    type CapturedTenant,
    ours,
    plainNotice,
    count,
    decideReadyPrompt,
    decideSwitch,
    resolveHelpUrl,
    type NpmPreference,
    shouldShowUpgradeNotice,
    type UpgradeNoticeState,
    writeOwnFile,
    httpUrl,
    apiBaseUrl,
    mcpServerName,
    say,
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
import { describeNpm, embeddedNodeRuntime, npmArgvOf, resolveNpm } from "./runtime.ts";
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
/**
 * **마지막으로 발급받은 프리뷰 키.** `session` 이 아니라 여기 사는 이유(심의 경고 · 2026-08-10):
 * 종전에는 keyId 가 `session` 에만 있어서, 「프리뷰 중지」 뒤 로그아웃하면 **서버 키를 못 지웠다.**
 * 프로세스는 죽었지만 키는 TTL(최대 12시간)까지 살아 있었고, 도움말은 "서버에서도 폐기됩니다"라고
 * 적혀 있었다 — 문서가 하지 않는 일을 했다고 말하는 자리였다.
 */
let issuedKey: { keyId: number; tenant: string } | null = null;
/**
 * `issuedKeyId` 를 창 밖으로 넘긴다. **모듈 메모리만으로는 부족하다**(심의 경고 · 2026-08-10) —
 * 「중지」 뒤 창을 다시 열면(reload·재시작) 값이 사라져, 로그아웃해도 서버 키가 TTL(최대 12시간)까지
 * 살아 있었다. 도움말은 그 경로에서도 폐기된다고 무조건으로 약속하고 있었다.
 */
const ISSUED_KEY_STATE = "zalkera.issuedKey";
let persistedState: vscode.Memento;

/**
 * ⚠ **테넌트를 함께 들고 다닌다**(클로징 심의 차단 · 2026-08-10). 종전에는 keyId 만 캡처하고 폐기할 때
 * `tenantCode()` 를 **라이브로** 읽었다. 그런데 `zalkera.tenant` 는 워크스페이스 범위라 창마다 다르고,
 * 테넌트는 `x-tenant` 헤더로만 간다 — 창 A(테넌트 a)에서 발급한 키를 창 B(테넌트 b)에서 로그아웃하면
 * 폐기 요청이 b 로 나가 서버가 거절하고, catch 가 그것을 삼킨다. **A 의 키가 최대 12시간 산다.**
 *
 * T3 가 「올리기·전환」에 만든 "표기와 동작이 같은 값을 본다"를 이 호출부에 그대로 옮긴 것이다.
 */
function setIssuedKey(next: { keyId: number; tenant: string } | null): void {
    issuedKey = next;
    void persistedState.update(ISSUED_KEY_STATE, next);
}
let store: SecretTokenStore;
let handshake: Handshake | null = null;
let sidebar: ZalkeraSidebar;
/** 동봉 자원(npm)을 찾으려면 확장 설치 경로가 필요하다. */
let extensionPath: string;
/** 동봉 매뉴얼(media/help.md)의 위치. */
let helpUri: vscode.Uri;
let renewTimer: NodeJS.Timeout | null = null;
let diagnostics: vscode.DiagnosticCollection;
/** 보호 경로 경고를 파일마다 한 번만 — 저장할 때마다 같은 말을 반복하면 사람은 그것을 끄고 만다. */
const warnedPaths = new Set<string>();

/**
 * **manifest 에서 읽는다.** 종전에는 `"0.1.0"` 이 소스에 박혀 있어, 0.1.14 를 쓰는 사람도 서버에는
 * 0.1.0 으로 보였다 — 핸드셰이크의 `minClientVersion` 판정이 그 값을 본다. 두 곳에 적힌 값은 갈린다.
 */
let extensionVersion = "0.0.0";

/** 확장 뷰로 데려다 줄 때 쓰는 식별자. manifest 에서 읽는다 — 소스에 박으면 갈린다. */
let extensionId = "zalkera.zalkera-devtools";

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("잘커라");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = "zalkera.preview.start";
    setStatus("$(zap) 잘커라");
    status.show();
    store = new SecretTokenStore(context);
    extensionPath = context.extensionPath;
    extensionVersion = String(context.extension.packageJSON.version ?? extensionVersion);
    extensionId = context.extension.id || extensionId;
    persistedState = context.globalState;
    // 지난 창이 남긴 키가 있으면 이어받는다 — 그래야 로그아웃이 그것까지 지운다.
    issuedKey = context.globalState.get<{ keyId: number; tenant: string }>(ISSUED_KEY_STATE) ?? null;
    helpUri = vscode.Uri.joinPath(context.extensionUri, "media", "help.md");
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
        register("zalkera.site.choose", chooseSite),
        register("zalkera.reset", resetAll),
        register("zalkera.signOut", async () => {
            await signOut();
        }),
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
        register("zalkera.version.switch", () => switchVersion()),
        register("zalkera.history", showHistory),
        register("zalkera.precheck", precheckCommand),
        register("zalkera.agent.connect", connectAgent),
        register("zalkera.help", showHelp),
        register("zalkera.doctor", doctor),
    );
}

export async function deactivate(): Promise<void> {
    clearRenewal();
    // 프리뷰를 켜 둔 채 창을 닫으면 dev 서버가 고아로 남는다 — 사용자는 그것을 볼 수도 끌 수도 없다.
    await session?.server.stop();
}

/**
 * 매뉴얼을 연다. **정본은 웹**이고(오너 확정 2026-08-10), 동봉본은 폴백이다.
 *
 * ■ 왜 웹이 정본인가
 *   확장은 고객 기계에 깔려 **강제 업데이트가 안 된다.** 동봉본만 두면 오탈자 하나 고치는 데 새 릴리스가
 *   필요하고, 안 올린 사람은 영영 옛 글을 본다. 웹은 고치는 즉시 모두에게 닿는다.
 *   그리고 설치 **전에** 읽을 수 있어야 한다 — 안 깔아 본 사람이 판단할 근거가 그것이다.
 *
 * ■ 그런데 왜 동봉본을 남기나
 *   매뉴얼이 제일 필요한 순간은 **뭔가 안 될 때**이고, 그때 안 되는 것이 인터넷일 수 있다.
 *
 * ■ 왜 열어 보기 전에 재나
 *   `openExternal` 은 **브라우저를 띄웠는가**만 알려 준다 — 그 페이지가 떴는지는 모른다. 그래서 그냥
 *   열면 오프라인 사용자는 브라우저 오류 화면을 보고 끝난다. 짧은 요청 한 번으로 먼저 확인한다.
 *   실패는 **정상 경로**다(오프라인·사내망 차단) — 조용히 동봉본으로 간다.
 *
 * ■ 주소는 **서버가 정한다**
 *   확장은 강제 업데이트가 안 되므로 주소를 박아 두면 호스트를 옮기는 날 전원이 새 VSIX 를 깔아야 한다.
 *   핸드셰이크의 `helpUrl` 을 먼저 보고, 없을 때만 아래 기본값을 쓴다. 지금 기본값이 GitHub Pages 인
 *   것은 **임시**이고, www 가 서면 서버 설정 한 줄로 옮겨진다 — 클라이언트 배포 0.
 */
const HELP_URL_FALLBACK = "https://zalkera.github.io/zalkera-devtools/";

async function showHelp(): Promise<void> {
    const url = await helpUrl();
    if (await reachable(url)) {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        if (opened) return;
        // 브라우저를 못 띄운 경우(원격·컨테이너 환경) — 여기서 끝내면 아무것도 안 열린다.
        log("브라우저를 열지 못해 동봉 매뉴얼을 엽니다.");
    }
    await openBundledHelp();
}

/**
 * 서버가 말한 주소 → 박힌 기본값 순.
 *
 * 핸드셰이크를 아직 안 받았으면 조용히 한 번 받아 본다. **실패는 삼킨다** — 도움말을 열려는데
 * 핸드셰이크 오류(구버전 경고 등)를 대신 띄우면 정작 도움말을 못 본다.
 *
 * ⚠ `http(s)` 만 받는다. 서버가 보낸 값이라도 그대로 `openExternal` 에 넘기지 않는다 — 잘못된 설정
 * 하나가 `file:`·`vscode:` 를 여는 통로가 되면 안 된다.
 */
async function helpUrl(): Promise<string> {
    if (!handshake) {
        try {
            await ensureHandshake();
        } catch {
            // 무시 — 기본값으로 간다.
        }
    }
    // 판정은 core 가 한다(§tenantScope). 여기서는 그 판단을 **말하기만** 한다 —
    // 조용히 기본값으로 돌아가면 운영자가 설정 오타를 영영 모른다.
    const resolved = resolveHelpUrl(handshake?.helpUrl, HELP_URL_FALLBACK);
    if (resolved.note) log(resolved.note);
    return resolved.url;
}

/** 2초 안에 응답이 오는가. 오래 기다리면 "도움말이 안 열린다"가 된다 — 그게 더 나쁜 고장이다. */
async function reachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) });
        return response.ok;
    } catch {
        return false;
    }
}

/** 마크다운 미리보기가 없는 편집기(일부 경량 배포판)에서는 원문을 연다 — **못 여는 것보다 낫다.** */
async function openBundledHelp(): Promise<void> {
    try {
        await vscode.commands.executeCommand("markdown.showPreview", helpUri);
    } catch {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(helpUri), { preview: false });
    }
}

/** 모든 명령을 한 자리에서 감싼다 — 오류를 **사람 말로** 보여 주는 곳이 여기 하나여야 한다. */
function register(command: string, handler: () => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(command, async () => {
        try {
            await handler();
        } catch (error) {
            // ⚠ **취소는 오류가 아니다.** 사용자가 스스로 그만둔 것을 빨간 창으로 알리면, 자기가
            //    뭘 잘못했나 싶게 만든다. 출력 채널에는 남긴다 — 무슨 일이 있었는지는 보여야 한다.
            //    (`signIn`·사이트 선택은 각자 삼키고 있었는데, 프리뷰 취소가 이 자리까지 올라와
            //    "인터넷을 확인하세요"로 떴다 — 재심의 지적. 한 자리에서 가른다.)
            if (error instanceof DevtoolsError && error.code === "CANCELLED") {
                log(`취소: ${error.humanMessage}`);
                return;
            }
            const message = error instanceof DevtoolsError ? error.humanMessage : String(error);
            log(`오류: ${message}`);
            // ⚠ `ours(message)` 였다 — **거짓이었다**(3회전 심의 실증). `humanMessage` 가 소독된 것은
            //    `api.ts` 응답 파싱 경로뿐이고, `safeWrite.ts`·`untar.ts` 는 서버가 정한 항목 이름을
            //    그대로 실어 보냈다. `String(error)` 갈래도 안전하지 않다 — `JSON.parse` 실패 메시지는
            //    입력 조각을 담는다. 출력 채널(위 `log`)은 링크를 렌더하지 않아 원문을 남긴다.
            const choice = await vscode.window.showErrorMessage(plainNotice(message), "자세히 보기");
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
                        // ⚠ **반환값을 본다.** VS Code 는 외부 주소를 열기 전에 "이 사이트를 여시겠습니까?"
                        // 확인창을 띄우고, 사용자가 거기서 취소하면 `false` 를 돌려준다. 이걸 무시하면
                        // **브라우저는 열리지도 않았는데** 코어가 콜백을 기다려, 진행 알림이 남고
                        // 사용자는 취소를 두 번 하게 된다(실사용 신고).
                        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
                        if (!opened) throw new DevtoolsError("CANCELLED", "로그인을 취소했습니다.");
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

/** 로그아웃했으면 `true`, 준비 중이라 거절했으면 `false`. **호출부는 이 값을 봐야 한다.** */
async function signOut(options: { quiet?: boolean } = {}): Promise<boolean> {
    // 준비 중(수 분짜리 첫 설치)에 로그아웃하면, 이미 발급된 키로 진행 중인 시작이 **로그아웃 뒤에
    // 완주해** 프리뷰가 선다 — 사이드바는 로그아웃 화면인데 상태바는 "프리뷰 N"이 된다(심의 경고).
    // 지금은 준비를 중간에 끊을 수단이 없으므로 **거절하고 말한다.** 조용히 어긋나게 두지 않는다.
    if (previewStarting) {
        void vscode.window.showWarningMessage("프리뷰를 준비하는 중입니다. 끝난 뒤 다시 시도해 주세요.");
        return false;
    }
    // ⚠ **로그아웃이 반쪽이었다**(심의 경고): 도는 프리뷰를 안 끄고 서버 키도 안 지웠다. 이미 뜬 dev 서버는
    // 부팅 때 읽은 키로 **최대 12시간 상용 데이터를 계속 읽는다** — "로그아웃했다"는 화면과 실제가 어긋난다.
    // 순서가 중요하다: 서버를 먼저 멈추고(그 키를 쓰는 프로세스를 없앤 뒤) 키를 지운다.
    //
    // 프리뷰가 돌던 폴더를 **멈추기 전에** 잡는다. `stopPreview()` 뒤엔 `session` 이 사라져서,
    // 아래 `.env.local` 정리가 지금 창의 폴더를 지우게 된다 — 키가 있는 곳은 저쪽인데(클로징 심의).
    const previewDir = session?.projectDir ?? null;
    await stopPreview();
    // `session` 이 아니라 [issuedKey] 를 본다 — 「중지」 뒤 로그아웃해도 서버 키가 지워져야 한다.
    if (issuedKey) {
        const doomed = issuedKey;
        setIssuedKey(null);
        await revokeKeyQuietly(doomed.keyId, doomed.tenant);
    }

    await logout(store);
    // 로컬 자격증명도 함께 지운다(A4) — **키 줄만** 지우고 고객이 넣은 값은 남긴다.
    const dir = previewDir ?? workspaceDir();
    if (dir) {
        const envPath = join(dir, ".env.local");
        if (existsSync(envPath)) {
            await writeOwnFile(envPath, stripCredentials(await readFile(envPath, "utf8")), 0o600);
            log(".env.local 의 프리뷰 키를 지웠습니다(다른 설정은 그대로).");
        }
    }
    await refreshSidebar();
    // 초기화가 부를 때는 자기 문구로 끝낸다 — 알림이 두 번 뜨면 무엇이 끝난 건지 흐려진다.
    if (!options.quiet) void vscode.window.showInformationMessage("로그아웃했습니다.");
    return true;
}

/**
 * 처음 상태로 되돌린다(오너 확정 2026-08-10 · memo146 §15.4).
 *
 * 종전에는 완전 초기화에 **세 곳을 사람이 기억해야 했다** — 로그아웃 · 설정의 `zalkera.tenant` ·
 * 받은 폴더. 앞의 둘을 여기서 한 번에 한다.
 *
 * ⚠ **파일은 지우지 않는다.** 고치던 소스를 도구가 지우는 것이 이 도구가 낼 수 있는 가장 큰 손해다
 * (`fetchSiteSource` 가 빈 폴더를 요구하는 것과 같은 규율). 대신 **경로를 알려주고 사람이 지우게** 한다.
 */
async function resetAll(): Promise<void> {
    // signOut 과 **같은 이유로** 거절한다. 여기서 막지 않으면 signOut 이 조용히 되돌아온 뒤 설정만
    // 지워져서 — 로그인은 살아 있고 프리뷰는 뒤늦게 뜨는데 사이트 설정만 사라진 — 최악의 중간 상태가 된다.
    const dir = workspaceDir();
    const confirmed = await vscode.window.showWarningMessage(
        "잘커라를 처음 상태로 되돌릴까요?",
        {
            modal: true,
            detail:
                "지웁니다: 로그인 · 작업 사이트 설정 · 프리뷰 자격증명(서버에서도 폐기)\n" +
                "남깁니다: 받은 소스 폴더와 그 안의 내 설정",
        },
        "초기화",
    );
    if (confirmed !== "초기화") return;

    // 로그아웃이 이미 하는 일(프리뷰 중지 → 서버 키 폐기 → 토큰 삭제 → .env.local 키 줄 제거)을
    // 그대로 쓴다. 두 벌로 만들면 한쪽만 고쳐진다.
    //
    // ⚠ **거절을 반드시 전달받는다**(심의 경고). 반환값을 안 보면, 확인창을 띄워 둔 사이에 갱신 타이머가
    // 프리뷰를 다시 세워 signOut 이 거절하고 — 그런데 여기는 그대로 진행해 **설정만 지운다.** 로그인은
    // 살아 있고 프리뷰는 뒤늦게 뜨는데 사이트 설정만 사라진, 주석이 스스로 최악이라 부른 그 상태다.
    if (!(await signOut({ quiet: true }))) return;

    // 사이트 설정은 **두 범위 모두** 지운다 — 한쪽만 지우면 남은 쪽이 되살아난다.
    const config = vscode.workspace.getConfiguration("zalkera");
    await config.update("tenant", undefined, vscode.ConfigurationTarget.Global);
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
        await config.update("tenant", undefined, vscode.ConfigurationTarget.Workspace);
    }

    log("초기화했습니다 — 로그인·사이트 설정·프리뷰 자격증명을 지웠습니다.");
    await refreshSidebar();

    if (dir) {
        // 폴더는 안 지운다. 다만 **지우고 싶은 사람이 어디를 지워야 하는지 모르는 것**이 진짜 불편이므로
        // 경로를 손에 쥐여 준다.
        const choice = await vscode.window.showInformationMessage(
            "초기화했습니다. 받은 소스 폴더는 그대로 남아 있습니다.",
            "폴더 위치 열기",
        );
        if (choice === "폴더 위치 열기") {
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
        }
        return;
    }
    void vscode.window.showInformationMessage("초기화했습니다.");
}


/**
 * 키 폐기는 **실패해도 로그아웃을 막지 않는다** — 사용자가 원한 것은 로그아웃이고, 서버가 잠깐 안 되는 것이
 * 그것을 되돌릴 이유가 되지 않는다. 대신 남은 키가 있다는 사실은 로그로 남긴다.
 */
async function revokeKeyQuietly(keyId: number, tenant: string): Promise<void> {
    try {
        const config = await ensureHandshake();
        const api = new ZalkeraApi({
            apiBase: apiBase(),
            accessToken: () => getAccessToken(config.auth, store),
            // **키를 발급받은 그 테넌트**로 폐기한다. 지금 고른 사이트가 아니다.
            tenantCode: () => tenant,
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
    log(`버전 ${count(result.revisionNo)} · 파일 ${count(result.fileCount)}개를 받았습니다.`);
    // ⚠ 받은 폴더가 **지금 열린 폴더**일 수 있다. 그때 갱신하지 않으면 사이드바가 계속 「소스」에
    //    머물러 프리뷰·발행으로 가는 길이 화면에서 끊긴다.
    await refreshSidebar();
    const open = await vscode.window.showInformationMessage(
        `사이트 소스를 받았습니다(버전 ${count(result.revisionNo)}).`,
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
        { location: vscode.ProgressLocation.Notification, title: `${plainNotice(preset.name, 64)} 를 받는 중` },
        () => startFromPreset({ api, presetCode: preset.code, targetDir: target, onProgress: log }),
    );
    log(`시작 소스 ${result.presetCode}@${result.version} · 파일 ${count(result.fileCount)}개.`);

    // 받은 폴더가 지금 열린 폴더일 수 있다 — `openSite` 와 같은 이유로 갱신한다.
    await refreshSidebar();
    const open = await vscode.window.showInformationMessage(
        // ⚠ `preset.name` 은 서버 응답(`/api/partner/site-preset/presets`)이다. 소독 없이 넣으면
        // 비-모달 알림이 `[글](command:…)` 를 클릭 링크로 렌더한다(심의 실증).
        `${plainNotice(preset.name, 64)} 를 받았습니다(${count(result.fileCount)}개 파일).`,
        "이 폴더 열기",
    );
    if (open === "이 폴더 열기") {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), { forceNewWindow: false });
    }
}

/**
 * D4「버전 전환」 — 어느 버전을 켤지 고른다. 백엔드 신작이 없다(activate 가 이미 있다).
 *
 * ■ 「되돌리기」와 합친 이유 (오너 확정 2026-08-10)
 *   종전 이름은 「버전 되돌리기」였는데, 목록은 처음부터 **활성이 아닌 버전 전부**였다 — 방금 올린
 *   새 버전도 거기 있었다. 앞으로 가는 것과 뒤로 가는 것이 **같은 연산**(`activateRevision`)인데
 *   이름만 뒤를 가리켜, 방금 올린 것을 켜려는 사람이 이 자리를 찾지 못했다.
 *
 *   같은 API 를 두 이름으로 두면 언젠가 한쪽만 고쳐진다. 그래서 하나로 둔다.
 *
 * ■ 확인을 modal 로 받는다
 *   전환은 **방문자가 보는 화면이 즉시 바뀌는** 동작이다. 잘못 누르면 손님이 다른 화면을 본다.
 *   「새 버전 올리기」가 조용한 대신 여기가 시끄러워야 한다 — 두 단계로 나눈 이유가 그것이다.
 */
async function switchVersion(preselected?: number, expectedTenant?: CapturedTenant): Promise<void> {
    const { api, tenant } = await ensureApiFor();
    // 「지금 전환」이 눌린 시점과 여기서 API 가 묶이는 시점 사이에도 사이트는 바뀔 수 있다.
    // 올린 곳과 켤 곳이 다르면 **아무것도 하지 않는다** — 조용히 남의 사이트를 켜는 것보다 낫다.
    const decision = decideSwitch(expectedTenant, tenant);
    if (!decision.ok) {
        void vscode.window.showWarningMessage(decision.message);
        return;
    }
    const revisions = await api.listRevisions();
    // **켤 수 있는 것만 고르게 한다.** BUILDING·FAILED 를 목록에 넣으면 골랐다가 409 로 거절당한다 —
    // 고를 수 없는 것을 보여 주고 거절하는 것은 화면이 사람에게 거짓말을 하는 것이다.
    const candidates = revisions.filter((r) => !r.isActive && r.status === "READY");
    if (candidates.length === 0) {
        const building = revisions.filter((r) => r.status === "BUILDING").length;
        void vscode.window.showInformationMessage(
            building > 0
                ? `지금 바꿀 수 있는 버전이 없습니다(빌드 중 ${count(building)}개). 끝나면 다시 보십시오.`
                : "바꿀 다른 버전이 없습니다.",
        );
        return;
    }

    // 목록은 최신순이다. 맨 위가 대개 **방금 올린 것**이라 그렇다고 말해 준다 — 사람이 번호를
    // 외우고 있지는 않다.
    const active = revisions.find((r) => r.isActive);

    // 방금 올려 놓고 "지금 전환"을 누른 경우 — 고르라고 다시 묻지 않는다. 이미 고른 것이다.
    const direct = preselected === undefined ? undefined : candidates.find((r) => r.revisionNo === preselected);
    if (preselected !== undefined && !direct) {
        void vscode.window.showWarningMessage(say.cannotSwitch(tenant, preselected));
        return;
    }

    const choice = direct ? { label: `버전 ${direct.revisionNo}` } : await vscode.window.showQuickPick(
        candidates.map((r, index) => ({
            label: `버전 ${r.revisionNo}`,
            description: new Date(r.createdAt).toLocaleString("ko-KR"),
            detail:
                index === 0 && (active === undefined || r.revisionNo > active.revisionNo)
                    ? `${r.status} · 가장 최근에 올린 것`
                    : r.status,
        })),
        { title: active ? `지금은 버전 ${active.revisionNo} 입니다 — 어느 버전으로 바꿀까요?` : "어느 버전으로 바꿀까요?" },
    );
    const target = candidates.find((r) => `버전 ${r.revisionNo}` === choice?.label);
    if (!target) return;

    const ask = say.switchConfirm(tenant, target.revisionNo);
    const confirm = await vscode.window.showWarningMessage(
        ask.message,
        { modal: true, detail: ask.detail },
        ask.action,
    );
    if (confirm !== ask.action) return;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `버전 ${count(target.revisionNo)} 로 바꾸는 중` },
        () => api.activateRevision(target.revisionNo),
    );
    log(`사이트를 버전 ${target.revisionNo} 로 바꿨습니다.`);
    void vscode.window.showInformationMessage(say.switched(tenant, target.revisionNo));
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
    // 폴더가 없으면 연결할 대상이 없다 — 종전에는 전역에 적어 놓고 "이 작업 공간을" 이라고 말했다.
    if (workspaceDir() === undefined) {
        throw new DevtoolsError("NOT_A_SITE", "열린 폴더가 없습니다.", "소스 폴더를 먼저 여신 뒤 다시 눌러 주세요.");
    }
    const api = await ensureApi();
    const tenants = await api.listMyTenants();
    const choice = await vscode.window.showQuickPick(
        tenants.map((t) => ({ label: t.name, description: t.code })),
        { title: "이 폴더를 어느 사이트로 연결할까요?" },
    );
    if (!choice?.description) return;
    await saveTenant(choice.description);
    log(`이 폴더를 ${plainNotice(choice.label, 64)}(${plainNotice(choice.description, 64)}) 에 연결했습니다.`);
    // ⚠ **적었으면 화면도 바꾼다.** 종전에는 설정만 바꾸고 사이드바가 옛 사이트를 계속 보여 줬다 —
    //    배송 문서가 "고른 사이트는 그룹 이름 옆에 늘 보입니다"라고 그 표시를 근거로 삼는다.
    await refreshSidebar();
    void vscode.window.showInformationMessage(
        `이 폴더를 ${plainNotice(choice.label, 64)} 사이트에 연결했습니다.`,
    );
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
    // ⚠ **가드는 반드시 finally 로 푼다**(심의 차단 · 2026-08-10). 종전에는 성공 경로에서만 풀어서,
    // 바로 아래 세 호출 중 하나만 던져도(폴더 미개방·사이트 선택 ESC·네트워크 오류) 가드가 영영 잠겼다.
    // 그 뒤로는 「프리뷰 시작」이 창을 새로 열 때까지 "준비하는 중입니다"만 반복했다 — 준비 중인 것이
    // 없는데 준비 중이라고 말하는 막다른 길이었다.
    previewStarting = true;
    try {
        await startPreviewInner();
    } catch (error) {
        // 시작이 실패했으면 **발급받은 키를 여기서 되돌린다.** 로그아웃까지 미루면 그때까지 서버에
        // 살아 있고, 사용자는 실패했다고 들었으므로 로그아웃할 이유도 못 느낀다.
        if (issuedKey !== null && !session) {
            // **비우는 것이 먼저다.** `await` 뒤에 비우면, 그 사이 시작된 두 번째 시도가 심어 둔 새 키를
            // 이 줄이 지워 버린다(심의 경고). 지역 변수로 옮겨 놓고 폐기한다.
            const doomed = issuedKey;
            setIssuedKey(null);
            await revokeKeyQuietly(doomed.keyId, doomed.tenant);
        }
        throw error;
    } finally {
        previewStarting = false;
    }
}

async function startPreviewInner(): Promise<void> {
    const dir = requireWorkspace();
    // ⚠ **캡처한다**(클로징 심의 W1). 종전에는 API 만 캡처 테넌트에 묶이고 dev 서버에 넘기는 값은
    // `tenantCode()` 라이브였다. 그 사이에 await 가 여럿(핸드셰이크·progress 준비) 있어서, 그 틈에
    // 사이트를 바꾸면 **키는 A 로 발급되고 서버 env 는 B** 가 된다.
    const { api, tenant } = await ensureApiFor();
    const config = await ensureHandshake();
    const runtime = embeddedNodeRuntime(extensionPath);
    // ⚠ **조용히 떨어지지 않는다.** 어느 npm 이 돌았는지 모르는 채 결과만 남으면, 실사용 신고가
    //   왔을 때 물어볼 것이 없다. 고른 이유까지 **정상 흐름에서** 남긴다.
    const npm = resolveNpm(extensionPath, npmPreference(), npmBlindSpots(dir));
    log(`npm: ${describeNpm(npm)} — ${npm.why}`);
    const npmArgv = npmArgvOf(npm, process.execPath);
    if (!npmArgv) {
        // ⚠ **여기서 멈춘다.** `null` 은 "PATH 의 npm 으로 해 보라"가 아니다 — 그 경로는 개발자 기계에서만
        //   서고, 비개발자 기계에서는 `spawn` 이 ENOENT 로 죽어 "인터넷을 확인하세요"라는 틀린 안내가 된다.
        throw new DevtoolsError(
            "DEPENDENCIES_FAILED",
            `의존성을 설치할 npm 이 없습니다 — ${npm.kind === "unavailable" ? npm.why : ""}`,
            npm.kind === "unavailable" ? npm.hint : "잘커라에 문의해 주세요.",
        );
    }

    setStatus("$(sync~spin) 프리뷰 준비 중");
    // ⚠ **취소 단추를 준다.** 첫 실행은 수 분짜리 설치이고, 사내망 프록시에 물리면 자식 프로세스가
    //   **끝나지 않는다** — 그러면 이 알림은 영원히 돈다. 이 파일이 이미 적어 둔 "사용자가 반드시 두 번
    //   누른다"는 실측에 재진입 가드는 만들었으면서 **멈출 방법은 안 만들었다**(심의 지적).
    //   `signOut` 도 준비 중에는 거절하므로, 취소가 없으면 남는 탈출구는 편집기 강제 종료뿐이다.
    //   형제 `signIn`(위)이 쓰는 패턴을 그대로 옮긴다.
    const started = await withStartGuard(() => vscode.window.withProgress<PreviewSession>(
        { location: vscode.ProgressLocation.Notification, title: "프리뷰를 준비하는 중", cancellable: true },
        (_progress, token) => {
            const controller = new AbortController();
            const subscription = token.onCancellationRequested(() => controller.abort());
            return startPreview({
                signal: controller.signal,
                projectDir: dir,
                api,
                apiBase: apiBase(),
                tenantCode: tenant,
                nodePath: runtime.nodePath,
                extraEnv: runtime.env,
                // 고른 npm 의 **경로**를 넘긴다. 코어에 기본값이 없으므로 이 값이 곧 실행될 것이다.
                npmCommand: npmArgv,
                npmEnv: runtime.env,
                label: `${vscode.env.appName} · ${process.platform}`,
                // 발급 즉시 붙잡는다 — 뒤가 실패해도 로그아웃·초기화가 이 키를 지울 수 있어야 한다.
                onKeyIssued: (keyId) => {
                    setIssuedKey({ keyId, tenant });
                },
                onProgress: log,
                onLog: log,
            }).finally(() => subscription.dispose());
        },
    ));

    session = { server: started.server, projectDir: dir, keyId: started.keyId };
    setIssuedKey({ keyId: started.keyId, tenant });
    sidebar.update({ previewUrl: started.server.url, keyExpiresAt: started.expiresAt });
    started.server.onExit((code) => {
        session = null;
        clearRenewal();
        // 만료 표시도 함께 걷는다 — 프리뷰가 없는데 "자격증명 만료: …"가 남으면 낡은 화면이다.
        sidebar.update({ previewUrl: null, keyExpiresAt: null });
        setStatus("$(zap) 잘커라");
        // **상태바를 되돌린다.** 종전에는 텍스트만 바꾸고 command 를 stop 에 둬서, 크래시 뒤 상태바를
        // 누르면 session 이 없어 아무 일도 안 하는 죽은 버튼이 됐다(심의 경고).
        status.command = "zalkera.preview.start";
        if (code !== 0 && code !== null) log(`프리뷰가 종료되었습니다(코드 ${code}).`);
    });

    setStatus(`$(browser) 프리뷰 ${new URL(started.server.url).port}`);
    status.command = "zalkera.preview.stop";

    if (started.revokedPrevious > 0) {
        // 말 없이 끊기면 다른 기계의 사용자는 그것을 고장으로 읽는다.
        void vscode.window.showWarningMessage(
            `다른 기계에서 켜 둔 프리뷰 ${count(started.revokedPrevious)}개가 해제되었습니다(프리뷰 자격증명은 한 번에 하나입니다).`,
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

/**
 * 실패하면 상태바를 되돌린다.
 *
 * ⚠ **여기서 가드를 풀지 않는다**(심의 경고 · 2026-08-10). 종전에는 이 catch 가 `previewStarting = false`
 * 를 했는데, 바깥 catch 가 키를 폐기하는 **수 초 동안 가드가 이미 풀려 있었다.** 그 창에서 다시 「프리뷰
 * 시작」이 통과하면 새 키가 발급되고, 뒤늦게 끝난 첫 번째 정리가 `issuedKeyId` 를 비워 **두 번째 키를
 * 아무도 못 지우게** 만든다 — 이 트랜치가 닫으려던 바로 그 누수가 경합으로 되살아난다.
 *
 * 가드 해제는 바깥 `finally` 한 곳뿐이다. 푸는 자리가 둘이면 반드시 어긋난다.
 */
async function withStartGuard<T>(run: () => Thenable<T>): Promise<T> {
    try {
        return await run();
    } catch (error) {
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
    sidebar.update({ previewUrl: null, keyExpiresAt: null });
    setStatus("$(zap) 잘커라");
    status.command = "zalkera.preview.start";
    log("프리뷰를 멈췄습니다.");
}

// ── 새 버전 올리기 ────────────────────────────────────────────────────────

/**
 * **「발행」이라 부르지 않는다**(오너 지적 2026-08-10). 이 명령이 하는 일은 `confirmArchive` 까지,
 * 곧 **버전을 하나 만드는 것**뿐이다. 사이트를 그 버전으로 바꾸는 것은 `activateRevision` 이고
 * 이 명령은 그것을 부르지 않는다. "발행"은 하지 않은 일을 했다고 말한다.
 *
 * 이름이 거짓이면 사람은 사이트가 바뀐 줄 알고 확인하지 않는다 — 그 오해가 제일 비싸다.
 */

async function publishCommand(): Promise<void> {
    const dir = requireWorkspace();
    const { api, tenant } = await ensureApiFor();

    // 문구는 core 가 만든다 — **`tenant` 를 인자로 요구하므로 라이브로 읽을 방법이 없다**(§tenantScope).
    // 오늘 이 자리에서 난 결함이 정확히 "알림이 라이브로 다시 읽는 것"이었다.
    const ask = say.publishConfirm(tenant);
    const confirm = await vscode.window.showWarningMessage(
        ask.message,
        { modal: true, detail: ask.detail },
        ask.action,
    );
    if (confirm !== ask.action) return;

    const result = await vscode.window.withProgress<PublishResult>(
        { location: vscode.ProgressLocation.Notification, title: "올리는 중" },
        () => publish({ projectDir: dir, api, onProgress: log }),
    );
    log(`버전 ${count(result.revisionNo)} 로 올렸습니다 — 파일 ${count(result.fileCount)}개 · ${Math.round(result.byteSize / 1024)}KB`);
    // 서버가 보낸 한계·상태 안내는 **그대로 보여 준다**(memo66 §4 거짓 성공 차단).
    if (result.capabilityNote) log(result.capabilityNote);

    // `STATIC` 은 올리는 즉시 READY 지만 `NEXT_SOURCE` 는 서버가 빌드해야 한다. 종전에는 여기서
    // 이야기가 끝나 **왜 못 켜는지 알 수 없었다.**
    const ready = result.status === "READY" ? true : await awaitBuild(api, result.revisionNo, tenant);
    if (!ready) return;

    await offerSwitch(result.revisionNo, tenant);
}

/**
 * 빌드가 끝날 때까지 지켜본다. **켜지는 않는다** — 켜는 것은 사람이 한 번 더 눌러야 한다.
 *
 * 취소는 **기다리기를 그만두는 것**이지 빌드를 멈추는 것이 아니다. 서버는 계속 짓는다 —
 * 그 사실을 말해 주지 않으면 사용자는 자기가 취소해서 안 된 줄 안다.
 */
async function awaitBuild(api: ZalkeraApi, revisionNo: number, tenant: CapturedTenant): Promise<boolean> {
    const outcome = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: say.building(tenant, revisionNo),
            cancellable: true,
        },
        (_progress, token) =>
            waitForBuild({
                revisionNo,
                listRevisions: () => api.listRevisions(),
                onProgress: log,
                isCancelled: () => token.isCancellationRequested,
            }),
    );

    switch (outcome.kind) {
        case "ready":
            return true;
        case "failed": {
            log(`버전 ${revisionNo} 빌드 실패${outcome.reason ? `\n${outcome.reason}` : ""}`);
            const choice = await vscode.window.showErrorMessage(
                say.buildFailed(tenant, revisionNo),
                ...(outcome.reason ? ["자세히 보기"] : []),
            );
            if (choice === "자세히 보기") output.show();
            return false;
        }
        case "timeout":
            void vscode.window.showWarningMessage(
                say.buildTimedOut(tenant, revisionNo),
            );
            return false;
        case "cancelled":
            log(`버전 ${revisionNo} 기다리기를 그만뒀습니다 — 빌드는 서버에서 계속됩니다.`);
            void vscode.window.showInformationMessage(say.buildWaitCancelled(tenant, revisionNo));
            return false;
        case "gone":
            void vscode.window.showWarningMessage(say.buildGone(tenant, revisionNo));
            return false;
    }
}

/**
 * 켤 수 있게 됐다고 알리고 **한 번 물어본다.**
 *
 * 자동으로 켜지 않는 이유가 여기 있다 — 확인 없이 켜면 잘못 고친 것이 바로 손님에게 간다.
 * 다만 "이제 켤 수 있다"는 사실까지 숨기면 사람이 콘솔을 뒤지게 된다. 알리되, 누르는 것은 사람이다.
 */
async function offerSwitch(revisionNo: number, tenant: CapturedTenant): Promise<void> {
    // 기다리는 동안 사이트를 바꿨을 수 있다. 그때 「지금 전환」을 그대로 두면 **다른 사이트를 켠다** —
    // 알리되 원클릭은 내린다. 판정은 core 가 하고 여기서는 그리기만 한다(시험이 그 판정을 잠근다).
    const prompt = decideReadyPrompt(tenant, tenantCode(), revisionNo);
    if (prompt.kind === "redirect") {
        void vscode.window.showInformationMessage(prompt.message);
        return;
    }
    const choice = await vscode.window.showInformationMessage(prompt.message, prompt.action);
    if (choice === prompt.action) await switchVersion(revisionNo, tenant);
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

    // 서버가 준 값이라도 그대로 고객 파일에 적지 않는다 — 이름은 **키**가 되어 동명 항목을 덮고,
    // 두 주소는 고객의 에이전트가 접속·로그인하러 가는 곳이다. 판정이 안 서면 **아무것도 안 적는다**
    // (매뉴얼과 달리 기본값으로 물러설 자리가 없다).
    const serverName = mcpServerName(config.mcp.serverName);
    const mcpUrl = httpUrl(config.mcp.sourceUrlTemplate.replace("{tenantCode}", encodeURIComponent(tenant)));
    const metadataUrl = httpUrl(config.mcp.authServerMetadataUrl);
    if (!serverName || !mcpUrl || !metadataUrl) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "서버가 보낸 에이전트 연결 정보를 쓸 수 없습니다.",
            "설정을 바꾸지 않았습니다. 잘커라에 문의해 주세요.",
        );
    }

    const result = await registerMcpServer(dir, {
        serverName,
        url: mcpUrl.toString(),
        clientId: config.mcp.clientId,
        authServerMetadataUrl: metadataUrl.toString(),
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
 * D5「이력」 — 버전 목록을 읽기 전용으로 보여 준다. 전환은 별도 명령(D4)이라 **여기서는 아무것도 바뀌지
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
    log(`(총 ${revisions.length}개 · 바꾸려면 「버전 전환」을 쓰세요)`);
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
    // 파일 이름은 **서버가 준 꾸러미의 항목명**에서 올 수 있다 — 우리가 지은 이름이 아니다.
    void vscode.window.showWarningMessage(`${plainNotice(relative, 120)} — ${ours(warning)}`);
}

// ── 진단 ────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
    const dir = workspaceDir();
    const checks = await runDoctor({
        apiBase: apiBase(),
        extensionVersion,
        ...(dir ? { projectDir: dir } : {}),
    });
    const runtime = embeddedNodeRuntime(extensionPath);
    output.show();
    log("── 진단 ──");
    {
        // ⚠ **경로까지 찍는다.** "동봉 npm 있음" 만으로는 신고를 받았을 때 어느 바이너리가 돌았는지
        //   물어볼 수 없다. 설정값·고른 결과·사유를 한 자리에 남긴다.
        const pref = npmPreference();
        const npm = resolveNpm(extensionPath, pref, npmBlindSpots(session?.projectDir));
        log(`${npm.kind === "unavailable" ? "❌" : "✅"} npm(설정 ${pref}): ${describeNpm(npm)}`);
        log(`   → ${npm.why}`);
        if (npm.kind === "unavailable") log(`   → ${npm.hint}`);
    }
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
    handshake = await fetchHandshake(apiBase(), extensionVersion);
    if (handshake.verdict === "UPGRADE_RECOMMENDED" && handshake.message) {
        // ⚠ **하루 한 번.** `ensureHandshake` 는 명령마다 불린다 — 억제가 없으면 창을 열 때마다,
        //   버튼을 누를 때마다 같은 알림이 뜬다. 새 권고 버전은 즉시 말한다.
        const key = "zalkera.upgradeNotice";
        const last = persistedState.get<UpgradeNoticeState>(key) ?? null;
        const target = handshake.recommendedExtensionVersion;
        // ⚠ `target` 을 **문장에 넣는다.** `shouldShowUpgradeNotice` 가 판 표기 형태를 강제하므로
        //   여기 도달한 값은 우리가 아는 모양이다 — 그 확인 없이 넣으면 서버가 문장을 쓰게 된다.
        if (shouldShowUpgradeNotice(target, last, Date.now())) {
            void persistedState.update(key, {version: target, shownAt: Date.now()});
            // Marketplace 를 우리가 조회하지 않는다(중복 UI · 새 실패 모드). 확장 뷰의 그 항목으로
            // 데려다 주기만 한다 — 설치·서명 판단은 VS Code 의 일이다.
            // **문장은 우리가 쓴다.** 서버 글자를 알림 본문에 얹으면, 그 글자를 정하는 쪽이 우리 이름으로
            // 뜨는 화면을 쓰게 된다(경계에서 소독은 하지만, 안 쓰는 편이 낫다). 서버 문장은 출력 채널에 남긴다.
            log(`서버 안내: ${handshake.message}`);
            const notice = `새 판이 있습니다(권고 ${target}). 지금 판은 ${extensionVersion} 입니다.`;
            // 바로 위에서 **우리가 조립한** 문장이다 — 서버 글자는 출력 채널에만 남긴다.
            void vscode.window.showInformationMessage(ours(notice), "업데이트").then((picked) => {
                if (picked === "업데이트") {
                    void vscode.commands.executeCommand("workbench.extensions.search", `@id:${extensionId}`);
                }
            });
        }
    }
    return handshake;
}

/**
 * 작업할 사이트를 고른다. **명령으로도, 곁다리로도 같은 경로**를 쓴다 — 두 벌이면 한쪽만 고쳐진다.
 *
 * @param force 이미 고른 사이트가 있어도 다시 묻는다(사이드바에서 바꾸려고 누른 경우).
 */
async function chooseTenant(force = false): Promise<string> {
    const config = await ensureHandshake();
    if (!(await store.read())) await signIn();

    const current = tenantCode();
    if (current && !force) return current;

    const api = new ZalkeraApi({
        apiBase: apiBase(),
        accessToken: () => getAccessToken(config.auth, store),
        tenantCode: () => "",
    });
    const { tenants, isSuperAdmin } = await api.whoAmI();

    // **목록이 비었다고 "사이트가 없다"가 아니다.** 서버는 소속(admin_user_tenant)만 열거하는데,
    // SUPER_ADMIN 은 소속과 무관하게 전 테넌트를 다룬다(`AdminUserAuth.canAccessTenant`).
    // 그 둘을 뭉뚱그리면 다 할 수 있는 사람에게 "권한이 없다"고 말하게 된다(실사용 신고).
    if (tenants.length === 0) {
        if (!isSuperAdmin) {
            throw new DevtoolsError(
                "FORBIDDEN",
                "이 계정에 연결된 사이트가 없습니다.",
                "잘커라 콘솔에서 사이트에 초대되었는지 확인해 주세요.",
            );
        }
        const typed = await vscode.window.showInputBox({
            title: "작업할 사이트 코드",
            prompt: "본사 관리자 계정입니다 — 사이트 코드를 직접 입력하세요.",
            placeHolder: "예: credium",
            ignoreFocusOut: true,
            validateInput: (value) =>
                /^[a-z0-9][a-z0-9-]{0,62}$/.test(value.trim()) ? undefined : "영문 소문자·숫자·하이픈만 씁니다.",
        });
        if (!typed) throw new DevtoolsError("CANCELLED", "사이트를 고르지 않았습니다.");
        const code = typed.trim();

        // **저장 전에 실재를 확인한다.** 형식만 맞으면 통과시키면, 오타 하나가 저장된 뒤
        // 프리뷰·발행에서 엉뚱한 오류로 튀어나온다 — 그때는 원인이 "설정에 적힌 코드"라는 걸
        // 사용자가 알 방법이 없다. 읽기 전용 호출 하나로 여기서 끝낸다.
        const probe = new ZalkeraApi({
            apiBase: apiBase(),
            accessToken: () => getAccessToken(config.auth, store),
            tenantCode: () => code,
        });
        try {
            await probe.listRevisions();
        } catch (error) {
            throw new DevtoolsError(
                "NOT_A_SITE",
                `'${code}' 사이트를 찾지 못했습니다.`,
                "사이트 코드를 다시 확인해 주세요. 잘커라 콘솔의 주소에서 볼 수 있습니다.",
                error,
            );
        }

        await saveTenant(code);
        return code;
    }
    // 하나뿐이어도 **바꾸려고 부른 경우엔 보여 준다** — 안 보여 주면 누른 사람이 무시당했다고 느낀다.
    const picked =
        tenants.length === 1 && !force
            ? tenants[0]
            : await vscode.window
                  .showQuickPick(
                      tenants.map((t) => ({
                          label: t.name,
                          description: t.code,
                          detail: t.code === current ? "지금 작업 중" : undefined,
                      })),
                      { title: "어느 사이트로 작업할까요?" },
                  )
                  .then((choice) => tenants.find((t) => t.code === choice?.description));
    if (!picked) throw new DevtoolsError("CANCELLED", "사이트를 고르지 않았습니다.");

    await saveTenant(picked.code);
    return picked.code;
}

/** 사이드바·팔레트에서 부르는 사이트 선택. 취소는 조용히 끝낸다. */
async function chooseSite(): Promise<void> {
    try {
        const code = await chooseTenant(true);
        log(`작업 사이트를 ${code} 로 바꿨습니다.`);
        await refreshSidebar();
        // `code` 는 서버 응답(`/api/me` 의 `tenants[].code`)이다 — 소독 없이 알림에 넣으면
        // 비-모달이 명령 링크로 렌더한다(재심의 실증).
        void vscode.window.showInformationMessage(`사이트: ${plainNotice(code, 64)}`);
    } catch (error) {
        if (error instanceof DevtoolsError && error.code === "CANCELLED") return;
        throw error;
    }
}

async function ensureApi(): Promise<ZalkeraApi> {
    return (await ensureApiFor()).api;
}

/**
 * API 와 **그 API 가 묶인 테넌트**를 함께 준다.
 *
 * ⚠ **표기는 동작이 묶인 테넌트를 적어야 한다**(심의 차단 · 2026-08-10). 종전에는 알림이 그리는
 * 시점에 `tenantCode()` 를 다시 읽었는데, 그 사이 사용자가 사이트를 바꿀 수 있다 — 빌드 대기는 수
 * 분이고 모달이 아니라서 사이드바가 열려 있다. 그러면 **A 에 올린 버전을 「B」라고 적고**, 「지금
 * 전환」이 실제로 B 를 전환한다(리비전 번호는 테넌트별 순번이라 겹친다).
 *
 * 사이트 이름을 적어 안심시키려던 트랜치가, 틀린 이름으로 **오인을 보증**하는 자리가 된다.
 */
async function ensureApiFor(): Promise<{ api: ZalkeraApi; tenant: CapturedTenant }> {
    const config = await ensureHandshake();
    // **여기가 유일한 캡처 지점이다.** 브랜드가 붙는 자리가 늘어나면 그것이 방어가 느슨해지는 신호다.
    const tenant = captureTenant(await chooseTenant());

    return {
        tenant,
        api: new ZalkeraApi({
            apiBase: apiBase(),
            accessToken: () => getAccessToken(config.auth, store),
            tenantCode: () => tenant,
        }),
    };
}

const API_BASE_DEFAULT = "https://api.zalkera.com";

/**
 * 서버 주소. **https 이거나 루프백**이어야 한다 — 이 주소가 준 값들이 로그인·에이전트 연결을
 * 지시하므로, 뿌리가 평문이면 중간에 앉은 쪽이 나머지를 전부 바꿔 쓴다.
 *
 * 설정 스키마의 `pattern` 만으로는 부족하다 — **이미 저장된 값**은 스키마를 다시 안 지난다.
 */
/**
 * 어느 npm 으로 설치할지의 사용자 선택. **머신 범위**라 남의 소스 폴더가 못 바꾼다 —
 * `apiBase` 와 같은 이유이고, 여기서는 **우리가 실행할 바이너리**가 걸려 있어 더 직접적이다.
 */
/**
 * npm 을 찾을 때 **보지 말아야 할 자리.** 열어 둔 폴더와 지금 다루는 소스 폴더가 온다.
 *
 * 이 도구의 기본 동작이 「남이 준 zip 을 풀어 그 폴더에서 명령을 돌리는 것」이라, 그 폴더는 언제나
 * 적대적일 수 있다고 본다. PATH 에 그 폴더 안쪽 항목이 들어와 있으면(직접 열린 터미널·direnv 등)
 * npm 찾기가 **그 폴더 안의 파일**을 집을 수 있다.
 */
function npmBlindSpots(projectDir?: string): string[] {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return [...folders, ...(projectDir ? [projectDir] : [])].filter((d) => d.length > 0);
}

function npmPreference(): NpmPreference {
    const raw = vscode.workspace.getConfiguration("zalkera").get<string>("npm");
    return raw === "system" || raw === "auto" ? raw : "bundled";
}

function apiBase(): string {
    const configured = vscode.workspace.getConfiguration("zalkera").get<string>("apiBase");
    if (configured === undefined || configured.trim() === "") return API_BASE_DEFAULT;
    const url = apiBaseUrl(configured);
    if (url) return url.toString();
    throw new DevtoolsError(
        "SERVER_REJECTED",
        `설정한 서버 주소를 쓸 수 없습니다(${configured}).`,
        "https 주소이거나 로컬(127.0.0.1)이어야 합니다. 설정 zalkera.apiBase 를 고쳐 주세요.",
    );
}

/**
 * 작업 사이트를 어디에 적을지 고른다.
 *
 * **폴더별로 다른 사이트를 다룰 수 있어야 하므로** 기본은 워크스페이스다. 그런데 폴더를 열지 않은
 * 창에서는 쓸 곳이 없어 VS Code 가 던진다 — `Unable to write to Workspace Settings because no
 * workspace is opened`(실사용 신고). 확장은 폴더 없이도 시작할 수 있으므로(사이트 선택 → 예제로
 * 시작 순서가 자연스럽다) 그때는 전역에 적는다. 뒤에 폴더를 열고 다시 고르면 그 폴더 값이 이긴다.
 */
function configTarget(): vscode.ConfigurationTarget {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}

async function saveTenant(code: string): Promise<void> {
    await vscode.workspace.getConfiguration("zalkera").update("tenant", code, configTarget());
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
