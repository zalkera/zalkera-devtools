import type { ArchiveConfirmed, ZalkeraApi } from "./api.ts";
import { needsDiscardConsent } from "./api.ts";
import { DevtoolsError } from "./errors.ts";
import { apiBaseUrl } from "./serverUrl.ts";
import { packProject } from "./zip.ts";

/**
 * 발행(D2·D3) — 묶어서 올린다. 흐름은 콘솔의 업로드와 **같은 파이프라인**이다:
 * presign → S3 로 직접 PUT → confirm(서버가 언팩·검사·새 버전 생성).
 *
 * 백엔드를 경유하지 않고 S3 로 직접 올리는 것이 중요하다 — 100MB 급 본문이 API 를 지나가지 않는다.
 */
export interface PublishOptions {
    projectDir: string;
    api: ZalkeraApi;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
    /**
     * 서버가 **게시 대기 중인 AI 변경을 버리는 데 동의**를 요구할 때 사람에게 묻는다.
     * `true` 를 돌려주면 동의로 다시 부르고, `false` 면 취소로 끝난다.
     *
     * ⚠ **안 주면 묻지 않고 그대로 던진다.** 조용히 동의한 것으로 치면 이미 정산된 토큰이 실린
     *   작업이 사람 모르게 사라진다. 화면이 없는 자리(CLI·시험)는 그 문을 안 열면 된다.
     *
     * @param serverMessage 서버가 보낸 문장(건수가 들어 있다). 표시 자리에서 소독한다.
     */
    onConsent?: (serverMessage: string) => Promise<boolean>;
}

export interface PublishResult {
    fileCount: number;
    byteSize: number;
    sha256: string;
    /** 이번 업로드가 만든 버전 번호. 이 뒤의 "빌드 기다리기·전환"이 전부 이 번호로 이어진다. */
    revisionNo: number;
    /** `READY` 면 바로 켤 수 있고, `BUILDING` 이면 서버가 빌드 중이다. */
    status: string;
    siteType: string;
    /** 서버가 보낸 한계·상태 안내. 있으면 **그대로 보여 준다**(memo66 §4). */
    capabilityNote: string;
}

/**
 * 업로드 확정. 서버가 **동의를 요구하면** 물어보고 다시 부른다.
 *
 * ■ 왜 여기 있나
 *   백엔드는 재업로드·버전 전환·프리셋 재개시 **세 문이 같은 가드**를 지나고, 셋 다 요청 본문의
 *   `discardPendingChanges` 로 동의를 받는다. 확장은 전환 쪽만 동의 경로를 갖고 있었다 — 그래서
 *   올리기는 zip 을 다 올린 뒤 409 를 받고 「계속하려면 확인해 주세요」만 반복했다.
 *
 * ■ 물어보는 것은 부르는 쪽이다
 *   core 는 화면이 없다. `onConsent` 를 안 주면 **묻지 않고 그대로 던진다** — 조용히 동의한 것으로
 *   치면 게시 대기 중인 AI 변경이 사람 모르게 사라진다(이미 정산된 토큰이 실린 작업이다).
 */
async function confirmWithConsent(options: PublishOptions, storageKey: string): Promise<ArchiveConfirmed> {
    try {
        return await options.api.confirmArchive(storageKey);
    } catch (error) {
        if (!needsDiscardConsent(error) || !options.onConsent) throw error;
        if (!(await options.onConsent(error instanceof Error ? error.message : String(error)))) {
            throw new DevtoolsError("CANCELLED", "올리기를 그만두었습니다.");
        }
        return await options.api.confirmArchive(storageKey, true);
    }
}

/** 업로드 상한(서버 `maxArchiveSize`). 넘으면 **올리기 전에** 끊어 준다 — 5분 올리고 거절당하지 않게. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/** 대용량 전송 상한(15분). 100MB 를 아주 느린 회선(≈1Mbps)으로 올려도 닿지 않는 값이다. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

export async function publish(options: PublishOptions): Promise<PublishResult> {
    const report = options.onProgress ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;

    report("소스를 묶는 중…");
    const packed = await packProject({ projectDir: options.projectDir, onProgress: report });
    if (packed.fileCount === 0) {
        throw new DevtoolsError("PACK_FAILED", "올릴 파일이 없습니다.", "폴더를 다시 확인해 주세요.");
    }
    if (packed.buffer.byteLength > MAX_ARCHIVE_BYTES) {
        throw new DevtoolsError(
            "PACK_FAILED",
            `묶은 파일이 너무 큽니다(${Math.round(packed.buffer.byteLength / 1024 / 1024)}MB · 상한 100MB).`,
            "빌드 산출물·큰 이미지·동영상이 폴더에 들어 있지 않은지 확인해 주세요.",
        );
    }

    report(`${packed.fileCount}개 파일을 올리는 중…`);
    const presigned = await options.api.presignArchive("site.zip", packed.buffer.byteLength);

    // ⚠ **주소를 검사한다 — 받는 쪽과 같은 정책으로.** 내려받는 세 경로(소스·프리셋·페이로드)는
  //   `apiBaseUrl`(https 또는 루프백)을 강제하는데 **올리는 자리만 맨몸이었다.** 서버 응답을
  //   신뢰 밖으로 두기로 해 놓고, 정작 **고객 소스가 나가는 문**에만 그 규율이 없었다. 피해는 임의
  //   코드 실행이 아니라 평문 다운그레이드·타처 유출이지만, 한 번 나간 소스는 되돌릴 수 없다.
  //   `handshake.ts` 가 이미 「자격증명을 나르는 주소에는 apiBaseUrl 을 건다」고 적어 둔 그 정책이다.
  if (apiBaseUrl(presigned.uploadUrl) === null) {
    throw new DevtoolsError(
      "SERVER_REJECTED",
      "업로드 주소를 신뢰할 수 없습니다.",
      "잘커라에 문의해 주세요. 올리지 않고 멈췄습니다.",
    );
  }

  // **상한을 둔다.** Node 의 fetch 는 기본 타임아웃이 없어, 연결만 붙들린 채 응답이 없으면 영원히
    // 매달린다. 제어 평면(30초)보다 훨씬 길게 잡는다 — 여기는 100MB 까지 오르는 자리라
    // 짧은 값은 **느린 회선의 정상 전송을 끊는다**(그쪽이 더 나쁜 고장이다).
    const upload = await fetchImpl(presigned.uploadUrl, {
        method: "PUT",
        headers: { "content-type": "application/zip" },
        body: new Uint8Array(packed.buffer),
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    });
    if (!upload.ok) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `업로드에 실패했습니다(HTTP ${upload.status}).`,
            "잠시 뒤 다시 시도해 주세요.",
        );
    }

    report("서버가 확인하는 중…");
    // ⚠ **여기서 다시 묶지 않는다.** 동의 뒤 재시도는 **같은 `storageKey`** 를 쓴다 — S3 에 이미
    //    올라간 그 바이트다. 다시 묶으면 사람이 그 사이 파일을 고쳤을 때 **동의한 것과 다른 것**이
    //    올라가고, 100MB 를 한 번 더 보내게 된다.
    const confirmed = await confirmWithConsent(options, presigned.storageKey);
    report(`버전 ${confirmed.revisionNo} 로 올렸습니다.`);

    return {
        fileCount: packed.fileCount,
        byteSize: packed.buffer.byteLength,
        sha256: packed.sha256,
        revisionNo: confirmed.revisionNo,
        status: confirmed.status,
        siteType: confirmed.siteType,
        capabilityNote: confirmed.capabilityNote,
    };
}
