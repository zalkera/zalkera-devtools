import { writeExclusive } from "./safeWrite.ts";
import type { ImportPlan } from "./importZip.ts";
import { join, resolve } from "node:path";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { DevtoolsError } from "./errors.ts";
import { assertNotSymlink, assertNotVendored, descend, safeSegments } from "./safeWrite.ts";
import { MAX_ZIP_ENTRIES, MAX_ENTRY_BYTES, MAX_EXTRACT_BYTES } from "./limits.ts";

const inflate = promisify(inflateRaw);


/**
 * **해제 총량 상한.** 항목당 상한만으로는 못 막는다 — zip 의 중앙 디렉터리 항목 여럿이 **같은
 * 로컬 헤더를 가리켜도** 되므로, 압축 스트림 하나를 이름 수만 개가 공유할 수 있다. 실측: 9KB zip
 * 하나가 파일 150개·157MB 를 오류 없이 뱉었다(증폭 17,320:1). 항목 수 상한(uint16 라 65,535)까지
 * 채우면 같은 방식으로 디스크가 찰 때까지 간다.
 *
 * 형제 `untar.ts` 는 총량과 항목 수를 **둘 다** 갖고 있다. zip 만 둘 다 없었다.
 *
 * **값의 근거**: 받는 아카이브는 다운로드 상한 150MB([MAX_DOWNLOAD_BYTES])로 이미 잘린다.
 * 실물 소스의 압축비는 2.5~3배(실측: 프리셋 2종). 그래서 상한은 **150 × 3 을 계산한 값**이다 —
 * `limits.ts` 가 그 곱을 한다. 종전에는 이 유도를 산문으로만 적고 값은 400MB 를 **타이핑**해 뒀다.
 * **소스 tar.gz 도 같은 상수를 import 한다**(`fetchSource.ts`) — 이제 갈리려면 `limits.ts` 를 고쳐야 한다.
 */
const MAX_TOTAL_BYTES = MAX_EXTRACT_BYTES;


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

/**
 * 아카이브의 **항목 이름만** 읽는다. 파일을 하나도 만들지 않는다.
 *
 * 들여오기가 쓴다 — 무엇을 풀지(`decideImportPlan`)는 **쓰기 전에** 정해져야 한다.
 */
/**
 * zip 항목의 **파일 이름을 읽는다 — UTF-8 만 받는다.**
 *
 * ⚠ **인코딩을 추측하지 않는다.** 범용 플래그 11번(EFS)을 안 세운 zip 은 이름이 어느 인코딩인지
 *   **진짜로 모호하다.** CP949 를 받아 주면 GB2312 이름이 엉뚱한 한자로 조용히 읽히고, 거기에
 *   Shift_JIS 를 더하면 또 다른 충돌이 생긴다 — 사다리를 늘릴수록 「조용히 틀리는」 조합이 는다.
 *
 *   그리고 이 이름은 여기서 끝나지 않는다. 소스가 서버로 올라가고 파일명이 곧 주소가 되는데,
 *   그 아래는 전부 UTF-8 을 전제한다. 경계에서 안 막으면 틀린 이름이 그대로 흘러간다.
 *
 *   거절은 **보이고 되돌릴 수 있다.** 오독은 「이미지가 404 인데 원인이 화면에 없는」 상태로
 *   남는다. 그래서 못 읽으면 멈추고, **다음에 할 일을 이름 대고 말한다** — 「최신 도구로」라고만
 *   하면 같은 도구로 다시 해서 또 막힌다.
 */
function decodeEntryName(raw: Buffer, flags: number): string {
    // ASCII 뿐이면 어느 인코딩이든 같다 — 가장 흔한 경우를 먼저 끝낸다.
    let ascii = true;
    for (const byte of raw) {
        if (byte >= 0x80) {
            ascii = false;
            break;
        }
    }
    if (ascii) return raw.toString("latin1");

    // ⚠ **비-ASCII 이름은 「UTF-8 이라고 표시된 것」만 받는다**(범용 플래그 11번 = EFS).
    //    형식이 정한 것이 그것이다 — 플래그가 없으면 이름은 UTF-8 이 **아니라고** 봐야 한다.
    //
    //    유효한 UTF-8 로 읽히는지만 보면 창이 남는다: CP949 두 바이트열 중 상당수가 UTF-8 로도
    //    유효하고, 그중에는 실제 한글 음절이 되는 것이 많다 — 「체크.png」가 `üũ.png` 로 조용히
    //    풀린다(심의 실측). 플래그를 요구하면 그 창이 닫힌다.
    if ((flags & 0x800) === 0) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "압축 파일 안의 파일 이름을 읽지 못했습니다.",
            "이름이 UTF-8 로 저장돼 있지 않습니다. 파일 이름을 영문으로 바꾸시거나, " +
                "이름을 UTF-8 로 저장하는 압축 도구로 다시 압축해 주세요.",
        );
    }
    try {
        return new TextDecoder("utf-8", {fatal: true}).decode(raw);
    } catch {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "압축 파일 안의 파일 이름을 읽지 못했습니다.",
            "이름이 UTF-8 로 저장돼 있지 않습니다. 파일 이름을 영문으로 바꾸시거나, " +
                "이름을 UTF-8 로 저장하는 압축 도구로 다시 압축해 주세요.",
        );
    }
}

export function listZipEntries(zip: Buffer): string[] {
    const eocd = findEocd(zip);
    const entryCount = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    if (entryCount > MAX_ZIP_ENTRIES) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `받은 파일에 항목이 너무 많습니다(${entryCount.toLocaleString()}개 · 상한 ${MAX_ZIP_ENTRIES.toLocaleString()}개).`,
            "받은 꾸러미가 정상이 아닙니다.",
        );
    }
    const names: string[] = [];
    for (let i = 0; i < entryCount; i += 1) {
        if (offset < 0 || offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 압축 파일이 손상되었습니다(목록 오류).");
        }
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const flags = zip.readUInt16LE(offset + 8);
        const name = decodeEntryName(zip.subarray(offset + 46, offset + 46 + nameLength), flags);
        offset += 46 + nameLength + extraLength + commentLength;
        // ⚠ **디렉터리 항목도 돌려준다.** 실물 zip(탐색기·Finder·`zip -r`)은 디렉터리 항목을
        //    담는데, 계획이 파일만 판정하면 `node_modules/` 같은 항목이 걸러지지 않고 해제기
        //    안쪽 가드까지 가서 **정상 zip 이 통째로 거절된다**(심의 실증).
        names.push(name);
    }
    return names;
}

/**
 * @param plan 들여오기 계획. 주면 **접두를 벗기고 계획에 없는 항목은 건너뛴다.**
 *
 * ⚠ **벗긴 뒤에 안전 검사가 돈다.** 순서가 뒤집히면 `site/../../etc/x` 같은 이름이 벗겨지기 전
 *   모양으로 검사를 통과하고, 실제로 쓰는 경로는 다른 것이 된다.
 */
export async function extractZip(zip: Buffer, targetDir: string, plan?: ImportPlan): Promise<UnzipResult> {
    const eocd = findEocd(zip);
    const entryCount = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    const root = resolve(targetDir);
    let fileCount = 0;
    /**
     * **이번 해제에서 우리가 쓴 경로들.** `writeExclusive` 가 「원래 있던 고객 파일」과 「아카이브가
     * 같은 경로를 두 번 담음」을 가르는 데 쓴다 — 다음에 할 일이 정반대라 뭉치면 안 된다.
     */
    const written = new Set<string>();
    let totalBytes = 0;
    /** 계획이 허락한 이름만 쓴다. 배열 조회를 반복하지 않으려고 한 번만 만든다. */
    const allowed = plan ? new Set(plan.keep) : null;

    if (entryCount > MAX_ZIP_ENTRIES) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `받은 파일에 항목이 너무 많습니다(${entryCount.toLocaleString()}개 · 상한 ${MAX_ZIP_ENTRIES.toLocaleString()}개).`,
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
        const flags = zip.readUInt16LE(offset + 8);
        const entryName = decodeEntryName(zip.subarray(offset + 46, offset + 46 + nameLength), flags);
        offset += 46 + nameLength + extraLength + commentLength;

        // ⚠ **여기서 벗긴다 — 안전 검사보다 앞이다.** 아래 `safeSegments`·`descend` 는 실제로 쓸
        //    경로를 봐야 한다. 벗기기 전 이름으로 검사하면 검사한 것과 쓰는 것이 달라진다.
        if (plan && !entryName.startsWith(plan.strip)) continue;
        const name = plan ? entryName.slice(plan.strip.length) : entryName;
        if (plan && (name === "" || !allowed?.has(name))) continue;

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
        // ⚠ **`wx` — 이미 있는 파일 위에 쓰지 않는다.** 「빈 폴더」 판정은 `.vscode` 같은
        //    편집기 산물을 일부러 통과시키고(`emptyDir.ts`), 도움말도 「있어도 괜찮습니다」라고
        //    말한다. 그런데 받는 아카이브가 같은 경로를 담고 있으면 **고객 파일이 소리 없이
        //    교체된다** — 그리고 롤백은 그 파일을 기준선으로 봐서 못 되감는다.
        //    「지금 폴더는 바뀌지 않습니다」라고 화면이 약속하는 자리다.
        await writeExclusive(path, data, name, written);
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

