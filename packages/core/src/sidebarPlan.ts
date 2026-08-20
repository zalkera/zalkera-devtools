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

export interface SidebarState {
    signedIn: boolean;
    tenant: string;
    site: string | null;
    previewUrl: string | null;
    keyExpiresAt: string | null;
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
 * 순서(오너 확정): 사이트 · 미리보기 · 내보내기 · 불러오기 · 버전 · 도움.
 * 소스가 없으면 미리보기·내보내기·버전이 빠져 자연히 `사이트 · 불러오기 · 도움` 이 된다 —
 * 상태별로 순서를 따로 두지 않는다.
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

    const {tenant, site, previewUrl, keyExpiresAt} = state;
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
                act("로그아웃", "zalkera.signOut", "sign-out"),
            ],
        },
    ];

    if (site) {
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
            {id: "preview", label: "미리보기", icon: "tools", tooltip: "내 컴퓨터에서 확인하고, AI 를 붙입니다", items: making},
            {
                id: "export",
                label: "내보내기",
                icon: "package",
                tooltip: "살펴보고 올립니다",
                // 순서가 이름의 약속과 같아야 한다 — 검사가 먼저, 발행이 나중.
                items: [
                    act("배포 전 검사", "zalkera.precheck", "checklist", "조언입니다 — 발행을 막지 않습니다"),
                    // 이름이 하는 일과 같아야 한다 — 이 명령은 **올리기까지**다(전환은 따로).
                    act("새 버전 올리기", "zalkera.publish", "cloud-upload", "올리기만 합니다 — 사이트는 아직 안 바뀝니다"),
                ],
            },
        );
    }

    // ⚠ **소스가 있어도 보인다.** 종전에는 이 묶음이 `!site` 안에만 있어, 사이트가 붙는 순간
    //    화면에서 사라졌다. 받기는 **빈 새 폴더**로만 가므로 지금 것을 위험하게 하지 않는다.
    //
    //    소스가 있을 때 「예제로 시작」·「폴더 연결」까지 보이면 「누르면 내 것이 날아가나」를 매번
    //    다시 계산하게 된다. 그 둘은 팔레트에 남는다(도움말이 어디로 갔는지 적는다).
    groups.push(
        site
            ? {
                  id: "source",
                  label: "불러오기",
                  icon: "cloud-download",
                  tooltip: "받기는 새 빈 폴더로만 갑니다 — 지금 폴더는 바뀌지 않습니다",
                  items: [
                      act("사이트 소스 받기", "zalkera.site.open", "cloud-download", "지금 방문자가 보는 판을 새 빈 폴더로 받습니다"),
                  ],
              }
            : {
                  id: "source",
                  label: "불러오기",
                  icon: "cloud-download",
                  // 셋은 **택일**이다. 번호(①②③)를 붙이지 않는 이유가 그것이다 — 번호는 "1번 하고
                  // 2번 하라"로 읽혀 정반대 뜻이 된다.
                  tooltip: "셋 중 하나로 시작합니다",
                  items: [
                      act("예제로 시작", "zalkera.site.create", "add", "시작 소스를 받아 새로 시작합니다"),
                      act("사이트 소스 받기", "zalkera.site.open", "cloud-download", "지금 배포 중인 소스를 로컬로"),
                      act("폴더 연결", "zalkera.site.link", "link", "이미 가진 소스를 이 사이트에 붙입니다"),
                  ],
              },
    );

    if (site) {
        groups.push({
            id: "version",
            label: "버전",
            icon: "history",
            // 「되돌리기」가 아니라 「버전」이다 — 여기서 하는 일은 **어느 버전을 켤지 고르는 것**이고,
            // 뒤로 가는 것은 그 한 경우일 뿐이다(오너 확정).
            tooltip: "어느 버전을 켤지 정합니다",
            items: [
                act("버전 이력", "zalkera.history", "list-flat", "읽기 전용 — 아무것도 바뀌지 않습니다"),
                act("버전 전환", "zalkera.version.switch", "arrow-swap", "방문자가 보는 화면이 바뀝니다"),
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
