import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_EXTRACT_BYTES } from "./limits.ts";
import { DevtoolsError } from "./errors.ts";
import { assertNotWrittenTwice, writeExclusive, writeViaRename } from "./safeWrite.ts";
import {assertNotSymlink, descend, safeSegments, assertNotVendored} from "./safeWrite.ts";

/**
 * tar 해제기 — **의존성 0**(내장 zlib). 두 경로가 이 한 파서를 공유한다.
 *
 * - {@link extractTarGz} — 버퍼 통째. 사이트 소스(수~수십 MB)용.
 * - {@link extractTarGzFile} — **스트리밍**. 의존성 페이로드(압축 167MB → 풀면 600MB)용.
 *
 * 파서를 나누지 않는 이유: 헤더 의미(GNU `L`·pax `x`·경로 탈출 판정)가 갈리면 **한쪽만 고쳐지는 날**이
 * 온다. 그 종류의 드리프트가 실제로 조용한 파일 유실을 만든다(아래 `L` 헤더 주석).
 *
 * ⚠ **GNU 긴 이름(`L`)·pax(`x`) 헤더를 반드시 해석한다**(심의 차단 · 2026-08-03).
 * 백엔드 패커가 `LONGFILE_GNU` 라 경로가 100바이트를 넘으면 무조건 `L` 헤더를 낸다. 건너뛰면 뒤따르는
 * 헤더의 **100자로 잘린 이름**이 쓰이고, 두 파일이 같은 잘린 경로로 겹쳐 하나가 다른 하나를 덮어쓴다.
 * 사용자에게는 "4개 받았습니다"라고 말하고 디스크엔 3개다. 한글 경로는 UTF-8 3바이트/자라 **약 33자에서**
 * 걸린다. 그래서 **모르는 타입을 만나면 조용히 넘어가지 않고 던진다** — 조용한 손상보다 실패가 낫다.
 */
export interface UntarOptions {
    /**
     * 심볼릭 링크 처리.
     *
     * - `reject`(기본) — 만들지 않고 건너뛴다. 사이트 소스에는 링크가 없어야 정상이다.
     * - `materialize` — **뿌리 안을 가리키는 상대 링크만** 만든다. 의존성 페이로드에 필요하다:
     *   `node_modules/.bin/*` 이 전부 상대 심볼릭 링크이고(실측 9개 · `next`·`tsc`·`jiti` 등),
     *   없으면 `next dev` 가 실행 파일을 못 찾는다.
     *   절대경로·뿌리 밖(`../../..`)은 **거절**한다 — 링크는 해제 시점이 아니라 **사용 시점에** 따라가므로,
     *   경로 검사를 안 하면 오염된 아카이브가 고객 홈의 임의 파일을 가리키게 만들 수 있다.
     */
    symlinks?: "reject" | "materialize";
    /**
     * 실행 비트 보존. 기본 false(0644 고정).
     *
     * 페이로드에는 **반드시 true** 다. `.bin` 의 스크립트가 실행 불가로 풀리면 `next dev` 가
     * `EACCES` 로 죽는데, 그 오류는 의존성 준비가 아니라 **실행 단계**에서 나므로 사용자도 우리도
     * 원인을 엉뚱한 데서 찾게 된다.
     */
    preserveMode?: boolean;
    /**
     * 해제 산출물 상한(심의 W3). 버퍼 경로엔 `maxOutputLength` 가 있었는데 **스트리밍 경로만 비어 있었다** —
     * 오염된 응답이 sha 대조 **전에** 디스크를 무제한 채울 수 있었다.
     *
     * 상한을 고정값으로 둘 수 없다: 정상 페이로드가 풀면 600MB 라 버퍼 경로의 200MB 를 그대로 쓰면
     * 정상 동작이 죽는다. 그래서 호출부가 **서버가 신고한 크기 기준**으로 넘긴다(`payload.ts`).
     */
    maxBytes?: number;
    /**
     * `node_modules` 를 담은 항목을 거부하는가. **소스 꾸러미는 true**, 의존성 페이로드는 false 다
     * (페이로드는 정당하게 `node_modules` 트리다). 자세한 이유는 [assertNotVendored].
     */
    rejectVendored?: boolean;
    /**
     * 항목 수 상한(기본 [MAX_ENTRIES]). 호출부가 더 좁게 잡을 수 있다 — `maxBytes` 와 같은 성질이다.
     *
     * 시험이 이 값을 쓰는 이유가 하나 더 있다: 기본 상한을 **실제로 넘겨** 재려면 20만 파일을 디스크에
     * 써야 하고, 그 시험은 자기가 디스크 폭탄이 된다(실측 — /tmp 를 채웠다). 가드를 재는 시험이
     * 가드가 막으려는 바로 그 손해를 내면 안 된다.
     */
    maxEntries?: number;
    /**
     * 항목마다 **무엇을 할지** 정한다. 없으면 전부 `create` — 종전 동작 그대로다.
     *
     * ■ 왜 「덮어쓰기 전역 스위치」가 아닌가
     *
     * 이미 있는 파일 위에 안 쓰는 규칙([writeExclusive])은 이유가 있어 서 있다 — 고객 파일이 소리
     * 없이 교체되면 되돌리기가 그 파일을 기준선으로 본다. 전역 `overwrite: true` 는 그 규칙을 **통째로**
     * 끈다. `pull` 이 필요한 것은 그게 아니라 **자기가 안전하다고 판정한 경로만** 덮는 것이다
     * (memo184 §2.2 — 깨끗하거나, 로컬 내용이 받을 내용과 이미 같은 경로).
     *
     * 그래서 판정을 부르는 쪽이 경로 단위로 넘긴다. 규칙의 뜻이 안 무너진다.
     *
     * @param path 뿌리 기준 상대 경로(`/` 구분자). [readTarGzManifest] 의 열쇠와 **같은 값**이다.
     */
    decide?: (path: string) => "create" | "replace" | "skip";
}

/** 버퍼 해제(사이트 소스용). 반환은 **쓴 파일 수**다(디렉터리·링크는 안 센다). */
export async function extractTarGz(gzipped: Buffer, targetDir: string, options: UntarOptions = {}): Promise<number> {
    // ⚠ `maxBytes` 를 **여기서도 쓴다**(심의 실측 · 2026-08-10). 종전에는 스트리밍 경로만 이 값을 보고
    // 버퍼 경로는 통짜 상한만 봐서, `maxBytes: 1024` 로 불러도 20,000 파일이 기록됐다. 호출부가 건 상한이
    // 경로에 따라 있다 없다 하면 그건 상한이 아니다.
    return extractTar(await gunzipBuffer(gzipped, options.maxBytes), targetDir, options);
}

/**
 * 이미 푼 tar 를 해제한다.
 *
 * ⚠ **한 번만 풀기 위한 문이다.** `pull` 은 같은 아카이브를 두 번 본다(판정용 읽기 → 쓰기). 각자
 *   `gunzip` 하면 산출물 크기만큼을 **두 번** 램에 올린다.
 *
 * ■ 실측 (300MB 로 부푸는 tar.gz · 파일 30개)
 *   · 두 번 풀 때 — peak RSS **1,071MB**(심의 실측)
 *   · 한 번 풀 때 — peak RSS **934MB**
 *   · 대조군: 이 문을 안 쓰는 기존 경로 `extractTarGz` 단독 — **934MB**(같다)
 *
 *   즉 **두 번 푸는 대가만** 없앴다. 남은 산출물 3배는 [extractTarGz] 가 통짜 Buffer 로 도는 성질이고
 *   이 트랜치 이전부터 있던 것이다 — 줄이려면 스트리밍이어야 하는데, 그러면 「무엇을 할지 정한 뒤에
 *   쓴다」(`pull.ts` 의 순서 계약)가 성립하지 않는다. **여기서 해결했다고 적지 않는다.**
 *
 *   재현: `node scratchpad/실전/mem.mjs` · `node scratchpad/실전/mem2.mjs`
 *   (`VmHWM` 을 읽는다. 두 스크립트가 같은 300MB 픽스처를 쓴다.)
 */
export async function extractTar(tar: Buffer, targetDir: string, options: UntarOptions = {}): Promise<number> {
    const sink = await createSink(targetDir, options);
    await forEachBufferedEntry(tar, (meta, data) => sink.consume(meta, data));
    return sink.fileCount();
}

/**
 * 버퍼 tar 를 항목 단위로 훑는다. **이 파일의 버퍼 경로는 전부 여기를 지난다.**
 *
 * ⚠ 파서 사본을 만들지 않으려고 뽑아낸 자리다. 종전에 이 루프가 [extractTarGz] 안에 인라인이었고,
 *   스트리밍 경로와 갈려 **한쪽만 잘린 데이터를 거절하던** 실측 드리프트가 있었다. 매니페스트 읽기가
 *   자기 루프를 또 쓰면 같은 일이 다시 난다.
 */
async function forEachBufferedEntry(
    tar: Buffer,
    consume: (meta: Entry, data: Buffer) => Promise<void>,
): Promise<void> {
    let offset = 0;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (isEndOfArchive(header)) break;
        const meta = parseHeader(header);
        offset += BLOCK;
        // 스트리밍 경로는 짧은 읽기를 거절하는데 **버퍼 경로만 조용히 잘린 데이터를 썼다**(재심의 경고 1 ·
        // 실측: 같은 아카이브가 한쪽은 REJECTED, 한쪽은 "1개 받았습니다" + 512B 파일). 파서를 하나로 묶은
        // 이유가 이런 드리프트를 없애는 것이었는데 정작 여기 남아 있었다.
        if (offset + meta.size > tar.length) {
            throw new DevtoolsError("SERVER_REJECTED", "받은 파일이 중간에 끊겼습니다.");
        }
        const data = tar.subarray(offset, offset + meta.size);
        offset += Math.ceil(meta.size / BLOCK) * BLOCK;
        await consume(meta, data);
    }
}

/** [readTarGzManifest] 가 돌려주는 한 항목. `bytes` 는 **푼 뒤**의 크기다. */
export interface TarManifestEntry {
    sha256: string;
    bytes: number;
}

/**
 * tar.gz 를 **디스크에 안 쓰고** 경로별 sha 로 읽는다(memo184 §2.2 — pull 의 「받을 매니페스트」).
 *
 * ■ 왜 해제와 따로인가
 *
 * pull 은 **무엇을 할지 정한 뒤에** 쓴다. 세 집합 분류가 끝나기 전에 파일을 하나라도 쓰면 「충돌이라
 * 아무것도 안 했습니다」가 거짓이 된다. 그래서 판정용 읽기가 먼저고 쓰기는 [extractTarGz] 의
 * `decide` 로 나중이다 — gz 를 두 번 푸는 값을 치르고 **부분 적용을 안 만든다.**
 *
 * ■ 열쇠는 [safeSegments] 를 지난 값이다
 *
 * 해제 쪽 판정과 **같은 표기**여야 계획이 그대로 먹는다. 조각 검사도 여기서 같이 걸리므로, 폴더 밖을
 * 가리키는 아카이브는 파일을 하나도 안 쓴 채로 거절된다.
 *
 * 디렉터리·심볼릭 링크·하드링크는 목록에 없다 — 매니페스트는 **파일의 목록**이다.
 */
export async function readTarGzManifest(
    gzipped: Buffer,
    options: TarManifestOptions = {},
): Promise<Record<string, TarManifestEntry>> {
    return readTarManifest(await gunzipBuffer(gzipped, options.maxBytes), options);
}

export interface TarManifestOptions {
    maxBytes?: number;
    maxEntries?: number;
    rejectVendored?: boolean;
}

/** 이미 푼 tar 의 매니페스트. gz 를 한 번만 풀려는 부르는 쪽을 위한 문이다([extractTar] 와 같은 이유). */
export async function readTarManifest(
    tar: Buffer,
    options: TarManifestOptions = {},
): Promise<Record<string, TarManifestEntry>> {
    const manifest: Record<string, TarManifestEntry> = {};
    // 디스크를 안 만지므로 뿌리는 **가상**이다. [safeSegments] 는 순수 문자열 계산이고, 파일시스템
    // 뿌리(`/`)를 그대로 쓰면 `root + sep` 가 `//` 가 되어 **정상 경로가 전부 거절된다.**
    const root = resolve(sep, "zalkera-manifest-root");
    let entries = 0;
    const entryCap = Math.min(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
    const names = createNameResolver();

    await forEachBufferedEntry(tar, async (meta, data) => {
        entries += 1;
        if (entries > entryCap) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `받은 파일의 항목이 너무 많습니다(${entryCap}개 초과).`,
                "잘못 받은 상태로 진행하지 않았습니다. 잘커라에 문의해 주세요.",
            );
        }
        const resolved = names.resolve(meta, data);
        if (!resolved) return;
        const {name} = resolved;
        // 🔴 **모르는 형식은 여기서 끊는다.** 종전에는 읽기가 조용히 건너뛰고 해제기만 던졌다 —
        //    그러면 그런 항목을 **뒤에 단** 아카이브가 앞부분을 디스크에 내려놓은 뒤에 죽는다.
        //    「거절이 쓰기보다 앞」이 불변식이 되려면 두 훑기가 **같은 것을 거절**해야 한다(심의 지적).
        assertKnownEntryType(meta.type, name);
        // 디렉터리(`5`)·심볼릭 링크(`2`)·하드링크(`1`)는 매니페스트에 없다 — **파일의 목록**이다.
        if (meta.type !== "0" && meta.type !== "\0") return;
        const segments = safeSegments(root, name);
        // 🔴 **거절은 쓰기보다 앞이어야 한다.** 이 검사를 해제 쪽에만 두면 아카이브 앞부분이 이미
        //    디스크에 내려앉은 **뒤에** 던진다 — 실측: `.env` 를 덮은 뒤 `node_modules` 에서 던졌다.
        //    읽기 훑기는 아무것도 안 쓰므로, 여기서 걸리면 폴더가 그대로다.
        if (options.rejectVendored === true) assertNotVendored(segments, name);
        const path = segments.join("/");
        if (path === "") return;
        manifest[path] = {sha256: createHash("sha256").update(data).digest("hex"), bytes: meta.size};
    });
    return manifest;
}

/**
 * 스트리밍 해제(페이로드용). gz 를 **파일로 흘린 뒤** 순차로 읽는다.
 *
 * 왜 두 단계인가: 압축 167MB 는 풀면 600MB 다. 통째로 Buffer 에 올리면 확장 호스트가 OOM 으로 죽고,
 * **그러면 다른 확장까지 함께** 죽는다(zip 해제기 주석과 같은 이유). tar 는 순차 형식이라 파일로 한 번
 * 흘려 놓으면 512바이트 헤더 → 데이터 → 다음 헤더로 **일정 메모리**에 읽을 수 있다.
 *
 * @param gzPath 이미 내려받아 둔 `.tar.gz` 경로
 * @param scratchPath 중간 tar 를 둘 자리. **끝나면 지운다**(실패해도 지운다).
 */
export async function extractTarGzFile(
    gzPath: string,
    targetDir: string,
    scratchPath: string,
    options: UntarOptions = {},
): Promise<number> {
    try {
        const limit = resolveCap(options.maxBytes); // 버퍼 경로와 **같은 문**을 지난다
        const guard = new Transform({
            transform(chunk: Buffer, _enc, done) {
                written += chunk.length;
                if (written > limit) {
                    done(new Error(`해제 산출물이 상한(${limit}B)을 넘었습니다`));
                    return;
                }
                done(null, chunk);
            },
        });
        let written = 0;
        await pipeline(createReadStream(gzPath), createGunzip(), guard, createWriteStream(scratchPath));
    } catch (cause) {
        await rm(scratchPath, { force: true }).catch(() => {});
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 의존성 꾸러미를 풀지 못했습니다.",
            "다시 시도해도 같으면 잘커라에 문의해 주세요.",
            cause,
        );
    }

    const sink = await createSink(targetDir, options);
    const handle = await open(scratchPath, "r");
    try {
        const header = Buffer.alloc(BLOCK);
        for (;;) {
            const { bytesRead } = await handle.read(header, 0, BLOCK, null);
            if (bytesRead < BLOCK) break;
            if (isEndOfArchive(header)) break;

            const meta = parseHeader(header);
            // 데이터는 항목 단위로만 메모리에 올린다. node_modules 의 개별 파일은 작다 —
            // 큰 것은 트리 **전체**이지 한 파일이 아니다.
            const data = Buffer.alloc(meta.size);
            if (meta.size > 0) {
                const read = await handle.read(data, 0, meta.size, null);
                if (read.bytesRead < meta.size) {
                    throw new DevtoolsError("SERVER_REJECTED", "받은 의존성 꾸러미가 중간에 끊겼습니다.");
                }
                // tar 는 512 배수로 채운다 — 남은 패딩을 건너뛴다.
                const padding = Math.ceil(meta.size / BLOCK) * BLOCK - meta.size;
                if (padding > 0) await handle.read(Buffer.alloc(padding), 0, padding, null);
            }
            await sink.consume(meta, data);
        }
    } finally {
        await handle.close().catch(() => {});
        await rm(scratchPath, { force: true }).catch(() => {});
    }
    return sink.fileCount();
}

const BLOCK = 512;

interface Entry {
    name: string;
    size: number;
    type: string;
    mode: number;
    linkTarget: string;
}

function isEndOfArchive(header: Buffer): boolean {
    return header.every((byte) => byte === 0);
}

function parseHeader(header: Buffer): Entry {
    const size = parseOctal(header.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0) {
        // 초판은 NaN 이면 루프가 조용히 끝나고 **성공으로 보고**했다(뒤 파일 유실).
        throw new DevtoolsError("SERVER_REJECTED", "받은 파일이 손상되었습니다(길이 필드 오류).");
    }
    // 🔴 **신고된 크기를 그대로 믿으면 안 된다**(재심의 차단 1 · 실측).
    // 스트리밍 경로가 `Buffer.alloc(size)` 를 하는데, 12바이트 8진 필드는 ~68GB 까지 표현한다.
    // 2GB 를 넘겨 신고하면 `handle.read` 의 length 가 Int32 를 벗어나 **네이티브 어서션으로 프로세스가
    // abort 된다** — JS 로 못 잡는 죽음이다. 실측: **65바이트 아카이브 하나로 exit 134**.
    // 그러면 확장 호스트가 통째로 죽고, 이 파일 첫머리가 걱정한 "다른 확장까지 함께"가 그대로 일어난다.
    // 헤더 하나가 신고만 하면 되므로 gz 산출 상한(maxBytes)으로는 보이지도 않는다.
    if (size > MAX_ENTRY_BYTES) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `받은 파일에 비정상적으로 큰 항목이 있습니다(${size}B).`,
            "잘못 받은 상태로 진행하지 않았습니다. 잘커라에 문의해 주세요.",
        );
    }
    const rawName = cstring(header.subarray(0, 100));
    const prefix = cstring(header.subarray(345, 500));
    return {
        name: prefix ? `${prefix}/${rawName}` : rawName,
        size,
        type: String.fromCharCode(header[156] ?? 0),
        mode: parseOctal(header.subarray(100, 108)) || 0o644,
        linkTarget: cstring(header.subarray(157, 257)),
    };
}

/**
 * 긴 이름 헤더를 풀어 **이 항목의 실제 이름**을 준다. `null` 이면 그 항목은 헤더일 뿐 실물이 아니다.
 *
 * ⚠ **이 해석을 두 벌로 두지 마라.** 해제 쪽과 매니페스트 쪽이 각자 이 분기를 베끼면, 한쪽만 `g`(pax
 *   전역)를 다루거나 한쪽만 빈 `path=` 를 걸러 **같은 아카이브가 두 경로에서 다른 이름으로 읽힌다.**
 *   pull 은 그 둘을 대조해 무엇을 덮을지 정하므로, 이름이 갈리면 계획이 엉뚱한 파일에 적용된다.
 *   이 파일은 파서를 갈랐다가 실제로 드리프트를 낸 적이 있다([forEachBufferedEntry] 주석).
 */
function createNameResolver() {
    /** 앞선 `L`/`x` 헤더가 지정한 다음 항목의 이름. 쓰고 나면 비운다. */
    let pendingName: string | null = null;
    /** 앞선 `K` 헤더가 지정한 다음 항목의 링크 대상(100바이트를 넘는 링크). */
    let pendingLink: string | null = null;

    return {
        resolve(entry: Entry, data: Buffer): {name: string; linkTarget: string} | null {
            if (entry.type === "L") {
                pendingName = cstring(data);
                return null;
            }
            // pax 확장 헤더 — `path=` 레코드가 다음 항목의 이름이다.
            if (entry.type === "x" || entry.type === "g") {
                const path = parsePaxPath(data);
                if (path) pendingName = path;
                return null;
            }
            // GNU 긴 링크 이름 — 다음 항목의 **링크 대상**이 이 데이터다.
            if (entry.type === "K") {
                pendingLink = cstring(data);
                return null;
            }
            const name = pendingName ?? entry.name;
            pendingName = null;
            const linkTarget = pendingLink ?? entry.linkTarget;
            pendingLink = null;
            return {name, linkTarget};
        },
    };
}

/**
 * 다룰 수 있는 항목 형식인가. **두 훑기가 같은 문을 지난다** — 한쪽만 거절하면 「거절이 쓰기보다
 * 앞」이 술어별로만 서고, 거절되는 항목을 아카이브 **뒤쪽에** 두는 것만으로 반쯤 적용이 난다.
 */
function assertKnownEntryType(type: string, name: string): void {
    if (type === "0" || type === "\0" || type === "5" || type === "2" || type === "1") return;
    throw new DevtoolsError(
        "SERVER_REJECTED",
        `받은 파일에 다룰 수 없는 항목이 있습니다(형식 ${type}): ${name}`,
        "잘커라에 문의해 주세요. 잘못 받은 상태로 진행하지 않았습니다.",
    );
}

/**
 * 항목을 디스크에 반영하는 쪽. 버퍼·스트리밍 두 경로가 **같은 판정**을 쓰게 묶어 둔다.
 *
 * 🔴 **경로 판정은 물리(physical)여야 한다**(심의 차단 · 2026-08-03 · 실제로 뚫렸다).
 *
 * 초판은 문자열로만 쟀다(`resolve`·`normalize`). 그런데 실제 `symlink(2)`·`writeFile` 은 **부모 조각을 전부
 * 따라간다** — 그래서 링크를 사다리처럼 엮으면 매 홉이 "어휘상 뿌리 안"이면서 물리적으로는 한 단계씩 올라간다:
 *
 * ```
 * node_modules/up         -> ..   (어휘상 뿌리 = 통과)
 * node_modules/up/up2     -> ..   (부모가 이미 뿌리 밖을 가리킨다)
 * node_modules/up/up2/up3 -> ..
 * → 뿌리와 무관한 파일이 덮어써졌다(재현 실측: 해제기는 "성공, 1개 씀"이라 보고했다)
 * ```
 *
 * 그래서 **뿌리에서부터 조각 단위로 내려가며 심볼릭 링크를 절대 따라가지 않는다**([descend]).
 * 이러면 우리가 만드는 모든 경로가 "우리가 확인한 실제 디렉터리들"만 거치므로, 사슬이 몇 홉이든 밖으로 못 나간다.
 * `..` 자체를 금지하는 방법은 못 쓴다 — `.bin` 링크 9개가 전부 `../` 다(실측).
 */
async function createSink(targetDir: string, options: UntarOptions) {
    await mkdir(targetDir, { recursive: true });
    // 뿌리 자체가 심링크일 수 있다(예: `/tmp` → `/private/tmp`). 기준을 실제 경로로 고정한다.
    const root = await realpath(targetDir);
    /**
     * 이미 "실제 디렉터리이고 심링크가 아님"을 확인한 자리. 같은 해제 안에서는 우리만 쓰므로 재검증이 없다.
     *
     * 없으면 항목마다 뿌리부터 조각 전부를 다시 `lstat` 한다 — 실측 +56%(1914ms → 2992ms · 14,229파일).
     * 절대치는 `npm install` 대비 무해하지만, 공짜로 없앨 수 있는 비용을 남길 이유가 없다(재심의 경고 2).
     */
    const verified = new Set<string>([root]);
    /**
     * 항목 수 상한. **zip 에는 있고 tar 에는 없었다**(심의 실측: 141KB gz → 20,000 항목 · 72:1).
     * 선언 167MB 짜리 페이로드는 260만 항목까지 허가하던 셈이다. 바이트 상한은 큰 파일을 막지만
     * **작은 파일 수백만 개**는 못 막는다 — inode 고갈과 몇 시간짜리 해제가 그 모습이다.
     *
     * 값은 zip 의 65,535 보다 크게 잡는다: 의존성 페이로드가 실측 14,229 파일이고, 그보다 큰 트리도
     * 정상일 수 있다. 막으려는 것은 "정상보다 두 자릿수 큰 것"이다.
     */
    let entries = 0;
    const entryCap = Math.min(options.maxEntries ?? MAX_ENTRIES, MAX_ENTRIES);
    const materializeLinks = options.symlinks === "materialize";
    const preserveMode = options.preserveMode === true;
    let count = 0;
    /**
     * **이번 해제에서 우리가 쓴 경로들.** 이름을 `written` 과 가른다 — 이 파일에는 「쓴 **바이트**
     * 수」를 뜻하는 `written` 이 따로 있고, 두 뜻이 한 이름을 쓰면 읽는 사람도 검사기도 헷갈린다. `writeExclusive` 가 「원래 있던 고객 파일」과 「아카이브가
     * 같은 경로를 두 번 담음」을 가르는 데 쓴다 — 다음에 할 일이 정반대라 뭉치면 안 된다.
     */
    const writtenPaths = new Set<string>();
    /**
     * 위의 것을 **소문자로 접은** 사본. 대소문자를 안 가리는 파일시스템에서 같은 파일이 되는 짝을
     * 잡는 데만 쓴다 — 「안 덮는」 갈래는 그 짝을 `EEXIST` 로 잡지만 「골라 덮는」 갈래는 못 잡는다.
     */
    const foldedPaths = new Set<string>();
    const names = createNameResolver();

    return {
        fileCount: () => count,
        async consume(entry: Entry, data: Buffer): Promise<void> {
            entries += 1;
            if (entries > entryCap) {
                throw new DevtoolsError(
                    "SERVER_REJECTED",
                    `받은 파일에 항목이 너무 많습니다(상한 ${entryCap.toLocaleString()}개).`,
                );
            }
            // GNU 긴 이름 — 이 항목의 **데이터가 다음 항목의 이름**이다.
            const resolved = names.resolve(entry, data);
            if (!resolved) return;
            const {name, linkTarget} = resolved;

            const segments = safeSegments(root, name);
            if (options.rejectVendored === true) assertNotVendored(segments, name);


            if (entry.type === "5") {
                // ⚠ `decide` 가 있으면 **빈 폴더를 미리 만들지 않는다.** 부르는 쪽은 파일 몇 개만
                //   골라 쓰는 중이고, 안 쓸 경로의 폴더까지 만들면 「손대지 않았다」가 거짓이 된다.
                //   쓸 파일의 부모는 아래 [descend] 가 필요할 때 만든다.
                if (options.decide) return;
                await descend(root, segments, verified);
                return;
            }

            if (entry.type === "2") {
                if (!materializeLinks) return;
                await writeSymlink(root, segments, name, linkTarget, verified);
                return;
            }
            // 하드링크(`1`)는 만들지 않는다. **실측**(2026-08-03 · examples 레포 node_modules 를 실제로 구워
            // 항목 타입을 셈): 디렉터리 984 · 파일 14,229 · **심볼릭 링크 9**(전부 `.bin` 의 상대 링크) ·
            // `L` 긴 이름 헤더 230 · **하드링크 0**. 지원하면 "이미 푼 파일을 가리킨다"는 전제가 생겨
            // 순서 의존이 붙는데, 정작 쓰이지 않는다.
            if (entry.type === "1") return;

            assertKnownEntryType(entry.type, name);

            const leaf = segments[segments.length - 1];
            if (!leaf) throw new DevtoolsError("SERVER_REJECTED", `받은 파일에 이상한 경로가 있습니다: ${name}`);
            // 판정은 **조각 검사를 통과한 경로**로 묻는다. tar 가 신고한 이름으로 물으면 `./a` 와 `a` 가
            // 갈려, 부르는 쪽이 「건드리지 마라」고 한 파일이 다른 표기로 들어와 덮인다.
            const verdict = options.decide?.(segments.join("/")) ?? "create";
            if (verdict === "skip") return;
            const parent = await descend(root, segments.slice(0, -1), verified);
            const path = join(parent, leaf);
            // 마지막 조각이 이미 심링크면 **쓰기가 그 링크를 따라간다** — 조각 검사의 마지막 칸이다.
            await assertNotSymlink(path, name);
            // ⚠ **기본은 「이미 있는 파일 위에 쓰지 않는다」**(아래 `else` 가지). 「빈 폴더」 판정은
            //    `.vscode` 같은 편집기 산물을 일부러 통과시키고 도움말도 「있어도 괜찮습니다」라고
            //    말한다. 아카이브가 같은 경로를 담고 있으면 고객 파일이 소리 없이 교체되고, 롤백은
            //    그 파일을 기준선으로 봐서 못 되감는다 — 화면은 「지금 폴더는 바뀌지 않습니다」라고 한다.
            //
            //    `replace` 가지는 그 규칙의 **예외가 아니라 위임**이다: 부르는 쪽이 그 경로 하나하나에
            //    대해 「덮어도 잃을 것이 없다」를 이미 판정했다([UntarOptions.decide] 참조).
            //    판정 없이 오는 길에서는 이 가지가 안 열린다.
            if (verdict === "replace") {
                // 부르는 쪽이 「이 경로는 덮어도 잃을 것이 없다」를 이미 판정했다. 그래도 **같은 해제에서
                // 두 번 나오는 것**은 여전히 사고다 — 그 판정은 [assertNotWrittenTwice] 한 벌이 한다.
                assertNotWrittenTwice(path, name, writtenPaths);
                // 🔴 **대소문자만 다른 짝도 잡는다.** macOS·Windows 에서 `App.tsx` 와 `app.tsx` 는
                //    같은 파일이다. 「안 덮는」 갈래는 그 자리에서 `EEXIST` 로 걸렸는데, 이 갈래는
                //    맨 `writeFile` 이라 **조용히 뒤엣것으로 교체된다** — 그리고 장부에는 둘 다
                //    남아 한쪽이 영영 안 맞는다(실측). 정본 tar 에 그런 짝이 있는 것 자체가 결함이다.
                assertNotWrittenTwice(path.toLowerCase(), name, foldedPaths);
                // 🔴 **맨 `writeFile` 을 쓰지 않는다.** 잎이 **하드링크**면 그 쓰기가 대상에 그대로
                //    가서 **폴더 밖 파일이 서버 내용으로 교체된다**(심의 실측). `lstat` 는 하드링크를
                //    못 본다 — 경계는 `rename` 이다([writeViaRename]).
                await writeViaRename(path, data, preserveMode && (entry.mode & 0o111) !== 0 ? 0o755 : 0o644);
                writtenPaths.add(path);
                foldedPaths.add(path.toLowerCase());
            } else {
                await writeExclusive(path, data, name, writtenPaths);
            }
            if (preserveMode && (entry.mode & 0o111) !== 0) {
                // 실행 비트가 있던 것만 되살린다. 전체 mode 를 그대로 쓰지 않는 이유는 아카이브가 정한
                // 권한(예: 0777·setuid)을 고객 디스크에 그대로 옮기지 않기 위해서다.
                await chmod(path, 0o755).catch(() => {});
            }
            count += 1;
        },
    };
}



/**
 * 심볼릭 링크를 만든다. **뿌리 안을 가리키는 상대 링크만.**
 *
 * 판정 기준이 둘이다.
 * 1. 링크가 놓일 자리까지 [descend] 로 내려간다 — 그 경로에 심링크 조각이 하나라도 있으면 거절한다.
 * 2. 대상은 **그 실제 부모 기준**으로 풀어 뿌리 안인지 본다. 부모가 물리적으로 뿌리 안이고 우리가 만든
 *    모든 링크가 뿌리 안을 가리키므로, 귀납적으로 어떤 사슬도 밖으로 못 나간다.
 *
 * 링크는 해제 시점이 아니라 **따라가는 시점에** 해석된다 — 그래서 이 검사가 없으면 오염된 아카이브가
 * 고객 홈의 임의 파일을 가리키는 링크를 심고, 그 뒤 도구가 그 링크를 읽거나 쓴다.
 */
async function writeSymlink(
    root: string,
    segments: string[],
    name: string,
    target: string,
    verified: Set<string>,
): Promise<void> {
    if (!target) return;
    if (isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 꾸러미에 절대경로 링크가 있습니다: ${name}`);
    }
    const leaf = segments[segments.length - 1];
    if (!leaf) throw new DevtoolsError("SERVER_REJECTED", `받은 꾸러미에 이상한 링크 이름이 있습니다: ${name}`);

    const parent = await descend(root, segments.slice(0, -1), verified);
    const resolved = resolve(parent, target);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 꾸러미의 링크가 폴더 밖을 가리킵니다: ${name}`);
    }

    const linkPath = join(parent, leaf);
    await assertNotSymlink(linkPath, name);
    // 상대 형태 그대로 심는다 — 절대경로로 바꿔 심으면 캐시 트리를 다른 자리로 옮기는 순간 전부 끊긴다
    // (`deps.ts` 의 `verbatimSymlinks` 와 같은 이유).
    await symlink(relative(parent, resolved) || ".", linkPath).catch((error: unknown) => {
        // EEXIST 를 삼키면 **링크가 안 생긴 채 성공으로 보고**된다(재심의 경고 5). 그 결과가 하필
        // 이 기능이 막으려던 증상 그대로다 — `next dev` 가 실행 파일을 못 찾는다. 조용한 손상보다 실패가 낫다.
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `링크를 만들지 못했습니다: ${name}`,
            "받는 폴더를 비우고 다시 시도해 주세요.",
            error,
        );
    });
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

/**
 * 이 해제에 설 상한. **두 경로가 이 한 함수를 지난다.**
 *
 * ⚠ 종전에는 버퍼 경로만 `Math.min` 으로 죄고 스트리밍 경로는 `options.maxBytes` 를 날로 써서,
 *   같은 파서·같은 옵션이 **경로에 따라 다르게 섰다**(해제 250MB 정상 소스: 버퍼 거부 · 스트리밍
 *   성공). 아래 KDoc 이 스스로 「호출부가 건 상한이 경로에 따라 있다 없다 하면 그건 상한이
 *   아니다」라고 적어 둔 형상이다.
 *
 * ⚠ **되죄지 않는다.** 한때 여기서 `Math.min(…, MAX_EXTRACT_BYTES)` 로 모든 호출부를 소스 천장에
 *   맞췄는데, 그러자 자기 입력에서 상한을 유도하던 의존성 페이로드 경로가 통째로 막혔다(요구
 *   1264MB · 실제 산출물 586MB → 450MB 로 되죔). 「더 좁게만 잡을 수 있다」는 지어낸 규칙이었다.
 *   호출부는 전부 우리 것이고 **각자 자기 입력에서 자기 상한을 유도한다** — 이 함수의 일은
 *   ⑴ 안 준 경우의 기본값을 주고 ⑵ 두 경로가 **같은 답**을 내게 하는 것뿐이다.
 */
export function resolveCap(maxBytes?: number): number {
    return maxBytes ?? MAX_EXTRACT_BYTES;
}

/** 압축 폭탄 방어 — 무제한 해제는 확장 호스트를 OOM 으로 죽이고, 그러면 다른 확장까지 함께 죽는다. */
/**
 * gz 를 푼다. **부르는 쪽이 한 번만 풀 수 있게** 내보낸다 — 같은 아카이브를 두 번 보는 길
 * (`pull` 의 판정 → 쓰기)이 각자 풀면 산출물만큼을 두 번 램에 올린다([extractTar] 참조).
 */
export async function gunzipTar(input: Buffer, maxBytes?: number): Promise<Buffer> {
    return gunzipBuffer(input, maxBytes);
}

async function gunzipBuffer(input: Buffer, maxBytes?: number): Promise<Buffer> {
    const { gunzip: gunzipCb } = await import("node:zlib");
    const { promisify } = await import("node:util");
    const cap = resolveCap(maxBytes);
    try {
        return (await promisify(gunzipCb)(input, { maxOutputLength: cap })) as Buffer;
    } catch (cause) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 파일이 너무 크거나 손상되었습니다.",
            "다시 시도해도 같으면 잘커라에 문의해 주세요.",
            cause,
        );
    }
}
