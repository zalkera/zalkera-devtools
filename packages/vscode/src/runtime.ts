import { execPath } from "node:process";

/**
 * **런타임 배달**(memo146 §2.3-1 · §3.1) — 확장이 하는 네 가지 중 첫째.
 *
 * 비개발자에게 "Node 를 까세요"를 요구하면 거기서 끊긴다. VS Code 는 확장 호스트용 Node 를 자체 탑재하므로,
 * `ELECTRON_RUN_AS_NODE=1` 을 켜고 `process.execPath` 를 실행하면 **그 Node 가 그대로 Node 로 돈다**.
 *
 * 실측(T0-1): VS Code 동봉 Node v24 로 Next dev 완주(HTTP 200). 단 **npm 은 동봉되지 않는다** — 그래서
 * 개발 서버는 npm 스크립트가 아니라 next 바이너리를 직접 부른다(core `dev.ts`).
 *
 * ⚠ 미검증 잔여: T0 측정은 Remote-SSH 서버판 Node 였다. 데스크톱 VS Code 의 `ELECTRON_RUN_AS_NODE` 경로는
 * 아직 한 번도 재현하지 않았다 — T3 를 실제 데스크톱에서 처음 켜는 날 이 줄을 지운다.
 */
export interface NodeRuntime {
    nodePath: string;
    env: Record<string, string>;
}

export function embeddedNodeRuntime(): NodeRuntime {
    return {
        nodePath: execPath,
        env: {
            ELECTRON_RUN_AS_NODE: "1",
            // Electron 이 자식에게 물려주는 변수 중 Node 실행을 헷갈리게 하는 것들을 끊는다.
            ELECTRON_NO_ATTACH_CONSOLE: "1",
        },
    };
}
