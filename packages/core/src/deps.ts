import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";
import { computePayloadKey, currentPlatform, evictOldCaches, tryFetchPayload, writePayloadStamp } from "./payload.ts";

/**
 * 의존성 준비(backend memo146 §3.2).
 *
 * 비개발자가 실제로 죽는 지점은 프리뷰 렌더가 아니라 `npm install` 이다 — 버전 충돌·네이티브 빌드·사내망
 * 프록시. 그래서 목표 형상은 **lockfile 해시 키 캐시**다: 한 번 만든 트리를 사용자 홈에 두고, 다음부터는
 * **하드링크**로 프로젝트에 연결한다(복사가 아니라 링크라 디스크가 거의 안 늘고 수백 ms 에 끝난다).
 *
 * 실측으로 못박힌 두 가지(§3.2):
 * - **심볼릭 링크는 안 된다** — Turbopack 이 "파일시스템 루트 밖을 가리킨다"며 거부한다.
 * - **하드링크는 같은 파일시스템에서만 된다** — `/tmp` ↔ `/home` 은 EXDEV 로 실패한다. 그래서 캐시 위치가
 *   프로젝트와 다른 볼륨이면 **복사로 폴백**한다(느리지만 도는 편이 낫다).
 *
 * 캐시 적재는 지금 `npm install` 이 한다(T2 착수 완화 — 페이로드를 굽는 CI 가 서면 그 자리만 갈아 끼운다).
 * 즉 **첫 사용자만 install 을 겪고, 같은 lockfile 을 쓰는 다음 프로젝트는 링크로 즉시 선다.**
 */
export interface DepsOptions {
    projectDir: string;
    /** 캐시 뿌리. 기본 `~/.zalkera/deps`. 프로젝트와 같은 볼륨이면 하드링크가 먹는다. */
    cacheRoot?: string;
    /** 진행 상황을 사람 말로 흘린다. */
    onProgress?: (message: string) => void;
    /**
     * `npm` 실행 방법. **기본값(`npm`)은 npm 이 PATH 에 있는 기계에서만 선다** — VS Code 는 Node 는 싣고
     * npm 은 안 싣기 때문에(T0 실측), 확장은 **반드시** 동봉한 npm 을 여기로 주입해야 한다.
     * 주입하지 않으면 비개발자 기계에서 `spawn` 이 ENOENT 로 죽고, 사용자는 "인터넷을 확인하세요"라는
     * 틀린 안내를 받는다(memo146 §3.2 ⚠ · §13 T-D2a).
     */
    npmCommand?: string[];
    /** npm 실행 환경 추가분. VS Code 동봉 Node 로 부르려면 `ELECTRON_RUN_AS_NODE=1` 이 필요하다. */
    npmEnv?: Record<string, string>;
    /**
     * 서버 주소. 주면 **캐시 미스 때 미리 구운 꾸러미를 먼저 물어본다**(§13.10.5 · T-D2c).
     * 안 주면 종전대로 곧장 `npm install` — 즉 이 배선은 **가산**이다.
     */
    apiBase?: string;
    fetchImpl?: typeof fetch;
}

export interface DepsResult {
    /** 이번 호출이 무엇을 했는가 — 관측·문서용. */
    action: "reused" | "linked" | "copied" | "installed";
    cacheKey: string;
}

export async function ensureDependencies(options: DepsOptions): Promise<DepsResult> {
    const { projectDir } = options;
    const cacheRoot = options.cacheRoot ?? join(homedir(), ".zalkera", "deps");
    const report = options.onProgress ?? (() => {});
    const cacheKey = await computeCacheKey(projectDir);
    const cacheDir = join(cacheRoot, cacheKey);
    const target = join(projectDir, "node_modules");

    // ⚠ **존재가 아니라 완결로 판정한다**(심의 차단 · 2026-08-03). 초판은 `existsSync(target)` 만 봤고,
    // 연결이 중간에 실패해 **반쯤 만들어진 트리**가 남으면 다음 실행이 그것을 "준비됨"으로 통과시켰다.
    // 그 뒤 dev 서버는 `Cannot find module` 로 죽고, 우리가 안내하는 복구책("의존성 준비를 다시 하세요")은
    // 같은 판정에 걸려 **아무 일도 하지 않는다** — 비개발자가 스스로 빠져나올 수 없는 자리였다.
    if (existsSync(join(target, COMPLETE_MARKER))) {
        report("의존성이 이미 준비돼 있습니다.");
        return { action: "reused", cacheKey };
    }
    if (existsSync(target)) {
        report("이전에 준비하다 만 의존성이 있어 지우고 다시 받습니다…");
        await rm(target, { recursive: true, force: true });
    }

    if (existsSync(join(cacheDir, "node_modules"))) {
        report("준비해 둔 의존성을 연결합니다…");
        const linked = await linkOrCopy(join(cacheDir, "node_modules"), target);
        await markComplete(target);
        return { action: linked, cacheKey };
    }

    // 캐시 미스 — **먼저 미리 구운 꾸러미를 물어본다**(§13.10.5). 실패·미존재는 전부 아래 npm 경로로
    // 수렴하므로, 이 블록은 있어도 없어도 결과가 같고 **빠를 때만 빠르다**.
    if (options.apiBase) {
        const payloadKey = await computePayloadKey(projectDir);
        if (payloadKey) {
            const payload = await tryFetchPayload({
                apiBase: options.apiBase,
                lockfileSha256: payloadKey,
                platform: currentPlatform(),
                cacheDir,
                onProgress: report,
                fetchImpl: options.fetchImpl,
            });
            if (payload) {
                await writePayloadStamp(cacheDir, payload, payloadKey);
                report(`준비된 의존성 ${payload.fileCount}개를 연결합니다…`);
                const linked = await linkOrCopy(join(cacheDir, "node_modules"), target);
                await markComplete(target);
                await evictOldCaches(cacheRoot, KEEP_CACHES, report);
                return { action: linked, cacheKey };
            }
        }
        // pnpm/yarn·lockfile 없음은 **조회조차 하지 않는다**(굽지 않으므로 항상 "없다"이고 왕복만 낭비다).
    }

    report("의존성을 처음 한 번 내려받습니다. 몇 분 걸릴 수 있습니다…");
    await runNpmInstall(projectDir, options.npmCommand ?? ["npm", "install"], options.npmEnv ?? {}, report);
    await seedCache(target, cacheDir, cacheKey, report);
    await markComplete(target);
    await evictOldCaches(cacheRoot, KEEP_CACHES, report);
    return { action: "installed", cacheKey };
}

/**
 * 남길 캐시 세대 수. 하드링크 트리라 **refcount 가 데이터를 지킨다** — 캐시를 지워도 이미 연결된
 * 프로젝트는 멀쩡하다(§13.5). 그래서 "쓰는 중인지"를 따지지 않는다.
 */
const KEEP_CACHES = 3;

/**
 * 캐시 키 = lockfile 내용 + 플랫폼. **플랫폼을 넣는 이유**는 네이티브 바이너리(SWC 등)가 OS·아키텍처마다
 * 다르기 때문이다 — 키에 안 넣으면 맥에서 만든 트리를 리눅스에 링크해 놓고 원인 모를 실패를 만난다.
 */
export async function computeCacheKey(projectDir: string): Promise<string> {
    const lockNames = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
    const hash = createHash("sha256");
    let found = false;
    for (const name of lockNames) {
        const path = join(projectDir, name);
        if (!existsSync(path)) continue;
        hash.update(name).update(await readFile(path));
        found = true;
        break;
    }
    if (!found) {
        // lockfile 이 없으면 재현 가능한 키를 만들 수 없다 — package.json 으로 대신하되 그 사실을 키에 남긴다.
        hash.update("no-lock").update(await readFile(join(projectDir, "package.json")));
    }
    hash.update(`${process.platform}-${process.arch}-node${process.versions.node.split(".")[0]}`);
    return hash.digest("hex").slice(0, 32);
}

/**
 * 하드링크 트리를 만든다. 실패하면 복사로 폴백한다.
 *
 * **하드링크가 기본인 이유**: 파일 내용을 복제하지 않아 디스크가 거의 안 늘고, 수만 개 파일이 수백 ms 에
 * 끝난다(실측 586MB·14,229파일 → 287ms). 복사는 같은 트리를 프로젝트마다 통째로 늘린다.
 *
 * **폴백이 필요한 이유**: 하드링크는 같은 파일시스템 안에서만 만들어진다. 캐시가 프로젝트와 다른 볼륨에
 * 있으면 첫 파일에서 `EXDEV` 가 난다 — 그때는 조용히 복사로 돌아선다(느린 것이 안 되는 것보다 낫다).
 * 판정은 **첫 실패 한 번으로 전체 모드를 바꾼다**(파일마다 예외를 삼키면 반쯤 링크된 트리가 남는다).
 */
async function linkOrCopy(source: string, target: string): Promise<"linked" | "copied"> {
    try {
        await hardlinkTree(source, target);
        return "linked";
    } catch (cause) {
        if (!isCrossDevice(cause)) {
            // **반쯤 만들어진 트리를 남기지 않는다**(심의 차단). 남기면 다음 실행이 그것을 "준비됨"으로 본다.
            await rm(target, { recursive: true, force: true }).catch(() => {});
            throw new DevtoolsError(
                "DEPENDENCIES_FAILED",
                "준비해 둔 의존성을 프로젝트에 연결하지 못했습니다.",
                "디스크 여유 공간과 폴더 권한을 확인해 주세요.",
                cause,
            );
        }
        // 다른 볼륨 — 반쯤 만들어진 트리를 지우고 복사로 다시 한다.
        await rm(target, { recursive: true, force: true });
        try {
            await cp(source, target, { recursive: true, verbatimSymlinks: true });
            return "copied";
        } catch (copyCause) {
            throw new DevtoolsError(
                "DEPENDENCIES_FAILED",
                "의존성을 프로젝트로 복사하지 못했습니다.",
                "디스크 여유 공간을 확인해 주세요.",
                copyCause,
            );
        }
    }
}

/** 디렉터리는 새로 만들고 파일은 링크한다. 심볼릭 링크는 **대상이 아니라 링크 자체를** 복제한다. */
async function hardlinkTree(source: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        const from = join(source, entry.name);
        const to = join(target, entry.name);
        if (entry.isDirectory()) {
            await hardlinkTree(from, to);
        } else if (entry.isSymbolicLink()) {
            await symlink(await readlink(from), to).catch((error: unknown) => {
                if (!isExists(error)) throw error;
            });
        } else {
            await link(from, to).catch((error: unknown) => {
                if (!isExists(error)) throw error;
            });
        }
    }
}

/** 완결 표식. 이것이 있어야 "준비됨"이다(존재만으로는 반쪽 트리와 구별되지 않는다). */
async function markComplete(target: string): Promise<void> {
    await writeFile(join(target, COMPLETE_MARKER), `${new Date().toISOString()}\n`, "utf8").catch(() => {});
}

const COMPLETE_MARKER = ".zalkera-deps-complete";

function isNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isCrossDevice(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV";
}

function isExists(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/** install 이 만든 트리를 캐시에 적재한다. 실패해도 진행을 막지 않는다 — 캐시는 편의지 필수가 아니다. */
async function seedCache(source: string, cacheDir: string, cacheKey: string, report: (m: string) => void): Promise<void> {
    try {
        await mkdir(cacheDir, { recursive: true });
        // ⚠ `verbatimSymlinks` 가 빠지면 Node 가 상대 심볼릭 링크를 **절대경로로 재작성**한다(심의 차단):
        // 캐시의 `.bin` 이 첫 프로젝트 경로에 못 박히고, 그 프로젝트를 지우면 **이 기계의 다른 모든 프로젝트가
        // 함께 깨진다**. 링크 연결 쪽(linkOrCopy)에는 있고 여기만 빠져 있었다.
        await cp(source, join(cacheDir, "node_modules"), { recursive: true, verbatimSymlinks: true });
        await writeFile(join(cacheDir, "key.txt"), `${cacheKey}\n`, "utf8");
    } catch {
        report("의존성 캐시 적재를 건너뜁니다(다음에 다시 받습니다).");
        await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function runNpmInstall(
    cwd: string,
    command: string[],
    env: Record<string, string>,
    report: (m: string) => void,
): Promise<void> {
    const [bin, ...args] = command;
    if (!bin) throw new DevtoolsError("DEPENDENCIES_FAILED", "npm 실행 방법을 알 수 없습니다.");

    await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (chunk: Buffer) => report(chunk.toString().trimEnd()));
        child.stderr?.on("data", (chunk: Buffer) => report(chunk.toString().trimEnd()));
        child.on("error", (cause) =>
            reject(
                // ⚠ 실행 자체가 안 된 것(ENOENT)과 받다가 실패한 것을 **구분한다**. 종전에는 둘 다
                // "인터넷을 확인하세요"로 안내해, npm 이 없는 기계의 사용자를 엉뚱한 곳으로 보냈다.
                new DevtoolsError(
                    "DEPENDENCIES_FAILED",
                    isNotFound(cause)
                        ? "의존성 설치 도구를 실행하지 못했습니다."
                        : "의존성을 내려받지 못했습니다.",
                    isNotFound(cause)
                        ? "확장을 다시 설치해 보세요. 그래도 같으면 잘커라에 문의해 주세요."
                        : "인터넷 연결이나 사내망 프록시 설정을 확인해 주세요.",
                    cause,
                ),
            ),
        );
        child.on("close", (code) => {
            if (code === 0) return resolve();
            reject(
                new DevtoolsError(
                    "DEPENDENCIES_FAILED",
                    `의존성 설치가 실패했습니다(종료 코드 ${code}).`,
                    "위 로그의 마지막 오류를 확인하거나, 잘커라에 문의해 주세요.",
                ),
            );
        });
    });
    await stat(join(cwd, "node_modules")).catch(() => {
        throw new DevtoolsError("DEPENDENCIES_FAILED", "설치는 끝났지만 의존성 폴더가 없습니다.");
    });
}
