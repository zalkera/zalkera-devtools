import type { ArchiveConfirmed, ZalkeraApi } from "./api.ts";
import { isUploadBaseMoved, needsDiscardConsent } from "./api.ts";
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
    /**
     * 이 소스가 나가는 사이트. **출처 표시**로 zip 에 찍힌다(`provenance.ts`).
     *
     * 부르는 쪽이 아는 값을 그대로 받는다 — 여기서 폴더 소속을 다시 읽으면 판정이 두 벌이 되고,
     * 발행 게이트(`siteMatches`)가 이미 「폴더 소속 = 고른 사이트」를 보장한 뒤다.
     */
    tenant: string;
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
    /**
     * ⚠ **문면 재료가 둘이다** — 서버 문장과 **서버 코드**. 같은 동의 인자로 뚫리는 코드가 둘이고
     *   결과가 다르다(판이 옮겨진다 / 판은 그대로고 작업만 버린다). 코드를 안 넘기면 부르는 쪽이
     *   그 둘을 못 갈라 **다른 행위에 대한 동의**를 받게 된다.
     */
    onConsent?: (serverMessage: string, serverCode: string | null) => Promise<boolean>;
    /**
     * 이 올리기가 딛는다고 **선언할 판**. `null` 은 무선언 — 서버는 현행 그대로 통과시킨다.
     *
     * 부르는 쪽이 폴더 표식에서 읽어 넘긴다(`declaredBaseRevisionNo`). core 가 다시 읽지 않는 이유는
     * `tenant` 와 같다 — 판정이 두 벌이 되면 갈린다.
     */
    baseRevisionNo?: number | null;
    /**
     * 선언한 판이 원장 꼬리가 아니어서 서버가 막았을 때 사람에게 묻는다. `true` 를 돌려주면
     * **무선언으로 같은 바이트를 다시 올린다**(그 사이 올라온 변경은 안 담긴다).
     *
     * ⚠ **안 주면 그대로 던진다.** 그러면 화면은 막다른 길이 된다 — 표식은 발행 성공에서만 갱신되므로
     *   다음 올리기도 같은 번호를 선언해 **같은 409 를 무한히 맞는다.** 사람이 최신 변경을 손으로
     *   합쳐 넣어도 표식은 옛 번호라 빠져나갈 수 없다. 화면이 없는 자리(시험)는 그 문을 안 열면 된다.
     *
     * ⚠ **[onConsent] 와 합치지 마라.** 사라지는 것이 다르다 — 저쪽은 내 편집, 이쪽은 남의 변경이다.
     *
     * @param serverMessage 서버가 보낸 문장(최신 판 번호가 들어 있다). 표시 자리에서 소독한다.
     */
    onBaseMoved?: (serverMessage: string) => Promise<boolean>;
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
 * confirm 을 **문이 열릴 때까지** 다시 부른다.
 *
 * ■ 왜 반복인가 — 문이 둘이고 **차례로** 걸린다
 *   백엔드는 동의 게이트(`BaselineShiftGuard`)를 기반 대조보다 **먼저** 지난다. 그래서 승격 사이트에
 *   게시 대기 작업이 있고 그 사이 남이 올렸으면 **동의를 받은 뒤에 기반 409 가 온다.** 갈래를 평평하게
 *   두면 그 두 번째 409 는 아무 데도 안 걸리고 그대로 던져진다 — 그리고 그 시도는 S3 put·tx 전에
 *   막혀 **아무 상태도 안 바꾸므로**, 다음 올리기도 같은 두 걸음을 그대로 반복한다. 빠져나갈 단추가
 *   없는 빨간창이 영구히 남는다(설계 심의가 반려 사유로 못 박은 그 형상).
 *
 * ■ 왜 끝나는가
 *   문마다 **한 번만** 묻는다. 같은 문이 두 번 걸리면 사람의 답이 안 통한 것이므로 그대로 던진다 —
 *   되풀이해 묻는 것은 「확인」이 아니라 조르기다. 그래서 시도는 최대 세 번이다.
 *
 * ■ 동의는 **상태**다
 *   `discard` 를 인자가 아니라 상태로 들고 다닌다. 기반 갈래에서 `discard=false` 로 재전송하면
 *   방금 받은 동의가 사라져 곧바로 같은 동의 409 를 다시 맞는다.
 */
async function confirmWithConsent(
    options: PublishOptions,
    storageKey: string,
    baseRevisionNo: number | null,
): Promise<ArchiveConfirmed> {
    let discard = false;
    let base = baseRevisionNo;
    let consentAsked = false;
    let baseAsked = false;
    for (;;) {
        try {
            // ⚠ **같은 `storageKey` 로 다시 부른다 — 절대 다시 묶지 않는다.** 사람이 동의한 것은
            //    「지금 이 바이트를 그대로 올린다」이고, 재압축하면 **동의한 것과 다른 것**이 올라간다.
            return await options.api.confirmArchive(storageKey, discard, base);
        } catch (error) {
            const rejected = error instanceof DevtoolsError ? error : null;
            const message = rejected?.message ?? String(error);
            if (needsDiscardConsent(error) && options.onConsent && !consentAsked) {
                consentAsked = true;
                if (!(await options.onConsent(message, rejected?.serverCode ?? null))) {
                    throw new DevtoolsError("CANCELLED", "올리기를 그만두었습니다.");
                }
                discard = true;
                continue;
            }
            if (isUploadBaseMoved(error) && options.onBaseMoved && !baseAsked) {
                baseAsked = true;
                if (!(await options.onBaseMoved(message))) {
                    throw new DevtoolsError("CANCELLED", "올리기를 그만두었습니다.");
                }
                // 무선언으로 내려놓는다. 같은 선언을 다시 실으면 같은 409 를 다시 맞고, 표식은 발행
                // 성공에서만 갱신되므로 **영원히 못 빠져나온다** — 그것이 이 갈래가 존재하는 이유다.
                base = null;
                continue;
            }
            throw error;
        }
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
    // 출처 표시를 찍는다 — 이 zip 이 어느 사이트에서 나왔는지 말할 수 있게 한다.
    // 발행 게이트가 `siteMatches` 로 「폴더 소속 = 고른 사이트」를 이미 보장한 자리다.
    const packed = await packProject({
        projectDir: options.projectDir,
        provenanceTenant: options.tenant,
        onProgress: report,
    });
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
    const confirmed = await confirmWithConsent(options, presigned.storageKey, options.baseRevisionNo ?? null);
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
