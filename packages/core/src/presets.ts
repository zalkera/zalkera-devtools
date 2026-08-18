import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { meaningfulEntries, removeAdded, snapshotEntries } from "./emptyDir.ts";
import type { ZalkeraApi } from "./api.ts";
import { DevtoolsError } from "./errors.ts";
import { downloadBounded } from "./download.ts";
import { extractZip } from "./unzip.ts";

/**
 * B1「예제로 시작」 — 시작 소스 팩을 받아 빈 폴더에 푼다.
 *
 * B2(내 사이트 받기)와 **형식이 다르다**: 팩은 zip, 버전 이력은 tar.gz 다. 하나로 합치고 싶은 유혹이 있지만
 * 서버가 실제로 그렇게 주므로 여기서는 사실을 따른다.
 *
 * 받은 zip 이 **원장의 그 바이트인지 스스로 대조한다** — 서버가 sha256 을 함께 주므로, 그 약속이 말뿐이
 * 아니려면 받는 쪽이 실제로 계산해 봐야 한다(전송 손상·중간자 모두 여기서 걸린다).
 */
export interface StartFromPresetOptions {
    api: ZalkeraApi;
    presetCode: string;
    targetDir: string;
    onProgress?: (message: string) => void;
    fetchImpl?: typeof fetch;
}

export interface StartFromPresetResult {
    presetCode: string;
    version: string;
    fileCount: number;
}

/** 큰 전송의 상한. 형제 `fetchSource.ts`·`publish.ts` 와 같은 값이다. */
const TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;

export async function startFromPreset(options: StartFromPresetOptions): Promise<StartFromPresetResult> {
    const report = options.onProgress ?? (() => {});
    const fetchImpl = options.fetchImpl ?? fetch;

    await mkdir(options.targetDir, { recursive: true });
    // 위와 같은 규율 — 편집기 설정·OS 부스러기는 "비어 있음"으로 본다(emptyDir.ts).
    if ((await meaningfulEntries(options.targetDir)).length > 0) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "받을 폴더가 비어 있지 않습니다.",
            "빈 폴더를 골라 주세요(있는 파일을 덮어쓰지 않습니다).",
        );
    }

    report("시작 소스를 받는 중…");
    const source = await options.api.presetSourceUrl(options.presetCode);
    // ⚠ **상한을 건다.** Node 의 `fetch` 는 기본 타임아웃이 없어, 연결만 받고 응답을 안 주는
    //    프록시·게이트웨이에 물리면 호출자가 **영원히 매달린다**(`api.ts` 가 같은 말을 적어 두고
    //    고친 자리다). 이 호출은 신규 고객이 제일 먼저 누르는 「예제로 시작」의 다운로드이고,
    //    그 위를 덮은 진행 알림에는 취소 버튼이 없다 — 상한이 유일한 탈출구다.
    //    형제 전송로 `fetchSource.ts`·`publish.ts` 와 같은 값을 쓴다.
    // 주소 검사·크기 상한은 형제 셋이 공유한다(`download.ts`).
    const zip = await downloadBounded(source.url, {
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
    const actual = createHash("sha256").update(zip).digest("hex");
    if (actual !== source.sha256) {
        // 받은 바이트가 서버가 약속한 바이트와 다르면 **풀지 않는다.** 여기서 진행하면 무엇이 깨졌는지
        // 모른 채 소스가 남고, 그 소스로 만든 사이트의 원인 추적이 불가능해진다.
        throw new DevtoolsError(
            "SERVER_REJECTED",
            "받은 파일이 원본과 다릅니다(무결성 확인 실패).",
            "네트워크 문제일 수 있습니다. 다시 시도해 주세요.",
        );
    }

    // ⚠ **반쪽 해제를 남기지 않는다** — 형제 `fetchSource.ts` 와 같은 규율이다. `extractZip` 은
    //    항목을 훑으며 그때그때 쓰므로, 경로 이탈·항목 상한이 중간에 걸리면 앞서 쓴 파일이 남는다.
    //    배송 문서(`media/help.md`)는 그 두 오류를 이름까지 대며 "아무것도 풀지 않고 멈춘 것이니
    //    폴더는 그대로입니다"라고 **보증**하는데, 그 보증은 이 경로에도 걸린다 — 앞 판이
    //    `fetchSource` 만 고쳐 여기서는 여전히 거짓이었다(재심의 실증).
    //
    //    위에서 빈 폴더임을 확인한 뒤이므로 우리가 쓴 것만 지운다.
    // ⚠ **우리가 쓴 것만 되감는다** — 형제 `fetchSource.ts` 와 같은 규율이다. 폴더를 통째로 지우면
    //    「빈 폴더」 판정이 일부러 통과시킨 고객 파일(`.vscode`)이 사라진다.
    const before = await snapshotEntries(options.targetDir);
    let fileCount: number;
    try {
        ({ fileCount } = await extractZip(zip, options.targetDir));
    } catch (cause) {
        await removeAdded(options.targetDir, before);
        throw cause;
    }
    report(`${source.version} · 파일 ${fileCount}개를 풀었습니다.`);
    return { presetCode: options.presetCode, version: source.version, fileCount };
}
