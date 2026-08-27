import {tempDir} from "./testing/tempDir.ts";
import {join} from "node:path";
import {chmod, mkdir, writeFile} from "node:fs/promises";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
    chooseNpm,
    describeNpm,
    majorOf,
    MIN_SYSTEM_NPM_MAJOR,
    npmArgvOf,
    acceptsResolvedNpmCli,
    systemNpmSearchSteps,
    probeSystemNpm,
    type NpmProbe,
} from "./npmChoice.ts";

const BUNDLED = "/ext/node_modules/npm/bin/npm-cli.js";
const SYS = "/usr/lib/node_modules/npm/bin/npm-cli.js";
const probe = (bundled: string | null, systemVersion: string | null): NpmProbe => ({
    bundled,
    system: systemVersion === null ? null : { version: systemVersion, path: SYS },
});

test("majorOf — 형태가 아니면 추측하지 않는다", () => {
    strictEqual(majorOf("9.8.1"), 9);
    strictEqual(majorOf("10.2.0"), 10);
    for (const v of [null, "", "  ", "v9.8.1", "nine", "9", "npm 9.8.1"]) strictEqual(majorOf(v), null, JSON.stringify(v));
});

test("bundled — 동봉본이 있으면 그것, 없으면 **말하고 멈춘다**", () => {
    strictEqual(chooseNpm("bundled", probe(BUNDLED, "10.0.0")).kind, "bundled");
    const none = chooseNpm("bundled", probe(null, "10.0.0"));
    strictEqual(none.kind, "unavailable", "동봉본이 없는데 시스템으로 조용히 떨어졌다");
});

test("system — 지정했으면 시스템만 본다(동봉본으로 조용히 안 떨어진다)", () => {
    strictEqual(chooseNpm("system", probe(BUNDLED, "10.0.0")).kind, "system");
    strictEqual(chooseNpm("system", probe(BUNDLED, null)).kind, "unavailable");
    strictEqual(chooseNpm("system", probe(BUNDLED, "8.19.4")).kind, "unavailable");
});

test("auto 는 '있으면'이 아니라 **'맞으면'** 이다 — 락파일 v3 를 읽어야 한다", () => {
    strictEqual(chooseNpm("auto", probe(BUNDLED, "10.0.0")).kind, "system");
    strictEqual(chooseNpm("auto", probe(BUNDLED, `${MIN_SYSTEM_NPM_MAJOR}.0.0`)).kind, "system");
    // 오래된 npm 은 조용히 다른 트리를 만든다 — 동봉본으로 간다
    strictEqual(chooseNpm("auto", probe(BUNDLED, "8.19.4")).kind, "bundled");
    strictEqual(chooseNpm("auto", probe(BUNDLED, null)).kind, "bundled");
    strictEqual(chooseNpm("auto", probe(null, "8.19.4")).kind, "unavailable");
});

test("고른 이유를 항상 말한다 — 어느 npm 이 돌았는지 물어볼 수 있어야 한다", () => {
    for (const pref of ["bundled", "system", "auto"] as const) {
        for (const p of [probe(BUNDLED, "10.0.0"), probe(BUNDLED, "8.0.0"), probe(null, null), probe(BUNDLED, null)]) {
            const c = chooseNpm(pref, p);
            strictEqual(typeof c.why, "string");
            strictEqual(c.why.length > 0, true, `${pref} ${JSON.stringify(p)} 가 사유 없이 판정했다`);
        }
    }
});

test("못 쓰는 경우엔 **다음에 할 일**을 준다", () => {
    for (const c of [chooseNpm("bundled", probe(null, null)), chooseNpm("system", probe(BUNDLED, "8.0.0")), chooseNpm("auto", probe(null, null))]) {
        strictEqual(c.kind, "unavailable");
        strictEqual((c as {hint: string}).hint.length > 0, true);
    }
});

test("describeNpm — 경로까지 말한다(신고를 받으려면 그것이 필요하다)", () => {
    const d = describeNpm(chooseNpm("bundled", probe(BUNDLED, null)));
    strictEqual(d.includes(BUNDLED), true, `경로가 빠졌다: ${d}`);
    strictEqual(describeNpm(chooseNpm("system", probe(null, "10.2.0"))).includes("10.2.0"), true);
});

test("통제군 — 경계 버전이 정확히 갈린다", () => {
    const below = `${MIN_SYSTEM_NPM_MAJOR - 1}.99.99`;
    strictEqual(chooseNpm("auto", probe(BUNDLED, below)).kind, "bundled");
    strictEqual(chooseNpm("auto", probe(BUNDLED, `${MIN_SYSTEM_NPM_MAJOR}.0.0`)).kind, "system");
});

test("판정 결과는 셋 중 하나뿐이다 — 조용한 넷째 상태가 없다", () => {
    const kinds = new Set<string>();
    for (const pref of ["bundled", "system", "auto"] as const)
        for (const b of [BUNDLED, null])
            for (const v of ["10.0.0", "8.0.0", null]) kinds.add(chooseNpm(pref, probe(b, v)).kind);
    deepStrictEqual([...kinds].sort(), ["bundled", "system", "unavailable"]);
});

test("npmArgvOf — 동봉본은 Node 로 부른다", () => {
    const argv = npmArgvOf({ kind: "bundled", path: "/x/npm/bin/npm-cli.js", why: "" }, "/node");
    deepStrictEqual(argv, ["/node", "/x/npm/bin/npm-cli.js", "install", "--ignore-scripts"]);
});

test("npmArgvOf — 시스템 npm 도 우리 Node 로 경로를 직접 부른다", () => {
    deepStrictEqual(npmArgvOf({ kind: "system", version: "10.9.8", path: SYS, why: "" }, "/node"), ["/node", SYS, "install", "--ignore-scripts"]);
});

test("npmArgvOf — 쓸 수 없으면 null 이고, 그것은 폴백이 아니다", () => {
    // ⚠ 이 시험이 무는 것: 누군가 `?? ["npm","install"]` 을 되살리면 판정이 통째로 무의미해진다.
    const argv = npmArgvOf({ kind: "unavailable", why: "없음", hint: "설치" }, "/node");
    strictEqual(argv, null);
});

test("npmArgvOf — 어떤 선택이든 설치 스크립트를 안 돌린다", () => {
    // ⚠ 이 설치는 **받은 폴더 안에서** 돈다. 그 폴더의 `package.json` 라이프사이클과 `.npmrc` 의
    //   `node-options` 가 그대로 임의 코드가 된다 — 이 인자 하나로 둘 다 막힌다(실측).
    for (const choice of [
        { kind: "bundled", path: "/p", why: "" },
        { kind: "system", version: "10.0.0", path: SYS, why: "" },
    ] as const) {
        const argv = npmArgvOf(choice, "/node");
        ok(argv, choice.kind);
        ok(argv.includes("install"), choice.kind);
        ok(argv.includes("--ignore-scripts"), `${choice.kind}: ${argv.join(" ")}`);
        ok(!argv.some((a) => a === "--foreground-scripts" || a === "--ignore-scripts=false"), argv.join(" "));
    }
});

test("describeNpm 은 사유를 담지 않는다 — 호출부가 붙이므로 두 번 나온다", () => {
    const c = chooseNpm("bundled", { bundled: null, system: null });
    const line = describeNpm(c);
    ok(c.kind === "unavailable");
    ok(!line.includes(c.why), `사유가 겹쳐 들어 있다: "${line}" ⊃ "${c.why}"`);
    // 호출부가 쓰는 형태에서 같은 문장이 두 번 안 나오는지 본다.
    const rendered = `${line} — ${c.why}`;
    strictEqual(rendered.split(c.why).length - 1, 1, rendered);
});

test("어떤 선택이든 한 줄 표시가 비지 않는다", () => {
    for (const c of [
        chooseNpm("bundled", { bundled: "/p", system: null }),
        chooseNpm("system", { bundled: null, system: { version: "10.0.0", path: SYS } }),
        chooseNpm("bundled", { bundled: null, system: null }),
    ]) ok(describeNpm(c).trim().length > 0, c.kind);
});

const POSIX = {
    join: (...p: string[]) => p.join("/").replace(/\/+/g, "/"),
    isAbsolute: (p: string) => p.startsWith("/"),
    normalize: (p: string) => p.replace(/\/+/g, "/").replace(/\/$/, ""),
    sep: "/",
};

test("걸음 — 상대 경로 항목은 건너뛴다(현재 폴더가 뒷문이 된다)", () => {
    const out = systemNpmSearchSteps(["", " ", ".", "..", "bin", "./tools", "~/bin", "/usr/bin"], POSIX);
    strictEqual(out.length, 2, JSON.stringify(out));
    for (const s of out) ok(s.path.startsWith("/usr/bin/"), s.path);
});

test("걸음 — **부모로 올라가지 않는다**", () => {
    // ⚠ 이 시험이 무는 것: `<항목>/../lib/…` 를 되살리면, PATH 에 `<열어둔소스>/node_modules/.bin`
    //   이 있을 때 후보가 **zip 이 담을 수 있는 자리**로 떨어진다.
    const out = systemNpmSearchSteps(["/ws/node_modules/.bin"], POSIX);
    ok(out.length > 0);
    for (const s of out) {
        ok(s.path.startsWith("/ws/node_modules/.bin/"), s.path);
        ok(!s.path.includes(".."), s.path);
    }
});

test("걸음 — 열어 둔 소스 폴더 아래는 통째로 건너뛴다", () => {
    const out = systemNpmSearchSteps(["/ws/node_modules/.bin", "/usr/bin"], POSIX, ["/ws"]);
    strictEqual(out.length, 2);
    for (const s of out) ok(s.path.startsWith("/usr/bin/"), s.path);
});

test("걸음 — 제외 구역 이름이 앞부분만 같은 폴더는 안 건드린다", () => {
    // `/ws2` 는 `/ws` 아래가 아니다. 문자열 접두만 보면 잘못 지운다.
    const out = systemNpmSearchSteps(["/ws2/bin"], POSIX, ["/ws"]);
    strictEqual(out.length, 2);
});

test("걸음 — 두 자리를 본다: 하위 배치와 따라갈 링크", () => {
    deepStrictEqual(systemNpmSearchSteps(["/usr/bin"], POSIX), [
        {kind: "cli", path: "/usr/bin/node_modules/npm/bin/npm-cli.js"},
        {kind: "link", path: "/usr/bin/npm"},
    ]);
});

test("걸음 — 빈 PATH 면 걸음도 없다", () => {
    deepStrictEqual(systemNpmSearchSteps([], POSIX), []);
});

test("걸음 — 조립 결과가 상대로 떨어지면 버린다", () => {
    // POSIX 판정을 통과하는 Windows 절대경로는 없다. 그래도 조립 뒤 한 번 더 본다.
    const weird = {...POSIX, join: (...p: string[]) => p.slice(1).join("/")}; // 앞을 먹는 조립
    deepStrictEqual(systemNpmSearchSteps(["/usr/bin"], weird), []);
});

test("따라간 결과 — .js 가 아니면 안 쓴다", () => {
    ok(acceptsResolvedNpmCli("/usr/lib/node_modules/npm/bin/npm-cli.js", POSIX));
    ok(!acceptsResolvedNpmCli("/usr/bin/npm", POSIX), "확장자가 없는 것");
    ok(!acceptsResolvedNpmCli("lib/npm-cli.js", POSIX), "상대 경로");
});

test("따라간 결과 — 열어 둔 소스 폴더 안으로 가면 안 쓴다", () => {
    // 링크는 어디로든 갈 수 있고, 그 링크 자체를 zip 이 담을 수 있다.
    ok(!acceptsResolvedNpmCli("/ws/evil/npm-cli.js", POSIX, ["/ws"]));
    ok(acceptsResolvedNpmCli("/usr/lib/npm-cli.js", POSIX, ["/ws"]));
});

test("어느 npm 이든 실행 인자는 이름이 아니라 경로다", () => {
    // ⚠ 이 시험이 무는 것: `["npm", "install"]` 로 되돌리면 Windows 에서 셸이 필요해지고,
    //   셸은 **받은 zip 을 푼 폴더부터** 실행 파일을 뒤진다.
    for (const c of [
        chooseNpm("bundled", { bundled: "/ext/npm-cli.js", system: null }),
        chooseNpm("system", { bundled: null, system: { version: "10.0.0", path: SYS } }),
    ]) {
        const argv = npmArgvOf(c, "/node");
        ok(argv, c.kind);
        strictEqual(argv[0], "/node");
        ok(argv[1]?.endsWith(".js"), argv[1]);
    }
});

test("🔴 `probeSystemNpm` 이 `env` 를 **자식에게** 넘긴다 — 안 넘기면 VS Code 에서 Electron 이 뜬다", async () => {
    // 확장은 `execPath`(Electron 바이너리)로 npm 을 부르고, 그것이 Node 로 뜨려면
    // `ELECTRON_RUN_AS_NODE=1` 이 있어야 한다. `env` 가 PATH 파싱에만 쓰이면 자식은 그 값을
    // 못 받아 「PATH 에 npm 이 없다」는 **거짓 진단**이 나간다(심의 실측).
    const dir = await tempDir("zalkera-npmenv-");
    const fake = join(dir, "fakenode");
    await writeFile(fake, "#!/bin/sh\necho \"MARK=[${ZALKERA_PROBE_MARK}]\"\n");
    await chmod(fake, 0o755);
    await mkdir(join(dir, "node_modules", "npm", "bin"), {recursive: true});
    await writeFile(join(dir, "node_modules", "npm", "bin", "npm-cli.js"), "//");

    const found = probeSystemNpm(fake, [], {PATH: dir, ZALKERA_PROBE_MARK: "지나감"});
    strictEqual(found?.version, "MARK=[지나감]", `자식이 env 를 못 받았다: ${JSON.stringify(found)}`);
});
