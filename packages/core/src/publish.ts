import type { ZalkeraApi } from "./api.ts";
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
    const confirmed = await options.api.confirmArchive(presigned.storageKey);
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
