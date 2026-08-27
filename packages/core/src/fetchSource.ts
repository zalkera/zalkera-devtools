import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { meaningfulEntries, removeAdded, snapshotEntries } from "./emptyDir.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { ZalkeraApi } from "./api.ts";
import { MAX_EXTRACT_BYTES } from "./limits.ts";
import { DevtoolsError } from "./errors.ts";
import { noRevisionError, pickRevision } from "./fetchTarget.ts";
import { downloadBounded } from "./download.ts";
import { extractTarGz } from "./untar.ts";
import { keepNames, replaceContents } from "./replaceDir.ts";
import { SOURCE_MARK_PATH, parseSourceMark, writeSourceMarkTo } from "./localMark.ts";
import { decideImportBinding, type WorkspaceLink } from "./siteBinding.ts";
import { packProject } from "./zip.ts";

// 해제기 본체는 `untar.ts` 로 옮겼다(페이로드 스트리밍 경로와 **같은 파서**를 쓰기 위해 · §13.10.6).
// 여기서 재수출한다 — 이 이름을 쓰던 호출부·테스트의 계약을 그대로 둔다.
export { extractTarGz };

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
    /** 받아서 **대조까지 마친** 정본 tar.gz 의 sha256. 출처 표식이 이 값을 적는다. */
    sha256: string;
}

/**
 * 소스 해제 총량 상한. **형제 zip 경로와 같은 상수**다 — 값을 옮겨 적지 않고 [MAX_EXTRACT_BYTES] 를
 * 그대로 쓴다. 두 소스 형식이 다른 기준을 쓸 이유가 없다.
 */
const MAX_SOURCE_EXTRACT_BYTES = MAX_EXTRACT_BYTES;

/** 대용량 전송 상한(15분) — publish 와 같은 근거. 짧으면 느린 회선의 정상 수신을 끊는다. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

/** 받아서 **대조까지 마친** 정본 tar.gz. 푸는 쪽과 다시 포장하는 쪽이 이것을 나눠 쓴다. */
export interface VerifiedSourceTar {
    revisionNo: number;
    /** 서버가 준 tar.gz 바이트 그대로. */
    buffer: Buffer;
    /** 대조에 쓴 값 — **이 tar.gz 의** 것이다. 다시 포장한 zip 의 해시가 아니다. */
    sha256: string;
}

/**
 * 정본 tar.gz 를 받아 **원장의 그 바이트인지 대조한다.** 푸는 것은 하지 않는다.
 *
 * ⚠ **두 입구가 이 하나를 지난다** — 폴더에 푸는 쪽(`fetchSiteSource`)과 zip 으로 다시 포장하는
 *   쪽(`downloadSourceZip`). 검증을 각자 두면 한쪽만 고쳐져 갈린다. 이 레포는 실제로 형제
 *   `presets.ts` 만 대조하고 **이 경로가 비어 있던** 적이 있다(심의 지적).
 */
export async function fetchVerifiedSourceTar(options: {
    api: ZalkeraApi;
    revisionNo?: number;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}): Promise<VerifiedSourceTar> {
    const report = options.onProgress ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;

    let revisionNo = options.revisionNo;
    if (revisionNo === undefined) {
        // ⚠ **판정을 여기 두 벌로 두지 않는다.** 종전에는 `revisions[0]` 로 때웠는데 그것이
        //    `BUILDING`·`FAILED` 일 수 있고(화면에 말한 판과 받는 판이 갈린다), 「없다」 문면도
        //    별도 사본이라 확장 쪽만 고쳐지면 이 길로 든 사람은 옛 문장을 본다.
        //    지금은 확장이 늘 `revisionNo` 를 넘겨 여기가 안 도는 길이지만, **이 함수는 공개 API** 다.
        const revisions = await options.api.listRevisions();
        const choice = pickRevision(revisions);
        if (!choice) throw noRevisionError(revisions);
        revisionNo = choice.revisionNo;
    }

    report(`버전 ${revisionNo} 소스를 받는 중…`);
    const source = await options.api.sourceUrl(revisionNo);

    // 주소 검사·크기 상한은 형제 셋이 공유한다(`download.ts`) — 자리마다 다르게 두던 것이 결함이었다.
    const buffer = await downloadBounded(source.url, {
        fetchImpl,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        what: "소스",
    });

    // ⚠ **받은 바이트가 원장의 그 바이트인지 대조한다.**
    // 불일치면 **아무것도 남기지 않는다**: 남기고 나면 무엇이 깨졌는지 모른 채 소스가 돌아다니고,
    // 그 소스로 만든 사이트의 원인 추적이 불가능해진다.
    //
    // ⚠ 종전에는 서버가 sha 를 안 주면 **경고하고 진행**했다. 그 경고는 출력 채널로만 가서 패널을
    //   안 여는 사용자에게는 아무것도 안 보였고, 그러면 "검사가 있는 척"이 된다 — 형제 `presets.ts`
    //   가 같은 지적으로 이미 끊는 쪽으로 갔는데 이 경로만 남아 있었다(심의 실측).
    if (!source.sha256) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "서버가 무결성 해시를 주지 않아 소스를 검증할 수 없습니다.",
            "잘커라에 문의해 주세요. 검증 없이 진행하지 않았습니다.",
        );
    }
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== source.sha256) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 소스가 원본과 다릅니다(무결성 확인 실패).",
            "네트워크 문제일 수 있습니다. 다시 시도해 주세요.",
        );
    }
    return { revisionNo, buffer, sha256: source.sha256 };
}

export async function fetchSiteSource(options: FetchSourceOptions): Promise<FetchSourceResult> {
    const report = options.onProgress ?? (() => {});

    await mkdir(options.targetDir, { recursive: true });
    // **편집기가 만든 것 때문에 막히지 않는다**(emptyDir.ts) — `.vscode` 는 우리가 만드는 쪽이다.
    //
    // ⚠ **받기 전에 본다.** 폴더가 못 쓸 상태인 것은 네트워크를 태우기 전에 알 수 있는 사실이다.
    const existing = await meaningfulEntries(options.targetDir);
    if (existing.length > 0) {
        // **덮어쓰지 않는다.** 고객이 고치던 소스를 서버 버전으로 조용히 밀어 버리는 것이 이 도구가 낼 수
        // 있는 가장 큰 손해다. 빈 폴더를 요구하는 편이 불편하지만 되돌릴 수 없는 손실보다 낫다.
        throw new DevtoolsError(
            "NOT_A_SITE",
            "받을 폴더가 비어 있지 않습니다.",
            "빈 폴더를 고르거나, 기존 폴더는 「잘커라: 사이트에 연결」로 이어 주세요.",
        );
    }

    const got = await fetchVerifiedSourceTar(options);
    const { revisionNo, buffer, sha256 } = got;

    // ⚠ **반쪽 해제를 남기지 않는다.** `extractTarGz` 는 항목을 훑으며 **그때그때 쓴다** — 경로 이탈·
    //    항목 상한 같은 검사가 중간 항목에서 걸리면 앞서 쓴 파일들이 그대로 남는다. 배송 문서
    //    (`media/help.md`)는 그 두 오류를 이름까지 대며 "아무것도 풀지 않고 멈춘 것이니 폴더는
    //    그대로입니다"라고 **보증**하는데, 롤백이 없어 그 문장이 거짓이었다(심의 실증 — 두 오류를
    //    각각 재현해 파일이 남는 것을 확인했다).
    //
    //    남으면 피해가 문면에 그치지 않는다: 같은 폴더로 재시도하면 위쪽 "빈 폴더" 조건에 막혀
    //    **되돌아갈 길이 없다.** 형제 `deps.ts` 는 같은 형상을 이미 `rm(target)` 으로 푼다.
    //
    //    이 자리는 위에서 **빈 폴더임을 확인한 뒤**이므로, 우리가 쓴 것만 지운다.
    // ⚠ **우리가 쓴 것만 되감는다.** 폴더를 통째로 지우면 「빈 폴더」 판정이 일부러 통과시킨
    //    고객 파일(`.vscode` — 배송 문서가 "있어도 괜찮습니다"라고 초대한 그것)이 사라진다.
    const before = await snapshotEntries(options.targetDir);
    let fileCount: number;
    try {
        // 소스 꾸러미는 `node_modules` 를 담을 수 없다 — 페이로드 경로와 갈리는 지점이다.
        // ⚠ **해제 상한을 명시한다.** 기본값도 같은 상수이지만([MAX_EXTRACT_BYTES]), 이 자리가 무엇을
        //    약속하는지는 호출부에 보여야 한다. 값은 `limits.ts` 가 전선 상한에서 유도한다.
        fileCount = await extractTarGz(buffer, options.targetDir, {
            rejectVendored: true,
            maxBytes: MAX_SOURCE_EXTRACT_BYTES,
        });
    } catch (cause) {
        await removeAdded(options.targetDir, before);
        throw cause;
    }
    report(`${fileCount}개 파일을 받았습니다.`);
    return { revisionNo, fileCount, sha256 };
}

/** 「서버 판으로 교체」의 결과. [FetchSourceResult] 에 **갈아 끼우기**의 사실을 더한다. */
export interface RefreshSourceResult extends FetchSourceResult {
    /** 새 소스 «위에» 되살린 경로. */
    preserved: string[];
    /** 자리에 그대로 둔 이름(치우지도 지우지도 않았다). */
    kept: string[];
    /**
     * 표식을 새 판으로 다시 썼는가 — 못 썼으면 **옛 표식이 그대로** 있고 그 사유.
     *
     * ⚠ **못 쓴 것을 던지지 않는다.** 소스는 이미 새 판인데 여기서 던지면 사람은 「실패했다」로
     *   읽고 다시 누른다. 옛 표식이 남으면 소속은 안 잃고, 다음 발행이 낡은 기반을 선언해
     *   **동의를 한 번 더** 받는 데서 끝난다 — 막다른 길이 아니다.
     */
    mark: { written: true } | { written: false; reason: string };
}

export interface RefreshSourceOptions {
    api: ZalkeraApi;
    /** 갈아 끼울 폴더. **비어 있지 않아도 된다** — 그것이 이 문의 존재 이유다. */
    targetDir: string;
    tenant: string;
    /** 창의 워크스페이스 링크. 표식이 없을 때 소속 판정이 쓴다. */
    link: WorkspaceLink;
    revisionNo?: number;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

/**
 * **폴더를 서버 정본으로 갈아 끼운다** — 「소스 다운로드」가 거절하는 «비어 있지 않은» 폴더가
 * 이 문의 대상이다.
 *
 * ■ 왜 「소스 zip 다운로드 → zip 으로 교체」로는 안 되나 — **결과가 틀린다**
 *   zip 은 표식(`.zalkera/source.json`)을 안 싣고(`EXCLUDED_PATHS`), 「zip 으로 교체」는 옛 표식을
 *   `preserve` 로 되살린다. 그래서 판 N 폴더를 두 걸음으로 판 M 에 맞추면 **표식이 여전히 N 을
 *   선언한다** — 다음 발행마다 「남이 올린 판이 있습니다」 동의가 뜬다. 자기가 방금 받아 온 판을
 *   두고. **거짓 경보를 습관으로 누르게 하면 진짜 경보도 눌러 버린다.**
 *
 *   조합으로는 원리상 못 고친다: zip 문은 **판 번호를 모른다**(`Provenance` 에 그 칸이 없다).
 *   이 함수는 번호와 sha 를 아는 자리에서 교체하므로 표식을 옳게 다시 쓸 수 있다.
 *
 * ■ **네트워크 먼저, 파괴는 나중**
 *   전송(최대 15분)과 sha 대조가 **끝난 뒤에야** 폴더에 손댄다. 그래서 받는 동안 창을 닫으면
 *   **폴더는 그대로 남는다.** 이 문에도 전송 취소 손잡이는 없지만(형제 받기와 같은 한계),
 *   순서가 이미 안전한 쪽이라 그 부재의 대가가 작다.
 *
 * ■ 표식 쓰기는 **여기** 산다
 *   확장 배선에 두면 시험도 검사기도 못 닿는다 — 그리고 이 축의 고장은 **멀리서** 난다(잊어도
 *   기능은 다 되는 것처럼 보이고, 증상은 몇 판 뒤의 「발행마다 409 동의」다).
 */
export async function refreshSiteSource(options: RefreshSourceOptions): Promise<RefreshSourceResult> {
    const report = options.onProgress ?? (() => {});

    // ⚠ **폴더에 손대기 전에 표식을 읽는다.** 갈아 끼운 뒤에는 그 파일이 새 소스의 것이거나
    //    `preserve` 로 되살아난 것이라, 「원래 이 폴더가 무엇이었나」를 묻는 자리가 아니다.
    const before = parseSourceMark(await readTextQuietly(join(options.targetDir, SOURCE_MARK_PATH)));
    const binding = decideImportBinding(before, options.link, options.tenant);

    const got = await fetchVerifiedSourceTar(options);
    const { revisionNo, buffer, sha256 } = got;

    const keep = await keepNames(options.targetDir);
    let fileCount = 0;
    const { preserved, kept } = await replaceContents(
        options.targetDir,
        // 표식을 되살린다 — 아래 쓰기가 실패해도 **소속을 안 잃는다.**
        [SOURCE_MARK_PATH],
        keep,
        async () => {
            // ⚠ **형제 `fetchSiteSource` 와 똑같이 푼다.** 같은 서버 산출물을 두 문이 다르게
            //    다루면 갈린다 — 감싸기 흡수 같은 것을 이쪽에만 붙이지 않는다(설계 §11 R1).
            fileCount = await extractTarGz(buffer, options.targetDir, {
                rejectVendored: true,
                maxBytes: MAX_SOURCE_EXTRACT_BYTES,
            });
        },
    );
    report(`${fileCount}개 파일로 갈아 끼웠습니다.`);

    // ⚠ **남의 소속은 안 덮는다.** `keep`(다른 사이트의 표식)·`unknown`(못 읽음)이면 안 쓴다 —
    //    「모른다」로 막지는 않되, 모르는 채로 **적지도** 않는다.
    if (binding.kind !== "bind") {
        return { revisionNo, fileCount, sha256, preserved, kept, mark: { written: false, reason: binding.kind } };
    }
    const done = await writeSourceMarkTo(options.targetDir, {
        tenant: options.tenant,
        revisionNo,
        sha256,
        fetchedAt: new Date().toISOString(),
    });
    return {
        revisionNo,
        fileCount,
        sha256,
        preserved,
        kept,
        mark: done.ok ? { written: true } : { written: false, reason: done.reason },
    };
}

/** 없으면 `null` — **못 읽은 것과 없는 것을 여기서 가르지 않는다**(둘 다 「표식 없음」으로 판정에 넘긴다). */
async function readTextQuietly(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

/** 「소스 zip 다운로드」의 결과. 두 해시가 **다른 물건의 것**이라 이름으로 갈라 둔다. */
export interface SourceZipResult {
    revisionNo: number;
    /** 포장한 zip 에 담긴 파일 수. */
    fileCount: number;
    /** 서버에서 받아 대조한 **정본 tar.gz** 의 해시. */
    sourceSha256: string;
    /** **우리가 방금 만든 zip** 의 해시. 서버는 이 값을 모른다. */
    zipSha256: string;
    buffer: Buffer;
}

/**
 * 배포 중인 판을 **zip 파일 하나로** 받는다 — 폴더에 풀지 않는다.
 *
 * ■ 왜 다시 포장하나
 *   서버 정본은 **tar.gz** 인데 이 도구가 소스를 들여오는 문(`importZip.ts` — 「zip 으로 시작」·
 *   「zip 으로 교체」)은 **zip 만** 받는다. tar.gz 를 그대로 내주면 받은 사람이 우리 도구로
 *   되돌릴 수 없다 — 「받았는데 못 넣는 파일」이 된다.
 *
 * ■ 포장 규칙을 새로 만들지 않는다
 *   「zip 으로 내보내기」와 **같은 `packProject`** 를 쓴다. 규칙이 둘이 되면 한쪽만 고쳐져
 *   갈리고, 갈린 날 「내보내기에서는 빠지는데 여기서는 들어오는」 파일이 생긴다.
 *
 * ■ 임시 폴더는 반드시 지운다
 *   푼 소스가 남으면 그것이 곧 유출면이다. `finally` 로 지운다 — 포장이 던져도 지운다.
 */
export async function downloadSourceZip(options: {
    api: ZalkeraApi;
    revisionNo?: number;
    /** 출처 표시에 찍을 사이트. 없으면 **안 찍는다** — 없는 정체성을 지어내지 않는다. */
    provenanceTenant?: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}): Promise<SourceZipResult> {
    const report = options.onProgress ?? (() => {});
    const got = await fetchVerifiedSourceTar(options);

    // ⚠ **작업 폴더는 임시 자리에 만든다.** 고객 폴더 안에 만들면 실패했을 때 부스러기가 남고,
    //    「빈 폴더」 판정에 걸려 다음 시도가 막힌다.
    const work = await mkdtemp(join(tmpdir(), "zalkera-source-"));
    try {
        const fileCount = await extractTarGz(got.buffer, work, {
            rejectVendored: true,
            maxBytes: MAX_SOURCE_EXTRACT_BYTES,
        });
        report(`${fileCount}개 파일을 확인했습니다 — zip 으로 포장하는 중…`);
        // 아카이브가 한 겹 감싸고 있을 수 있다 — 포장 뿌리를 잘못 잡으면 `package.json` 이
        // 한 단계 안쪽에 들어가 `importZip` 이 「소스 zip 이 아니다」로 거절한다.
        const root = await findProjectRoot(work);
        const packed = await packProject({
            projectDir: root,
            provenanceTenant: options.provenanceTenant,
            onProgress: options.onProgress,
        });
        return {
            revisionNo: got.revisionNo,
            fileCount: packed.fileCount,
            sourceSha256: got.sha256,
            zipSha256: packed.sha256,
            buffer: packed.buffer,
        };
    } finally {
        await rm(work, { recursive: true, force: true });
    }
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
