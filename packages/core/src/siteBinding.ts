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
import {plausibleRevisionNo} from "./localMark.ts";
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

/**
 * 워크스페이스 링크를 읽은 **결과**. 「없다」와 「못 읽었다」를 가른다.
 *
 * ⚠ **둘을 접으면 가드가 열린다**(보안 심의 🟠). 링크 판독기는 생 `JSON.parse` 라 주석·후행
 *   쉼표가 있는 `settings.json`(JSONC — VS Code 가 정상으로 취급하는 형식)에서 던진다. 그것을
 *   `null` 로 접으면 **소속이 있는 폴더가 「소속 없음」으로 보이고**, 소속을 덮지 않기로 한
 *   자리가 덮는다. 같은 폴더를 창으로 열면 VS Code 의 판독기는 JSONC 를 읽으므로 화면은
 *   「그 사이트 소속」이라 말한다 — 두 판독이 갈리는 것이 이 형상의 본체다.
 *
 *   쓰기 쪽은 이미 이 규율을 지킨다(`mergeTenantSetting` 의 「못 읽으면 안 쓴다」). 읽고 **판정**
 *   하는 쪽에도 같은 자를 댄다.
 */
export type WorkspaceLink =
    /** `settings.json` 이 없거나, 있는데 그 키가 없다. */
    | {kind: "absent"}
    /** 파일은 있는데 못 읽었다 — 「없다」가 아니라 **모른다**. */
    | {kind: "unreadable"}
    | {kind: "tenant"; tenant: string};

/** [WorkspaceLink] 를 종전 계약(`string | null`)으로 좁힌다. **판독은 한 벌이다.** */
export function linkedTenantOf(link: WorkspaceLink): string | null {
    return link.kind === "tenant" ? link.tenant : null;
}

/** zip 을 푼 폴더에 소속을 적을 것인가. */
export type ImportBinding =
    /** 적는다 — 비어 있거나 이미 그 사이트다. */
    | {kind: "bind"}
    /** 다른 사이트에 붙어 있다. **안 적는다** — 소속을 바꾸는 동사는 「사이트에 연결」 하나다. */
    | {kind: "keep"; bound: string}
    /** 소속을 못 읽었다. **안 적는다** — 모르는 것을 우리 값으로 덮지 않는다. */
    | {kind: "unknown"};

/**
 * ⚠ **`unknown` 을 `bind` 로 접지 마라.** 그 접힘이 이 판정을 만든 이유다 — 자세한 것은
 *   [WorkspaceLink] 의 주석에 있다. 못 읽은 폴더에는 아무것도 안 적고 사람에게 넘긴다.
 */
export function decideImportBinding(
    mark: SourceMark | null,
    link: WorkspaceLink,
    tenant: string,
): ImportBinding {
    if (mark !== null) return mark.tenant === tenant ? {kind: "bind"} : {kind: "keep", bound: mark.tenant};
    if (link.kind === "unreadable") return {kind: "unknown"};
    if (link.kind === "tenant" && link.tenant !== "") {
        return link.tenant === tenant ? {kind: "bind"} : {kind: "keep", bound: link.tenant};
    }
    return {kind: "bind"};
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
    | {kind: "elsewhere"}
    /**
     * **열린 폴더가 없는 창이다** — 고른 사이트는 창에 적혔지만 일할 자리가 없다.
     * [ElsewhereOption] 을 그대로 낸다: 그 넷이 곧 「폴더를 정하는 길」이라 여기서도 같은 길이다.
     *
     * ⚠ **`elsewhere` 와 적히는 것이 다르다.** 저쪽은 아무것도 안 적히지만(`none`) 여기는
     *   창의 사이트가 **적힌다**(`global`) — 취소해도 그 값은 남는다. 그러니 이 갈래의 화면에서
     *   「바꾸지 않았습니다」로 말하면 안 된다.
     */
    | {kind: "no-folder"};

export interface ChoiceInput {
    picked: string;
    binding: string | null;
    siteFolderOpen: boolean;
    /**
     * 창에 **폴더가 열려 있는가**. `siteFolderOpen` 이 참이면 이것도 참이다(소스 폴더는 폴더다).
     *
     * ⚠ **`siteFolderOpen` 하나로는 「폴더가 없다」와 「폴더는 있는데 소스가 아니다」가 한 칸에
     *   접힌다.** 그 둘은 사람이 할 일이 다르다 — 앞은 자리를 **정해야** 하고, 뒤는 이미 자리에
     *   서 있다(그 폴더가 빈 폴더면 받기가 거기로 간다 · [decideFetchTargetPlan]). 화면 문면도
     *   그만큼 달라야 해서, 접으면 둘 중 하나에 거짓말을 하게 된다.
     */
    folderOpen: boolean;
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
    // ⚠ **소속이 판정을 지배한다 — [decideTenantScope] 와 같은 순서여야 한다.** 폴더 유무를 먼저
    //    보면 「소속은 있는데 소스가 아닌 폴더」(package.json 을 지웠거나 아직 안 받은 자리)에서
    //    둘이 갈린다: 이쪽은 `switched` 라 「사이트: y」라고 말하는데 저쪽은 `none` 이라 **아무것도
    //    안 적힌다.** 그 어긋남에 이름을 붙여 둔 것이 저 함수의 KDoc 이고, 여기서 순서를 뒤집으면
    //    그 실패를 그대로 재현한다(실측으로 3칸이 갈렸다).
    if (input.binding !== null) {
        if (input.binding !== input.picked) return {kind: "elsewhere"};
        return input.current === input.picked ? {kind: "unchanged"} : {kind: "switched"};
    }
    if (input.siteFolderOpen) return {kind: "adopted"};
    // ⚠ **`siteFolderOpen` 을 먼저 본다 — 모순 입력의 방어선이 여기다.** 두 불리언은 「소스 폴더면
    //    폴더다」라는 불변식으로 묶여 있는데, 타입이 그것을 못 지킨다. 순서를 뒤집으면 잘못 지은
    //    입력 한 칸이 입양을 통째로 삼켜, 소스 폴더를 열어 둔 사람이 폴더를 다시 고르게 된다.
    if (!input.folderOpen) return {kind: "no-folder"};
    // ⚠ **`unchanged` 는 폴더가 있을 때만 참이다.** 폴더가 없는 창에서 「이미 그 사이트로 작업
    //    중」이라고 말하면 작업할 자리가 없는 사람에게 다 됐다고 말하는 것이다 — 그 칸은 위에서
    //    이미 `no-folder` 로 갔다(오너 판정).
    return input.current === input.picked ? {kind: "unchanged"} : {kind: "switched"};
}

/**
 * 고른 사이트의 작업을 **어느 폴더에서 할지** 물을 때 사람에게 낼 선택지. 부르는 자리가 둘이다 —
 * 열린 폴더가 **남의 사이트** 것일 때([SiteChoice] `elsewhere`)와 **열린 폴더가 없을 때**(`no-folder`).
 *
 * ⚠ **둘 다 「여기 말고 어딘가」라서 같은 넷이다.** 네 항목 모두 자리를 **정하는** 동사라, 폴더가
 *   아예 없는 창에서도 그대로 선다.
 *
 * ⚠ **「지금 폴더를 안 건드린다」고 적지 말 것 — 한 칸에서 거짓이다**(심의 실측). 열린 폴더가
 *   **빈 폴더**면(`.vscode` 만 있는 폴더도 빈 폴더로 센다 — [meaningfulEntries]) 받기가 **거기로**
 *   갈 수 있고([decideFetchTargetPlan] 의 `here`), 그때 그 폴더의 소속이 고른 사이트로 바뀐다.
 *   **받기·풀기가 파일을 덮는 일은 없다**(비어 있지 않으면 그 전에 던진다)는 참이지만, 그것과
 *   「안 건드린다」는 다른 말이다 — `pick-folder` 는 고른 폴더에 **우리 파일 둘**(표식 ·
 *   `.vscode/settings.json` 병합)을 쓴다. 그것은 받기가 아니라 「연결」이지만, 쓰기는 쓰기다.
 *
 * **배열 순서가 곧 화면 순서이자 권고다** — 첫 항목이 기본 포커스를 받는다.
 */
export type ElsewhereOption =
    /**
     * 확증된 로컬본을 연다.
     *
     * `drift` 는 **둘 다 알고 서로 다를 때만** 값이 있다 — 하나라도 모르면 `null` 이고 화면은
     * 아무 말도 안 한다. ⚠ **이름이 방향을 안 싣는다**(`stale` 이 아니다): 되돌린 사이트에서는
     * 로컬이 서버보다 **앞**이라 「낡았다」가 거짓이 된다.
     */
    | {kind: "open"; dir: string; drift: {held: number; server: number} | null}
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
     * ⚠ **「없다」를 두 사유로 가른다.** `no-revision` 은 아직 아무도 안 올린 사이트이고,
     *   `no-ready` 는 올렸는데 빌드 중이거나 실패한 것이다. 뭉개면 **빌드가 도는 사이트의
     *   사용자에게 「소스가 없으니 zip 으로 시작하라」는 오진**이 나가고, 잠시 기다리면 될 사람을
     *   엉뚱한 길로 보낸다(`noRevisionError` 가 이미 그 둘을 가른다).
     *
     * `unknown` 은 조회 실패다 — 「없다」가 아니다. 그 둘을 뭉개면 서버가 잠시 흔들린 것으로
     * 정상 경로가 사라진다.
     */
    fetchable: "yes" | "no-revision" | "no-ready" | "unknown";
    /**
     * `confirmedDir` 이 **선언하는 기반 판**(`declaredBaseRevisionNo`). 모르면 `null` — 침묵한다.
     *
     * ⚠ **`holdsSameRevision` 이 아니다.** 그 술어는 불리언이라 「모른다」가 「다르다」로 접히고,
     *   무엇보다 **「이 폴더가 그 판의 사본이다」**를 주장하는 자리라 발행 표식을 일부러 뺀다.
     *   여기서 말하려는 것은 사본이 아니라 **기반**이고, 오너 시나리오(내가 올린 뒤 남이 또 올림)의
     *   폴더는 받기 표식이 아니라 **발행 표식**을 든다.
     */
    heldRevisionNo?: number | null;
    /**
     * 서버 정본 판(`pickRevision` 결과). 모르면 `null` — 침묵한다.
     *
     * ⚠ **받기 문 셋·「서버 판으로 교체」와 같은 판정이어야 한다.** 여기서 갈리면 「화면이 말한
     *   번호와 교체가 받는 번호가 다른」 날이 온다.
     *
     * 판 번호로 안 통하는 값(0·음수·Int32 초과·정수 아님)은 **모름으로 접는다**
     * ([plausibleRevisionNo]) — `heldRevisionNo` 도 같다.
     */
    serverRevisionNo?: number | null;
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
    note: "no-revision" | "no-ready" | null;
} {
    const blocked = input.fetchable === "no-revision" || input.fetchable === "no-ready" ? input.fetchable : null;
    const options: ElsewhereOption[] = [];
    if (input.confirmedDir !== null) {
        // ⚠ **둘 다 알고 다를 때만 말한다.** 하나라도 모르면 침묵 — 없는 소식을 지어내지 않는다.
        //    같을 때도 침묵이다: 「서버와 같습니다」는 **사본 주장**으로 읽히는데 우리가 아는 것은
        //    기반뿐이고, 그건 없는 소식이다.
        //
        // ⚠ **정수만 싣는다 — 그 잣대를 여기서 세운다.** 화면은 「이 줄에 서버 문자열이 오면
        //    QuickPick 라벨 소독 구멍을 넓힌다」고 적어 뒀는데, 서버 번호는 `request<T>` 의
        //    **캐스트**로 와서 형 선언만 있고 런타임 검사가 없다. 배선 한 줄로 지키면 그 줄을
        //    지운 판이 전건 초록으로 나간다(3축 실측). 판정 자리에서 접어야 시험이 문다.
        const held = plausibleRevisionNo(input.heldRevisionNo);
        const server = plausibleRevisionNo(input.serverRevisionNo);
        const drift = held !== null && server !== null && held !== server ? {held, server} : null;
        options.push({kind: "open", dir: input.confirmedDir, drift});
    }
    if (blocked === null) options.push({kind: "fetch"});
    // 판이 아예 없는 사이트로 옮기는 사람의 흔한 형상은 zip 입고(신규 테넌트 온보딩)다.
    // **빌드 대기(`no-ready`)에서는 안 올린다** — 그 사람은 잠시 뒤 받으면 되지 새로 시작할 일이 아니다.
    if (input.fetchable === "no-revision") {
        options.push({kind: "import-zip"}, {kind: "pick-folder"});
    } else {
        options.push({kind: "pick-folder"}, {kind: "import-zip"});
    }
    return {options, note: blocked};
}

/** 사람이 직접 고른 폴더를 어떻게 할 것인가. */
export type PickedFolderPlan =
    /** 그 사이트의 소스다 — 링크를 소속에 맞추고 연다(복원이라 동의가 필요 없다). */
    | {kind: "open"}
    /** 소속이 없다 — 동의를 받고 소속을 **처음** 준 뒤 연다. */
    | {kind: "link-consent"}
    /** 다른 사이트의 소스다 — **열지 않는다.** */
    | {kind: "refuse"; bound: string}
    /**
     * 설정을 **못 읽어** 소속을 모른다 — 아무것도 안 적고 **열기만** 한다.
     *
     * ⚠ **`link-consent` 로 접으면 안 된다.** 그러면 「처음 연결합니다」라고 말한 뒤 표식을 쓰는데,
     *   그 폴더에 이미 다른 소속이 적혀 있을 수 있다 — 표식이 링크를 이기므로 **두 판독이 갈린
     *   채** 열린다(우리는 x, VS Code 는 y). 재연결 동의 없이 소속이 바뀐 셈이다.
     *
     * ⚠ **`refuse` 로 접어서도 안 된다.** 「못 읽었다」의 가장 흔한 사유는 주석이 든
     *   `settings.json`(JSONC — VS Code 가 정상으로 취급하는 형식)이고, 그 파일에 우리 키가
     *   **없어도** 못 읽음이 된다. 막으면 정상 폴더를 대거 막는다 — 「모르는 것으로는 막지
     *   않는다」가 이 레포의 이행 원칙이다.
     *
     * ⚠ **「VS Code 가 대신 읽어 준다」는 그 파일에 키가 «적혀 있을 때만» 참이다**(심의 지적 — 종전
     *   문장은 이 조건 없이 단정했다). 적혀 있으면 도착한 창의 소속·유효 사이트가 그 값으로 서서
     *   화면이 정직하다. **안 적혀 있으면** 그 창의 사이트는 전역 잔값이 된다 — 폴더 없는 창에서
     *   온 길이면 방금 고른 값이라 맞지만, 소속이 다른 폴더에서 온 길(`elsewhere`)이면 그 창은
     *   아무것도 안 적은 채라 **묵은 값**이 선다. 그 형상을 받는 것은 상태바의
     *   `$(zap) {그 값} · 처음 올릴 때 정해짐` 과 사이드바의 「처음 올리실 때 사이트가 정해집니다」,
     *   그리고 마지막 방어선인 발행 확인이다 — ⚠ **묵은 값이 «사이트 이름으로» 그대로 보인다**는
     *   뜻이고, 경고색도 아니다. 이 판정이 그것까지 담보하지는 않는다.
     *
     * ⚠ **근본은 우리 판독기가 JSONC 를 못 읽는 것**이다. 그것을 고치면 `unreadable` 이 진짜 손상
     *   파일로 좁혀져 이 칸이 사라진다 — 의존을 늘리는 일이라 `doc/DEFERRED.md` 에 두었다.
     */
    | {kind: "open-unlinked"};

/**
 * ⚠ **이 동사는 재연결이 아니다.** `link-consent` 는 소속이 **없는** 폴더에 소속을 처음 주는 것이고,
 *   소속이 있는 폴더는 [PickedFolderPlan] `refuse` 로 거절한다. 소속을 **바꾸는** 것은 「사이트에
 *   연결」 하나로 남는다 — 가장 위험한 동사를 가장 흔한 흐름의 한 클릭 거리에 두지 않는다.
 *
 * ⚠ **판독은 한 벌이고 3상이다 — 형제 [decideImportBinding] 과 같은 순서로 본다.** 표식이 먼저,
 *   그다음 「못 읽음」, 그다음 링크 값. 「못 읽음」을 `null` 로 좁혀 받던 종전 계약에서는 그 칸이
 *   `link-consent` 로 떨어졌다(보안 심의).
 */
export function decidePickedFolder(
    mark: SourceMark | null,
    link: WorkspaceLink,
    chosen: string,
): PickedFolderPlan {
    if (mark !== null) return mark.tenant === chosen ? {kind: "open"} : {kind: "refuse", bound: mark.tenant};
    if (link.kind === "unreadable") return {kind: "open-unlinked"};
    if (link.kind === "tenant" && link.tenant !== "") {
        return link.tenant === chosen ? {kind: "open"} : {kind: "refuse", bound: link.tenant};
    }
    return {kind: "link-consent"};
}

/** 「작업 폴더 변경」이 무엇을 보여 줄 것인가. */
export type ChangeFolderPlan =
    /** 확증된 로컬본이 있고 지금 폴더가 아니다 — 그것부터 내고, 직접 고르는 길을 함께 둔다. */
    | {kind: "offer"; dir: string}
    /** 낼 것이 없다 — 고르는 화면을 건너뛰고 곧장 폴더 대화상자로 간다(한 단계 덜). */
    | {kind: "pick"};

/**
 * ⚠ **이 문은 아무것도 적지 않는다.** 창만 옮긴다 — 소속을 **바꾸는** 동사는 「사이트에 연결」
 *   하나로 남는다([decidePickedFolder] 가 세운 규율). 고른 폴더가 남의 사이트 것이어도 막지
 *   않는다: 도착한 창의 어긋남 표면(상태바 경고·「이 폴더의 사이트로 돌아가기」)이 받고,
 *   최종 방어선은 발행 확인이다. 여기에 사전 게이트를 달면 「모르는 것으로는 막지 않는다」와
 *   어긋나고, 달 필요도 없다.
 *
 * @param confirmedDir 확증까지 통과한 그 사이트의 로컬본(`confirmedFolderFor`). 없으면 `null`.
 */
export function changeFolderPlan(input: {openDir: string | null; confirmedDir: string | null}): ChangeFolderPlan {
    // 지금 열려 있는 그 폴더를 다시 제안하지 않는다 — 눌러도 아무 일이 없는 죽은 항목이 된다.
    if (input.confirmedDir !== null && input.confirmedDir !== input.openDir) {
        return {kind: "offer", dir: input.confirmedDir};
    }
    return {kind: "pick"};
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

/**
 * **화면에 보인 폴더가 아직 그 폴더인가.** 아니면 열지 않는다.
 *
 * 목록·모달을 만들 때 확증한 폴더([shown])와, **누른 시점에** 다시 확증한 폴더([current])를 견준다.
 * 그 사이 다른 창이 같은 사이트의 링크를 바꿨을 수 있고, 그때 여는 것이 이 축이 막는 사고다 —
 * 이 축의 주제가 「보이는 것과 실제가 갈리지 않게」다.
 *
 * ⚠ **`null` 만 보면 안 된다.** 폴더가 **사라진 것**과 **다른 폴더가 된 것**은 다르고, 뒤엣것을
 *   안 보면 `detail` 에 적힌 경로와 다른 폴더가 말없이 열린다.
 *
 * ⚠ **이 술어가 여기 있는 이유**: 종전에는 같은 판정이 확장 쪽 **두 자리에 손으로** 적혀 있었고,
 *   심의 권고가 그중 한쪽에만 반영돼 나머지 한 자리가 `null` 만 보는 채로 세 판이 배송됐다.
 *   한 벌로 두면 한쪽만 고쳐질 수 없다.
 */
// 타입 가드로 둔다 — 호출부가 통과 뒤 `current` 를 non-null 로 쓴다(좁힘을 손으로 다시 하지 않게).
export function folderStillShown(current: string | null, shown: string): current is string {
    return current !== null && current === shown;
}
