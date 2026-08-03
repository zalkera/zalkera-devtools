import { mkdir, writeFile } from "node:fs/promises";
import { dirname, normalize, resolve, sep } from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { DevtoolsError } from "./errors.ts";

const inflate = promisify(inflateRaw);

/**
 * zip 해제기 — **의존성 0**(내장 zlib). 시작 소스 팩(B1)이 zip 으로 오기 때문에 필요하다
 * (버전 이력의 소스는 tar.gz 라 `fetchSource.ts` 가 따로 맡는다 — 두 형식이 실제로 둘 다 온다).
 *
 * **중앙 디렉터리를 읽는다**(로컬 헤더 순차 스캔이 아니라). 로컬 헤더만 보면 데이터 서술자(streaming 생성물)에서
 * 길이를 못 읽어 파일 끝을 추정하게 되고, 그 추정이 틀리는 날 조용히 깨진 파일을 쓴다.
 */
export interface UnzipResult {
    fileCount: number;
}

export async function extractZip(zip: Buffer, targetDir: string): Promise<UnzipResult> {
    const eocd = findEocd(zip);
    const entryCount = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    const root = resolve(targetDir);
    let fileCount = 0;

    for (let i = 0; i < entryCount; i += 1) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 압축 파일이 손상되었습니다.");
        }
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const localOffset = zip.readUInt32LE(offset + 42);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
        offset += 46 + nameLength + extraLength + commentLength;

        if (name.endsWith("/")) {
            await mkdir(safeJoin(root, name), { recursive: true });
            continue;
        }

        // 로컬 헤더의 가변 길이는 중앙 디렉터리의 것과 다를 수 있다 — 데이터 시작을 로컬 헤더에서 다시 읽는다.
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const localExtraLength = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = zip.subarray(dataStart, dataStart + compressedSize);

        const data = method === 0 ? raw : await inflate(raw);
        const path = safeJoin(root, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        fileCount += 1;
    }
    return { fileCount };
}

/** EOCD(끝 표식)를 뒤에서 찾는다. 주석이 붙어 있을 수 있어 마지막 64KB 를 훑는다. */
function findEocd(zip: Buffer): number {
    const start = Math.max(0, zip.length - 66_000);
    for (let i = zip.length - 22; i >= start; i -= 1) {
        if (zip.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new DevtoolsError("SERVER_REJECTED", "받은 파일이 zip 형식이 아닙니다.");
}

/** 대상 폴더 밖을 가리키는 항목은 거절한다(Zip Slip). tar 해제기와 **같은 판정**이어야 한다. */
function safeJoin(root: string, name: string): string {
    const cleaned = name.replace(/^(\.\/)+/, "");
    if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned) || cleaned.includes("\0")) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일에 이상한 경로가 있습니다: ${name}`);
    }
    const path = resolve(root, normalize(cleaned));
    if (path !== root && !path.startsWith(root + sep)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일이 폴더 밖을 가리킵니다: ${name}`);
    }
    return path;
}
