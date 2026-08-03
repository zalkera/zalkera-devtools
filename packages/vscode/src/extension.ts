import * as vscode from "vscode";
import {
    DevtoolsError,
    fetchHandshake,
    fetchSiteSource,
    findProjectRoot,
    getAccessToken,
    login,
    logout,
    publish,
    runDoctor,
    startPreview,
    stripCredentials,
    ZalkeraApi,
    type DevServer,
    type FetchSourceResult,
    type Handshake,
    type PreviewSession,
    type PublishResult,
} from "@zalkera/devtools-core";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SecretTokenStore } from "./secretStore.ts";
import { embeddedNodeRuntime } from "./runtime.ts";

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
let session: { server: DevServer; projectDir: string } | null = null;
let store: SecretTokenStore;
let handshake: Handshake | null = null;

const EXTENSION_VERSION = "0.1.0";

export function activate(context: vscode.ExtensionContext): void {
    output = vscode.window.createOutputChannel("잘커라");
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    status.command = "zalkera.preview.start";
    setStatus("$(zap) 잘커라");
    status.show();
    store = new SecretTokenStore(context);

    context.subscriptions.push(
        output,
        status,
        register("zalkera.signIn", signIn),
        register("zalkera.signOut", signOut),
        register("zalkera.site.open", openSite),
        register("zalkera.site.link", linkFolder),
        register("zalkera.preview.start", startPreviewCommand),
        register("zalkera.preview.stop", stopPreview),
        register("zalkera.preview.restart", async () => {
            await stopPreview();
            await startPreviewCommand();
        }),
        register("zalkera.publish", publishCommand),
        register("zalkera.doctor", doctor),
    );
}

export async function deactivate(): Promise<void> {
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
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "잘커라 로그인 — 브라우저에서 계속하세요" },
        async () => {
            await login(config.auth, store, {
                // 브라우저를 여는 방법만 확장이 안다 — 나머지 흐름은 코어가 갖는다.
                openBrowser: async (url) => {
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                },
            });
        },
    );
    log("로그인했습니다.");
    void vscode.window.showInformationMessage("잘커라에 로그인했습니다.");
}

async function signOut(): Promise<void> {
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
    void vscode.window.showInformationMessage("로그아웃했습니다.");
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
    const dir = requireWorkspace();
    const api = await ensureApi();
    const config = await ensureHandshake();
    const runtime = embeddedNodeRuntime();

    setStatus("$(sync~spin) 프리뷰 준비 중");
    const started = await vscode.window.withProgress<PreviewSession>(
        { location: vscode.ProgressLocation.Notification, title: "프리뷰를 준비하는 중" },
        () =>
            startPreview({
                projectDir: dir,
                api,
                apiBase: apiBase(),
                tenantCode: tenantCode(),
                nodePath: runtime.nodePath,
                extraEnv: runtime.env,
                label: `${vscode.env.appName} · ${process.platform}`,
                onProgress: log,
                onLog: log,
            }),
    );

    session = { server: started.server, projectDir: dir };
    started.server.onExit((code) => {
        session = null;
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
    if (started.expiresAt) log(`프리뷰 자격증명 만료: ${new Date(started.expiresAt).toLocaleString("ko-KR")}`);

    // **웹뷰가 아니라 실제 브라우저로 연다**(§3.5) — 웹뷰는 쿠키·CSP 가 실제 탭과 달라
    // "로컬에선 됐는데 배포하니 다르다"를 만드는 정확한 자리다.
    await vscode.env.openExternal(vscode.Uri.parse(started.server.url));
}

async function stopPreview(): Promise<void> {
    if (!session) return;
    await session.server.stop();
    session = null;
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

// ── 진단 ────────────────────────────────────────────────────────────────

async function doctor(): Promise<void> {
    const dir = workspaceDir();
    const checks = await runDoctor({
        apiBase: apiBase(),
        extensionVersion: EXTENSION_VERSION,
        ...(dir ? { projectDir: dir } : {}),
    });
    output.show();
    log("── 진단 ──");
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

function setStatus(text: string): void {
    status.text = text;
    status.tooltip = session ? `프리뷰 실행 중 — ${session.server.url}` : "잘커라 프리뷰 시작";
}

function log(message: string): void {
    output.appendLine(message);
}
