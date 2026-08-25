/**
 * **사이드바에 무엇이 어떤 순서로 보이는가.** `vscode` 를 모른다 — 그래야 시험이 문다.
 *
 * ■ 왜 core 로 내리나
 *   이 판정이 확장 안에 있을 때, 「사이트가 붙으면 받기 진입점이 사라진다」는 결함이 아무 시험에도
 *   안 걸렸다. 명령은 팔레트에 그대로 있었으므로 명령 검사기도 통과했다. 사람 눈에만 걸렸고,
 *   그것도 「불러오는 기능이 없다」는 오해로 한참 뒤에 걸렸다.
 *   `reentrancy.ts` 가 같은 이유로 내려온 자리다 — 확장 안 판정은 시험도 검사기도 못 닿는다.
 *
 * ■ 그리는 것은 여기 없다
 *   아이콘·툴팁은 서술만 하고, `TreeItem` 을 만드는 것은 `vscode/sidebar.ts` 다. 그림을 여기 두면
 *   `vscode` 의존이 딸려 와 시험이 다시 못 닿는다.
 */

import {displayPath} from "./displayPath.ts";

export interface SidebarState {
    signedIn: boolean;
    tenant: string;
    site: string | null;
    previewUrl: string | null;
    keyExpiresAt: string | null;
    /**
     * 열린 폴더가 속한 사이트. 모르면 `null`.
     *
     * ⚠ **모른다고 아무 말도 안 하지는 않는다.** 종전 주석이 그렇게 적혀 있었는데, 소속 없는
     *   폴더가 전역 잔값을 물려받아 **화면이 남의 사이트를 건강하게 단언하던** 것이 실사용
     *   신고로 왔다. 지금은 그 칸에서 **예고형 한 줄**을 낸다 — 막지도, 나무라지도 않고
     *   「처음 올리실 때 정해집니다」라는 사실만 말한다(배송 문서가 이미 그렇게 약속했다).
     */
    folderTenant: string | null;
    /**
     * 지금 작업 폴더의 경로. 열린 폴더가 없으면 `null`.
     *
     * ⚠ **이 값이 「이 폴더」의 지시대상이다.** 배송 문면 열두 자리가 「이 폴더」라고 말하는데
     *   화면 어디에도 그 폴더가 무엇인지 없었다 — 「사이트에 연결」 툴팁부터 발행 확인 모달까지.
     *   그리는 자리는 **묶음 머리**여야 한다(접어도 보인다).
     */
    folderPath: string | null;
}

/**
 * 항목. **판별 유니온이다** — `command` 를 선택 값으로 두면 렌더러가 `?? ""` 로 흘려보내고,
 * 그러면 「누를 수 없는 항목」이 타입으로도 시험으로도 안 걸린다. 「받기 진입점이 사라졌다」
 * 사건의 본질이 *누를 수 없다* 였는데, 목록에 있기만 하면 통과하는 판정은 그것을 못 잡는다.
 */
export type PlanItem =
    | {
          kind: "action";
          label: string;
          command: string;
          icon: string;
          tooltip?: string;
          /**
           * 라벨이 **지금 상태를 담는다**(사이트 이름·미리보기 주소). 팔레트 제목과 같을 수 없으므로
           * 라벨 일치 검사에서 뺀다 — 그 사실을 **판정이 말한다.** 종전에는 소스의 백틱 여부로
           * 짐작했는데, 그러면 표기를 바꾸는 순간 검사기가 조용히 눈이 먼다.
           */
          dynamic?: true;
      }
    | {kind: "info"; label: string; icon: string};

export interface PlanGroup {
    /** **라벨과 무관한 상수 id.** 문면을 다듬을 때마다 사람이 접어 둔 것이 초기화되면 안 된다. */
    id: string;
    label: string;
    icon: string;
    tooltip?: string;
    description?: string;
    items: PlanItem[];
}

const act = (label: string, command: string, icon: string, tooltip?: string): PlanItem => ({
    kind: "action",
    label,
    command,
    icon,
    tooltip,
});

/** 라벨이 상태를 담는 항목. 라벨 일치 검사에서 빠진다. */
const live = (label: string, command: string, icon: string, tooltip?: string): PlanItem => ({
    kind: "action",
    label,
    command,
    icon,
    tooltip,
    dynamic: true,
});

/**
 * 지금 상태에서 보일 묶음들. 순서가 그대로 화면 순서다.
 *
 * 순서(오너 확정): 사이트 · 미리보기 · 배포 · 내려받기 · 작업 폴더 · 버전 · 도움.
 *
 * ■ **묶음마다 만지는 것이 다르다**
 *   배포는 **서버**를, 내려받기는 **내 디스크**를, 작업 폴더는 **지금/새 폴더**를 만진다.
 *   이름을 방향이 아니라 대상으로 지은 이유다 — 「올리기」·「동기화」 같은 방향 낱말은
 *   두 묶음이 같이 쓰게 되고, 그러면 둘 중 하나는 반드시 잘못 눌린다.
 *
 * ■ **묶음은 항상 보인다**(오너 확정)
 *   종전에는 소스가 없으면 미리보기·내보내기·버전을 **숨겼다.** 「할 수 없는 일을 권하지
 *   않는다」는 뜻이었는데, 실사용에서 그 대가가 더 컸다 — 확장을 새로 깔았는데 메뉴가 셋뿐이니
 *   **「갱신이 안 됐다」로 읽혔다.** 사람은 없는 것을 「아직 조건이 안 됐다」로 읽지 않고
 *   「고장」이나 「이 도구엔 그 기능이 없다」로 읽는다.
 *
 *   그래서 **있다는 것은 늘 보이고**, 못 하는 이유는 **누를 때 말한다.** 그 문면은 확장이
 *   낸다(`whyBlocked`) — 여기는 무엇이 막혔는지만 표시한다.
 *
 * ■ 못 하는 항목을 `info` 로 바꾸지 않는다
 *   회색 글자로 두면 왜 안 되는지 물을 자리가 없어진다. **누를 수 있게 두고 눌렀을 때 말하는**
 *   편이 낫다 — 그 말이 곧 다음에 할 일이다.
 */
export function sidebarPlan(state: SidebarState): PlanGroup[] {
    if (!state.signedIn) {
        // 로그인 전에는 묶을 것이 없다 — 두 줄에 그룹을 씌우면 형식만 남는다.
        return [
            {
                id: "signin",
                label: "",
                icon: "",
                items: [
                    act("로그인", "zalkera.signIn", "sign-in", "브라우저로 잘커라에 로그인합니다"),
                    act("진단", "zalkera.doctor", "pulse", "무엇이 없어서 안 되는지 확인합니다"),
                ],
            },
        ];
    }

    const {tenant, site, previewUrl, keyExpiresAt, folderTenant, folderPath} = state;
    // 화면에 적을 경로. 홈은 확장이 알므로 여기서는 접지 않는다 — 판정에 `vscode` 를 끌어오지 않는다.
    // ⚠ **「없음」을 총체적으로 받는다.** 타입은 `string | null` 이지만 이 판정은 JS 에서도
    //    불린다(라벨 검사기가 상태를 손으로 짜서 넘긴다) — `undefined` 한 칸에 터지면 그 검사기가
    //    옛 코드를 검사하는 것보다 나쁘게, 아예 안 돈다. 실제로 그렇게 터졌다.
    const folderShown = folderPath ? displayPath(folderPath) : null;
    // 「소스 폴더인데 그 폴더가 어느 사이트 것인지 모른다」 — 발행 모달·상태바와 **같은 술어**다.
    const undeclared = site !== null && folderTenant === null && tenant !== "";
    // 어긋난 폴더는 **화면에서도** 어긋나 보여야 한다. 게이트가 누를 때 막는 것만으로는,
    // 누르기 전까지 이 창이 건강해 보인다.
    const mismatched = folderTenant !== null && tenant !== "" && site !== null && folderTenant !== tenant;
    const groups: PlanGroup[] = [
        {
            id: "site",
            label: "사이트",
            icon: "account",
            description: tenant,
            items: [
                tenant
                    ? live(tenant, "zalkera.site.choose", "circle-filled", "다른 사이트로 바꿉니다")
                    : act("사이트 선택", "zalkera.site.choose", "circle-outline", "작업할 사이트를 고릅니다"),
                // 경고로 그치면 다음 할 일이 화면에 없다 — 누르면 그 사이트로 돌아간다.
                ...(mismatched
                    ? [act("이 폴더의 사이트로 돌아가기", "zalkera.site.useFolder", "warning")]
                    : []),
                act("로그아웃", "zalkera.signOut", "sign-out"),
            ],
        },
    ];

    {
        const making: PlanItem[] = [
            previewUrl
                ? live(`미리보기 열기 — ${previewUrl}`, "zalkera.preview.start", "browser", "실행 중")
                : act("미리보기 시작", "zalkera.preview.start", "play", "로컬에서 확인합니다"),
        ];
        if (previewUrl) making.push(act("미리보기 중지", "zalkera.preview.stop", "debug-stop"));
        // **미리보기와 한 묶음이다.** 보는 것과 고치는 것이 같은 단계이므로 붙어 있어야 한다.
        // 종전에는 팔레트에만 있어 비개발자가 찾지 못했다 — "말로 고치기"의 입구인데.
        making.push(act("에이전트 연결(MCP)", "zalkera.agent.connect", "plug", "쓰시는 AI 가 이 사이트를 다루게 합니다"));
        if (keyExpiresAt) {
            making.push({kind: "info", label: `미리보기 자격증명 만료: ${keyExpiresAt}`, icon: "key"});
        }
        groups.push(
            {
                id: "preview",
                label: "미리보기",
                icon: "tools",
                tooltip: site
                    ? "내 컴퓨터에서 확인하고, AI 를 붙입니다"
                    : "소스를 먼저 받아야 씁니다 — 눌러 보시면 무엇이 필요한지 알려 드립니다",
                items: making,
            },
            {
                // id 는 라벨과 무관한 상수다 — 이름을 「배포」로 바꿔도 접어 둔 상태가 살아야 한다.
                id: "export",
                label: "배포",
                icon: "cloud-upload",
                tooltip: site
                    ? "살펴보고 올립니다"
                    : "소스를 먼저 받아야 씁니다 — 눌러 보시면 무엇이 필요한지 알려 드립니다",
                // 순서가 이름의 약속과 같아야 한다 — 검사가 먼저, 발행이 나중.
                items: [
                    act("배포 전 검사", "zalkera.precheck", "checklist", "조언입니다 — 발행을 막지 않습니다"),
                    // 「배포」는 **켜지는 것까지**로 읽히고, 실제로 그렇다 — 백엔드가 올린 판을
                    // 자동으로 켠다(STATIC 은 즉시, Next 소스는 빌드가 끝나는 순간).
                    act("새 버전 배포", "zalkera.publish", "cloud-upload", "올리면 방문자가 보는 사이트가 이 소스로 바뀝니다"),
                    // 넘기는 길. 손으로 압축하면 자격증명이 딸려 가므로 이 자리가 필요하다.
                    act("zip 으로 내보내기", "zalkera.export", "package", "미리보기 열쇠와 널리 쓰이는 자격증명 파일, 빌드 산출물을 빼고 담습니다"),
                ],
            },
        );
    }

    // ⚠ **소스가 있어도 보인다.** 종전에는 이 묶음이 `!site` 안에만 있어, 사이트가 붙는 순간
    //    화면에서 사라졌다.
    //
    //    ⚠ **상태에 따라 커졌다 작아졌다 하지 않는다.** 종전에는 사이트가 붙으면 이 자리가 넷에서
    //      둘로 줄었다. 사람은 줄어든 것을 「조건이 안 됐다」로 읽지 않고 「고장」으로 읽는다.
    //      지금은 셋이 늘 서고, 못 하는 이유는 **누를 때** 말한다(`whyBlocked`).
    groups.push({
        id: "download",
        label: "내려받기",
        icon: "cloud-download",
        // 셋 다 **지금 폴더를 안 건드린다.** 이 약속을 시험이 문다 — 여기에 항목을 더할 때는
        // 그것도 참이어야 한다.
        tooltip: "셋 다 지금 폴더를 안 건드립니다 — 파일로 받거나 새 빈 폴더로 갑니다",
        items: [
            act("소스 다운로드", "zalkera.site.open", "cloud-download", "지금 배포 중인 판을 새 빈 폴더에 풉니다"),
            // ⚠ 서버 정본은 tar.gz 인데 이 도구가 소스를 들여오는 문은 zip 만 받는다. 그래서
            //   받아서 **다시 포장해** 준다 — 안 그러면 「받았는데 못 넣는 파일」이 된다.
            act("소스 zip 다운로드", "zalkera.site.downloadZip", "archive", "지금 배포 중인 판을 zip 파일 하나로 받습니다"),
            act("예제 zip 다운로드", "zalkera.preset.download", "add", "시작 소스 팩을 zip 파일 하나로 받습니다"),
        ],
    });

    // ⚠ **「내려받기」와 갈라 둔다.** 저쪽은 디스크에 파일을 놓을 뿐이고, 여기 셋은 **폴더의 정체를
    //    바꾼다.** 한 묶음에 섞으면 「zip 으로 시작」과 「zip 으로 교체」가 나란히 서서, 두 글자
    //    차이로 하나는 안전하고 하나는 되돌릴 수 없게 된다.
    //
    //    ⚠ **사이트 유무로 숨기지 않는다.** 묶음이 상황에 따라 나타났다 사라지면 화면이 흔들리고,
    //      없는 것은 「갱신이 안 됐다」로 읽힌다(오너 확정).
    groups.push({
        id: "workdir",
        // ⚠ **경로는 묶음 머리에 둔다.** 항목으로만 두면 묶음을 접은 사람에게 지시대상이 다시
        //    없어진다 — 사이트 묶음이 같은 자리에 사이트 코드를 두는 것과 같은 이유다.
        //    긴 경로의 잘림은 `displayPath` 가 **머리를 접고 꼬리를 지켜** 처리한다.
        description: folderShown ?? "열린 폴더 없음",
        label: "작업 폴더",
        icon: "folder-opened",
        // 전체 경로는 여기 — 툴팁은 안 잘린다. 기존 약속 문장은 그대로 뒤에 둔다.
        tooltip:
            (folderPath ? `${folderPath}\n` : "") +
            "어느 폴더로 일할지 정합니다 — 「교체」만 지금 폴더를 지웁니다",
        items: [
            // ⚠ **맨 위다.** 묶음 툴팁 첫 구(「어느 폴더로 일할지 정합니다」)를 그대로 동사화한
            //    항목이고, 「시작」·「교체」 쌍을 갈라놓지 않는 유일한 삽입 자리다 — 그 둘은
            //    두 글자 차이라 나란히 보여야 한다.
            //
            // ⚠ **이 문은 아무것도 적지 않는다**(`changeFolderPlan`). 소속을 바꾸는 것은
            //    「사이트에 연결」 하나다 — 툴팁이 그 경계를 말한다.
            act("작업 폴더 변경", "zalkera.folder.change", "folder-opened", "이 창을 다른 폴더로 옮깁니다 — 연결은 「사이트에 연결」이 바꿉니다"),
            act("zip 으로 시작", "zalkera.site.importZip", "file-zip", "받으신 zip 을 새 빈 폴더에 풉니다"),
            // 「갱신」이 아니라 「교체」다 — 「갱신」은 덧쓰기·병합으로 읽혀 **되돌릴 수 없다는
            // 사실을 숨긴다.** 핵심 함수 이름도 `replaceContents` 다.
            act(
                "zip 으로 교체",
                "zalkera.site.updateZip",
                "replace-all",
                "지금 폴더를 지우고 받으신 zip 으로 바꿉니다. 지금 내용은 사라집니다",
            ),
            act("사이트에 연결", "zalkera.site.link", "link", "이 폴더가 어느 사이트 것인지 적어 둡니다"),
            // ⚠ **예고형이다.** 이 칸은 밀림 피해자만의 상태가 아니라 **정상 온보딩**의 상태이기도
            //    하다(예제 팩으로 막 시작한 폴더). 결핍형(「연결되지 않았습니다」)으로 쓰면 정상
            //    진행 중인 사람에게 「뭔가 빠졌다」로 읽힌다 — 배송 문서가 이미 「처음 올리실 때
            //    정해집니다」라고 약속해 둔 그 말을 그대로 쓴다.
            //
            // ⚠ **사이트 이름을 넣지 않는다.** 이름을 박은 고지는 발행 확인 모달의 일이고,
            //    여기 이름을 넣으면 그 값을 라이브로 읽고 싶어진다.
            ...(undeclared ? [{kind: "info" as const, label: "처음 올리실 때 사이트가 정해집니다", icon: "info"}] : []),
        ],
    });

    {
        groups.push({
            id: "version",
            label: "버전",
            icon: "history",
            // 「되돌리기」가 아니라 「버전」이다 — 여기서 하는 일은 **어느 버전을 켤지 고르는 것**이고,
            // 뒤로 가는 것은 그 한 경우일 뿐이다(오너 확정).
            tooltip: "어느 버전을 켤지 정합니다",
            items: [
                act("버전 이력", "zalkera.history", "list-flat", "읽기 전용 — 아무것도 바뀌지 않습니다"),
                act("버전 전환", "zalkera.version.switch", "arrow-swap", "방문자가 보는 화면이 바로 바뀝니다"),
            ],
        });
    }

    groups.push({
        id: "help",
        label: "도움",
        icon: "question",
        // 「도움」에 남는 것은 **막혔을 때 쓰는 것**뿐이다 — 왜 안 되는지 보는 것과, 안 되면 처음으로.
        items: [
            // 맨 위다 — 막힌 사람이 제일 먼저 볼 것은 "어떻게 쓰는가"이지 진단 결과가 아니다.
            act("도움말", "zalkera.help", "book", "쓰는 방법을 처음부터 봅니다"),
            act("진단", "zalkera.doctor", "pulse", "무엇이 없어서 안 되는지 확인합니다"),
            act("초기화", "zalkera.reset", "clear-all", "처음 상태로 되돌립니다(받은 소스는 남깁니다)"),
        ],
    });
    return groups;
}
