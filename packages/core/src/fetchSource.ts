import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { meaningfulEntries, removeAdded, snapshotEntries, sweepOurScratch } from "./emptyDir.ts";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { ZalkeraApi } from "./api.ts";
import { MAX_EXTRACT_BYTES } from "./limits.ts";
import { DevtoolsError } from "./errors.ts";
import { downloadBoundedToFile } from "./download.ts";
import { extractTarGz, extractTarGzFile } from "./untar.ts";

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
}

/**
 * 소스 해제 총량 상한. **형제 zip 경로와 같은 상수**다 — 값을 옮겨 적지 않고 [MAX_EXTRACT_BYTES] 를
 * 그대로 쓴다. 두 소스 형식이 다른 기준을 쓸 이유가 없다.
 */
const MAX_SOURCE_EXTRACT_BYTES = MAX_EXTRACT_BYTES;

/** 대용량 전송 상한(15분) — publish 와 같은 근거. 짧으면 느린 회선의 정상 수신을 끊는다. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

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
    const source = await options.api.sourceUrl(revisionNo);
    await mkdir(options.targetDir, { recursive: true });
    // ⚠ **우리가 남긴 임시 자리를 먼저 걷어낸다.** 다운로드는 최대 15분이고 그 사이에 확장 호스트가
    //    죽으면 `.zalkera-fetch-*` 가 남는다. 그것은 점으로 시작해 `ls` 에 **안 보이는데**, 그
    //    폴더는 그 뒤 모든 「소스 받기」에서 막힌다 — 고객 눈에 그 폴더는 비어 있고, 안내문은
    //    "빈 폴더를 고르세요"다. 우리가 만든 것이니 우리가 지운다(마감 심의 차단).
    const swept = await sweepOurScratch(options.targetDir);
    if (swept > 0) report(`이전에 받다 만 임시 파일 ${swept}건을 정리했습니다.`);

    // **편집기가 만든 것 때문에 막히지 않는다**(emptyDir.ts) — `.vscode` 는 우리가 만드는 쪽이다.
    const existing = await meaningfulEntries(options.targetDir);
    if (existing.length > 0) {
        // **덮어쓰지 않는다.** 고객이 고치던 소스를 서버 버전으로 조용히 밀어 버리는 것이 이 도구가 낼 수 있는
        // 가장 큰 손해다. 빈 폴더를 요구하는 편이 불편하지만 되돌릴 수 없는 손실보다 낫다.
        throw new DevtoolsError(
            "NOT_A_SITE",
            "받을 폴더가 비어 있지 않습니다.",
            "빈 폴더를 고르거나, 기존 폴더는 「잘커라: 폴더 연결」로 이어 주세요.",
        );
    }

    // ⚠ **우리가 쓴 것만 되감는다.** 폴더를 통째로 지우면 「빈 폴더」 판정이 일부러 통과시킨
    //    고객 파일(`.vscode` — 배송 문서가 "있어도 괜찮습니다"라고 초대한 그것)이 사라진다.
    //    스냅샷은 **한 바이트라도 쓰기 전**에 찍는다 — 아래 임시 파일도 되감기 대상이다.
    const before = await snapshotEntries(options.targetDir);

    // ⚠ **통버퍼를 만들지 않는다.** 종전에는 tar.gz 전체를 메모리에 올린 뒤 통째로 gunzip 했다.
    //    실측(해제 250MB 소스): VmHWM **566MB** → 이 경로 **125MB**, 게다가 더 빠르다(712ms → 624ms).
    //    확장 호스트는 다른 확장과 프로세스를 공유하므로 우리가 부풀면 **남의 확장까지 함께 죽는다.**
    //    형제 `payload.ts` 가 이미 같은 형상(받으며 해시 → 파일 → 대조 → 스트리밍 해제)이다.
    //
    //    임시 파일은 **받을 폴더 안**에 둔다: 같은 파일시스템이라 공간이 보장되고, `/tmp` 는 여러
    //    환경에서 tmpfs(=메모리)라 거기 두면 방금 없앤 메모리를 도로 쓰는 셈이다. 이름은 `mkdtemp`
    //    로 무작위라 아카이브 안의 경로와 부딪히지 않는다.
    const scratchDir = await mkdtemp(join(options.targetDir, ".zalkera-fetch-"));
    let fileCount: number;
    try {
        const gzPath = join(scratchDir, "source.tar.gz");
        // 주소 검사·크기 상한은 형제 셋이 공유한다(`download.ts`) — 자리마다 다르게 두던 것이 결함이었다.
        const actual = await downloadBoundedToFile(source.url, gzPath, {
            fetchImpl,
            timeoutMs: TRANSFER_TIMEOUT_MS,
            what: "소스",
        });

        // ⚠ **받은 바이트가 원장의 그 바이트인지 대조한다.** 시작 소스(B1)는 진작 대조하는데
        //   **이 경로만 비어 있었다** — 그런데 이쪽이 MVP 절단선의 본체다. 불일치면 **풀지 않는다**:
        //   풀고 나면 무엇이 깨졌는지 모른 채 소스가 남고, 그 소스로 만든 사이트의 원인 추적이
        //   불가능해진다. 해시는 **디스크에 쓴 것과 같은 바이트**로 셌다(`downloadBoundedToFile`).
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
        if (actual !== source.sha256) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                "받은 소스가 원본과 다릅니다(무결성 확인 실패).",
                "네트워크 문제일 수 있습니다. 다시 시도해 주세요.",
            );
        }

        // ⚠ **반쪽 해제를 남기지 않는다.** 해제기는 항목을 훑으며 **그때그때 쓴다** — 경로 이탈·항목
        //    상한 같은 검사가 중간 항목에서 걸리면 앞서 쓴 파일들이 그대로 남는다. 배송 문서
        //    (`media/help.md`)는 그 두 오류를 이름까지 대며 "아무것도 풀지 않고 멈춘 것이니 폴더는
        //    그대로입니다"라고 **보증**한다. 남으면 피해가 문면에 그치지 않는다: 같은 폴더로
        //    재시도하면 위쪽 "빈 폴더" 조건에 막혀 **되돌아갈 길이 없다.**
        //
        //    소스 꾸러미는 `node_modules` 를 담을 수 없다 — 페이로드 경로와 갈리는 지점이다. 그 밖의
        //    가드(경로 봉쇄·심링크·항목 수·항목당 상한)는 두 경로가 `createSink` 하나를 공유한다.
        fileCount = await extractTarGzFile(gzPath, options.targetDir, join(scratchDir, "source.tar"), {
            rejectVendored: true,
            maxBytes: MAX_SOURCE_EXTRACT_BYTES,
            label: "받은 소스",
        });
    } catch (cause) {
        await removeAdded(options.targetDir, before);
        throw cause;
    } finally {
        // ⚠ **`finally` 다.** `try` 밖에 두면 여기서 던질 때 소스는 다 풀렸는데 명령은 실패로 끝나고,
        //    롤백도 안 돌며, 재시도는 「비어 있지 않습니다」에 막힌다. 그리고 **삼킨다** — 임시물을
        //    못 지운 것이 다 받은 일을 무를 이유는 아니다(다음 회차의 `sweepOurScratch` 가 걷는다).
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }

    report(`${fileCount}개 파일을 받았습니다.`);
    return { revisionNo, fileCount };
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
