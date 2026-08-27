/**
 * B1「예제 zip 다운로드」 — 시작 소스 팩을 받아 **파일 하나로** 내준다.
 *
 * 푸는 것은 이 모듈이 아니다 — 받은 zip 은 「zip 으로 시작」·「zip 으로 교체」(`importZip.ts`)가 푼다.
 * 소스가 폴더로 들어가는 문을 하나로 모아 두면, 경로 이탈·항목 상한·고객 파일 보존 같은 규율을
 * 한 자리에서만 지키면 된다.
 *
 * B2(내 사이트 받기)와 **형식이 다르다**: 팩은 zip, 버전 이력은 tar.gz 다. 하나로 합치고 싶은 유혹이 있지만
 * 서버가 실제로 그렇게 주므로 여기서는 사실을 따른다.
 *
 * 받은 zip 이 **원장의 그 바이트인지 스스로 대조한다** — 서버가 sha256 을 함께 주므로, 그 약속이 말뿐이
 * 아니려면 받는 쪽이 실제로 계산해 봐야 한다(전송 손상·중간자 모두 여기서 걸린다).
 */
import { createHash } from "node:crypto";
import type { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";
import { downloadBounded } from "./download.ts";


/** 받아서 **대조까지 마친** 시작 소스 팩 그 자체. */
export interface PresetZip {
    presetCode: string;
    version: string;
    /** 서버가 준 zip 바이트 **그대로**. 다시 포장하지 않는다 — 그러면 아래 sha256 이 거짓이 된다. */
    bytes: Buffer;
    /** 대조에 쓴 값. 파일로 남길 때 함께 적어야 받은 사람이 스스로 확인할 수 있다. */
    sha256: string;
}

/** 큰 전송의 상한. 형제 `fetchSource.ts`·`publish.ts` 와 같은 값이다. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 팩을 받아 **원장의 그 바이트인지 대조한다.** 푸는 것은 하지 않는다.
 *
 * ⚠ **두 입구가 이 하나를 지난다** — 파일로 남기는 쪽(「예제 zip 다운로드」)과 폴더에 푸는 쪽.
 *   검증을 각자 두면 한쪽만 고쳐져 갈린다. 이 레포는 실제로 형제 `fetchSource.ts` 만 고쳐지고
 *   여기가 fail-open 으로 남아 있던 적이 있다(심의 지적). 문이 하나면 그 사고가 구조적으로 안 난다.
 */
export async function fetchPresetZip(options: {
    api: ZalkeraApi;
    presetCode: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}): Promise<PresetZip> {
    const report = options.onProgress ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;

    report("시작 소스를 받는 중…");
    const source = await options.api.presetSourceUrl(options.presetCode);
    // ⚠ **상한을 건다.** Node 의 `fetch` 는 기본 타임아웃이 없어, 연결만 받고 응답을 안 주는
    //    프록시·게이트웨이에 물리면 호출자가 **영원히 매달린다**(`api.ts` 가 같은 말을 적어 두고
    //    고친 자리다). 이 호출은 신규 고객이 제일 먼저 누르는 다운로드이고, 그 위를 덮은 진행
    //    알림에는 취소 버튼이 없다 — 상한이 유일한 탈출구다.
    //    형제 전송로 `fetchSource.ts`·`publish.ts` 와 같은 값을 쓴다.
    // 주소 검사·크기 상한은 형제 셋이 공유한다(`download.ts`).
    const bytes = await downloadBounded(source.url, {
        fetchImpl,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        what: "시작 소스",
    });

    // ⚠ **fail-open 이었다**(심의 지적): `source.sha256 &&` 라 서버가 빈 값을 주면 검사가 소멸했는데,
    // 주석은 "중간자도 여기서 걸린다"고 강하게 적혀 있었다. 검사가 있는 척하는 것이 없는 것보다 나쁘다.
    if (!source.sha256) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "서버가 무결성 해시를 주지 않아 시작 소스를 검증할 수 없습니다.",
            "잘커라에 문의해 주세요. 검증 없이 진행하지 않았습니다.",
        );
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== source.sha256) {
        // 받은 바이트가 서버가 약속한 바이트와 다르면 **아무것도 남기지 않는다.** 진행하면 무엇이
        // 깨졌는지 모른 채 소스가 남고, 그 소스로 만든 사이트의 원인 추적이 불가능해진다.
        //
        // ⚠ 파일로 남기는 쪽에서 특히 중요하다 — 검증 안 된 zip 이 디스크에 남으면 그것이 그대로
        //   「zip 으로 교체」로 들어가 **되돌릴 수 없는 폴더 교체**의 재료가 된다.
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 파일이 원본과 다릅니다(무결성 확인 실패).",
            "네트워크 문제일 수 있습니다. 다시 시도해 주세요.",
        );
    }
    return { presetCode: options.presetCode, version: source.version, bytes, sha256: source.sha256 };
}
