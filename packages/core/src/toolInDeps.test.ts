/**
 * **이 도구가 사이트 의존에 들어와 있는가** — 그 판정과 그것을 말하는 두 자리.
 *
 * 초안은 이 오용을 **이름으로** 막으려 했다(비스코프 `zalkera` = 치는 것 · `@zalkera/*` = import
 * 하는 것). npm 이 그 이름을 거절해 스코프 안으로 들어왔고, 이름 관례가 사라진 자리를 검사가
 * 대신한다. 그래서 이 시험이 재는 것은 **관례가 아니라 실물이 잡는가**다.
 */
import {test} from "node:test";
import {deepEqual, ok, strictEqual} from "node:assert/strict";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tempDir} from "./testing/tempDir.ts";
import {inspectProject, TOOL_PACKAGES} from "./project.ts";
import {precheck} from "./precheck.ts";

async function project(pkg: Record<string, unknown>): Promise<string> {
    const dir = await tempDir("zalkera-tooldep-");
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, "package.json"), JSON.stringify({name: "site", ...pkg}));
    return dir;
}

test("깨끗한 프로젝트는 아무것도 안 짚는다 — 없는 걱정을 지어내지 않는다", async () => {
    const dir = await project({dependencies: {next: "15.0.0", "@zalkera/client": "^0.27.0"}});
    const seen = await inspectProject(dir);
    deepEqual(seen.toolInDeps, [], "안 들어온 것을 들어왔다고 말한다");
    const findings = await precheck({projectDir: dir});
    ok(!findings.some((f) => /의존으로 들어 있습니다/.test(f.message)), "거짓 경보가 난다");
});

test("🔴 이 도구가 사이트 의존에 들어오면 짚는다 — 그 package.json 은 서버가 빌드에 쓴다", async () => {
    const dir = await project({dependencies: {next: "15.0.0", "@zalkera/cli": "^0.20.1"}});
    const seen = await inspectProject(dir);
    deepEqual(seen.toolInDeps, ["@zalkera/cli"]);
    const findings = await precheck({projectDir: dir});
    const hit = findings.find((f) => /의존으로 들어 있습니다/.test(f.message));
    ok(hit, `안 짚었다: ${JSON.stringify(findings.map((f) => f.message))}`);
    strictEqual(hit.level, "warn", "막지는 않되 말은 해야 한다");
    ok(/package.json/.test(hit.hint ?? ""), "무엇을 하라는지 안 말한다");
});

test("🔴 `devDependencies` 로 들어와도 짚는다 — 그쪽도 업로드되는 같은 파일이다", async () => {
    const dir = await project({devDependencies: {"@zalkera/cli": "^0.20.1"}});
    deepEqual((await inspectProject(dir)).toolInDeps, ["@zalkera/cli"]);
});

test("🔴 **옛 이름도 본다** — 목록이 지금 이름 하나로 좁아지면 개명하는 날 조용히 뚫린다", async () => {
    // 이 도구는 발행 전에 이미 이름이 한 번 갈렸다(npm 유사도 거절). 또 갈릴 수 있다.
    for (const name of TOOL_PACKAGES) {
        const dir = await project({dependencies: {[name]: "1.0.0"}});
        deepEqual((await inspectProject(dir)).toolInDeps, [name], `${name} 을 놓쳤다`);
    }
});

test("🔴 형제 `@zalkera/client` 는 **짚지 않는다** — 그것은 소스가 import 하는 것이 맞다", async () => {
    // 같은 스코프라 목록을 넓게 잡으면 정상 의존을 오탐한다. 그러면 사람이 경고를 습관으로 넘긴다.
    const dir = await project({dependencies: {"@zalkera/client": "^0.27.0"}});
    deepEqual((await inspectProject(dir)).toolInDeps, []);
});
