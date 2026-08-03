import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
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
    const fetchImpl = options.fetchImpl ?? fetch;

    const block = await lookup(options, fetchImpl);
    if (block === "unsupported") {
        // 구서버(필드 없음)·기능 off·조회 실패 — 전부 같은 자리로 온다. 말은 하되 놀라게 하지 않는다.
        report("미리 준비된 의존성 꾸러미가 없어 직접 내려받습니다(조금 더 걸립니다).");
        return null;
    }
    if (!block.payload) {
        report("이 버전에 맞는 의존성 꾸러미가 아직 없어 직접 내려받습니다(조금 더 걸립니다).");
        return null;
    }

    const { url, sha256, bytes, bakedAt } = block.payload;
    report(`준비된 의존성 꾸러미를 받는 중… (${formatMegabytes(bytes)})`);

    await mkdir(options.cacheDir, { recursive: true });
    const archivePath = join(options.cacheDir, DOWNLOAD_NAME);
    const scratchPath = join(options.cacheDir, SCRATCH_NAME);

    try {
        const actual = await download(url, archivePath, fetchImpl);
        if (actual !== sha256.toLowerCase()) {
            // **문구가 다른 유일한 실패**(§13.5). 여기까지 왔다는 것은 네트워크가 됐다는 뜻이므로,
            // "안 됐다"가 아니라 "받은 것을 믿을 수 없다"가 사실이다.
            report("받은 꾸러미가 원본과 달라 폐기했습니다. 의존성을 직접 내려받습니다.");
            return null;
        }

        report("의존성 꾸러미를 푸는 중…");
        const fileCount = await extractTarGzFile(archivePath, options.cacheDir, scratchPath, {
            // `.bin` 의 상대 심볼릭 링크 9개가 없으면 `next dev` 가 실행 파일을 못 찾는다(실측).
            symlinks: "materialize",
            // 실행 비트가 없으면 그 실패는 **실행 단계**에서 EACCES 로 나타나, 원인을 엉뚱한 데서 찾게 된다.
            preserveMode: true,
        });

        const treeDir = join(options.cacheDir, "node_modules");
        if (!existsSync(treeDir)) {
            // 아카이브 모양이 우리 전제와 다르다(뿌리에 `node_modules/` 가 있어야 한다).
            report("받은 꾸러미의 모양이 예상과 달라 쓰지 않았습니다. 의존성을 직접 내려받습니다.");
            await rm(treeDir, { recursive: true, force: true }).catch(() => {});
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

/** 받으면서 sha256 을 함께 센다 — 다 받고 다시 읽으면 167MB 를 두 번 만진다. */
async function download(url: string, targetPath: string, fetchImpl: typeof fetch): Promise<string> {
    const response = await fetchImpl(url);
    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    const body = Readable.fromWeb(response.body as never);
    body.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(targetPath));
    return hash.digest("hex");
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
export async function evictOldCaches(cacheRoot: string, keep = 3, onProgress?: (m: string) => void): Promise<number> {
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

const LOOKUP_TIMEOUT_MS = 5_000;
const DOWNLOAD_NAME = ".payload.tar.gz";
const SCRATCH_NAME = ".payload.tar";

function formatMegabytes(bytes: number): string {
    return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function describe(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause);
    return message.length > 80 ? `${message.slice(0, 80)}…` : message;
}
