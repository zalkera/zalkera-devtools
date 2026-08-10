import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { meaningfulEntries } from "./emptyDir.ts";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";
import { extractTarGz } from "./untar.ts";

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
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `소스를 내려받지 못했습니다(HTTP ${response.status}).`,
            "잠시 뒤 다시 시도해 주세요.",
        );
    }

    await mkdir(options.targetDir, { recursive: true });
    // **편집기가 만든 것 때문에 막히지 않는다**(emptyDir.ts) — `.vscode` 는 우리가 만드는 쪽이다.
    const existing = await meaningfulEntries(options.targetDir);
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

    // ⚠ **받은 바이트가 원장의 그 바이트인지 대조한다**(심의 반영 · 2026-08-03).
    // 시작 소스(B1)는 진작 대조하는데 **이 경로만 비어 있었다** — 그런데 이쪽이 MVP 절단선의 본체다.
    // 불일치면 **풀지 않는다**: 풀고 나면 무엇이 깨졌는지 모른 채 소스가 남고, 그 소스로 만든 사이트의
    // 원인 추적이 불가능해진다. 서버가 sha 를 안 주면(구버전 서버) 그 사실을 말하고 진행한다 —
    // **검사가 있는 척하지 않는다.**
    if (source.sha256) {
        const actual = createHash("sha256").update(buffer).digest("hex");
        if (actual !== source.sha256) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                "받은 소스가 원본과 다릅니다(무결성 확인 실패).",
                "네트워크 문제일 수 있습니다. 다시 시도해 주세요.",
            );
        }
    } else {
        report("⚠ 서버가 무결성 해시를 주지 않아 대조를 건너뜁니다(서버가 오래된 버전일 수 있습니다).");
    }

    const fileCount = await extractTarGz(buffer, options.targetDir);
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
