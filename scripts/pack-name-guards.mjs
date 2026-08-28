#!/usr/bin/env node
/**
 * **이름 선점 방어 스텁을 굽는다**(오너 판단 · 심의 🟠).
 *
 * ■ 왜 필요한가
 *
 *   `zalkera-devtools` 는 **우리 GitHub 레포 이름**이자 마켓 확장 id 의 절반(`zalkera.zalkera-devtools`)이고,
 *   루트 `README.md` 가 그 이름으로 링크한다. `zalkera-cli` 는 스코프 이름을 본 사람이 자연스럽게
 *   추측하는 형태다. 둘 다 npm 에 **비어 있다**.
 *
 *   발행 뒤 사람이나 에이전트가 그 이름으로 손을 뻗으면 `npm i -g zalkera-devtools` 를 친다.
 *   먼저 등록한 쪽이 **설치 시점 코드 실행**을 얻고, 그것도 우리 CLI 가 refresh 토큰을 평문으로
 *   두는 바로 그 기계에서다.
 *
 * ■ 왜 별칭이 아니라 **스텁**인가
 *
 *   `DECISIONS.md` 는 「별칭을 함께 내지 않는다」로 정했다 — 판을 올릴 때마다 둘 다 발행해야 하고,
 *   발행 대상이 둘이면 언젠가 한쪽이 빠져 그쪽 사용자가 갇힌다.
 *
 *   ⚠ **그 근거는 «동작하는» 별칭의 대가다.** 이 스텁은 아무것도 안 한다 — `bin` 도, 의존도,
 *     스크립트도 없다. **판 축이 필요 없으므로** 한 번 내고 잊는다. 그래서 그 결정과 안 부딪힌다.
 *
 * ■ 스텁이 하는 일
 *
 *   아무것도 안 한다. `npm i` 로 받아도 실행되는 코드가 0 이고, README 가 진짜 이름을 가리킨다.
 *   ⚠ **`bin` 을 두지 않는다** — 두면 그것이 실행 표면이 되고, 방어하려던 것을 우리가 만든다.
 *
 * ■ 발행 (오너)
 *
 *   ```
 *   npm publish ./shared/guard-zalkera-devtools-0.0.1.tgz --access public
 *   npm publish ./shared/guard-zalkera-cli-0.0.1.tgz --access public
 *   npm deprecate zalkera-devtools "이 이름은 쓰이지 않습니다. 터미널 도구는 @zalkera/cli 입니다."
 *   npm deprecate zalkera-cli      "이 이름은 쓰이지 않습니다. 터미널 도구는 @zalkera/cli 입니다."
 *   ```
 *   `deprecate` 는 설치할 때 경고를 띄운다 — 잘못 찾아온 사람에게 그 자리에서 말해 준다.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const shared = join(root, "shared");

/** 진짜 이름. 스텁 README·description 이 전부 이것을 가리킨다. */
const REAL = "@zalkera/cli";

/**
 * 지킬 이름들.
 *
 * ⚠ `@zalkera/*` 는 **스코프라 외부가 못 낸다** — 여기 안 넣는다. 맨 이름 `zalkera` 도 npm 이
 *   유사도로 거절하므로(우리에게도 거절했다) 남도 못 낸다.
 */
const GUARDED = ["zalkera-devtools", "zalkera-cli"];

/** 스텁 판. **올릴 일이 없다** — 내용이 안 바뀌기 때문이다. */
const VERSION = "0.0.1";

mkdirSync(out, { recursive: true });
mkdirSync(shared, { recursive: true });

for (const name of GUARDED) {
    const stage = mkdtempSync(join(tmpdir(), "zalkera-guard-"));
    try {
        writeFileSync(
            join(stage, "package.json"),
            `${JSON.stringify(
                {
                    name,
                    version: VERSION,
                    description: `이 이름은 쓰이지 않습니다 — 잘커라 터미널 도구는 ${REAL} 입니다.`,
                    license: "MIT",
                    // ⚠ `bin`·`main`·`dependencies`·`scripts` 를 두지 않는다. 실행 표면이 0 이어야 한다.
                    files: ["README.md"],
                    keywords: ["zalkera", "잘커라"],
                    repository: { type: "git", url: "https://github.com/zalkera/zalkera-devtools.git" },
                    homepage: "https://zalkera.com",
                    publishConfig: { access: "public" },
                },
                null,
                2,
            )}\n`,
        );
        writeFileSync(
            join(stage, "README.md"),
            [
                `# ${name}`,
                "",
                "**이 이름은 쓰이지 않습니다.** 이름을 잘못 찾아오신 것을 막으려고 자리만 잡아 둔 빈 패키지입니다.",
                "",
                `잘커라 터미널 도구는 [\`${REAL}\`](https://www.npmjs.com/package/${REAL}) 입니다.`,
                "",
                "```bash",
                `npx ${REAL} pull --site <사이트코드>`,
                "```",
                "",
                "VS Code 확장은 마켓플레이스에서 「잘커라」로 찾으실 수 있습니다.",
                "",
            ].join("\n"),
        );
        cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
        execFileSync("npm", ["pack", "--pack-destination", out], { cwd: stage, stdio: "inherit" });
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }

    // 검수 — 실행 표면이 정말 0 인가.
    const made = join(out, `${name}-${VERSION}.tgz`);
    const listed = execFileSync("tar", ["tzf", made], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    const expected = ["package/LICENSE", "package/README.md", "package/package.json"];
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
        throw new Error(`${name}: 실린 것이 예상과 다르다 — ${listed.join(", ")}`);
    }
    const manifest = JSON.parse(
        execFileSync("tar", ["xzfO", made, "package/package.json"], { encoding: "utf8" }),
    );
    for (const forbidden of ["bin", "main", "dependencies", "scripts"]) {
        if (manifest[forbidden] !== undefined) throw new Error(`${name}: 실행 표면이 생겼다 — ${forbidden}`);
    }
    // ⚠ **이름을 갈라 둔다.** `zalkera-cli-0.0.1.tgz` 는 진짜 `@zalkera/cli` 의 탈볼(같은 꼴)과
    //   한 폴더에 섞여, 오너가 발행할 때 **어느 것인지 헷갈린다.** 접두로 못박는다.
    cpSync(made, join(shared, `guard-${name}-${VERSION}.tgz`));
}

console.log("");
console.log(`✅ 이름 방어 스텁 ${GUARDED.length}개 — 실행 표면 0 확인`);
for (const name of GUARDED) console.log(`   shared/guard-${name}-${VERSION}.tgz`);
console.log("");
console.log("   발행(오너):");
for (const name of GUARDED) console.log(`     npm publish ./shared/guard-${name}-${VERSION}.tgz --access public`);
console.log("   그다음 안내를 붙입니다:");
for (const name of GUARDED) {
    console.log(`     npm deprecate ${name} "이 이름은 쓰이지 않습니다. 터미널 도구는 ${REAL} 입니다."`);
}
