import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DevtoolsError } from "./errors.ts";
import { deflateRaw } from "node:zlib";
import { promisify } from "node:util";

const deflate = promisify(deflateRaw);

/**
 * zip 작성기 — **의존성 0**(Node 내장 zlib 만 쓴다).
 *
 * 외부 압축 라이브러리를 안 쓰는 이유: 이 코드는 고객 노트북에서 돌고, 우리가 넣은 의존성 하나가
 * 그 기계에서 설치 실패하면 "올리기"가 통째로 막힌다. 형식은 표준 zip(로컬 헤더 + 중앙 디렉터리)이라
 * 서버가 쓰는 어느 해제기로도 열린다.
 *
 * ZIP64 는 다루지 않는다 — 업로드 상한이 100MB 라 4GB·65535개 경계에 닿을 수 없다.
 */
export interface ZipEntry {
    /** zip 안 경로. 항상 `/` 구분자(윈도우에서도). */
    path: string;
    data: Buffer;
}

export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
    // ZIP64 를 안 다루므로 항목 수 상한이 실재한다. 초판 주석은 "100MB 상한이라 닿을 수 없다"고 적었지만
    // **거짓이었다** — 작은 파일 65,536개는 수 MB 다(심의 실측: raw RangeError). 사람 말로 끊는다.
    if (entries.length > MAX_ENTRIES) {
        throw new DevtoolsError(
            "PACK_FAILED",
            `파일이 너무 많습니다(${entries.length.toLocaleString()}개 · 상한 ${MAX_ENTRIES.toLocaleString()}개).`,
            "빌드 산출물·캐시 폴더가 섞여 있지 않은지 확인해 주세요.",
        );
    }
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.path, "utf8");
        const crc = crc32(entry.data);
        const compressed = await deflate(entry.data, { level: 6 });
        // 압축이 되레 커지는 파일(이미 압축된 이미지 등)은 저장(store)으로 둔다.
        const useDeflate = compressed.length < entry.data.length;
        const payload = useDeflate ? compressed : entry.data;
        const method = useDeflate ? 8 : 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // 필요 버전 2.0
        local.writeUInt16LE(0x0800, 6); // UTF-8 파일명 플래그
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); // 시각·날짜는 0 — **재현 가능한 zip**(같은 소스 → 같은 바이트)
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(0, 38); // 외부 속성
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * 패킹에서 **반드시 빠지는 것들**(memo146 §5 D2).
 *
 * `node_modules` 가 첫 줄인 이유: 서버 업로드 정규화가 그것을 어차피 제거하고, 상한 100MB 에 먼저 걸린다.
 * `.env.local` 이 있는 이유는 더 무겁다 — **자격증명이 들어 있다.** 여기서 새면 프리뷰 키가 서버로 올라간다.
 */
const ALWAYS_EXCLUDED = new Set([
    "node_modules",
    ".git",
    ".next",
    "dist",
    "out",
    ".DS_Store",
    ".turbo",
    ".vercel",
    ".claude",
]);

/**
 * `.env` 로 시작하는 것은 **전부** 뺀다(대소문자 무관).
 *
 * 초판은 `.env`·`.env.local` 정확 일치만 봤다. 심의가 실측으로 `.env.production`·`.env.development.local`·
 * `.env.local.bak`·`.Env.Local` 에서 **`oqsk_` 키가 zip 에 실리는 것**을 확인했다 — 앞의 둘은 Next 가 실제로
 * 읽는 표준 파일명이다. 자격증명이 새는 자리는 정확 일치로 막을 수 없다.
 */
function isSecretFile(name: string): boolean {
    const lower = name.toLowerCase();
    return lower === ".env" || lower.startsWith(".env.") || SECRET_NAMES.has(lower) || lower.endsWith(".pem");
}

const SECRET_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json", ".npmrc"]);

export interface PackOptions {
    projectDir: string;
    /** 추가 제외(프로젝트 사정). 이름 단위 비교라 경로가 아니라 파일·폴더 이름을 넣는다. */
    exclude?: string[];
    onProgress?: (message: string) => void;
}

export interface PackResult {
    buffer: Buffer;
    fileCount: number;
    /** 업로드 전 무결성 확인용(서버가 다시 계산한다). */
    sha256: string;
}

/** 프로젝트를 zip 으로 묶는다. 제외 규칙은 위 목록 + 호출부 추가분. */
export async function packProject(options: PackOptions): Promise<PackResult> {
    const excluded = new Set([...ALWAYS_EXCLUDED, ...(options.exclude ?? [])]);
    const entries: ZipEntry[] = [];
    const report = options.onProgress ?? (() => {});

    const walk = async (dir: string): Promise<void> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
            if (excluded.has(item.name) || isSecretFile(item.name)) continue;
            const full = join(dir, item.name);
            if (item.isDirectory()) {
                await walk(full);
            } else if (item.isFile()) {
                const info = await stat(full);
                if (info.size > MAX_FILE_BYTES) {
                    // ⚠ **조용히 빼지 않는다**(심의 차단 · 2026-08-03). 초판은 건너뛰고 로그 한 줄만 남겼는데,
                    // 사용자는 출력 채널을 열어 두지 않는다 — "발행 접수" 알림만 보고 **자기 동영상이 사라진 줄
                    // 모른 채** 라이브가 바뀐다. 게다가 20MB 라는 선에 근거가 없었다(서버 상한은 아카이브 전체
                    // 100MB 이고 그 검사는 publish 가 따로 한다). 넘으면 **끊고 이름을 말한다.**
                    throw new DevtoolsError(
                        "PACK_FAILED",
                        `너무 큰 파일이 있습니다: ${relative(options.projectDir, full)} (${Math.round(info.size / 1024 / 1024)}MB)`,
                        "동영상·원본 이미지는 소스에 넣지 말고 미디어로 올려 주세요. 업로드 상한은 전체 100MB 입니다.",
                    );
                }
                entries.push({
                    path: relative(options.projectDir, full).split(sep).join("/"),
                    data: await readFile(full),
                });
            }
            // 심볼릭 링크는 담지 않는다 — zip 밖을 가리키는 링크는 서버에서 해제할 때 위험하다.
        }
    };
    await walk(options.projectDir);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // 재현 가능한 순서

    const buffer = await createZip(entries);
    return { buffer, fileCount: entries.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/** 디버깅·CI 용 — 만든 zip 을 파일로 떨군다. */
export async function writeZip(path: string, buffer: Buffer): Promise<void> {
    await writeFile(path, buffer);
}

/** 파일 하나가 이보다 크면 어차피 전체 상한(100MB)을 다 먹는다 — 여기서 이름을 대고 끊는다. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 65_535;

let crcTable: Uint32Array | null = null;

function crc32(data: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let c = i;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
    return (crc ^ 0xffffffff) >>> 0;
}
