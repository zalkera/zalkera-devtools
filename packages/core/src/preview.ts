import type { ZalkeraApi } from "./api.ts";
import { ensureDependencies } from "./deps.ts";
import { startDevServer, type DevServer } from "./dev.ts";
import { writePreviewEnv } from "./env.ts";
import { ensureEnvIgnored, inspectProject } from "./project.ts";

/**
 * 프리뷰 한 판(C1) — **이 트랜치의 존재 이유**를 한 함수로 묶는다.
 *
 * 순서에 뜻이 있다: 프로젝트 확인 → `.gitignore` 보정 → **키 발급** → `.env.local` 조립 → 의존성 →
 * 개발 서버. 키 발급을 의존성보다 **먼저** 하는 이유는, 권한이 없어 못 받을 사람에게 5분짜리 설치를
 * 시킨 뒤에 거절을 통보하지 않기 위해서다(순수 STAFF 계정은 프리뷰 키를 못 받는다).
 */
export interface PreviewOptions {
    projectDir: string;
    api: ZalkeraApi;
    apiBase: string;
    tenantCode: string;
    /** 실행할 Node. 확장은 VS Code 동봉 Node 를 넘긴다. */
    nodePath: string;
    label?: string;
    port?: number;
    extraEnv?: Record<string, string>;
    onProgress?: (message: string) => void;
    onLog?: (line: string) => void;
}

export interface PreviewSession {
    server: DevServer;
    /** 이 세션이 쓰는 프리뷰 키 id — 로그아웃·중지에서 **폐기**하려면 필요하다. */
    keyId: number;
    /** 이 발급으로 끊긴 다른 기계의 프리뷰 수 — 0 이 아니면 사람에게 알려야 한다. */
    revokedPrevious: number;
    /** 키 만료 시각(ISO). 확장은 이 시각 전에 재발급한다(C6). */
    expiresAt: string | null;
}

export async function startPreview(options: PreviewOptions): Promise<PreviewSession> {
    const report = options.onProgress ?? (() => {});

    const project = await inspectProject(options.projectDir);
    report(`사이트 소스를 확인했습니다: ${project.name}`);

    const ignored = await ensureEnvIgnored(options.projectDir);
    // 침묵은 이 자리에서 위험하다 — 자격증명이 레포로 갈 수 있는 상태를 말하지 않고 넘어가지 않는다.
    if (ignored === "added") report(".gitignore 에 .env.local 을 추가했습니다(자격증명 커밋 방지).");
    if (ignored === "created") report(".gitignore 를 만들어 .env.local 을 제외했습니다(자격증명 커밋 방지).");

    report("프리뷰 자격증명을 발급받는 중…");
    const key = await options.api.issuePreviewKey(options.label);

    const deps = await ensureDependencies({ projectDir: options.projectDir, onProgress: report });
    if (deps.action === "installed") report("의존성 준비가 끝났습니다(다음부터는 즉시 시작합니다).");

    // 포트를 먼저 정한다 — `ZALKERA_SITE_URL` 이 실제 주소와 달라지면 링크·정규 URL 이 어긋난다.
    const server = await startDevServerWithEnv(options, key.key, key.envName);

    return { server, keyId: key.id, revokedPrevious: key.revokedPrevious, expiresAt: key.expiresAt };
}

async function startDevServerWithEnv(
    options: PreviewOptions,
    storefrontKey: string,
    envName: string,
): Promise<DevServer> {
    const { pickPort } = await import("./dev.ts");
    const port = await pickPort(options.port);

    // 서버가 알려 준 칸 이름을 **실제로 쓴다**(심의 경고 — 주석은 "하드코딩하지 않는다"인데 실물은 리터럴이었다).
    // 서버가 이름을 바꾸면 확장을 안 고쳐도 따라간다. 모르는 이름이면 계약의 기본값으로 떨어진다.
    if (envName !== "ZALKERA_STOREFRONT_KEY") {
        options.onProgress?.(`서버가 알려 준 자격증명 칸 이름을 씁니다: ${envName}`);
    }
    await writePreviewEnv(options.projectDir, {
        ZALKERA_API_BASE: options.apiBase,
        ZALKERA_TENANT: options.tenantCode,
        ZALKERA_STOREFRONT_KEY: storefrontKey,
        ZALKERA_SITE_URL: `http://localhost:${port}`,
        NEXT_PUBLIC_ZALKERA_PREVIEW: "1",
    });

    return startDevServer({
        projectDir: options.projectDir,
        nodePath: options.nodePath,
        port,
        ...(options.onLog ? { onLog: options.onLog } : {}),
        ...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
    });
}
