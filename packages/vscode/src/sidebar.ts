import * as vscode from "vscode";

/**
 * 사이드바 뷰 하나(T5 · §5 「UI 표면 — 넷뿐」).
 *
 * **트리 하나로 끝낸다.** 웹뷰를 쓰지 않는 이유는 프리뷰와 같다: 우리가 화면을 그리기 시작하면 그 화면이
 * 곧 제품이 되고, 확장이 두꺼워져 CLI·데스크톱이 같은 것을 재사용하지 못한다(§W-5). 여기 있는 것은
 * **상태 표시와 명령 바로가기**뿐이고, 로직은 한 줄도 없다.
 *
 * ■ 왜 계층인가 (오너 요청 2026-08-10)
 *   평평한 열 줄은 **어디까지가 한 묶음인지 보이지 않는다.** 특히 「예제로 시작·사이트 소스 받기·폴더
 *   연결」 셋은 단계가 아니라 **출처 세 갈래**(memo138 §3.1 *"어디서든 구한다"*)인데, 나열만 하면
 *   순서로 읽힌다. 그룹이 그 사실을 말한다.
 *
 *   가짜 소제목(누를 수 없는 항목) 대신 **진짜 트리 계층**을 쓴다 — VS Code 가 접힘 상태를 기억하므로
 *   안 쓰는 묶음은 사용자가 접어 둘 수 있다. 소제목은 그게 안 된다.
 *
 * ■ 순서는 작업 흐름이다
 *   사이트(어디서) → 소스(가져오기) → 만들기(고치고 보기) → 내보내기(살펴보고 올리기) → 되돌리기 → 도움.
 *   ⚠ 종전에는 **「배포 전 검사」가 「발행」 아래**에 있었다 — 이름이 약속한 순서와 화면이 어긋났다.
 */
export interface SidebarState {
    signedIn: boolean;
    tenant: string;
    site: string | null;
    previewUrl: string | null;
    keyExpiresAt: string | null;
}

export class ZalkeraSidebar implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private state: SidebarState = {
        signedIn: false,
        tenant: "",
        site: null,
        previewUrl: null,
        keyExpiresAt: null,
    };

    update(patch: Partial<SidebarState>): void {
        this.state = { ...this.state, ...patch };
        this.changed.fire(undefined);
    }

    getTreeItem(node: Node): vscode.TreeItem {
        return node;
    }

    getChildren(element?: Node): Node[] {
        // 그룹을 펼칠 때는 그 그룹이 들고 있던 자식을 그대로 돌려준다.
        if (element) return element.children ?? [];

        const { signedIn, tenant, site, previewUrl, keyExpiresAt } = this.state;

        if (!signedIn) {
            // 로그인 전에는 묶을 것이 없다 — 두 줄에 그룹을 씌우면 형식만 남는다.
            return [
                action("로그인", "zalkera.signIn", "sign-in", "브라우저로 잘커라에 로그인합니다"),
                action("진단", "zalkera.doctor", "pulse", "무엇이 없어서 안 되는지 확인합니다"),
            ];
        }

        const nodes: Node[] = [
            // 「사이트」는 **지금 누구로 어디에 붙어 있는가**다. 로그아웃이 여기 있는 이유가 그것이다 —
            // 「도움」에 두면 문제 해결 도구처럼 보이지만, 실제로는 이 붙어 있음을 **끊는** 일이다(오너 지적).
            //
            // 이름 줄은 **누를 수 있어야 한다.** 종전에는 info() 라 클릭이 안 됐다 — "안 골랐다"고
            // 알리면서 고를 방법을 주지 않는 것은 막다른 길이다.
            //
            // 라벨에 「사이트: 」를 다시 붙이지 않는다. 그룹 이름이 이미 그 말을 했고, 계층을 만든
            // 이유가 그 반복을 없애는 것이다.
            group("사이트", "account", undefined, [
                tenant
                    ? action(`${tenant}`, "zalkera.site.choose", "circle-filled", "다른 사이트로 바꿉니다")
                    : action("사이트 선택", "zalkera.site.choose", "circle-outline", "작업할 사이트를 고릅니다"),
                action("로그아웃", "zalkera.signOut", "sign-out"),
            ], tenant),
        ];

        if (!site) {
            // 소스가 없는 사람에게 프리뷰·발행을 먼저 보여 주면 할 수 없는 일을 권하는 것이 된다.
            //
            // 셋은 **택일**이다. 번호(①②③)를 붙이지 않는 이유가 그것이다 — 번호는 "1번 하고 2번 하라"로
            // 읽혀 정반대 뜻이 된다. 그룹 이름과 설명이 택일임을 말한다.
            nodes.push(
                group("소스", "repo", "셋 중 하나로 시작합니다", [
                    action("예제로 시작", "zalkera.site.create", "add", "시작 소스를 받아 새로 시작합니다"),
                    action("사이트 소스 받기", "zalkera.site.open", "cloud-download", "지금 배포 중인 소스를 로컬로"),
                    action("폴더 연결", "zalkera.site.link", "link", "이미 가진 소스를 이 사이트에 붙입니다"),
                ]),
            );
        } else {
            const making: Node[] = [
                previewUrl
                    ? action(`프리뷰 열기 — ${previewUrl}`, "zalkera.preview.start", "browser", "실행 중")
                    : action("프리뷰 시작", "zalkera.preview.start", "play", "로컬에서 확인합니다"),
            ];
            if (previewUrl) making.push(action("프리뷰 중지", "zalkera.preview.stop", "debug-stop"));
            // **프리뷰와 한 묶음이다.** 보는 것과 고치는 것이 같은 단계이므로 붙어 있어야 한다.
            // 종전에는 팔레트에만 있어 비개발자가 찾지 못했다 — "말로 고치기"의 입구인데.
            making.push(
                action("에이전트 연결(MCP)", "zalkera.agent.connect", "plug", "쓰시는 AI 가 이 사이트를 다루게 합니다"),
            );
            if (keyExpiresAt) {
                making.push(info(`프리뷰 자격증명 만료: ${new Date(keyExpiresAt).toLocaleString("ko-KR")}`, "key"));
            }

            nodes.push(
                group("만들기", "tools", "고치고 확인합니다", making),
                // 순서가 이름의 약속과 같아야 한다 — 검사가 먼저, 발행이 나중.
                group("내보내기", "package", "살펴보고 올립니다", [
                    action("배포 전 검사", "zalkera.precheck", "checklist", "조언입니다 — 발행을 막지 않습니다"),
                    // 이름이 하는 일과 같아야 한다 — 이 명령은 **올리기까지**다(전환은 따로).
                    action("새 버전 올리기", "zalkera.publish", "cloud-upload", "올리기만 합니다 — 사이트는 아직 안 바뀝니다"),
                ]),
                group("되돌리기", "history", "지난 버전으로 갑니다", [
                    action("버전 이력", "zalkera.history", "list-flat", "읽기 전용 — 아무것도 바뀌지 않습니다"),
                    action("버전 되돌리기", "zalkera.rollback", "discard", "버전 이력에서 고릅니다"),
                ]),
            );
        }

        nodes.push(
            // 「도움」에 남는 것은 **막혔을 때 쓰는 것**뿐이다 — 왜 안 되는지 보는 것과, 안 되면 처음으로.
            group("도움", "question", undefined, [
                // 맨 위다 — 막힌 사람이 제일 먼저 볼 것은 "어떻게 쓰는가"이지 진단 결과가 아니다.
                action("도움말", "zalkera.help", "book", "쓰는 방법을 처음부터 봅니다"),
                action("진단", "zalkera.doctor", "pulse", "무엇이 없어서 안 되는지 확인합니다"),
                action("초기화", "zalkera.reset", "clear-all", "처음 상태로 되돌립니다(받은 소스는 남깁니다)"),
            ]),
        );
        return nodes;
    }
}

/** 트리 항목. 그룹은 자식을 들고 다닌다 — 상태를 두 곳에 두지 않으려고 노드 자신이 갖는다. */
type Node = vscode.TreeItem & { children?: Node[] };

function action(label: string, command: string, icon: string, tooltip?: string): Node {
    const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) item.tooltip = tooltip;
    return item;
}

function info(label: string, icon: string): Node {
    const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
}

/**
 * 묶음. **기본은 펼침**이다 — 접혀 있으면 처음 쓰는 사람이 한 번 더 눌러야 명령을 본다.
 * 접는 것은 익숙해진 사람의 선택이고, VS Code 가 그 선택을 기억한다.
 */
function group(
    label: string,
    icon: string,
    tooltip: string | undefined,
    children: Node[],
    description?: string,
): Node {
    const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    // **안정적인 id 가 있어야 접힘이 유지된다.** 없으면 VS Code 가 라벨로 추정하는데, 새로고침마다
    // 새 객체를 만드는 이 구조에서는 사용자가 접어 둔 것이 상태 변화(프리뷰 시작 등)마다 도로 펼쳐진다.
    item.id = `zalkera.group.${label}`;
    item.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) item.tooltip = tooltip;
    // 흐린 글씨로 라벨 옆에 붙는다. **접어도 보이는 자리**라 "지금 어느 사이트인가"를 여기 둔다 —
    // 자식으로만 두면 접는 순간 사라져, 계층을 만든 대가로 정보를 잃는다.
    if (description) item.description = description;
    item.children = children;
    return item;
}
