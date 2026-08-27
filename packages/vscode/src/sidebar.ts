import * as vscode from "vscode";
import { sidebarPlan, type SidebarState } from "@zalkera/devtools-core";

/**
 * 사이드바 뷰 하나(T5 · §5 「UI 표면 — 넷뿐」).
 *
 * **트리 하나로 끝낸다.** 웹뷰를 쓰지 않는 이유는 미리보기와 같다: 우리가 화면을 그리기 시작하면 그 화면이
 * 곧 제품이 되고, 확장이 두꺼워져 CLI·데스크톱이 같은 것을 재사용하지 못한다(§W-5). 여기 있는 것은
 * **상태 표시와 명령 바로가기**뿐이고, 로직은 한 줄도 없다.
 *
 * ■ 왜 계층인가 (오너 요청 2026-08-10)
 *   평평한 열 줄은 **어디까지가 한 묶음인지 보이지 않는다.** 「소스 다운로드」와 「zip 으로 교체」는
 *   이름이 비슷한데 하나는 새 폴더로 가고 하나는 지금 폴더를 지운다 — 나열만 하면 그 차이가
 *   글자 몇 개에 걸린다. 묶음이 «무엇을 만지는가»로 갈라 그 사실을 먼저 말한다.
 *
 *   가짜 소제목(누를 수 없는 항목) 대신 **진짜 트리 계층**을 쓴다 — VS Code 가 접힘 상태를 기억하므로
 *   안 쓰는 묶음은 사용자가 접어 둘 수 있다. 소제목은 그게 안 된다.
 *
 * ■ 순서는 작업 흐름이다
 *   사이트(어디서) → 소스(가져오기) → 만들기(고치고 보기) → 내보내기(살펴보고 올리기) → 버전 → 도움.
 *   ⚠ 종전에는 **「배포 전 검사」가 「발행」 아래**에 있었다 — 이름이 약속한 순서와 화면이 어긋났다.
 */
export type { SidebarState };

export class ZalkeraSidebar implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    private state: SidebarState = {
        signedIn: false,
        tenant: "",
        site: null,
        previewUrl: null,
        keyExpiresAt: null,
        folderTenant: null,
        folderPath: null,
        // 아직 목록을 본 적이 없다 — **모름**이다(「하나뿐」이 아니다).
        canSwitch: null,
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

        // **무엇이 보일지는 `sidebarPlan`(core)이 정한다.** 여기서는 그리기만 한다 — 판정이 이
        // 파일에 있을 때 「사이트가 붙으면 받기 진입점이 사라진다」가 아무 시험에도 안 걸렸다.
        return sidebarPlan(this.state).flatMap((g) => {
            // `?? ""` 폴백을 두지 않는다 — 명령 없는 항목이 조용히 안 눌리게 되는 자리다.
            // 타입(판별 유니온)이 그것을 막는다.
            const items = g.items.map((i) =>
                i.kind === "info" ? info(i.label, i.icon) : action(i.label, i.command, i.icon, i.tooltip),
            );
            // 로그인 전 묶음은 라벨이 없다 — 두 줄에 그룹을 씌우면 형식만 남는다.
            return g.label === "" ? items : [group(g.id, g.label, g.icon, g.tooltip, items, g.description)];
        });
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
    id: string,
    label: string,
    icon: string,
    tooltip: string | undefined,
    children: Node[],
    description?: string,
): Node {
    const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    // **안정적인 id 가 있어야 접힘이 유지된다.** 없으면 VS Code 가 라벨로 추정하는데, 새로고침마다
    // 새 객체를 만드는 이 구조에서는 사용자가 접어 둔 것이 상태 변화(미리보기 시작 등)마다 도로 펼쳐진다.
    //
    // ⚠ **id 를 라벨에서 만들지 않는다.** 그러면 문면을 다듬을 때마다 사람이 접어 둔 것이
    //   초기화된다 — 라벨은 다듬으라고 있는 것이고, id 는 그 다듬음을 견디라고 있는 것이다.
    item.id = `zalkera.group.${id}`;
    item.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) item.tooltip = tooltip;
    // 흐린 글씨로 라벨 옆에 붙는다. **접어도 보이는 자리**라 "지금 어느 사이트인가"를 여기 둔다 —
    // 자식으로만 두면 접는 순간 사라져, 계층을 만든 대가로 정보를 잃는다.
    if (description) item.description = description;
    item.children = children;
    return item;
}
