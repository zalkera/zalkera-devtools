/**
 * **어느 npm 으로 설치할지 정하는 판정.** 순수 함수라 전수로 시험한다.
 *
 * ■ 왜 선택지가 있나
 *   VS Code 는 Node 는 싣고 **npm 은 안 싣는다.** 그래서 확장이 npm CLI 를 동봉하고 그것을 먼저
 *   쓴다 — 비개발자 기계에서 `ENOENT` 로 죽던 자리다. 그런데 그 선택이 **보이지도 않고 바꿀 수도
 *   없었다**: 사내 레지스트리·corepack·모노레포 툴링을 쓰는 개발자는 자기 npm 이 돌기를 바란다.
 *
 * ■ 왜 `auto` 가 "있으면 시스템"이 아닌가
 *   락파일 v3 를 읽어야 하므로 **npm 9 미만은 다른 트리를 만든다.** 조용히 그쪽으로 떨어지면 그
 *   결과가 우리 관문에 나타나고 원인은 안 보인다. `auto` 는 "있으면"이 아니라 **"맞으면"** 이다.
 *
 * ■ 폴백을 안 만든다
 *   고른 쪽이 안 되면 **말하고 멈춘다.** 조용한 폴백은 "어느 npm 이 돌았는지 모르는 채 결과만
 *   남는" 상태를 만들고, 실사용 신고가 왔을 때 물어볼 것이 없어진다.
 */
import {execFileSync} from "node:child_process";
import {existsSync, realpathSync} from "node:fs";
import {delimiter, isAbsolute, join, normalize, sep} from "node:path";


/** 사용자가 고를 수 있는 값. 설정 스키마와 같은 목록이다. */
export type NpmPreference = "bundled" | "system" | "auto";

/** 시스템 npm 이 만족해야 하는 최소 메이저 — 락파일 v3 를 읽는 첫 판. */
export const MIN_SYSTEM_NPM_MAJOR = 9;

export interface NpmProbe {
    /** 동봉 npm CLI 의 절대 경로. 못 찾았으면 `null`. */
    bundled: string | null;
    /** 이 컴퓨터에 깔린 npm 의 CLI 경로와 판. 못 찾았거나 못 읽었으면 `null`. */
    system: { version: string; path: string } | null;
}

export type NpmChoice =
    | { kind: "bundled"; path: string; why: string }
    | { kind: "system"; version: string; path: string; why: string }
    | { kind: "unavailable"; why: string; hint: string };

/** `"9.8.1"` → `9`. 형태가 아니면 `null` — 판정에 쓰므로 추측하지 않는다. */
export function majorOf(version: string | null): number | null {
    const m = /^(\d+)\./.exec((version ?? "").trim());
    return m ? Number(m[1]) : null;
}

export function chooseNpm(preference: NpmPreference, probe: NpmProbe): NpmChoice {
    const systemVersion = probe.system?.version ?? null;
    const systemMajor = majorOf(systemVersion);
    const systemOk = systemMajor !== null && systemMajor >= MIN_SYSTEM_NPM_MAJOR;

    if (preference === "bundled") {
        if (probe.bundled) return { kind: "bundled", path: probe.bundled, why: "설정이 동봉본을 지정했습니다." };
        return {
            kind: "unavailable",
            why: "동봉 npm 을 찾지 못했습니다.",
            hint: '설정 `zalkera.npm` 을 `"auto"` 로 두면 조건을 만족하는 시스템 npm 을 씁니다.',
        };
    }

    if (preference === "system") {
        if (probe.system === null) {
            return {
                kind: "unavailable",
                why: "설정이 시스템 npm 을 지정했는데 PATH 에서 찾지 못했습니다.",
                hint: 'npm 을 설치하거나 설정 `zalkera.npm` 을 `"bundled"` 로 되돌리십시오.',
            };
        }
        if (!systemOk) {
            return {
                kind: "unavailable",
                why: `시스템 npm 이 ${systemVersion} 입니다 — 락파일 v3 를 읽으려면 ${MIN_SYSTEM_NPM_MAJOR} 이상이어야 합니다.`,
                hint: 'npm 을 올리거나 설정 `zalkera.npm` 을 `"bundled"` 로 되돌리십시오.',
            };
        }
        return { kind: "system", version: probe.system.version, path: probe.system.path, why: "설정이 시스템 npm 을 지정했습니다." };
    }

    // auto — 조건을 만족하는 시스템 npm 이 있으면 그것, 아니면 동봉본.
    if (systemOk && probe.system) {
        return {
            kind: "system",
            version: probe.system.version,
            path: probe.system.path,
            why: `시스템 npm ${probe.system.version} 이 조건을 만족합니다.`,
        };
    }
    if (probe.bundled) {
        const because =
            systemVersion === null
                ? "PATH 에 npm 이 없어"
                : `시스템 npm 이 ${systemVersion} 라서(${MIN_SYSTEM_NPM_MAJOR} 미만)`;
        return { kind: "bundled", path: probe.bundled, why: `${because} 동봉본을 씁니다.` };
    }
    return {
        kind: "unavailable",
        why: "동봉 npm 도 없고 쓸 수 있는 시스템 npm 도 없습니다.",
        hint: `npm ${MIN_SYSTEM_NPM_MAJOR} 이상을 설치한 뒤 다시 시도하십시오.`,
    };
}

/**
 * 고른 결과를 **실행 인자**로. `unavailable` 은 `null` 이고, 그것은 "PATH 의 npm 으로 해 보라"가
 * 아니라 **"실행하지 마라"** 는 뜻이다 — 호출부가 `null` 을 기본값으로 갈아 끼우면 이 모듈의 판정이
 * 통째로 무의미해진다.
 *
 * `nodePath` 는 동봉 npm 을 부를 때만 쓴다(npm 은 JS 파일이라 Node 가 필요하다). VS Code 확장은
 * `process.execPath` 를 주며, 그때 `ELECTRON_RUN_AS_NODE=1` 환경이 함께 필요하다.
 */
export function npmArgvOf(choice: NpmChoice, nodePath: string): string[] | null {
    switch (choice.kind) {
        case "bundled":
        case "system":
            // **양쪽 다 우리 Node 로 `npm-cli.js` 를 부른다.** `["npm", "install"]` 처럼 이름만 넘기면
            //   실행 파일 탐색이 OS 손에 넘어간다 — Windows 에서는 `npm.cmd` 라 shell 없이는 안 돌고,
            //   shell 을 켜면 cmd.exe 가 **현재 폴더부터** 뒤진다. 우리는 남이 준 zip 을 푼 폴더에서
            //   돈다. 그래서 이름이 아니라 **경로**로 부른다.
            //
            // ⚠ **`--ignore-scripts`.** 이 설치는 **받은 폴더 안에서** 돈다. 그 폴더의 `package.json`
            //   라이프사이클 스크립트와 `.npmrc` 의 `node-options` 가 그대로 임의 코드가 된다(둘 다 실측,
            //   이 인자 하나로 둘 다 막히는 것도 실측). 어느 npm 을 부를지 이만큼 좁혀 놓고 그 npm 이
            //   폴더가 시키는 대로 돌면 좁힌 의미가 없다. 명령줄 인자는 `.npmrc` 를 이긴다.
            //   지금 시작 소스 락파일 113개 항목 중 설치 스크립트를 쓰는 것은 0개다(실측) — 대가가 없다.
            //   스크립트가 필요한 꾸러미를 고객이 더하면 [installScriptPackages] 가 알린다.
            return [nodePath, choice.path, "install", "--ignore-scripts"];
        case "unavailable":
            return null;
    }
}

/** 찾기 한 걸음. `cli` 는 그 자리가 곧 CLI 라는 뜻, `link` 는 **따라가 봐야** 안다는 뜻이다. */
export type NpmSearchStep = { kind: "cli" | "link"; path: string };

/** 경로 조작만 주입받는다 — 이 모듈은 파일시스템을 안 만진다. */
export interface PathOps {
    join(...parts: string[]): string;
    isAbsolute(path: string): boolean;
    normalize(path: string): string;
    sep: string;
}

/** 경로 조작 한 벌. 순수 판정에 주입해 플랫폼별 동작을 시험할 수 있게 한다. */
const PATH_OPS = { join, isAbsolute, normalize, sep };

/**
 * 이 컴퓨터에 깔린 npm 을 **경로로** 찾아 판본을 읽는다. 없거나 못 읽으면 `null` — **추측하지 않는다.**
 *
 * ■ 왜 `npm --version` 을 안 부르나
 *   이름으로 부르면 실행 파일 탐색이 OS 손에 넘어간다. Windows 의 `npm` 은 `npm.cmd` 배치라 shell
 *   없이는 안 돌고, shell 을 켜면 cmd.exe 가 **현재 폴더부터** 뒤진다 — 우리가 도는 곳은 **남이 준
 *   zip 을 푼 폴더**다. 그래서 `npm-cli.js` 를 찾아 **우리 Node 로** 부른다.
 *
 * ⚠ **탐색·수용 판정은 [systemNpmSearchSteps]·[acceptsResolvedNpmCli] 한 벌이다.** 이 함수는 그것을
 *   파일시스템에 대고 도는 껍데기다 — 껍데기를 문마다 따로 쓰면 한쪽만 조여진다(확장과 CLI 가
 *   같은 npm 을 골라야 한다).
 *
 * 3초를 넘기면 없는 것으로 본다 — 느린 네트워크 드라이브에서 멈추는 형상이 있다.
 *
 * @param nodePath 이 npm 을 부를 Node. 확장은 동봉 Node 를, CLI 는 자기 자신을 준다.
 * @param env `--version` 을 부를 때의 환경. VS Code 의 Node 는 `ELECTRON_RUN_AS_NODE=1` 이 필요하다.
 */
export function probeSystemNpm(
    nodePath: string,
    excludeUnder: readonly string[] = [],
    env: NodeJS.ProcessEnv = process.env,
): { version: string; path: string } | null {
    const entries = (env.PATH ?? "").split(delimiter);
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
            const out = execFileSync(nodePath, [cli, "--version"], {
                encoding: "utf8",
                timeout: 3_000,
                stdio: ["ignore", "pipe", "ignore"],
            });
            const version = out.trim();
            if (version) return { version, path: cli };
        } catch {
            // 이 걸음은 못 쓴다 — 다음을 본다. **없는 것으로 단정하지 않는다.**
        }
    }
    return null;
}

/**
 * PATH 에서 시스템 npm 을 찾을 **걸음**을 순서대로 낸다. 순수 함수라 시험한다.
 *
 * ■ 왜 실행 파일 이름이 아니라 경로인가
 *   `npm` 은 POSIX 에서 `npm-cli.js` 로 가는 심링크이고 Windows 에서는 `npm.cmd` 배치다. 배치를 돌리려면
 *   셸이 필요하고, 셸은 **현재 폴더를 먼저 뒤진다.** 우리가 도는 곳은 받은 zip 을 푼 폴더다.
 *
 * ■ **PATH 항목 밖으로 나가지 않는다**
 *   종전에는 `<항목>/../lib/node_modules/npm/bin/npm-cli.js` 를 후보로 냈다. **부모로 올라가는** 형태라,
 *   PATH 에 `<열어둔소스>/node_modules/.bin` 이 **들어 있다면** 후보가 `<열어둔소스>/node_modules/lib/…`
 *   이 되고 **그 자리는 zip 이 담을 수 있다.** 그 PATH 형상이 실제로 얼마나 흔한지는 재보지 않았다 —
 *   다만 항목 아래만 보는 것에 드는 비용이 없어서, 전제를 따지지 않고 닫는다.
 *   POSIX 배치는 `<항목>/npm` 을 따라가서 찾는다(따라간 결과는 호출부가 다시 검사한다).
 *
 * ■ **상대 경로 항목은 건너뛴다**
 *   PATH 의 빈 항목·`.` 은 **현재 폴더**를 뜻한다. 위에서 없앤 위험이 뒷문으로 돌아온다.
 *   ⚠ 입력만 거르면 부족하다 — 조립한 결과도 절대경로인지 다시 본다(종전에 `"C:\\nodejs"` 가
 *   POSIX 필터를 통과한 뒤 `join(…, "..")` 에서 상대 경로 후보가 됐다).
 *
 * `excludeUnder` 에는 **열어 둔 소스 폴더**가 온다. 그 아래 것은 무엇이든 보지 않는다.
 */
export function systemNpmSearchSteps(
    pathEntries: readonly string[],
    ops: PathOps,
    excludeUnder: readonly string[] = [],
): NpmSearchStep[] {
    const forbidden = excludeUnder.filter((d) => d && ops.isAbsolute(d)).map((d) => ops.normalize(d));
    const steps: NpmSearchStep[] = [];
    for (const raw of pathEntries) {
        const entry = raw.trim();
        if (entry === "" || !ops.isAbsolute(entry)) continue;
        if (isUnder(ops, ops.normalize(entry), forbidden)) continue;
        for (const path of [ops.join(entry, "node_modules", "npm", "bin", "npm-cli.js"), ops.join(entry, "npm")]) {
            if (!ops.isAbsolute(path)) continue; // 조립이 상대로 떨어지면 버린다
            steps.push({kind: path.endsWith(".js") ? "cli" : "link", path});
        }
    }
    return steps;
}

/**
 * 심링크를 따라간 **결과**가 쓸 만한가. 따라간 뒤에 다시 묻는 이유는, 링크가 어디로든 갈 수 있고
 * 그 링크 자체를 열어 둔 소스 폴더가 담을 수 있기 때문이다.
 */
export function acceptsResolvedNpmCli(
    resolved: string,
    ops: PathOps,
    excludeUnder: readonly string[] = [],
): boolean {
    if (!ops.isAbsolute(resolved) || !resolved.endsWith(".js")) return false;
    const forbidden = excludeUnder.filter((d) => d && ops.isAbsolute(d)).map((d) => ops.normalize(d));
    return !isUnder(ops, ops.normalize(resolved), forbidden);
}

function isUnder(ops: PathOps, path: string, roots: readonly string[]): boolean {
    return roots.some((root) => path === root || path.startsWith(root.endsWith(ops.sep) ? root : root + ops.sep));
}

/** 사람에게 보이는 한 줄. `doctor` 와 사이드바가 같은 문장을 쓴다. */
export function describeNpm(choice: NpmChoice): string {
    switch (choice.kind) {
        case "bundled":
            return `동봉 npm (${choice.path})`;
        case "system":
            return `시스템 npm ${choice.version} (${choice.path})`;
        case "unavailable":
            // ⚠ 사유를 여기 담지 않는다. 호출부가 `describeNpm(c) — c.why` 로 적으므로 **같은 문장이 두 번** 나온다.
            return "쓸 수 있는 npm 없음";
    }
}
