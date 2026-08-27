import { existsSync } from "node:fs";
import { join } from "node:path";

/** 순수 판정에 넘기는 경로 조작 한 벌. 코어는 `node:path` 를 안 가져간다. */
import { execPath } from "node:process";
import {
    probeSystemNpm,
    chooseNpm,
    describeNpm,
    npmArgvOf,
    type NpmChoice,
    type NpmPreference,
} from "@zalkera/devtools-core";

/**
 * **런타임 배달**(memo146 §2.3-1 · §3.1) — 확장이 하는 네 가지 중 첫째.
 *
 * 비개발자에게 "Node 를 까세요"를 요구하면 거기서 끊긴다. VS Code 는 확장 호스트용 Node 를 자체 탑재하므로,
 * `ELECTRON_RUN_AS_NODE=1` 을 켜고 `process.execPath` 를 실행하면 **그 Node 가 그대로 Node 로 돈다**.
 *
 * 실측(T0-1): VS Code 동봉 Node v24 로 Next dev 완주(HTTP 200). 단 **npm 은 동봉되지 않는다** — 그래서
 * 개발 서버는 npm 스크립트가 아니라 next 바이너리를 직접 부른다(core `dev.ts`).
 *
 * ⚠ **미검증 잔여 — 배포 전 반드시 볼 것.** 지금까지 잰 것은 Remote-SSH 서버판 Node 다. 데스크톱
 * VS Code 의 `ELECTRON_RUN_AS_NODE` 경로는 한 번도 재현하지 않았다. **비개발자는 전부 데스크톱이고,
 * 이 설계가 존재하는 이유가 그 경로다.**
 *
 * ⚠ 그리고 **node·npm 이 깔린 기계에서 켜 보는 것으로는 확인이 덜 된다** — 설정이 `auto` 면 조건을
 * 만족하는 시스템 npm 이 골라지므로, 동봉 경로가 실제로 돌았는지는 구분되지 않는다. 확인하려면
 * **PATH 에서 node·npm 을 가린 채** 켜야 한다. 그것이 비개발자 기계의 실제 형상이다.
 *
 * 재현: `env -i HOME=$HOME PATH=/usr/bin:/bin <VS Code 실행>` 뒤 미리보기를 켠다.
 */
export interface NodeRuntime {
    nodePath: string;
    env: Record<string, string>;
    /**
     * 동봉한 CLI 번들 경로. 「소스 다루게 하기」가 `.mcp.json` 에 **이 절대경로**를 적는다.
     *
     * ⚠ **`npx` 로 부르지 않는 이유가 이 필드의 존재 이유다.** `.mcp.json` 은 사이트 소스 폴더에
     *   씌어지고 그 폴더가 MCP 클라이언트의 cwd 다 — `npm exec` 은 그 폴더의
     *   `node_modules/@zalkera/cli` 가 자기 `package.json.version` 으로 스펙을 만족한다고
     *   주장하면 그것을 쓴다. 판을 못박아도 안 막힌다(심의 실측).
     */
    cliPath: string | null;
    /**
     * 동봉한 npm 의 `npm-cli.js` **경로**. VS Code 는 Node 는 싣고 npm 은 안 싣는다(위 실측).
     *
     * ⚠ **실행 인자 모양으로 두지 않는다.** 종전에는 `[node, cli, "install"]` 을 냈는데, 그것은
     *   `ensureDependencies` 가 받는 모양과 같아서 미래의 호출부가 **그대로 넘길 수 있다** — 그러면
     *   `--ignore-scripts` 가 빠진 채 받은 폴더에서 설치가 돌아 그 폴더의 스크립트가 실행된다.
     *   인자를 만드는 곳은 `npmArgvOf` 하나다.
     *
     * `null` 이면 동봉본을 못 찾은 것이고, **그때 코어가 대신 찾아 주지 않는다** — `chooseNpm` 이
     * `unavailable` 을 내고 호출부가 말하고 멈춘다. 종전에는 여기서 코어의 기본값(PATH 의 `npm`)으로
     * 떨어졌고, 비개발자 기계에서 ENOENT 로 죽으며 "인터넷을 확인하세요"라는 **틀린 안내**가 나갔다.
     */
    npmCliPath: string | null;
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

    // 🔴 **CLI 는 동봉본을 절대경로로 부른다.** `npx` 로는 사이트 폴더의 `node_modules` 를 못
    //    이긴다 — `npm exec` 은 그 폴더의 패키지가 자기 `package.json.version` 으로 스펙을
    //    만족한다고 주장하면 그것을 쓰고, 그 버전 문자열은 공격자가 적는다(심의 실측).
    //
    // ⚠ npm 과 **같은 두 자리**를 본다: 구운 VSIX 안이거나, 개발 중 워크스페이스다.
    const cli = [
        join(extensionPath, "dist", "zalkera-cli.js"),
        join(extensionPath, "..", "cli", "dist", "main.js"),
    ].find((candidate) => existsSync(candidate));

    return {
        nodePath: execPath,
        env,
        npmCliPath: npmCli ?? null,
        cliPath: cli ?? null,
    };
}


/**
 * 설정과 실측을 합쳐 **어느 npm 으로 설치할지** 정한다. 판정은 `core` 의 순수 함수가 든다.
 *
 * ⚠ 여기서 폴백을 만들지 마라. 고른 쪽이 안 되면 `unavailable` 이 나오고 호출부가 **말하고 멈춘다** —
 *   조용한 폴백은 "어느 npm 이 돌았는지 모르는 채 결과만 남는" 상태를 만든다.
 */
export function resolveNpm(
    extensionPath: string,
    preference: NpmPreference,
    excludeUnder: readonly string[] = [],
): NpmChoice {
    const runtime = embeddedNodeRuntime(extensionPath);
    const bundled = runtime.npmCliPath;
    // ⚠ **동봉본으로 끝나는 경우에는 PATH 를 아예 안 만진다.** 종전에는 인자를 먼저 평가해,
    //   설정이 `bundled` 여도 PATH 에서 찾은 JS 를 우리 Node 로 **실행**했다. 고르지도 않을 것을
    //   실행하는 것이고, 더 나쁜 것은 "PATH 가 의심스러우면 bundled 로 두세요"가 거짓이 된다는 점이다.
    // ⚠ **`&& bundled` 를 빼는 것이 핵심이다.** 동봉본이 **없는** 설치에서는 이 조건이 거짓이 되어
    //   PATH 를 뒤지고 찾은 `npm-cli.js` 를 우리 Node 로 `--version` 실행했다(실증: 표식 파일 생성).
    //   그런데 `chooseNpm` 은 bundled 선호 + 동봉 부재면 `probe.system` 을 **보지도 않고** unavailable
    //   을 낸다 — 즉 순수 낭비이면서, 배송 문서의 「bundled 로 두시면 이 컴퓨터의 npm 은 찾지도
    //   실행하지도 않습니다」를 거짓으로 만든다.
    // ⚠ **껍데기도 코어 것을 쓴다** — 확장과 CLI 가 같은 npm 을 골라야 한다.
    //   VS Code 의 Node 는 `ELECTRON_RUN_AS_NODE` 없이는 Electron 으로 뜬다.
    const system =
        preference === "bundled"
            ? null
            : probeSystemNpm(execPath, excludeUnder, {...process.env, ELECTRON_RUN_AS_NODE: "1"});
    return chooseNpm(preference, {bundled, system});
}

/** 고른 npm 을 `ensureDependencies` 가 받는 형태로. `unavailable` 이면 `null`. */
export { describeNpm, npmArgvOf };
