import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { DevtoolsError } from "./errors.ts";
import { assertNotSymlink, assertNotVendored, descend, safeSegments } from "./safeWrite.ts";

const inflate = promisify(inflateRaw);

/**
 * 해제 산출물 상한. 업로드 상한(100MB)의 배수로 넉넉히 잡되 **무제한은 아니다** — 실측으로 408KB zip 이
 * 400MB 를 뱉었고, 확장 호스트가 OOM 으로 죽으면 **다른 확장까지 함께** 죽는다.
 */
const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

/**
 * **해제 총량 상한.** 항목당 상한만으로는 못 막는다 — zip 의 중앙 디렉터리 항목 여럿이 **같은
 * 로컬 헤더를 가리켜도** 되므로, 압축 스트림 하나를 이름 수만 개가 공유할 수 있다. 실측: 9KB zip
 * 하나가 파일 150개·157MB 를 오류 없이 뱉었다(증폭 17,320:1). 항목 수 상한(uint16 라 65,535)까지
 * 채우면 같은 방식으로 디스크가 찰 때까지 간다.
 *
 * 형제 `untar.ts` 는 총량과 항목 수를 **둘 다** 갖고 있다. zip 만 둘 다 없었다.
 * 값은 항목당 상한과 같은 근거다 — 업로드 상한(100MB)의 배수로 넉넉히, 그러나 무제한은 아니게.
 */
const MAX_TOTAL_BYTES = 400 * 1024 * 1024;

/** 항목 수 상한. 형제 `untar.ts` 와 같은 값 — 두 형식이 다른 기준을 쓸 이유가 없다. */
const MAX_ENTRIES = 200_000;

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
    let totalBytes = 0;

    if (entryCount > MAX_ENTRIES) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `받은 파일에 항목이 너무 많습니다(${entryCount.toLocaleString()}개 · 상한 ${MAX_ENTRIES.toLocaleString()}개).`,
            "받은 꾸러미가 정상이 아닙니다. 잘커라에 문의해 주세요.",
        );
    }

    // 부모 조각을 하나씩 확인한 결과를 재사용한다 — 항목마다 뿌리부터 다시 `lstat` 하지 않는다.
    const verified = new Set<string>();

    for (let i = 0; i < entryCount; i += 1) {
        // ⚠ **읽기 전에** 범위를 본다. 종전에는 이 줄이 경계 검사보다 앞서서, 중앙 디렉터리 오프셋이
        //   깨진 zip 이 raw `RangeError` 를 사용자에게 그대로 보냈다(심의 실측).
        if (offset < 0 || offset + 46 > zip.length) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 압축 파일이 손상되었습니다(목록 오류).");
        }
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
            const dirSegments = safeSegments(root, name);
            assertNotVendored(dirSegments, name);
            await descend(root, dirSegments, verified);
            continue;
        }

        // ⚠ **읽기 전에** 범위를 검증한다(심의 실측): 초판은 이 오프셋을 그대로 readUInt16LE 에 넘겨
        // `RangeError: The value of "offset" is out of range` 가 사용자에게 그대로 갔다.
        if (localOffset + 30 > zip.length) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 압축 파일이 손상되었습니다(항목 위치 오류).");
        }
        // 로컬 헤더의 가변 길이는 중앙 디렉터리의 것과 다를 수 있다 — 데이터 시작을 로컬 헤더에서 다시 읽는다.
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const localExtraLength = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        if (dataStart + compressedSize > zip.length) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 압축 파일이 손상되었습니다(길이 오류).");
        }
        const raw = zip.subarray(dataStart, dataStart + compressedSize);

        const data = method === 0 ? raw : await inflateGuarded(raw);
        // ⚠ **총량은 쓰기 전에 본다.** 항목당 상한을 통과한 조각도 쌓이면 디스크를 채운다.
        totalBytes += data.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `받은 파일이 풀면 너무 큽니다(상한 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB).`,
                "받은 꾸러미가 정상이 아닙니다. 잘커라에 문의해 주세요.",
            );
        }
        // ⚠ **문자열 판정만으로는 부족하다.** `resolve` 가 뿌리 안이라 해도 부모 조각이 심링크면
        //   `writeFile` 은 그 링크를 따라간다 — 판정은 파일시스템에 물어야 한다(`safeWrite.ts`).
        const segments = safeSegments(root, name);
        assertNotVendored(segments, name);
        const parent = await descend(root, segments.slice(0, -1), verified);
        const path = join(parent, segments[segments.length - 1] ?? "");
        await assertNotSymlink(path, name);
        await writeFile(path, data);
        fileCount += 1;
    }
    return { fileCount };
}

/** 해제하되 상한을 건다. 넘으면 사람이 읽을 오류로 끊는다(압축 폭탄 방어). */
async function inflateGuarded(raw: Buffer): Promise<Buffer> {
    try {
        return (await inflate(raw, { maxOutputLength: MAX_ENTRY_BYTES })) as Buffer;
    } catch (cause) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 파일이 너무 크거나 손상되었습니다.",
            "다시 시도해도 같으면 잘커라에 문의해 주세요.",
            cause,
        );
    }
}

/** EOCD(끝 표식)를 뒤에서 찾는다. 주석이 붙어 있을 수 있어 마지막 64KB 를 훑는다. */
function findEocd(zip: Buffer): number {
    const start = Math.max(0, zip.length - 66_000);
    for (let i = zip.length - 22; i >= start; i -= 1) {
        if (zip.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new DevtoolsError("SERVER_REJECTED", "받은 파일이 zip 형식이 아닙니다.");
}

