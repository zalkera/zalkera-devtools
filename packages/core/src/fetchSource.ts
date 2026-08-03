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
 */
export async function extractTarGz(gzipped: Buffer, targetDir: string): Promise<number> {
    const tar = await gunzip(gzipped);
    const root = resolve(targetDir);
    let offset = 0;
    let count = 0;

    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) break; // 끝 표식(0 블록 2개)

        const rawName = cstring(header.subarray(0, 100));
        const prefix = cstring(header.subarray(345, 500));
        const size = parseOctal(header.subarray(124, 136));
        const type = String.fromCharCode(header[156] ?? 0);
        const name = prefix ? `${prefix}/${rawName}` : rawName;
        offset += BLOCK;

        const dataBlocks = Math.ceil(size / BLOCK);
        const data = tar.subarray(offset, offset + size);
        offset += dataBlocks * BLOCK;

        // 'x'/'g' 는 pax 확장 헤더, 'L' 은 GNU 긴 이름 — 이 트랜치에서는 건너뛴다(우리 아카이브는 안 쓴다).
        if (type === "5") {
            await mkdir(safeJoin(root, name), { recursive: true });
            continue;
        }
        if (type !== "0" && type !== "\0") continue;

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

function parseOctal(buffer: Buffer): number {
    const text = cstring(buffer).trim();
    return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

async function gunzip(input: Buffer): Promise<Buffer> {
    const { gunzip: gunzipCb } = await import("node:zlib");
    const { promisify } = await import("node:util");
    return promisify(gunzipCb)(input) as Promise<Buffer>;
}

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
