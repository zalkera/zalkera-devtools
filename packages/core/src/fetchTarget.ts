/**
 * **어느 판을 어디로 받을지 정하는 판정.** 파일시스템·`vscode` 를 안 만진다 — 그래야 시험이 문다.
 *
 * ■ 왜 확장 밖으로 내리나
 *   이 레포에서 확장 안에 둔 판정은 시험도 검사기도 못 닿아, 조건을 통째로 무력화해도 전건 초록이
 *   되는 일이 반복됐다(`reentrancy.ts` 가 같은 이유로 내려왔다). 받기는 **사람 폴더를 만드는**
 *   자리라 그 사각을 남길 수 없다.
 */

import { DevtoolsError } from "./errors.ts";

/** 판 목록의 한 줄. `api.ts` 의 `SiteRevision` 중 이 판정이 쓰는 것만 요구한다. */
export interface RevisionLike {
    revisionNo: number;
    status: string;
    isActive: boolean;
}

export interface RevisionChoice {
    revisionNo: number;
    /** `active` = 지금 방문자가 보는 판 · `latest-ready` = 켜진 판이 없어 최근 것을 골랐다. */
    why: "active" | "latest-ready";
}

/**
 * 받을 판을 고른다. 없으면 `null`.
 *
 * ⚠ **`revisions[0]` 로 때우지 않는다.** 그것이 `BUILDING`·`FAILED` 일 수 있고, 그러면 화면에
 *   말한 판과 실제로 받는 것이 갈린다. 켜진 판이 우선이고, 없으면 **READY 중 가장 큰 번호**다.
 */
export function pickRevision(revisions: readonly RevisionLike[]): RevisionChoice | null {
    const active = revisions.find((r) => r.isActive && r.status === "READY");
    if (active) return {revisionNo: active.revisionNo, why: "active"};
    let best: RevisionLike | null = null;
    for (const r of revisions) {
        if (r.status !== "READY") continue;
        if (best === null || r.revisionNo > best.revisionNo) best = r;
    }
    return best === null ? null : {revisionNo: best.revisionNo, why: "latest-ready"};
}

/**
 * 새로 받을 폴더 이름.
 *
 * ■ 해시를 안 쓰는 이유
 *   판 번호가 **이미 불변 식별자**다 — 13판의 내용은 영원히 13판이다. 이름에 지문을 더하면 같은
 *   말을 두 번 하면서 사람이 못 읽는 글자만 는다. 지문은 이름이 아니라 **판정**에 쓴다
 *   (`.zalkera/source.json` 을 읽어 「이미 받아 두셨습니다」를 말하는 자리).
 *
 * ■ `-2` 가 나오는 자리
 *   같은 판을 다시 받는 흔한 경우가 아니라, **그 이름이 남의 것일 때**다. 드물게 나오므로 사람이
 *   읽는 숫자가 낫다.
 */
export function suggestFolderName(baseName: string, revisionNo: number): string {
    const cleaned = baseName.trim().replace(/[/\\]+$/, "");
    const stem = cleaned.length > 0 ? cleaned : "site";
    return `${stem}-v${revisionNo}`;
}

/**
 * 비어 있는 이름을 찾는다. `taken` 이 참이면 `-2`·`-3` 으로 비킨다.
 *
 * `limit` 까지만 시도하고 못 찾으면 `null` — 무한 반복으로 매달리는 대신 사람에게 폴더를 고르게
 * 한다. 어느 쪽도 **기존 폴더를 건드리지 않는다.**
 */
export function nextAvailableName(base: string, taken: (name: string) => boolean, limit = 50): string | null {
    if (!taken(base)) return base;
    for (let n = 2; n <= limit; n++) {
        const candidate = `${base}-${n}`;
        if (!taken(candidate)) return candidate;
    }
    return null;
}

/**
 * 받을 판이 없을 때의 오류. **「없다」를 한 문장으로 뭉치지 않는다.**
 *
 * 한 번도 안 올린 사람과 올렸는데 아직 못 켜는 사람은 다음에 할 일이 정반대다. 뭉치면 처음 쓰는
 * 사람이 「아직 만들어지는 중이거나 실패했습니다」를 듣고 「버전 이력」을 열어 **빈 목록**을 본다 —
 * 도구가 자기 상태를 잘못 진단해 놓고 사람을 엉뚱한 곳으로 보내는 것이다.
 */
export function noRevisionError(revisions: readonly RevisionLike[]): DevtoolsError {
    if (revisions.length === 0) {
        return new DevtoolsError(
            "NOT_A_SITE",
            "아직 올린 사이트 소스가 없습니다.",
            "예제로 시작하거나, 잘커라 콘솔에서 소스를 먼저 올려 주세요.",
        );
    }
    return new DevtoolsError(
        "NOT_A_SITE",
        "받을 수 있는 판이 없습니다.",
        "올린 판이 아직 만들어지는 중이거나 실패했습니다. 「버전 이력」에서 확인해 주세요.",
    );
}
