import { existsSync } from "node:fs";
import { join } from "node:path";
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
    /**
     * 동봉한 npm 을 부르는 명령(§13 T-D2a). **이것이 없으면 폴백 자체가 안 선다** — VS Code 는 Node 는 싣고
     * npm 은 안 싣는데(위 실측), 코어의 기본값은 PATH 의 `npm` 이라 비개발자 기계에서 ENOENT 로 죽는다.
     * 그때 사용자가 보는 것은 "인터넷을 확인하세요"라는 **틀린 안내**였다.
     *
     * null 이면 동봉본을 찾지 못한 것이다 — 코어가 PATH 의 npm 으로 떨어진다(개발자 기계에서는 그것으로 선다).
     */
    npmCommand: string[] | null;
}

export function embeddedNodeRuntime(extensionPath: string): NodeRuntime {
    const env = {
        ELECTRON_RUN_AS_NODE: "1",
        // Electron 이 자식에게 물려주는 변수 중 Node 실행을 헷갈리게 하는 것들을 끊는다.
        ELECTRON_NO_ATTACH_CONSOLE: "1",
    };
    // npm 은 자바스크립트라 **동봉한 Node 로 직접 실행**한다(npm 실행 파일이 필요 없다 — 셸도 PATH 도 안 탄다).
    //
    // ⚠ 두 자리를 본다: VSIX 로 구우면 확장 폴더 안에 있지만, **개발 중에는 워크스페이스 루트로 호이스팅**돼
    // 확장 폴더에 없다(실측). 첫 자리만 보면 개발 기계에서 "동봉 npm 없음"으로 오진한다.
    const npmCli = [
        join(extensionPath, "node_modules", "npm", "bin", "npm-cli.js"),
        join(extensionPath, "..", "..", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((candidate) => existsSync(candidate));

    return {
        nodePath: execPath,
        env,
        npmCommand: npmCli ? [execPath, npmCli, "install"] : null,
    };
}
