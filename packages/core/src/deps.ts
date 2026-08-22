import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, link, mkdir, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DevtoolsError } from "./errors.ts";
import { computePayloadKey, currentPlatform, evictOldCaches, tryFetchPayload, writePayloadStamp } from "./payload.ts";

/**
 * 의존성 준비(backend memo146 §3.2).
 *
 * 비개발자가 실제로 죽는 지점은 미리보기 렌더가 아니라 `npm install` 이다 — 버전 충돌·네이티브 빌드·사내망
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
    /**
     * 취소 신호. 첫 설치는 수 분이고, 사내망 프록시에 물리면 자식이 **끝나지 않는다** — 그때
     * 사용자가 멈출 수 있어야 한다. 안 주면 종전과 같이 취소할 수 없다(호출부가 명시적으로 정한다).
     */
    signal?: AbortSignal;
    /** 캐시 뿌리. 기본 `~/.zalkera/deps`. 프로젝트와 같은 볼륨이면 하드링크가 먹는다. */
    cacheRoot?: string;
    /** 진행 상황을 사람 말로 흘린다. */
    onProgress?: (message: string) => void;
    /**
     * `npm` 실행 방법. **필수다** — 기본값 `["npm","install"]` 은 npm 이 PATH 에 있는 기계에서만 서는데
     * VS Code 는 Node 는 싣고 npm 은 안 싣는다(실측). 비개발자 기계에서 `spawn` 이 ENOENT 로 죽고
     * 사용자는 "인터넷을 확인하세요"라는 틀린 안내를 받는다.
     *
     * ⚠ 종전에는 선택 항목이고 *"확장은 **반드시** 주입해야 한다"* 는 **주석만** 있었다. 주석은 안 물고,
     * 호출부는 늘어난다. 지금은 타입이 문다 — [npmArgvOf] 로 만들어 넘긴다.
     */
    npmCommand: string[];
    /** npm 실행 환경 추가분. VS Code 동봉 Node 로 부르려면 `ELECTRON_RUN_AS_NODE=1` 이 필요하다. */
    npmEnv?: Record<string, string>;
    /**
     * 서버 주소. 주면 **캐시 미스 때 미리 구운 꾸러미를 먼저 물어본다**(§13.10.5 · T-D2c).
     * 안 주면 종전대로 곧장 `npm install`.
     *
     * ⚠ **"안 주면 완전히 종전과 같다"는 아니다**(심의 W4 · 종전 주석이 그렇게 적어 거짓이었다):
     * 캐시 폐기([KEEP_CACHES])는 **양쪽 공통**으로 돈다. 세대당 586MB 라 무한 증식이 그 자체로 결함이고,
     * 페이로드를 쓰든 안 쓰든 같은 문제이기 때문이다. 기존 사용자는 이 배포부터 3세대 초과분을 잃는다
     * (재생성 가능한 캐시라 손실이 아니지만, **말없이 바뀌는 것은 아니어야** 한다).
     */
    apiBase?: string;
    fetchImpl?: typeof fetch;
}

export interface DepsResult {
    /** 이번 호출이 무엇을 했는가 — 관측·문서용. */
    action: "reused" | "linked" | "copied" | "installed";
    cacheKey: string;
}

/**
 * 자식 프로세스가 **뜨지 못한** 원인을 사람 말로 옮긴다. 갈래 셋이 서로 다른 행동을 요구한다.
 *
 * ⚠ **취소는 오류가 아니다.** `signal` 로 끊으면 여기에 `AbortError` 가 온다. 종전에는 그것도
 *   "인터넷 연결이나 사내망 프록시 설정을 확인해 주세요"로 안내해, 취소를 누른 사람에게 **빨간
 *   오류창**이 떴다(재심의 지적). 형제 `signIn` 은 `CANCELLED` 를 조용히 삼키는데 이 경로만 그
 *   구분이 없었다. `register()` 가 이 코드를 보고 삼킨다.
 *
 * ⚠ 실행 자체가 안 된 것(ENOENT)과 받다가 실패한 것도 **구분한다**. 종전에는 둘 다 "인터넷을
 *   확인하세요"로 안내해, npm 이 없는 기계의 사용자를 엉뚱한 곳으로 보냈다.
 *
 * 갈래를 판별하는 일과 자식 프로세스를 띄우는 일을 갈라 둔다 — 아니면 이 판정을 확인하는 데
 * 매번 실제 설치를 돌려야 한다.
 */
export function spawnFailure(cause: unknown): DevtoolsError {
    if (cause instanceof Error && cause.name === "AbortError") {
        return new DevtoolsError("CANCELLED", "준비를 취소했습니다.");
    }
    const missing = isNotFound(cause);
    return new DevtoolsError(
        "DEPENDENCIES_FAILED",
        missing ? "의존성 설치 도구를 실행하지 못했습니다." : "의존성을 내려받지 못했습니다.",
        missing
            ? "확장을 다시 설치해 보세요. 그래도 같으면 잘커라에 문의해 주세요."
            : "인터넷 연결이나 사내망 프록시 설정을 확인해 주세요.",
        cause,
    );
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
    // ⚠ **표식을 프로젝트 안에 두지 않는다.** 종전에는 `node_modules/.zalkera-deps-complete` 를 봤는데,
    //   그 자리는 **받은 zip 이 담을 수 있다.** 담아 오면 우리가 준비를 통째로 건너뛰고 zip 이 가져온
    //   `node_modules` 를 그대로 실행한다 — 어느 npm 을 쓸지 고르는 장치가 한 번도 안 돈다.
    //   지금은 **우리만 쓰는 자리**에 두고, 트리가 실제로 있는지와 **함께** 본다.
    const doneAt = completionPath(cacheRoot, projectDir, cacheKey);
    if (existsSync(doneAt) && existsSync(target)) {
        report("의존성이 이미 준비돼 있습니다.");
        return { action: "reused", cacheKey };
    }
    // ⚠ **여기서 `node_modules` 를 지우지 않는다.**
    //
    //   종전에는 완결 표식이 없으면 트리를 통째로 지우고 "이전에 준비하다 만 의존성이 있어
    //   지우고 다시 받습니다" 라고 말했다. 표식은 **우리가 처음 돌 때만** 생기므로, 고객이 이미
    //   `npm install` 해 둔 폴더를 「사이트에 연결」(배송 문서가 안내하는 흐름)로 붙이면 **첫 실행에서
    //   무조건** 그 분기를 탄다 — 고객 트리는 멀쩡했는데 우리 표식이 없었을 뿐이다. 그리고 그
    //   문장은 거짓이다.
    //
    //   피해가 문면에 그치지 않는다: 우리는 `--ignore-scripts` 로 설치하므로 postinstall 이 필요한
    //   꾸러미(esbuild·sharp 류)는 **원래보다 나쁜 상태**로 돌아오고, 사내망에서 재설치가 실패하면
    //   옛 트리도 새 트리도 없다.
    //
    //   지울 이유도 없다 — 우리가 부르는 것은 `npm ci` 가 아니라 **`npm install`** 이고, 그것은
    //   락파일 기준으로 기존 트리를 **조정**한다. 반쪽 설치도 그 자리에서 메워진다.

    if (isCacheComplete(cacheDir)) {
        report("준비해 둔 의존성을 연결합니다…");
        // **쓴 시각을 남긴다**(심의 관찰). 안 하면 폐기 기준이 "최근 생성"이라, 네 세대 이상을 오가는
        // 사용자의 **활발한 세대가 먼저 지워진다**(그리고 재설치를 다시 겪는다).
        await utimes(cacheDir, new Date(), new Date()).catch(() => {});
        const linked = await linkOrCopy(join(cacheDir, "node_modules"), target);
        await markComplete(doneAt);
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
                // 표식을 **연결 전에** 남긴다 — 이 줄이 캐시 쪽 완결 판정의 근거다(아래 isCacheComplete).
                await writePayloadStamp(cacheDir, payload, payloadKey);
                report(`준비된 의존성 ${payload.fileCount}개를 연결합니다…`);
                const linked = await linkOrCopy(join(cacheDir, "node_modules"), target);
                await markComplete(doneAt);
                await evictOldCaches(cacheRoot, KEEP_CACHES, report, cacheDir);
                return { action: linked, cacheKey };
            }
        }
        else {
            // pnpm/yarn·lockfile 없음은 **조회조차 하지 않는다**(굽지 않으므로 항상 "없다"이고 왕복만 낭비다).
            // 그래도 **말은 한다**(심의 W6) — 침묵하면 "왜 나만 느린가"를 사용자도 우리도 설명할 수 없다.
            // ⚠ 문구를 정확히 한다(재심의 관찰 1): 우리가 굽는 것은 `package-lock.json` 세대뿐이다.
            // "npm lockfile 이 필요합니다"는 `npm-shrinkwrap.json` 사용자에게 거짓이 된다.
            report("이 프로젝트는 미리 준비된 꾸러미를 쓸 수 없어 직접 내려받습니다(package-lock.json 이 필요합니다).");
        }
    }

    // **말없이 다르게 설치하지 않는다.** 설치 스크립트는 안 돌린다(받은 폴더에서 도는 설치라
    // 그 스크립트가 곧 임의 코드다). 그 결정이 이 프로젝트에 영향을 준다면 이름을 대고 말한다.
    const needsScripts = await installScriptPackages(projectDir);
    if (needsScripts.length) {
        report(
            `설치 스크립트가 필요한 꾸러미가 ${needsScripts.length}개 있습니다(${needsScripts.slice(0, 3).join(", ")}` +
                `${needsScripts.length > 3 ? " 외" : ""}). 안전을 위해 실행하지 않았습니다 — 이 꾸러미가 제대로 안 설 수 있습니다.`,
        );
    }
    report("의존성을 처음 한 번 내려받습니다. 몇 분 걸릴 수 있습니다…");
    await runNpmInstall(projectDir, options.npmCommand, options.npmEnv ?? {}, report, options.signal);
    await seedCache(target, cacheDir, cacheKey, report);
    await markComplete(doneAt);
    await evictOldCaches(cacheRoot, KEEP_CACHES, report, cacheDir);
    return { action: "installed", cacheKey };
}

/**
 * 캐시 세대가 **완결**인가. 존재가 아니라 표식으로 판정한다(3회차 심의 경고 4).
 *
 * 종전엔 `cacheDir/node_modules` 의 **존재만** 봤다. 586MB 해제 도중 프로세스가 죽으면 반쪽 트리가 남고,
 * 다음 실행은 그것을 링크한 뒤 완결 표식까지 찍는다 — 사용자는 "준비 완료"를 본 뒤 `Cannot find module`
 * 을 만나고, 우리가 안내하는 복구책은 같은 판정에 걸려 아무 일도 안 한다. **프로젝트 쪽에서 이미 한 번
 * 겪고 고친 결함의 캐시판**이다(위 COMPLETE_MARKER 주석).
 *
 * 표식은 새로 만들지 않고 이미 쓰던 둘을 쓴다 — `key.txt`(npm 경로가 적재 끝에 쓴다) ·
 * `payload.json`(페이로드 경로가 연결 전에 쓴다). 기존 사용자의 캐시도 `key.txt` 를 갖고 있어 그대로 산다.
 */
function isCacheComplete(cacheDir: string): boolean {
    if (!existsSync(join(cacheDir, "node_modules"))) return false;
    return existsSync(join(cacheDir, "key.txt")) || existsSync(join(cacheDir, "payload.json"));
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
    // **`.npmrc` 도 트리를 정한다.** `registry=` 한 줄이면 같은 lockfile 에서 **다른 꾸러미**가 온다.
    // 종전에는 키가 그것을 안 세서, 조작된 `.npmrc` 로 만든 트리가 **정상 lockfile 의 키**로 캐시에
    // 적재됐다 — 시작 팩이 공통이라 lockfile 이 겹치는 것이 이 제품의 정상 형상이므로 남의 사이트가
    // 그 트리를 이어받는다. 없다는 사실도 키에 남긴다(있다가 없어진 것과 처음부터 없던 것은 다르다).
    const npmrc = join(projectDir, ".npmrc");
    hash.update(existsSync(npmrc) ? Buffer.concat([Buffer.from("npmrc:"), await readFile(npmrc)]) : Buffer.from("no-npmrc"));
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

/**
 * 락파일이 **설치 스크립트를 쓴다고 적은** 꾸러미들. 없으면 빈 배열.
 *
 * 락파일을 읽는 이유는 설치 **전에** 알아야 하기 때문이다 — 설치 뒤에 말하면 이미 늦다.
 * 락파일이 없거나 못 읽으면 빈 배열이다. 여기서 던지면 설치가 그 이유로 막힌다.
 */
export async function installScriptPackages(projectDir: string): Promise<string[]> {
    const lock = join(projectDir, "package-lock.json");
    if (!existsSync(lock)) return [];
    try {
        const parsed = JSON.parse(await readFile(lock, "utf8")) as {
            packages?: Record<string, {hasInstallScript?: boolean}>;
        };
        return Object.entries(parsed.packages ?? {})
            .filter(([, meta]) => meta?.hasInstallScript === true)
            .map(([name]) => name.replace(/^node_modules\//, ""))
            .sort();
    } catch {
        return [];
    }
}

/**
 * 완결 표식이 놓이는 자리. **캐시 뿌리 아래**, 프로젝트 경로와 캐시 키로 갈라 둔다.
 *
 * 키를 함께 넣는 이유가 둘이다. 하나는 **lockfile 이 바뀌면 표식도 안 맞아야** 한다는 것 — 종전처럼
 * 트리 안에 두면 lockfile 을 고쳐도 "준비됨"으로 통과했다. 다른 하나는 프로젝트를 오가며 세대를
 * 바꿔도 각 세대의 완결 사실이 따로 남는다는 것이다.
 */
function completionPath(cacheRoot: string, projectDir: string, cacheKey: string): string {
    const where = createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
    return join(cacheRoot, ".complete", `${where}-${cacheKey}`);
}

/** 완결 표식. 이것이 있어야 "준비됨"이다(존재만으로는 반쪽 트리와 구별되지 않는다). */
async function markComplete(doneAt: string): Promise<void> {
    await mkdir(dirname(doneAt), { recursive: true }).catch(() => {});
    await writeFile(doneAt, `${new Date().toISOString()}\n`, "utf8").catch(() => {});
}

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
    signal?: AbortSignal,
): Promise<void> {
    const [bin, ...args] = command;
    if (!bin) throw new DevtoolsError("DEPENDENCIES_FAILED", "npm 실행 방법을 알 수 없습니다.");

    await new Promise<void>((resolve, reject) => {
        // ⚠ **취소를 받는다.** 이 설치는 첫 실행에서 수 분이 걸리고, 사내망 프록시에 물리면
        //   `close`/`error` 가 **영원히 안 온다** — 이 Promise 가 정착하지 않는다. 그 위를 덮은
        //   진행 알림에 취소 단추가 없으면 사용자에게 남는 탈출구는 편집기 강제 종료뿐이다.
        //   (`signOut` 도 미리보기 준비 중이면 거절하므로 로그아웃으로도 못 빠져나간다.)
        //   형제 경로 `signIn` 이 이미 같은 패턴을 쓴다 — 새 설계가 아니라 그것을 여기로 옮긴 것이다.
        const child = spawn(bin, args, {
            cwd,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
            signal,
        });
        child.stdout?.on("data", (chunk: Buffer) => report(chunk.toString().trimEnd()));
        child.stderr?.on("data", (chunk: Buffer) => report(chunk.toString().trimEnd()));
        child.on("error", (cause) => reject(spawnFailure(cause)));
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
