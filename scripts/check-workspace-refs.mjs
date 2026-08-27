#!/usr/bin/env node
/**
 * **루트 스크립트의 `-w <이름>` 이 실재하는 워크스페이스를 가리키는가.**
 *
 * ■ 왜 있나
 *
 *   패키지 이름을 바꾸면 루트 `package.json` 의 `--workspace` 인자는 **따라오지 않는다.** npm 은
 *   그것을 교정하지 않고 `No workspaces found` 로 죽는다. 그 자체는 정직한 실패인데, 죽는 자리가
 *   하필 `verify` **체인 한가운데**다:
 *
 *   `verify = typecheck && test && check:dist && … (검사기 18종)`
 *
 *   `test` 가 죽으면 `&&` 가 끊겨 **검사기가 하나도 안 돈다.** 개별로 돌리면 전부 초록이라
 *   「검사기가 나쁜 게 아니라 체인에 도달을 못 한다」 — 그리고 그 사실은 문면(`❌`·`✗`)으로 안
 *   드러나고 **종료 코드로만** 드러난다. 실측: 개명 한 번에 검사기 18종과 CLI 시험 50개가 조용히
 *   체인 밖으로 나갔고, 산출물을 내는 유일한 길이 `--skip-verify` 가 됐다.
 *
 * ■ 형제 검사기가 못 잡는 이유
 *
 *   `check-verify-chain.mjs` 는 「검사기가 `verify` 에 **등록**됐는가」를 본다(자기 KDoc 이 그
 *   범위를 적어 뒀다). 등록된 이름이 실제로 **풀리는가**는 그 검사기의 관할 밖이다.
 *
 * ■ 걸리면
 *   루트 `package.json` 의 그 이름을 실물에 맞춘다. `package-lock.json` 도 함께
 *   (`npm install --package-lock-only`) — 안 그러면 CI 의 `npm ci` 가 따로 죽는다.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const rootPkg = read("package.json");

// 실재하는 워크스페이스 이름. 루트 자신도 `-w` 대상이 될 수 있다.
const names = new Set([rootPkg.name]);
for (const dir of readdirSync(join(root, "packages"))) {
    try {
        names.add(read(join("packages", dir, "package.json")).name);
    } catch {
        /* package.json 이 없는 폴더는 워크스페이스가 아니다. */
    }
}

// ⚠ **`-w` 앞에 경계를 둔다.** 안 두면 `check-workspaces`·`check-wiring.mjs` 같은 **단어 안의
//   `-w`** 를 인자로 읽어 오탐한다(실측: 첫 판이 `orkspaces`·`iring.mjs` 를 안 풀린다고 신고했다).
//   `--workspace` 도 같은 이유로 `--w` 로 시작하는 다른 플래그와 안 겹치게 전체를 적는다.
const problems = [];
for (const [script, body] of Object.entries(rootPkg.scripts ?? {})) {
    for (const m of String(body).matchAll(/(?:^|\s)(?:-w\s+|--workspace(?:=|\s+))(@?[\w./-]+)/g)) {
        const asked = m[1];
        if (!names.has(asked)) problems.push({ script, asked });
    }
}

if (problems.length > 0) {
    console.error(`❌ 워크스페이스 참조 검사 — 안 풀리는 이름 ${problems.length}건:`);
    for (const { script, asked } of problems) console.error(`   · scripts.${script} → ${asked}`);
    console.error(`\n  실재하는 이름: ${[...names].sort().join(" · ")}`);
    console.error("  npm 은 이것을 교정하지 않고 `No workspaces found` 로 죽습니다 — 그러면 `verify` 의");
    console.error("  `&&` 가 끊겨 **뒤따르는 검사기가 하나도 안 돕니다.**");
    process.exit(1);
}
console.log(`✓ 워크스페이스 참조 검사 — 통과 (스크립트가 부르는 이름이 전부 풀린다 · 워크스페이스 ${names.size}개)`);
