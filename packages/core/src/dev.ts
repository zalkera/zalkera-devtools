import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";

/**
 * 개발 서버 기동(C1·C4·C5).
 *
 * **npm 스크립트를 부르지 않고 Next 바이너리를 직접 부른다** — VS Code 는 Node 는 싣지만 **npm 은 안 싣기**
 * 때문이다(실측). `node node_modules/next/dist/bin/next dev` 는 Node 하나만 있으면 돈다.
 *
 * 실행 Node 도 주입받는다: 확장은 VS Code 동봉 Node(`process.execPath` + `ELECTRON_RUN_AS_NODE`)를 넘기고,
 * CLI 는 자기 Node 를 넘긴다. 이 한 줄이 "비개발자가 Node 를 안 깔아도 된다"의 전부다.
 */
export interface DevServerOptions {
    projectDir: string;
    /** 실행할 Node 경로. 확장은 VS Code 동봉 Node 를 넘긴다. */
    nodePath: string;
    /** 원하는 포트(비면 자동). 이미 쓰이면 빈 포트를 찾는다. */
    port?: number;
    /** 로그 한 줄씩. 흔한 오류는 [translateLog] 가 사람 말로 바꿔 준다. */
    onLog?: (line: string) => void;
    /** 서버가 요청을 받을 준비가 됐을 때 1회. */
    onReady?: (url: string) => void;
    /** VS Code 동봉 Node 를 쓰려면 `ELECTRON_RUN_AS_NODE=1` 이 필요하다. */
    extraEnv?: Record<string, string>;
    /**
     * 취소. **첫 컴파일 대기가 이 함수에서 제일 긴 구간**이라 여기까지 와야 취소가 뜻을 갖는다.
     *
     * 종전에는 호출부(`preview.ts`)가 설치 뒤에 점 검사 한 번만 했다. 그래서 사각이
     * 「설치 직후」에서 **「Next 첫 컴파일(최대 2분)」으로 옮겨갔을 뿐**이었다 — 사용자가 취소를
     * 누를 확률이 가장 높은 바로 그 구간이다. 취소가 무시되면 예외가 안 나므로 호출부의
     * 정리(발급한 프리뷰 키 폐기)도 안 돌고, 세션이 서고 브라우저 탭이 열린다.
     */
    signal?: AbortSignal;
}

export interface DevServer {
    url: string;
    port: number;
    /** 멈춘다(멱등). 자식 프로세스 트리를 정리한다. */
    stop(): Promise<void>;
    /** 프로세스가 끝났을 때(정상·비정상 모두). */
    onExit(listener: (code: number | null) => void): void;
}

const READY_TIMEOUT_MS = 120_000;

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
    const nextBin = join(options.projectDir, "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(nextBin)) {
        throw new DevtoolsError(
            "DEV_SERVER_FAILED",
            "개발 서버를 찾지 못했습니다.",
            "의존성 준비가 끝났는지 확인해 주세요.",
        );
    }

    const port = await pickPort(options.port);
    const url = `http://localhost:${port}`;
    const log = options.onLog ?? (() => {});

    const child = spawn(options.nodePath, [nextBin, "dev", "--port", String(port)], {
        cwd: options.projectDir,
        env: { ...process.env, ...options.extraEnv, PORT: String(port), BROWSER: "none" },
        stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const markReady = () => {
        if (ready) return;
        ready = true;
        options.onReady?.(url);
    };

    const handle = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
            const trimmed = line.trimEnd();
            if (trimmed.length === 0) continue;
            log(translateLog(trimmed));
            // Next 는 준비되면 "Ready in ..." 을 찍는다. 판정을 포트 폴링이 아니라 로그로 하는 이유는
            // 포트가 열려도 첫 컴파일 전에는 응답이 없기 때문이다.
            if (/\bReady in\b|started server on|Local:\s+http/i.test(trimmed)) markReady();
        }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);

    const exitListeners: ((code: number | null) => void)[] = [];
    child.on("exit", (code) => {
        for (const listener of exitListeners) listener(code);
    });

    await waitForReady(child, () => ready, options.signal);

    return {
        url,
        port,
        stop: () => stopChild(child),
        onExit: (listener) => exitListeners.push(listener),
    };
}

/** 요청한 포트가 막혀 있으면 OS 가 준 빈 포트를 쓴다 — 고정 포트 충돌로 사람을 붙잡지 않는다. */
export async function pickPort(preferred?: number): Promise<number> {
    if (preferred && (await isFree(preferred))) return preferred;
    return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

async function isFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

/**
 * "Ready" 가 뜰 때까지 기다린다.
 *
 * ⚠ **타임아웃은 자식을 죽인다**(심의 차단 · 2026-08-10). 종전에는 reject 만 하고 프로세스를 그대로
 * 뒀다. 그런데 이 함수가 던지면 [DevServer] 가 **반환되지 않으므로 `stop` 핸들 자체가 없다** — 즉
 * 확장에서 끌 방법이 사라진다. 저사양 기계의 첫 컴파일이 상한을 넘는 일은 흔하고, 그때 사용자는
 * "안 떴습니다"를 보는데 서버는 뒤에서 계속 떠서 **프리뷰 키를 든 채 UI 밖에 남았다.**
 * 안 떴다고 말했으면 실제로 없어야 한다 — 거짓 실패는 거짓 성공만큼 나쁘다.
 */
async function waitForReady(child: ChildProcess, isReady: () => boolean, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            clearInterval(poll);
            // 마지막 poll 틱과 이 타이머 사이(≤100ms)에 "Ready" 가 왔을 수 있다. 그때 죽이면
            // **다 뜬 서버를 죽이고 실패라고 말하는** 것이 된다 — 고치려던 거짓 실패의 거울상이다.
            if (isReady()) {
                clearTimeout(timer);
                resolve();
                return;
            }
            // 던지기 **전에** 죽인다. 뒤에 두면 호출부가 먼저 정리를 시도한다.
            void stopChild(child);
            reject(
                new DevtoolsError(
                    "DEV_SERVER_FAILED",
                    "개발 서버가 시간 안에 뜨지 않았습니다.",
                    "로그의 마지막 오류를 확인해 주세요. 뜨다 만 서버는 정리했습니다.",
                ),
            );
        }, READY_TIMEOUT_MS);
        timer.unref?.();

        const poll = setInterval(() => {
            if (!isReady()) return;
            clearInterval(poll);
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, 100);
        poll.unref?.();

        // ⚠ **취소는 자식을 죽이고 나서 던진다** — 타임아웃 갈래와 같은 순서다. 뒤에 두면 호출부가
        //   먼저 정리를 시도하고 뜨다 만 서버가 남는다. Ready 와 취소가 겹쳐도 사용자의 뜻을 따른다:
        //   이미 「취소」를 눌렀으므로 다 뜬 서버라도 세우지 않는다.
        function onAbort(): void {
            clearInterval(poll);
            clearTimeout(timer);
            void stopChild(child);
            reject(new DevtoolsError("CANCELLED", "준비를 취소했습니다."));
        }
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener("abort", onAbort, {once: true});

        child.once("exit", (code) => {
            if (isReady()) return;
            clearInterval(poll);
            clearTimeout(timer);
            reject(
                new DevtoolsError(
                    "DEV_SERVER_FAILED",
                    `개발 서버가 바로 종료되었습니다(종료 코드 ${code}).`,
                    "로그의 마지막 오류를 확인해 주세요.",
                ),
            );
        });
    });
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
        }, 5_000);
        timer.unref?.();
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * 흔한 오류를 **사람 말로 옮긴다**(C3). 원문을 지우지 않고 앞에 한 줄을 붙인다 — 개발자가 볼 근거는 남긴다.
 */
export function translateLog(line: string): string {
    if (/EADDRINUSE/.test(line)) return `⚠ 그 포트는 다른 프로그램이 쓰고 있습니다. 다른 포트로 다시 켜 주세요.\n${line}`;
    if (/Cannot find module/.test(line)) return `⚠ 필요한 파일이 빠졌습니다. 의존성 준비를 다시 해 주세요.\n${line}`;
    if (/ENOSPC/.test(line)) return `⚠ 디스크 공간이 부족합니다.\n${line}`;
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(line)) {
        return `⚠ 서버에 연결하지 못했습니다. 인터넷·사내망 프록시를 확인해 주세요.\n${line}`;
    }
    // ⚠ **이 줄은 한 번도 발화하지 않았다**(실측). `@zalkera/client` 가 키 거절에서 내는 것은
    //    HTTP 숫자가 아니라 **사람용 한국어 문면**이고(`STOREFRONT_KEY_MESSAGES`), 그 문장에는
    //    `401`·`403` 이 없다. 실측한 네 형태 전부 종전 조건(`/401|403/` ∧ `/storefront|zalkera/i`)에
    //    안 걸렸다:
    //
    //      ZalkeraError: 스토어프론트 시크릿 키가 필요합니다. …ZALKERA_STOREFRONT_KEY…
    //      ZalkeraError: secretKey 가 tenant 옵션과 다른 테넌트의 키입니다. …
    //      at async getSiteConfig (…/@zalkera/client/dist/index.js:…)
    //      Error: Failed to fetch site config (401)
    //
    //    그래서 **두 갈래로 본다** — 우리 클라이언트가 내는 키 문면, 그리고 남이 만든 숫자 형태.
    //    문자열 매칭이라 문면이 바뀌면 다시 죽는다. 틀려도 해는 없다(원문이 그대로 나간다).
    //    `dev.translateLog.test.ts` 가 실제 클라이언트 문면으로 이 두 갈래를 못 박는다.
    if (
        (/ZalkeraError/.test(line) && /시크릿 키|secretKey|ZALKERA_STOREFRONT_KEY|테넌트의 키/.test(line)) ||
        (/\b(401|403)\b/.test(line) && /storefront|zalkera/i.test(line))
    ) {
        return (
            `⚠ 데이터 접속이 거절되었습니다 — 프리뷰 자격증명이 해제됐거나 만료됐습니다.\n` +
            `   자격증명은 **한 번에 하나**라, 다른 기계(또는 다른 창)에서 프리뷰를 켜면 이쪽이 끊깁니다.\n` +
            `   프리뷰를 다시 켜 주세요.\n${line}`
        );
    }
    return line;
}
