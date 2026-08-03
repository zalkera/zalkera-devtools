import { createWriteStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";

/**
 * B2「현재 사이트 소스 내려받기」(memo146 §5 B2 — **MVP 절단선 안**).
 *
 * 이것이 체크리스트 ③("이미 있는 사이트를 로컬에서 고쳐 재배포")의 입구다. B1(예제로 시작)만으로는
 * ②(신규 배포)의 변형에 그친다.
 *
 * 서버가 주는 것은 tar.gz 이고, **해제기를 의존성 없이 직접 쓴다**(내장 zlib + 200줄). 고객 노트북에서
 * 우리 의존성 하나가 설치 실패하면 "내 소스 받기"가 통째로 막히기 때문이다.
 */
export interface FetchSourceOptions {
    api: ZalkeraApi;
    /** 받을 버전. 비우면 현재 배포 중인 버전. */
    revisionNo?: number;
    targetDir: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface FetchSourceResult {
    revisionNo: number;
    fileCount: number;
}

export async function fetchSiteSource(options: FetchSourceOptions): Promise<FetchSourceResult> {
    const report = options.onProgress ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;

    let revisionNo = options.revisionNo;
    if (revisionNo === undefined) {
        const revisions = await options.api.listRevisions();
        const active = revisions.find((r) => r.isActive) ?? revisions[0];
        if (!active) {
            throw new DevtoolsError(
                "NOT_A_SITE",
                "아직 올린 사이트 소스가 없습니다.",
                "예제로 시작하거나, 콘솔에서 소스를 먼저 올려 주세요.",
            );
        }
        revisionNo = active.revisionNo;
    }

    report(`버전 ${revisionNo} 소스를 받는 중…`);
    const url = await options.api.sourceUrl(revisionNo);
    const response = await fetchImpl(url);
    if (!response.ok || !response.body) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `소스를 내려받지 못했습니다(HTTP ${response.status}).`,
            "잠시 뒤 다시 시도해 주세요.",
        );
    }

    await mkdir(options.targetDir, { recursive: true });
    const existing = await readdir(options.targetDir);
    if (existing.length > 0) {
        // **덮어쓰지 않는다.** 고객이 고치던 소스를 서버 버전으로 조용히 밀어 버리는 것이 이 도구가 낼 수 있는
        // 가장 큰 손해다. 빈 폴더를 요구하는 편이 불편하지만 되돌릴 수 없는 손실보다 낫다.
        throw new DevtoolsError(
            "NOT_A_SITE",
            "받을 폴더가 비어 있지 않습니다.",
            "빈 폴더를 고르거나, 기존 폴더는 「기존 폴더 연결」로 이어 주세요.",
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const fileCount = await extractTarGz(buffer, options.targetDir);
    report(`${fileCount}개 파일을 받았습니다.`);
    return { revisionNo, fileCount };
}

/**
 * tar.gz 해제. **경로 탈출(`../`·절대경로·심볼릭 링크)을 거절한다** — 서버가 주는 아카이브라도 해제기가
 * 안전해야 한다(우리 아카이브가 오염되는 날, 이 검사만이 고객 홈 디렉터리를 지킨다).
 *
 * ⚠ **GNU 긴 이름(`L`)·pax(`x`) 헤더를 반드시 해석한다**(심의 차단 · 2026-08-03).
 *
 * 초판은 그 헤더들을 **건너뛰며** 주석에 "우리 아카이브는 안 쓴다"고 적었는데 **거짓이었다** —
 * 백엔드 패커가 `LONGFILE_GNU` 라서(`CanonicalTarballPacker.kt`) **경로가 100바이트를 넘으면 무조건**
 * `L` 헤더를 낸다. 건너뛰면 뒤따르는 헤더의 **100자로 잘린 이름**이 쓰이고, 두 파일이 같은 잘린 경로로
 * 겹쳐 **하나가 다른 하나를 덮어쓴다**. 사용자에게는 "4개 받았습니다"라고 말하고 디스크엔 3개다.
 * 한글 경로는 UTF-8 3바이트/자라 **약 33자에서** 걸린다. 그 트리를 고쳐 발행하면 라이브에서 파일이 소멸한다.
 *
 * 그래서 이 해제기는 **모르는 타입을 만나면 조용히 넘어가지 않고 던진다.** 조용한 손상보다 실패가 낫다.
 */
export async function extractTarGz(gzipped: Buffer, targetDir: string): Promise<number> {
    const tar = await gunzip(gzipped);
    const root = resolve(targetDir);
    let offset = 0;
    let count = 0;
    /** 앞선 `L`/`x` 헤더가 지정한 다음 항목의 이름. 쓰고 나면 비운다. */
    let pendingName: string | null = null;

    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) break; // 끝 표식(0 블록 2개)

        const rawName = cstring(header.subarray(0, 100));
        const prefix = cstring(header.subarray(345, 500));
        const size = parseOctal(header.subarray(124, 136));
        if (!Number.isFinite(size) || size < 0) {
            // 초판은 NaN 이면 루프가 조용히 끝나고 **성공으로 보고**했다(뒤 파일 유실).
            throw new DevtoolsError("SERVER_REJECTED", "받은 파일이 손상되었습니다(길이 필드 오류).");
        }
        const type = String.fromCharCode(header[156] ?? 0);
        const headerName = prefix ? `${prefix}/${rawName}` : rawName;
        offset += BLOCK;

        const dataBlocks = Math.ceil(size / BLOCK);
        const data = tar.subarray(offset, offset + size);
        offset += dataBlocks * BLOCK;

        // GNU 긴 이름 — 이 항목의 **데이터가 다음 항목의 이름**이다.
        if (type === "L") {
            pendingName = cstring(data);
            continue;
        }
        // pax 확장 헤더 — `path=` 레코드가 다음 항목의 이름이다.
        if (type === "x" || type === "g") {
            const path = parsePaxPath(data);
            if (path) pendingName = path;
            continue;
        }
        // GNU 긴 링크 이름 — 링크 자체를 안 만들므로 이름만 버린다(데이터는 위에서 이미 건너뛰었다).
        if (type === "K") continue;

        const name = pendingName ?? headerName;
        pendingName = null;

        if (type === "5") {
            await mkdir(safeJoin(root, name), { recursive: true });
            continue;
        }
        // 링크류는 만들지 않는다(경로 탈출 매개). 건너뛰되 **조용히 지나가지 않는다**는 사실은 위 주석에 남긴다.
        if (type === "1" || type === "2") continue;
        if (type !== "0" && type !== "\0") {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `받은 파일에 다룰 수 없는 항목이 있습니다(형식 ${type}).`,
                "잘커라에 문의해 주세요. 잘못 받은 상태로 진행하지 않았습니다.",
            );
        }

        const path = safeJoin(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        count += 1;
    }
    return count;
}

const BLOCK = 512;

/** 아카이브 안 경로가 대상 폴더 밖을 가리키면 거절한다(Zip Slip 동형). */
function safeJoin(root: string, name: string): string {
    const cleaned = name.replace(/^(\.\/)+/, "");
    if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일에 이상한 경로가 있습니다: ${name}`);
    }
    const path = resolve(root, normalize(cleaned));
    if (path !== root && !path.startsWith(root + sep)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일이 폴더 밖을 가리킵니다: ${name}`);
    }
    return path;
}

function cstring(buffer: Buffer): string {
    const end = buffer.indexOf(0);
    return buffer.subarray(0, end === -1 ? buffer.length : end).toString("utf8");
}

/** pax 레코드(`"<len> key=value\n"` 반복)에서 경로를 찾는다. `path` 가 없으면 null. */
function parsePaxPath(data: Buffer): string | null {
    const text = data.toString("utf8");
    const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
    return match?.[1] ?? null;
}

function parseOctal(buffer: Buffer): number {
    const text = cstring(buffer).trim();
    return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/** 압축 폭탄 방어 — 무제한 해제는 확장 호스트를 OOM 으로 죽이고, 그러면 다른 확장까지 함께 죽는다. */
async function gunzip(input: Buffer): Promise<Buffer> {
    const { gunzip: gunzipCb } = await import("node:zlib");
    const { promisify } = await import("node:util");
    try {
        return (await promisify(gunzipCb)(input, { maxOutputLength: MAX_ARCHIVE_BYTES })) as Buffer;
    } catch (cause) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 파일이 너무 크거나 손상되었습니다.",
            "다시 시도해도 같으면 잘커라에 문의해 주세요.",
            cause,
        );
    }
}

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** 큰 아카이브를 메모리에 다 올리지 않고 파일로 흘리고 싶을 때(현재 미사용 · CLI 대용량 경로 대비). */
export async function streamToFile(body: ReadableStream<Uint8Array>, path: string): Promise<void> {
    const { Readable } = await import("node:stream");
    await pipeline(Readable.fromWeb(body as never), createGunzip(), createWriteStream(path));
}

/** 받은 폴더에서 프로젝트 뿌리를 찾는다 — 아카이브가 한 겹 감싸고 있을 수 있다. */
export async function findProjectRoot(dir: string): Promise<string> {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === "package.json")) return dir;
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1 && dirs[0]) return findProjectRoot(join(dir, dirs[0].name));
    return dir;
}
