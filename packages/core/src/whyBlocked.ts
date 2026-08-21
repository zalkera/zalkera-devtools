/**
 * **왜 지금 이걸 못 하는가 — 사람에게 할 말.**
 *
 * ■ 왜 생겼나
 *   사이드바는 여섯 묶음을 **항상** 보여 준다(오너 확정). 종전에는 못 하는 것을 숨겼는데,
 *   실사용에서 그 대가가 더 컸다 — 확장을 새로 깔았는데 메뉴가 셋뿐이니 **「갱신이 안 됐다」로
 *   읽혔다.** 사람은 없는 것을 「아직 조건이 안 됐다」로 읽지 않는다.
 *
 *   그래서 있다는 것은 늘 보이고, **못 하는 이유는 누를 때 말한다.** 그 말을 여기서 만든다.
 *
 * ■ 왜 core 인가
 *   확장 안에 두면 시험도 검사기도 못 닿는다 — 이 레포가 반복해서 겪은 형상이다
 *   (`reentrancy.ts`·`errorNotice.ts`·`sidebarPlan.ts` 가 같은 이유로 내려왔다).
 *
 * ■ **다음에 할 일을 반드시 말한다**
 *   「소스가 없습니다」로 끝내면 사람은 그다음을 모른다. 막힌 문면은 **어디를 누르면 되는지**를
 *   같이 말한다 — 그 자리가 사이드바에 보이고 있으므로 가리킬 수 있다.
 */

/** 명령이 돌기 전에 갖춰져 있어야 하는 것. */
export interface Readiness {
    /** 로그인했는가. */
    signedIn: boolean;
    /** 작업할 사이트를 골랐는가. */
    tenant: string;
    /** 이 창에 사이트 소스 폴더가 열려 있는가. */
    site: string | null;
}

export interface Blocked {
    /** 사람에게 보여 줄 한 줄. */
    message: string;
    /** 누르면 그 자리로 데려다 주는 명령. 없으면 단추를 안 만든다. */
    action?: {label: string; command: string};
}

/**
 * 명령마다 무엇이 필요한지. **여기 없는 명령은 언제나 눌린다** — 요건이 없다는 뜻이다.
 *
 * ⚠ 순서가 뜻을 가진다. 로그인이 없으면 사이트 선택도 못 하므로 로그인을 먼저 말한다.
 *   두 개를 한 번에 말하면 사람은 무엇부터 할지 모른다.
 *
 * ⚠ **「미리보기 중지」는 요건이 없다.** 도는 것을 멈추는 명령은 **탈출구**다. 요건을 걸면,
 *   미리보기가 도는 중에 폴더가 닫히거나 사이트 선택이 풀렸을 때 **중지 단추가 무동작**이 되어
 *   dev 서버(발급된 자격증명을 들고 있다)를 화면에서 끌 수 없다(심의 권고).
 */
const NEEDS: Readonly<Record<string, ReadonlyArray<"signedIn" | "tenant" | "site">>> = {
    "zalkera.preview.start": ["signedIn", "tenant", "site"],
    "zalkera.preview.restart": ["signedIn", "tenant", "site"],
    "zalkera.agent.connect": ["signedIn", "tenant", "site"],
    "zalkera.precheck": ["signedIn", "tenant", "site"],
    "zalkera.publish": ["signedIn", "tenant", "site"],
    "zalkera.history": ["signedIn", "tenant"],
    "zalkera.version.switch": ["signedIn", "tenant"],
    "zalkera.site.open": ["signedIn", "tenant"],
    "zalkera.site.create": ["signedIn", "tenant"],
    "zalkera.site.link": ["signedIn", "tenant", "site"],
};

/**
 * 이 명령이 지금 막혔는가. 막혔으면 **왜인지와 다음에 할 일**을, 아니면 `null`.
 *
 * @param command 명령 아이디(`zalkera.*`)
 */
export function whyBlocked(command: string, ready: Readiness): Blocked | null {
    for (const need of NEEDS[command] ?? []) {
        if (need === "signedIn" && !ready.signedIn) {
            return {
                message: "먼저 로그인해 주세요. 브라우저가 열립니다.",
                action: {label: "로그인", command: "zalkera.signIn"},
            };
        }
        if (need === "tenant" && ready.tenant === "") {
            return {
                message: "작업할 사이트를 먼저 골라 주세요.",
                action: {label: "사이트 선택", command: "zalkera.site.choose"},
            };
        }
        if (need === "site" && ready.site === null) {
            return {
                message:
                    "이 창에 사이트 소스가 없습니다. 「불러오기」에서 소스를 먼저 받아 주세요 — " +
                    "받은 폴더를 열면 여기 있는 것들이 전부 됩니다.",
                action: {label: "사이트 소스 받기", command: "zalkera.site.open"},
            };
        }
    }
    return null;
}

/**
 * 요건 목록이 사이드바가 보여 주는 명령을 **전부 덮는가.**
 *
 * 목록에 없는 명령은 언제나 눌리는데, 그것이 **의도**인지 **빠뜨린 것**인지 목록만 보면 모른다.
 * 시험이 이 함수로 그 차이를 못 박는다 — 새 명령이 사이드바에 붙으면 여기서 멈춘다.
 */
export function commandsWithNeeds(): string[] {
    return Object.keys(NEEDS).sort();
}
