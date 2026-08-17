import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, normalize, sep } from "node:path";

/** 순수 판정에 넘기는 경로 조작 한 벌. 코어는 `node:path` 를 안 가져간다. */
const PATH_OPS = {join, isAbsolute, normalize, sep};
import { execPath } from "node:process";
import {
    chooseNpm,
    describeNpm,
    npmArgvOf,
    acceptsResolvedNpmCli,
    systemNpmSearchSteps,
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
 * 재현: `env -i HOME=$HOME PATH=/usr/bin:/bin <VS Code 실행>` 뒤 프리뷰를 켠다.
 */
export interface NodeRuntime {
    nodePath: string;
    env: Record<string, string>;
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

    return {
        nodePath: execPath,
        env,
        npmCliPath: npmCli ?? null,
    };
}

/**
 * 이 컴퓨터에 깔린 npm 을 **경로로** 찾아 판본을 읽는다. 없거나 못 읽으면 `null` — **추측하지 않는다.**
 *
 * ■ 왜 `npm --version` 을 안 부르나
 *   이름으로 부르면 실행 파일 탐색이 OS 손에 넘어간다. Windows 의 `npm` 은 `npm.cmd` 배치라 shell 없이는
 *   안 돌고, shell 을 켜면 cmd.exe 가 **현재 폴더부터** 뒤진다 — 우리가 도는 곳은 **남이 준 zip 을 푼
 *   폴더**다. 그래서 `npm-cli.js` 를 찾아 **우리 Node 로** 부른다. 셸도, 배치도, 폴더 탐색도 없다.
 *
 * 3초를 넘기면 없는 것으로 본다 — 느린 네트워크 드라이브에서 멈추는 형상이 있다.
 */
export function systemNpm(excludeUnder: readonly string[] = []): { version: string; path: string } | null {
    const entries = (process.env.PATH ?? "").split(delimiter);
    for (const step of systemNpmSearchSteps(entries, PATH_OPS, excludeUnder)) {
        if (!existsSync(step.path)) continue;
        // `link` 는 따라가 봐야 안다 — 그리고 따라간 **결과**를 다시 검사한다.
        let cli = step.path;
        if (step.kind === "link") {
            try {
                cli = realpathSync(step.path);
            } catch {
                continue;
            }
            if (!acceptsResolvedNpmCli(cli, PATH_OPS, excludeUnder)) continue;
        }
        try {
            const out = execFileSync(execPath, [cli, "--version"], {
                encoding: "utf8",
                timeout: 3_000,
                stdio: ["ignore", "pipe", "ignore"],
                // VS Code 의 Node 는 이것 없이는 Electron 으로 뜬다.
                env: {...process.env, ELECTRON_RUN_AS_NODE: "1"},
            });
            const version = out.trim();
            if (version) return {version, path: cli};
        } catch {
            // 이 걸음은 못 쓴다 — 다음을 본다. **없는 것으로 단정하지 않는다.**
        }
    }
    return null;
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
    const system = preference === "bundled" && bundled ? null : systemNpm(excludeUnder);
    return chooseNpm(preference, {bundled, system});
}

/** 고른 npm 을 `ensureDependencies` 가 받는 형태로. `unavailable` 이면 `null`. */
export { describeNpm, npmArgvOf };
