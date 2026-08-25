/**
 * **왜 지금 이걸 못 하는가 — 사람에게 할 말.**
 *
 * ■ 왜 생겼나
 *   사이드바는 일곱 묶음을 **항상** 보여 준다(오너 확정). 종전에는 못 하는 것을 숨겼는데,
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
import {plainNotice} from "./notice.ts";

export interface Readiness {
    /** 로그인했는가. */
    signedIn: boolean;
    /** 작업할 사이트를 골랐는가. */
    tenant: string;
    /** 이 창에 사이트 소스 폴더가 열려 있는가. */
    site: string | null;
    /**
     * 열린 폴더가 **속한** 사이트. 모르면 `null`.
     *
     * ⚠ **`null` 은 「아무 사이트도 아니다」가 아니라 「모른다」다.** 모르는 폴더는 막지 않는다 —
     *   막으면 표식 없이 받아 둔 폴더를 쓰는 사람이 전부 멈춘다.
     */
    folderTenant: string | null;
}

export interface Blocked {
    /** 사람에게 보여 줄 한 줄. */
    message: string;
    /** 누르면 그 자리로 데려다 주는 명령. 없으면 단추를 안 만든다. */
    action?: {label: string; command: string};
    /** 둘째 버튼. 문면이 잘려도 버튼은 잘리지 않으므로, 다른 길은 문장이 아니라 여기로 나른다. */
    alternative?: {label: string; command: string};
}

/**
 * 폴더의 소속과 고른 사이트가 어긋났는가.
 *
 * 넷을 모두 만족할 때만 참이다 — 소속을 알고, 사이트를 골랐고, 이 창에 소스가 있고, 둘이 다르다.
 * 앞의 셋 중 하나라도 빠지면 **다른 요건이 말할 일**이지 이 자리가 막을 일이 아니다.
 */
function mismatched(ready: Readiness): boolean {
    return (
        ready.folderTenant !== null &&
        ready.tenant !== "" &&
        ready.site !== null &&
        ready.folderTenant !== ready.tenant
    );
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
type Need = "signedIn" | "tenant" | "site" | "siteMatches";

const NEEDS: Readonly<Record<string, ReadonlyArray<Need>>> = {
    "zalkera.preview.start": ["signedIn", "tenant", "site", "siteMatches"],
    "zalkera.preview.restart": ["signedIn", "tenant", "site", "siteMatches"],
    "zalkera.agent.connect": ["signedIn", "tenant", "site", "siteMatches"],
    "zalkera.precheck": ["signedIn", "tenant", "site", "siteMatches"],
    "zalkera.publish": ["signedIn", "tenant", "site", "siteMatches"],
    "zalkera.history": ["signedIn", "tenant"],
    "zalkera.version.switch": ["signedIn", "tenant"],
    "zalkera.site.open": ["signedIn", "tenant"],
    // ⚠ 파일로 받는 둘에는 `site` 를 달지 않는다. 이 둘은 **열린 폴더를 안 건드리고** 고르신
    //    자리에 파일 하나를 놓는다 — `site` 를 달면 「소스가 없어서 소스를 못 받는」 고리가 된다.
    "zalkera.site.downloadZip": ["signedIn", "tenant"],
    "zalkera.preset.download": ["signedIn", "tenant"],
    // ⚠ `tenant`·`siteMatches` 를 달지 않는다. 이 명령은 **새 빈 폴더로 가는 길**이고, 소속이
    //    어긋난 창에서 다음 거래처 zip 을 여는 것이 정상 사용이다. 달면 그 창이 갇힌다.
    "zalkera.site.importZip": ["signedIn"],
    // 갱신은 **있는 소스를 갈아 끼운다** — 어느 폴더인지, 어느 사이트 것인지가 정해져 있어야 한다.
    "zalkera.site.updateZip": ["signedIn", "tenant", "site", "siteMatches"],
    // 포장은 **이 폴더를 파일로 만드는 일**이다 — 로그인도 사이트도 필요 없고, 소속과도 무관하다.
    // 필요한 것은 「열린 폴더」뿐이고 그 판정은 `exportZipCommand` 자신이 한다.
    //
    // ⚠ **`site` 를 달면 고리가 생긴다.** 그 요건의 버튼은 `site.open` 인데, 사이트 미선택
    //    상태에서는 그것도 막힌다. `site` 를 다는 명령은 반드시 `tenant` 가 앞에 있어야 한다.
    "zalkera.export": [],
    // ⚠ 「사이트에 연결」과 「이 폴더의 사이트로 돌아가기」에는 `siteMatches` 를 달지 않는다 —
    //    둘이 곧 어긋난 상태의 정규 탈출구다. 달면 빠져나갈 수 없는 고리가 된다.
    // ⚠ **`tenant` 요건을 달지 마라.** 이 명령은 사이트를 **정하는** 자리이고, 목록을 스스로
    //    받아 온다(`listMyTenants`) — 고른 사이트를 쓰지 않는다. 달면 고리가 생긴다:
    //    로그아웃이 링크를 지우고 표식만 남긴 폴더에서 다른 계정이 사이트를 고르면 소속이
    //    달라 아무것도 안 적히고(§4.3 넷째 행), 그러면 `tenant` 가 영원히 비어 재연결이 막힌다.
    // `site`(= package.json 이 있는 소스 폴더)도 요건이 아니다. 이 명령이 필요로 하는 것은
    // 「열린 폴더」뿐이고 그 판정은 `linkFolder` 자신이 한다. `site` 를 달면 소스가 없는 창에서
    // 「소스를 먼저 받으세요 → 받기」로 보내는데, 그 받기가 다시 사이트 미선택으로 막힌다.
    "zalkera.site.link": ["signedIn"],
    // ⚠ **요건이 없다.** 이 문은 창을 옮길 뿐 아무것도 안 적는다 — 로그인도 사이트도 소스도
    //    필요 없다. 특히 **열린 폴더가 없는 창의 출구**가 이것이라, `site` 를 달면 「폴더가
    //    없어서 폴더를 못 바꾸는」 고리가 된다.
    "zalkera.folder.change": [],
    "zalkera.site.useFolder": [],
};

/**
 * 이 명령이 지금 막혔는가. 막혔으면 **왜인지와 다음에 할 일**을, 아니면 `null`.
 *
 * @param command 명령 아이디(`zalkera.*`)
 */
export function decideBlocked(command: string, ready: Readiness): Blocked | null {
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
        if (need === "siteMatches" && mismatched(ready)) {
            return {
                message:
                    `이 폴더는 「${plainNotice(ready.folderTenant ?? "", 64)}」 사이트의 소스입니다 — ` +
                    `「${plainNotice(ready.tenant, 64)}」 작업은 다른 폴더에서 해 주세요.`,
                action: {label: "이 폴더의 사이트로 돌아가기", command: "zalkera.site.useFolder"},
                // ⚠ 라벨에 「그 사이트」를 붙이지 않는다 — 바로 앞 문장이 이름으로 말했고,
                //    그것을 「그」로 되받으면 정관사를 옮긴 번역투가 된다.
                alternative: {label: "소스 다운로드", command: "zalkera.site.open"},
            };
        }
        if (need === "site" && ready.site === null) {
            return {
                message:
                    "이 창에 사이트 소스가 없습니다. 「내려받기」에서 소스를 먼저 받아 주세요 — " +
                    "받은 폴더를 열면 여기 있는 것들이 전부 됩니다.",
                action: {label: "소스 다운로드", command: "zalkera.site.open"},
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
