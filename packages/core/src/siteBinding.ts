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
    /** 이미 그 사이트로 작업 중이었다 — **아무것도 안 바뀌었다.** 재확인만 말한다. */
    | {kind: "unchanged"}
    /** 창의 대상이 실제로 바뀌었다(어긋난 링크의 복원 포함). */
    | {kind: "switched"}
    /** 소속 없던 소스 폴더가 이 사이트를 입양했다 — 연결 사실을 알린다. */
    | {kind: "adopted"}
    /** 소속이 다르다 — 이 창은 그대로 두고 [ElsewhereOption] 을 낸다. */
    | {kind: "elsewhere"};

export interface ChoiceInput {
    picked: string;
    binding: string | null;
    siteFolderOpen: boolean;
    /**
     * **고르기 전**의 유효 사이트. `unchanged` 를 가리는 데만 쓴다.
     *
     * ⚠ 고른 **뒤**에 읽으면 안 된다 — 사이트 선택이 설정을 쓰고 나면 이 값이 늘 `picked` 와
     *   같아져 모든 전환이 `unchanged` 로 접힌다.
     */
    current: string;
}

/**
 * ⚠ **`unchanged` 와 `switched` 를 가르는 것은 「무엇이 실제로 바뀌었나」다.** 종전에는 둘이 한
 *   칸이라, 이미 그 사이트인데 다시 고른 사람에게 「바꿨습니다」라고 말했다 — 아무것도 안 한 것을
 *   한 것처럼 말하는 자리다.
 *
 *   다만 **어긋난 창에서 자기 사이트를 다시 고르는 것은 복원이라 `switched` 가 참이다**: 표식은
 *   x 인데 링크 잔재로 유효 사이트가 y 인 창에서 x 를 고르면 링크가 표식에 맞춰지므로 실제로
 *   바뀐다. 그래서 소속이 있으면 그것과 견주고, 없을 때만 유효 사이트와 견준다.
 */
export function decideSiteChoice(input: ChoiceInput): SiteChoice {
    if (!input.siteFolderOpen) {
        return input.current === input.picked ? {kind: "unchanged"} : {kind: "switched"};
    }
    if (input.binding === null) return {kind: "adopted"};
    if (input.binding !== input.picked) return {kind: "elsewhere"};
    return input.current === input.picked ? {kind: "unchanged"} : {kind: "switched"};
}

/**
 * 소속이 다른 폴더에서 사이트를 골랐을 때 사람에게 낼 선택지.
 *
 * **배열 순서가 곧 화면 순서이자 권고다** — 첫 항목이 기본 포커스를 받는다.
 */
export type ElsewhereOption =
    /** 확증된 로컬본을 연다. */
    | {kind: "open"; dir: string}
    /** 새 빈 폴더로 받는다. */
    | {kind: "fetch"}
    /** 로컬본 폴더를 사람이 직접 고른다. */
    | {kind: "pick-folder"}
    /** 받아 둔 zip 으로 시작한다. */
    | {kind: "import-zip"};

export interface ElsewhereInput {
    /**
     * **확증까지 마친** 레지스트리 값. 기억만 있는 값을 넣으면 안 된다 — 경로가 재활용돼 다른
     * 사이트를 담게 된 폴더를 「그 사이트 폴더」로 열어 주는 것이 이 설계가 막으려는 사고다.
     */
    confirmedDir: string | null;
    /**
     * 고른 사이트에 **받을 판이 있는가**.
     *
     * `unknown` 은 조회 실패다 — 「없다」가 아니다. 그 둘을 뭉개면 서버가 잠시 흔들린 것으로
     * 정상 경로가 사라진다.
     */
    fetchable: "yes" | "none" | "unknown";
}

/**
 * ⚠ **`none` 이면 받기를 안 낸다.** 판이 없는 사이트에서 받기는 누르는 순간 실패한다 —
 *   제안 표면이 실패를 약속하면 사람은 자기가 뭘 잘못한 줄 안다.
 *
 * ⚠ **`unknown` 에서는 남긴다.** 모르는 것으로는 막지 않는다(이 레포의 이행 원칙). 눌러서
 *   실패하면 그때 진단이 두 갈래로 정직하게 말한다.
 *
 * 판이 없는 사이트로 옮기는 사람의 흔한 형상은 **zip 입고**(신규 테넌트 온보딩)라, 그때만
 * `import-zip` 이 `pick-folder` 앞에 선다.
 */
export function elsewhereOptions(input: ElsewhereInput): {
    options: ElsewhereOption[];
    note: "no-source" | null;
} {
    const options: ElsewhereOption[] = [];
    if (input.confirmedDir !== null) options.push({kind: "open", dir: input.confirmedDir});
    if (input.fetchable !== "none") options.push({kind: "fetch"});
    if (input.fetchable === "none") {
        options.push({kind: "import-zip"}, {kind: "pick-folder"});
    } else {
        options.push({kind: "pick-folder"}, {kind: "import-zip"});
    }
    return {options, note: input.fetchable === "none" ? "no-source" : null};
}

/** 사람이 직접 고른 폴더를 어떻게 할 것인가. */
export type PickedFolderPlan =
    /** 그 사이트의 소스다 — 링크를 소속에 맞추고 연다(복원이라 동의가 필요 없다). */
    | {kind: "open"}
    /** 소속이 없다 — 동의를 받고 소속을 **처음** 준 뒤 연다. */
    | {kind: "link-consent"}
    /** 다른 사이트의 소스다 — **열지 않는다.** */
    | {kind: "refuse"; bound: string};

/**
 * ⚠ **이 동사는 재연결이 아니다.** `link-consent` 는 소속이 **없는** 폴더에 소속을 처음 주는 것이고,
 *   소속이 있는 폴더는 [PickedFolderPlan] `refuse` 로 거절한다. 소속을 **바꾸는** 것은 「사이트에
 *   연결」 하나로 남는다 — 가장 위험한 동사를 가장 흔한 흐름의 한 클릭 거리에 두지 않는다.
 */
export function decidePickedFolder(binding: string | null, chosen: string): PickedFolderPlan {
    if (binding === null) return {kind: "link-consent"};
    return binding === chosen ? {kind: "open"} : {kind: "refuse", bound: binding};
}

/** 받기·zip 풀기가 **어디로** 갈지의 첫 제안. */
export type FetchTargetPlan =
    /** 지금 열어 둔 빈 폴더 — 사람이 이미 고른 자리다. */
    | {kind: "here"; dir: string}
    /** 소스 폴더 옆의 새 이름. */
    | {kind: "sibling"}
    /** 제안할 자리가 없다 — 대화상자로만 받는다. */
    | {kind: "pick-only"};

export interface FetchTargetInput {
    /** 지금 창에 열린 폴더(없으면 `null`). */
    openDir: string | null;
    /** 그 폴더가 **받아도 되는 빈 폴더**인가(`isReceivable` — 확장이 재서 넘긴다). */
    openDirReceivable: boolean;
    /** 그 폴더가 사이트 소스인가(`siteDir() !== null`). */
    siteFolderOpen: boolean;
}

/**
 * ⚠ **빈 폴더를 열어 두고 온 사람에게 「빈 폴더를 고르세요」라고 다시 묻지 않는다.** 그 사람은
 *   이미 자리를 골랐다 — 그 뜻을 못 읽으면 탐색기로 올라가 새 폴더를 만들게 하는 왕복이 생기고,
 *   그것이 비개발자가 멈추는 자리다.
 *
 * ⚠ **소스 폴더에는 안 푼다.** 열려 있는 소스를 덮어쓰는 일이 없어야 하므로 그 창에서는 옆 자리를
 *   제안한다(현행). 빈 폴더 판정은 확장이 `isReceivable` 로 재서 넘긴다.
 */
export function decideFetchTargetPlan(input: FetchTargetInput): FetchTargetPlan {
    if (input.siteFolderOpen) return {kind: "sibling"};
    if (input.openDir !== null && input.openDirReceivable) return {kind: "here", dir: input.openDir};
    return {kind: "pick-only"};
}

/**
 * 「사이트에 연결」이 동의를 받아야 하는가.
 *
 * 소속이 있고 그것이 고른 사이트와 다르면 받는다 — 그 폴더의 소스가 다른 사이트로 올라가게
 * 되는 변경이라, 조용히 하면 안 된다.
 */
export function needsRelinkConsent(binding: string | null, chosen: string): boolean {
    return binding !== null && binding !== chosen;
}
