import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractTarGzFile } from "./untar.ts";

/**
 * 의존성 페이로드 받기(backend memo146 §13.10.5 · T-D2c).
 *
 * CI 가 미리 구운 `node_modules` 트리를 받아 캐시에 편다. **가속기이지 필수가 아니다** — 여기서 나는 모든
 * 실패는 `null` 로 수렴하고 호출부(`deps.ts`)는 `npm install` 로 내려간다.
 *
 * **말하고 내려간다**(§13.5). 미생성·미지원·네트워크 실패는 한 줄 고지이지 오류가 아니고,
 * **sha 불일치만 문구를 다르게** 한다("받은 꾸러미가 원본과 달라 폐기했습니다") — 그 둘을 같은 말로
 * 뭉개면 지원 시 "느린 것"과 "믿을 수 없는 것"을 구분할 수 없다.
 *
 * 무언 강등은 금지다. 조용히 npm 으로 내려가면, 페이로드가 몇 달째 안 쓰이고 있어도 아무도 모른다.
 */
export interface PayloadOptions {
    apiBase: string;
    /**
     * 질의 키 — `package-lock.json` **원본 바이트의 sha256**.
     *
     * ⚠ `deps.ts` 의 `computeCacheKey`(로컬 캐시 키)와 **다른 값**이다(§13.10.1). 로컬 키는 lockfile +
     * 플랫폼 + node major 의 복합 해시라 보수적이고, 주소 키는 lockfile 바이트만이다(트리가 node 버전
     * 무관임이 실측됐다 — §13.3). 둘을 섞으면 **적중률이 0** 이 되는데, 그 실패는 "그냥 좀 느리다"로만
     * 보여서 아무도 못 찾는다.
     */
    lockfileSha256: string;
    platform: string;
    /** 받은 트리를 펼 자리(= 캐시 디렉터리). 여기 아래에 `node_modules` 가 생긴다. */
    cacheDir: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
    /** 매니페스트 조회 상한. 가속기 하나 때문에 사용자를 기다리게 하지 않는다(§13.5). */
    lookupTimeoutMs?: number;
    /**
     * 다운로드 **무전송** 상한(심의 W1). 전체 시간이 아니다 — 느린 회선을 시간으로 자르면 사내망
     * 사용자가 영영 못 받는다. "받다가 멈춘" 경우만 끊어 npm 폴백으로 보낸다.
     */
    stallTimeoutMs?: number;
}

export interface PayloadResult {
    bytes: number;
    fileCount: number;
    /** 서버가 말한 굽기 시각. doctor·지원 대화에서 "언제 구운 것인가"를 답한다. */
    bakedAt: string | null;
}

/** 서버가 답하는 좌표. `payload` 가 null 이면 "이 세대·이 플랫폼은 안 구워졌다". */
interface DepsBlock {
    lockfileSha256: string;
    payload: { url: string; sha256: string; bytes: number; bakedAt: string | null } | null;
}

/**
 * 받아서 캐시에 편다. **성공하면** [PayloadResult], 아니면 `null`(호출부는 npm 으로 내려간다).
 *
 * 던지지 않는다 — 던지면 호출부가 "실패"와 "없음"을 구분해 처리해야 하는데, 이 축에서 그 둘은 **같은 뜻**이다.
 */
export async function tryFetchPayload(options: PayloadOptions): Promise<PayloadResult | null> {
    const report = options.onProgress ?? (() => {});
    try {
        return await attempt(options, report);
    } catch (cause) {
        // 🔴 **이 함수는 절대 던지지 않는다**(재심의 차단 2). 종전엔 계약을 주석에만 적어 두고, 정작
        // 에코 검사(`.toLowerCase()`)와 `new URL(apiBase)` 이 try 밖이라 **깨진 JSON·이상한 주소 하나가
        // 의존성 준비 전체를 죽였다** — npm 폴백으로도 못 갔다. 그리고 그 깨진 응답을 만드는 것이 바로
        // 우리가 방어하려던 "프록시가 답을 바꿔치기하는" 상황이다.
        await rm(join(options.cacheDir, "node_modules"), { recursive: true, force: true }).catch(() => {});
        report(`준비된 의존성 꾸러미를 쓰지 못해 직접 내려받습니다(${describe(cause)}).`);
        return null;
    }
}

async function attempt(options: PayloadOptions, report: (m: string) => void): Promise<PayloadResult | null> {
    const fetchImpl = options.fetchImpl ?? fetch;

    const block = await lookup(options, fetchImpl);
    if (block === "unsupported") {
        // 구서버(필드 없음)·기능 off·조회 실패 — 전부 같은 자리로 온다. 말은 하되 놀라게 하지 않는다.
        report("미리 준비된 의존성 꾸러미가 없어 직접 내려받습니다(조금 더 걸립니다).");
        return null;
    }
    const echo = typeof block.lockfileSha256 === "string" ? block.lockfileSha256 : "";
    if (echo && echo.toLowerCase() !== options.lockfileSha256.toLowerCase()) {
        // 서버는 자기정합을 이미 확인하지만, 프록시가 다른 응답을 끼워 넣는 경우가 이 축의 실재 위협이다.
        report("서버가 다른 버전의 답을 주어 준비된 꾸러미를 쓰지 않습니다.");
        return null;
    }
    const entry = block.payload;
    if (!entry || typeof entry !== "object") {
        report("이 버전에 맞는 의존성 꾸러미가 아직 없어 직접 내려받습니다(조금 더 걸립니다).");
        return null;
    }

    // 🔴 **서버가 준 값의 형태를 믿지 않는다**(재심의 차단 3). 종전엔 `bytes` 가 0·누락이면 크기 강제·
    // 최종 대조·디스크 점검 **셋이 한꺼번에 꺼졌다**(실측: `bytes:0` 신고에 180MB 를 전량 받았다).
    // 사용자에겐 "(NaNMB)" 를 보이고 이어서 틀린 진단까지 냈다. 값이 이상하면 **쓰지 않는다** —
    // 그게 이 축의 유일한 안전한 답이다(폴백이 있으므로 잃는 것은 속도뿐이다).
    const url = typeof entry.url === "string" ? entry.url : "";
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256 : "";
    const bytes = typeof entry.bytes === "number" ? entry.bytes : Number.NaN;
    const bakedAt = typeof entry.bakedAt === "string" ? entry.bakedAt : null;
    if (!isSafeHttpsUrl(url) || !/^[0-9a-f]{64}$/i.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0) {
        report("서버가 준 꾸러미 정보를 이해할 수 없어 직접 내려받습니다.");
        return null;
    }
    report(`준비된 의존성 꾸러미를 받는 중… (${formatMegabytes(bytes)})`);

    await mkdir(options.cacheDir, { recursive: true });
    if (!(await hasRoomFor(options.cacheDir, bytes))) {
        // 받다가 디스크가 차면 사용자는 **의존성도 없고 공간도 없는** 상태가 된다. 시작하지 않는 편이 낫다.
        report("디스크 여유가 부족해 준비된 꾸러미를 쓰지 않고 직접 내려받습니다.");
        return null;
    }
    const archivePath = join(options.cacheDir, DOWNLOAD_NAME);
    const scratchPath = join(options.cacheDir, SCRATCH_NAME);

    try {
        const actual = await download(url, archivePath, fetchImpl, bytes, options.stallTimeoutMs ?? STALL_TIMEOUT_MS);
        if (actual !== sha256.toLowerCase()) {
            // **문구가 다른 유일한 실패**(§13.5). 여기까지 왔다는 것은 네트워크가 됐다는 뜻이므로,
            // "안 됐다"가 아니라 "받은 것을 믿을 수 없다"가 사실이다.
            report("받은 꾸러미가 원본과 달라 폐기했습니다. 의존성을 직접 내려받습니다.");
            return null;
        }

        report("의존성 꾸러미를 푸는 중…");
        const fileCount = await extractTarGzFile(archivePath, options.cacheDir, scratchPath, {
            // 오염된 응답이 sha 대조 **전에** 디스크를 채우지 못하게 막는다(심의 W3). 정상 페이로드는
            // 압축 대비 4배 안쪽이라(실측 158MB → 586MB) 여유 있게 잡되 무제한은 아니다.
            maxBytes: Math.max(bytes * EXTRACT_RATIO_CAP, MIN_EXTRACT_CAP),
            // `.bin` 의 상대 심볼릭 링크 9개가 없으면 `next dev` 가 실행 파일을 못 찾는다(실측).
            symlinks: "materialize",
            // 실행 비트가 없으면 그 실패는 **실행 단계**에서 EACCES 로 나타나, 원인을 엉뚱한 데서 찾게 된다.
            preserveMode: true,
        });

        const treeDir = join(options.cacheDir, "node_modules");
        if (!existsSync(treeDir)) {
            // 아카이브 모양이 우리 전제와 다르다(뿌리에 `node_modules/` 가 있어야 한다).
            report("받은 꾸러미의 모양이 예상과 달라 쓰지 않았습니다. 의존성을 직접 내려받습니다.");
            // `node_modules` 만 지우면 그 아카이브가 만든 **다른 최상위 항목이 영구 잔류**하고,
            // 폐기기는 그 디렉터리를 살아 있는 한 세대로 센다(재심의 관찰 3). 캐시 자리는 우리 것이므로
            // 통째로 되돌린다.
            await rm(options.cacheDir, { recursive: true, force: true }).catch(() => {});
            return null;
        }

        return { bytes, fileCount, bakedAt };
    } catch (cause) {
        // 네트워크 끊김·디스크 부족·해제 실패. **반쯤 펼쳐진 트리를 남기지 않는다** — 남기면
        // `deps.ts` 의 캐시 판정이 그것을 "준비됨"으로 통과시킨다(같은 종류의 결함을 이미 한 번 겪었다).
        await rm(join(options.cacheDir, "node_modules"), { recursive: true, force: true }).catch(() => {});
        report(`준비된 의존성 꾸러미를 쓰지 못해 직접 내려받습니다(${describe(cause)}).`);
        return null;
    } finally {
        await rm(archivePath, { force: true }).catch(() => {});
        await rm(scratchPath, { force: true }).catch(() => {});
    }
}

/**
 * 매니페스트 조회 — **핸드셰이크 재호출**이다(별도 엔드포인트가 없다 · §13.10.2).
 *
 * `deps` 필드 부재(구서버)·`payload: null`·타임아웃·오류를 **하나로 수렴**시킨다. 이 자리에서 굳이 갈라
 * 봐야 호출부가 할 수 있는 일이 같다.
 */
async function lookup(options: PayloadOptions, fetchImpl: typeof fetch): Promise<DepsBlock | "unsupported"> {
    const url = new URL("/api/devtools/handshake", options.apiBase.endsWith("/") ? options.apiBase : `${options.apiBase}/`);
    url.searchParams.set("lockfileHash", options.lockfileSha256);
    url.searchParams.set("platform", options.platform);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
        if (!response.ok) return "unsupported";
        const body = (await response.json()) as { data?: { deps?: DepsBlock | null } };
        const deps = body?.data?.deps;
        if (!deps || typeof deps !== "object") return "unsupported";
        return deps;
    } catch {
        // 사내망 프록시가 응답을 바꾸는 것도, 서버가 잠깐 죽은 것도 여기로 온다. 가속기 조회 실패로
        // 사용자를 막지 않는다.
        return "unsupported";
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 받으면서 sha256 을 함께 센다 — 다 받고 다시 읽으면 167MB 를 두 번 만진다.
 *
 * 둘이 심의에서 나온 수정이다.
 * - **정체 상한**(W1): 조회에만 5초를 걸어 뒀는데, 정작 167MB 를 받다 연결이 멈추면 **무한히 기다렸다.**
 *   가속기가 가속 대상을 막는 형국이다. 전체 시간이 아니라 **무전송 구간**으로 잰다 — 느린 회선을
 *   시간으로 자르면 사내망 사용자가 영영 못 받는다.
 * - **신고 크기 강제**(W2): 서버가 말한 바이트를 넘기면 그 자리에서 끊는다. sha 대조는 다 받은 **뒤**라,
 *   그때까지 디스크가 무한히 차는 것을 막을 수 있는 유일한 지점이 여기다.
 */
async function download(
    url: string,
    targetPath: string,
    fetchImpl: typeof fetch,
    declaredBytes: number,
    stallMs: number,
): Promise<string> {
    const controller = new AbortController();
    // `unref()` 가 없으면 fetch 가 **거절**될 때(DNS·TLS·프록시 차단) 아무도 이 타이머를 안 지워
    // 프로세스가 stall 값만큼 더 살아 있는다(실측: 24ms 에 끝난 일이 +4초 뒤 종료). 사내망이
    // 이 기능의 표적 사용자라 하필 그쪽에서 드러난다(재심의 경고 3).
    let stall = setTimeout(() => controller.abort(), stallMs);
    stall.unref?.();
    let response: Response;
    try {
        response = await fetchImpl(url, { signal: controller.signal });
    } catch (cause) {
        clearTimeout(stall);
        throw cause;
    }
    if (!response.ok || !response.body) {
        clearTimeout(stall);
        throw new Error(`HTTP ${response.status}`);
    }

    const hash = createHash("sha256");
    const cap = declaredBytes > 0 ? declaredBytes : Number.POSITIVE_INFINITY;
    let received = 0;
    const body = Readable.fromWeb(response.body as never);
    const guard = new Transform({
        transform(chunk: Buffer, _enc, done) {
            clearTimeout(stall);
            stall = setTimeout(() => controller.abort(), stallMs);
            stall.unref?.();
            received += chunk.length;
            if (received > cap) {
                done(new Error(`받는 양이 서버가 말한 크기(${cap}B)를 넘었습니다`));
                return;
            }
            // 해시는 **디스크에 쓰는 것과 같은 바이트**로 센다. 여기서 갈리면 무결성 검사가 손상 파일을
            // 통과시킨다 — 두 스트림으로 나누지 않는 이유다.
            hash.update(chunk);
            done(null, chunk);
        },
    });

    try {
        await pipeline(body, guard, createWriteStream(targetPath));
    } finally {
        clearTimeout(stall);
    }
    if (received !== declaredBytes && declaredBytes > 0) {
        throw new Error(`받은 크기가 서버가 말한 것과 다릅니다(${received} != ${declaredBytes})`);
    }
    return hash.digest("hex");
}

/**
 * 디스크 여유 점검(심의 W2). 필요량은 **압축본 + 중간 tar + 트리** 라 신고 크기의 몇 배가 든다.
 *
 * 못 재는 환경(구 Node·특수 파일시스템)에서는 **막지 않는다** — 재지 못한다는 이유로 되는 일을 막는 것은
 * 이 축의 성격(가속기)에 맞지 않는다.
 */
async function hasRoomFor(dir: string, declaredBytes: number): Promise<boolean> {
    try {
        const { statfs } = await import("node:fs/promises");
        if (typeof statfs !== "function") return true;
        const info = await statfs(dir);
        const free = Number(info.bavail) * Number(info.bsize);
        return free > declaredBytes * DISK_HEADROOM;
    } catch {
        return true;
    }
}

/**
 * 캐시 폐기 — **최근 [keep]개 키만 남긴다**.
 *
 * 하드링크 트리라 **refcount 가 데이터를 지킨다**: 캐시 쪽 항목을 지워도 이미 연결된 프로젝트의
 * `node_modules` 는 같은 inode 를 붙들고 있어 멀쩡하다(§13.5). 그래서 "쓰고 있는 캐시인지"를 따지지 않아도
 * 안전하다 — 따지려 들면 사용 중 판정이라는 새 진실원천이 생기고, 그건 반드시 어긋난다.
 *
 * 실패는 삼킨다. 캐시 청소가 안 됐다고 사용자의 작업을 막을 이유가 없다.
 */
export async function evictOldCaches(
    cacheRoot: string,
    keep = 3,
    onProgress?: (m: string) => void,
    protectPath?: string,
): Promise<number> {
    try {
        const entries = await readdir(cacheRoot, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory());
        if (dirs.length <= keep) return 0;

        const withTime = await Promise.all(
            dirs.map(async (e) => {
                const path = join(cacheRoot, e.name);
                const mtime = await stat(path)
                    .then((s) => s.mtimeMs)
                    .catch(() => 0);
                return { path, mtime };
            }),
        );
        withTime.sort((a, b) => b.mtime - a.mtime);

        let removed = 0;
        for (const entry of withTime.slice(keep)) {
            // 방금 만든/쓴 세대는 절대 지우지 않는다 — mtime 순서만 믿으면 시계 왜곡·동시 실행에서
            // **자기가 쓰려던 캐시를 자기가 지우는** 자리가 생긴다(재심의 관찰 6).
            if (protectPath && entry.path === protectPath) continue;
            await rm(entry.path, { recursive: true, force: true });
            removed += 1;
        }
        if (removed > 0) onProgress?.(`오래된 의존성 캐시 ${removed}개를 정리했습니다.`);
        return removed;
    } catch {
        return 0;
    }
}

/**
 * 질의 키를 만든다 — `package-lock.json` **원본 바이트의 sha256**.
 *
 * lockfile 이 없거나 npm 계열이 아니면 `null` 이다(**조회조차 하지 않는다** — pnpm/yarn 은 굽지 않으므로
 * 물어봐야 항상 "없다"이고, 그 왕복이 곧 낭비다 · §13.5).
 */
export async function computePayloadKey(projectDir: string): Promise<string | null> {
    const lockPath = join(projectDir, "package-lock.json");
    if (!existsSync(lockPath)) return null;
    return createHash("sha256").update(await readFile(lockPath)).digest("hex");
}

/** 서버가 쓰는 이름과 **같은 표기**여야 한다(`linux-x64`·`darwin-arm64`·`win32-x64`). */
export function currentPlatform(): string {
    return `${process.platform}-${process.arch}`;
}

/** 캐시 적재 성공 표식 — 어느 세대를 어디서 받았는지 남긴다(지원 대화에서 이게 첫 질문이다). */
export async function writePayloadStamp(cacheDir: string, result: PayloadResult, key: string): Promise<void> {
    await writeFile(
        join(cacheDir, "payload.json"),
        `${JSON.stringify({ lockfileSha256: key, bakedAt: result.bakedAt, fileCount: result.fileCount }, null, 2)}\n`,
        "utf8",
    ).catch(() => {});
}

/**
 * 저장처 좌표는 서버가 주지만(클라이언트에 저장처 지식 0), **스킴까지 아무거나 받을 이유는 없다**
 * (재심의 관찰 2 — 실측 `data:` URL 통과). https 한정은 공짜다.
 */
function isSafeHttpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

const LOOKUP_TIMEOUT_MS = 5_000;
const STALL_TIMEOUT_MS = 30_000;
/**
 * 여유 공간 배수 — 압축본 + 중간 tar + 펼친 트리가 **동시에 존재하는 순간**이 있다.
 *
 * 6 이었는데 실측 소요가 **9.19×** 였다(재심의 차단 4): scratch 는 전량 기록된 뒤 루프가 읽고 finally
 * 에서야 지워지고, gz 는 그보다 더 늦게까지 산다. 실 페이로드 비율(158MB→586MB)로도 ≈8.4× 다.
 * 검사를 통과하고 나서 디스크가 차면 사용자는 **의존성도 없고 공간도 없는** 상태가 된다 — 그 실패는
 * 우리가 아낀 여유보다 훨씬 비싸다.
 */
const DISK_HEADROOM = 10;
/** 해제 상한 배수(실측 158MB → 586MB ≈ 3.7배). */
const EXTRACT_RATIO_CAP = 8;
/**
 * 해제 상한 하한선. 배수만 쓰면 **작은 아카이브에서 정상 동작이 죽는다** — tar 는 512바이트 블록에 패딩하고
 * 끝 표식 2블록이 붙어, 몇 KB 짜리 트리도 압축본의 수십 배가 된다(테스트가 이걸 잡았다).
 * 남용 방어는 이 하한선 안에서도 성립한다(32MB 는 채워도 무해하다).
 */
const MIN_EXTRACT_CAP = 32 * 1024 * 1024;
const DOWNLOAD_NAME = ".payload.tar.gz";
const SCRATCH_NAME = ".payload.tar";

function formatMegabytes(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function describe(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.length > 80 ? `${message.slice(0, 80)}…` : message;
}
