/**
 * 로컬 소스 폴더의 **사이트 소속** 판정.
 *
 * 폴더는 한 사이트에 속한다. 소속의 정본은 폴더 안의 표식(`.zalkera/source.json`)이고,
 * 워크스페이스 링크(`zalkera.tenant`)는 둘째 근거다. 사이트 선택은 소속을 바꾸지 않는다 —
 * 소속을 바꾸는 것은 명시 재연결뿐이다.
 *
 * ⚠ **판정이 여기 사는 이유.** 확장 안 조건문은 시험도 검사기도 못 문다. 이 파일의 함수가
 *   순수하기 때문에 「사이트 선택이 남의 폴더 링크를 덮는다」가 시험 한 줄로 고정된다.
 */
import type {SourceMark} from "./localMark.ts";

/**
 * 이 폴더가 어느 사이트에 속하는가. 모르면 `null`.
 *
 * 서열은 **표식 > 워크스페이스 링크**다. 표식은 받기·발행이라는 실제 사건의 기록이고 도구만
 * 쓰지만, 링크는 사이트 선택이 곁다리로 덮던 자리다 — 어긋났을 때 사고를 입은 쪽이 링크다.
 */
export function folderBinding(mark: SourceMark | null, linkedTenant: string | null): string | null {
    if (mark !== null) return mark.tenant;
    if (linkedTenant !== null && linkedTenant !== "") return linkedTenant;
    return null;
}

/** 고른 사이트를 어느 범위에 적을지. `none` 이면 **아무것도 적지 않는다.** */
export type TenantScope = "workspace" | "global" | "none";

export interface ScopeInput {
    /** 이 창에 사이트 소스가 열려 있는가(`siteDir() !== null`). */
    siteFolderOpen: boolean;
    /** [folderBinding] 의 값. */
    binding: string | null;
    chosen: string;
}

/**
 * | 상태 | 범위 |
 * |---|---|
 * | 폴더 없음 · 소스 아닌 폴더 | `global` — 창의 작업 사이트만 바뀐다 |
 * | 소스 폴더 · 소속 없음 | `workspace` — 폴더가 그 사이트를 입양한다 |
 * | 소속 == 고른 사이트 | `workspace` — 재확인이자 어긋난 링크의 복원 |
 * | 소속 != 고른 사이트 | `none` — 폴더 링크도, 전역도 적지 않는다 |
 *
 * ⚠ **넷째 행이 `global` 로 퇴행하면 교차 업로드가 되살아난다.** 전역의 그 값은 이 창에서는
 *   죽은 값이지만, 표식도 링크도 없는 폴더를 여는 순간 그 창의 유효 사이트가 된다. 그런 폴더에는
 *   게이트가 설 근거가 없으므로(표식 부재로는 막지 않는다) 그대로 발행이 나간다.
 */
export function decideTenantScope(input: ScopeInput): TenantScope {
    // 소속이 **판정을 지배한다.** 폴더 유무를 먼저 보면, 구판이 소스 아닌 폴더에 적어 둔 링크가
    // 있는 창에서 전역에 적히는데 병합 조회는 그 링크가 이겨 — 화면은 「y」, 실동작은 x 가 된다.
    if (input.binding !== null) return input.binding === input.chosen ? "workspace" : "none";
    return input.siteFolderOpen ? "workspace" : "global";
}

/** 사이트를 고른 뒤 화면이 할 일. */
export type SiteChoice =
    /** 폴더 없음 · 소속 없음 · 같은 사이트 — 창의 사이트가 실제로 바뀌었다. */
    | {kind: "switched"}
    /** 소속 없던 소스 폴더가 이 사이트를 입양했다 — 연결 사실을 알린다. */
    | {kind: "adopted"}
    /** 소속이 다르다 — 이 창은 그대로 두고 폴더 전환을 제안한다. */
    | {kind: "elsewhere"; offer: "open" | "fetch"};

export interface ChoiceInput {
    picked: string;
    binding: string | null;
    siteFolderOpen: boolean;
    /**
     * 레지스트리가 기억하는 그 사이트의 폴더를 **확증까지 마쳤는가**.
     *
     * ⚠ 기억만으로 열기를 제안하면 안 된다. 경로가 재활용돼 다른 사이트를 담게 된 폴더를
     *   「그 사이트 폴더」로 열어 주는 것이 이 설계가 막으려는 바로 그 사고다.
     */
    knownFolderConfirmed: boolean;
}

export function decideSiteChoice(input: ChoiceInput): SiteChoice {
    if (!input.siteFolderOpen) return {kind: "switched"};
    if (input.binding === null) return {kind: "adopted"};
    if (input.binding === input.picked) return {kind: "switched"};
    return {kind: "elsewhere", offer: input.knownFolderConfirmed ? "open" : "fetch"};
}

/**
 * 「폴더 연결」이 동의를 받아야 하는가.
 *
 * 소속이 있고 그것이 고른 사이트와 다르면 받는다 — 그 폴더의 소스가 다른 사이트로 올라가게
 * 되는 변경이라, 조용히 하면 안 된다.
 */
export function needsRelinkConsent(binding: string | null, chosen: string): boolean {
    return binding !== null && binding !== chosen;
}
