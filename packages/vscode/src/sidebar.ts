import * as vscode from "vscode";

/**
 * 사이드바 뷰 하나(T5 · §5 「UI 표면 — 넷뿐」).
 *
 * **트리 하나로 끝낸다.** 웹뷰를 쓰지 않는 이유는 프리뷰와 같다: 우리가 화면을 그리기 시작하면 그 화면이
 * 곧 제품이 되고, 확장이 두꺼워져 CLI·데스크톱이 같은 것을 재사용하지 못한다(§W-5). 여기 있는 것은
 * **상태 표시와 명령 바로가기**뿐이고, 로직은 한 줄도 없다.
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

    getChildren(): Node[] {
        const { signedIn, tenant, site, previewUrl, keyExpiresAt } = this.state;

        if (!signedIn) {
            return [
                action("로그인", "zalkera.signIn", "sign-in", "브라우저로 잘커라에 로그인합니다"),
                action("진단", "zalkera.doctor", "pulse", "무엇이 없어서 안 되는지 확인합니다"),
            ];
        }

        const nodes: Node[] = [
            // **누를 수 있어야 한다.** 종전에는 info() 라 클릭이 안 됐다 — "안 골랐다"고 알리면서
            // 고를 방법을 주지 않는 것은 막다른 길이다.
            tenant
                ? action(`사이트: ${tenant}`, "zalkera.site.choose", "account", "다른 사이트로 바꿉니다")
                : action("사이트 선택", "zalkera.site.choose", "account", "작업할 사이트를 고릅니다"),
        ];

        if (!site) {
            // 소스가 없는 사람에게 프리뷰·발행을 먼저 보여 주면 할 수 없는 일을 권하는 것이 된다.
            nodes.push(
                action("예제로 시작", "zalkera.site.create", "add", "시작 소스를 받아 새로 시작합니다"),
                action("사이트 소스 받기", "zalkera.site.open", "cloud-download", "지금 배포 중인 소스를 로컬로"),
                action("폴더 연결", "zalkera.site.link", "link", "이미 가진 소스를 이 사이트에 붙입니다"),
            );
        } else {
            nodes.push(
                previewUrl
                    ? action(`프리뷰 열기 — ${previewUrl}`, "zalkera.preview.start", "browser", "실행 중")
                    : action("프리뷰 시작", "zalkera.preview.start", "play", "로컬에서 확인합니다"),
            );
            if (previewUrl) nodes.push(action("프리뷰 중지", "zalkera.preview.stop", "debug-stop"));
            if (keyExpiresAt) {
                nodes.push(info(`프리뷰 자격증명 만료: ${new Date(keyExpiresAt).toLocaleString("ko-KR")}`, "key"));
            }
            nodes.push(
                action("발행", "zalkera.publish", "cloud-upload", "묶어서 올립니다"),
                action("버전 이력", "zalkera.history", "list-flat", "읽기 전용 — 아무것도 바뀌지 않습니다"),
                action("버전 되돌리기", "zalkera.rollback", "history", "버전 이력에서 고릅니다"),
                action("배포 전 검사", "zalkera.precheck", "checklist", "조언입니다 — 발행을 막지 않습니다"),
            );
        }

        nodes.push(
            action("진단", "zalkera.doctor", "pulse"),
            action("로그아웃", "zalkera.signOut", "sign-out"),
            action("초기화", "zalkera.reset", "clear-all", "처음 상태로 되돌립니다(받은 소스는 남깁니다)"),
        );
        return nodes;
    }
}

type Node = vscode.TreeItem;

function action(label: string, command: string, icon: string, tooltip?: string): Node {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { command, title: label };
    item.iconPath = new vscode.ThemeIcon(icon);
    if (tooltip) item.tooltip = tooltip;
    return item;
}

function info(label: string, icon: string): Node {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
}
