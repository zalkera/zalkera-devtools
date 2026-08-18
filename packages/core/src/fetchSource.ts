import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { meaningfulEntries, removeWritten } from "./emptyDir.ts";
import { tmpdir } from "node:os";
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
  /**
   * 임시 파일을 둘 **우리 마당**. 확장은 VS Code 가 주는 전용 저장 경로를 넘긴다.
   *
   * 비우면 OS 임시 디렉터리로 물러나는데, 그것이 tmpfs(=메모리)인 환경이 많다 — 받는 자리로는
   * 실디스크가 옳다. **고객이 고른 폴더에는 절대 두지 않는다**(본문 KDoc 의 이유).
   */
  scratchRoot?: string;
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

export async function fetchSiteSource(
    options: FetchSourceOptions,
): Promise<FetchSourceResult> {
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

    // **편집기가 만든 것 때문에 막히지 않는다**(emptyDir.ts) — `.vscode` 는 우리가 만드는 쪽이다.
    const existing = await meaningfulEntries(options.targetDir);
    if (existing.length > 0) {
        // **덮어쓰지 않는다.** 고객이 고치던 소스를 서버 버전으로 조용히 밀어 버리는 것이 이 도구가
        // 낼 수 있는 가장 큰 손해다. 빈 폴더를 요구하는 편이 불편하지만 되돌릴 수 없는 손실보다 낫다.
        throw new DevtoolsError(
            "NOT_A_SITE",
            "받을 폴더가 비어 있지 않습니다.",
            "빈 폴더를 고르거나, 기존 폴더는 「잘커라: 폴더 연결」로 이어 주세요.",
        );
    }

    // ⚠ **임시 파일은 우리 마당에 둔다 — 고객 폴더가 아니라.**
    //
    //   한때 받을 폴더 **안**에 임시 자리를 뒀다(같은 파일시스템이라 공간이 보장되고, `/tmp` 가
    //   tmpfs 인 환경이 많다는 것이 이유였다). 그 결정 하나에서 심의 차단이 연달아 나왔다:
    //
    //     · 크래시 잔해가 남으면 「비어 있지 않습니다」인데 그것은 점 파일이라 **고객 눈엔 빈 폴더**다
    //     · 그 잔해를 걷으려면 「버려진 것」과 「지금 받는 중인 것」을 **추측**해야 한다
    //     · 이름이 아카이브 안의 경로와 부딪혀 **파일이 조용히 사라졌다**(3개 보고·2개 실재)
    //     · 「비어 있는가」 판정을 여러 명령이 공유하는데 거기 우리 것이 끼었다
    //
    //   전부 «남의 마당에서 작업한다»는 하나에서 나왔다. 우리 마당에 두면 추측할 것이 없다 —
    //   고객 파일이 있을 수 없으니 그냥 지우면 된다. npm 이 `~/.npm/_cacache` 를 쓰고 git 이
    //   `.git` 안에서 임시를 다루는 것과 같은 관례다: **받는 것은 내 마당, 놓는 것만 남의 마당.**
    //
    //   자리는 호출부가 준다([FetchSourceOptions.scratchRoot]) — 확장은 VS Code 가 주는 전용
    //   저장 경로를, CLI 는 자기 캐시를 넘긴다. 둘 다 **고객 컴퓨터의 실디스크**다.
    const scratchDir = await mkdtemp(join(await scratchBase(options.scratchRoot), "fetch-"));

    // 해제기가 **자기가 만든 최상위 이름**을 알려 준다 — 되감을 것은 그것뿐이다.
    const wrote: string[] = [];
    let fileCount: number;
    try {
        const gzPath = join(scratchDir, "source.tar.gz");

        // ⚠ **통버퍼를 만들지 않는다.** 종전에는 tar.gz 전체를 메모리에 올린 뒤 통째로 gunzip 했다.
        //    실측(해제 250MB 소스): VmHWM **566MB** → 이 경로 **125MB**, 게다가 더 빠르다.
        //    확장 호스트는 다른 확장과 프로세스를 공유하므로 우리가 부풀면 **남의 확장까지 죽는다.**
        //    주소 검사·크기 상한은 형제 셋이 공유한다(`download.ts`).
        const actual = await downloadBoundedToFile(source.url, gzPath, {
            fetchImpl,
            timeoutMs: TRANSFER_TIMEOUT_MS,
            what: "소스",
        });

        // ⚠ **받은 바이트가 원장의 그 바이트인지 대조한다.** 불일치면 **풀지 않는다**: 풀고 나면
        //   무엇이 깨졌는지 모른 채 소스가 남고, 그 소스로 만든 사이트의 원인 추적이 불가능해진다.
        //   해시는 **디스크에 쓴 것과 같은 바이트**로 셌다(`downloadBoundedToFile`).
        //
        // ⚠ 종전에는 서버가 sha 를 안 주면 **경고하고 진행**했다. 그 경고는 출력 채널로만 가서
        //   패널을 안 여는 사용자에게는 아무것도 안 보였고, 그러면 "검사가 있는 척"이 된다.
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

        // ⚠ **반쪽 해제를 남기지 않는다.** 해제기는 항목을 훑으며 **그때그때 쓴다** — 중간 항목에서
        //    검사가 걸리면 앞서 쓴 파일들이 그대로 남는다. 배송 문서(`media/help.md`)가 그 두 오류를
        //    이름까지 대며 "아무것도 풀지 않고 멈춘 것이니 폴더는 그대로입니다"라고 **보증**한다.
        //
        //    소스 꾸러미는 `node_modules` 를 담을 수 없다 — 페이로드 경로와 갈리는 지점이다. 그 밖의
        //    가드(경로 봉쇄·심링크·항목 수·항목당 상한)는 두 경로가 `createSink` 하나를 공유한다.
        fileCount = await extractTarGzFile(
            gzPath,
            options.targetDir,
            join(scratchDir, "source.tar"),
            {
                rejectVendored: true,
                maxBytes: MAX_SOURCE_EXTRACT_BYTES,
                label: "받은 소스",
                onWroteRoot: (name) => wrote.push(name),
            },
        );
    } catch (cause) {
        // ⚠ **우리가 쓴 것만 되감는다.** 「해제 전에 없던 것」을 지우면 받는 **동안**(최대 15분)
        //    고객이 만든 파일까지 사라진다 — VS Code 가 폴더를 연 창에서 만드는
        //    `.vscode/settings.json` 도 그 창 안이다(실측으로 고객 메모와 함께 사라졌다).
        await removeWritten(options.targetDir, wrote);
        throw cause;
    } finally {
        // 우리 마당이라 조건 없이 지운다 — 여기엔 고객 파일이 있을 수 없다.
        await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    }

    report(`${fileCount}개 파일을 받았습니다.`);
    return { revisionNo, fileCount };
}

/**
 * **우리 마당의 잔해를 걷는다.** 확장이 켜질 때 한 번 부른다.
 *
 * 크래시(창 닫기·SIGKILL·절전)로 죽으면 `finally` 가 안 돌아 `fetch-*` 가 남는다. 우리 마당은
 * VS Code 가 절대 안 지우므로, 그대로 두면 크래시 1회당 최대 `150MB(gz) + 450MB(중간 tar)` 가
 * 사용자 프로필에 **영구히·보이지 않게** 쌓인다.
 *
 * ⚠ **여기서는 추측하지 않는다.** 고객 폴더의 잔해를 걷을 때는 「버려진 것」과 「받는 중인 것」을
 *   갈라야 했고, 그 추측이 세 라운드 연속으로 진행 중 받기를 죽였다. 여기는 **우리 마당**이라
 *   갈 필요가 없다 — 살아 있는 것을 지워도 피해는 그 받기의 실패뿐이고(롤백은 이제 우리가 쓴
 *   것만 지운다), 고객 파일은 애초에 여기 없다. 그래서 **조건 없이** 지운다.
 *
 *   다만 확장은 창마다 한 번씩 `activate` 한다 — 창 A 가 받는 중에 창 B 가 켜지면 A 의 작업
 *   자리가 지워진다. 그 피해가 「A 의 받기 실패」로 끝나는 것이 위 문단의 근거다. 창이 둘일 때의
 *   상호배제는 애초에 없다고 선언한 축이라 새 구멍이 아니다.
 */
export async function sweepScratch(root: string): Promise<number> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return 0; // 아직 안 만들어졌다 — 걷을 것도 없다
    }
    let swept = 0;
    for (const entry of entries) {
        if (!entry.name.startsWith("fetch-") || !entry.isDirectory()) continue;
        try {
            await rm(join(root, entry.name), { recursive: true, force: true });
            swept += 1; // **성공만 센다** — 시도를 세면 「정리했습니다」가 거짓이 된다
        } catch {
            /* 못 지웠다 — 다음 회차가 다시 시도한다 */
        }
    }
    return swept;
}

/**
 * 임시 자리의 뿌리. 호출부가 안 주면 OS 임시 디렉터리로 물러난다.
 *
 * ⚠ **호출부가 주는 것이 옳다.** `os.tmpdir()` 은 리눅스에서 tmpfs(=메모리)인 경우가 많아, 150MB
 *   짜리 소스를 거기 받으면 스트리밍으로 아낀 메모리를 도로 쓴다. 확장은 VS Code 가 주는 전용
 *   저장 경로(`globalStorageUri` · 실디스크)를 넘긴다. 폴백을 두는 이유는 **안 주면 못 받는 것**보다
 *   메모리를 좀 쓰더라도 되는 편이 낫기 때문이다(그리고 CLI·시험은 그 경로를 쓴다).
 */
async function scratchBase(root: string | undefined): Promise<string> {
    const base = root ?? tmpdir();
    try {
        await mkdir(base, { recursive: true });
    } catch (cause) {
        // ⚠ **원시 errno 를 사용자에게 보내지 않는다.** 고객이 **한 번도 고른 적 없는 경로**가
        //   `EACCES: permission denied, mkdtemp '/…/fetch-vSrRXM'` 로 튀어나오고 행동 지시가 없다.
        //   그리고 이제 스크래치와 받을 폴더가 **다른 디스크일 수 있다** — 외장 디스크에 큰 사이트를
        //   받으면 시스템 디스크가 차서 여기서 터진다. 그 사실을 말해 준다.
        throw new DevtoolsError(
            "PACK_FAILED",
            "받는 중에 쓸 임시 자리를 만들지 못했습니다.",
            "이 컴퓨터의 시스템 디스크 여유 공간과 권한을 확인해 주세요(받을 폴더와 다른 디스크일 수 있습니다).",
            cause,
        );
    }
    return base;
}

/** 큰 아카이브를 메모리에 다 올리지 않고 파일로 흘리고 싶을 때(현재 미사용 · CLI 대용량 경로 대비). */
export async function streamToFile(
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<void> {
  const { Readable } = await import("node:stream");
  await pipeline(
    Readable.fromWeb(body as never),
    createGunzip(),
    createWriteStream(path),
  );
}

/** 받은 폴더에서 프로젝트 뿌리를 찾는다 — 아카이브가 한 겹 감싸고 있을 수 있다. */
export async function findProjectRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === "package.json")) return dir;
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1 && dirs[0])
    return findProjectRoot(join(dir, dirs[0].name));
  return dir;
}
