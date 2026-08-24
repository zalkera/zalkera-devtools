#!/usr/bin/env node
/**
 * **만든 검사기가 실제로 도는가.**
 *
 * ■ 왜 있나
 *   `check-shipped-claims.mjs` 를 만들고 `verify` 에 등록했는데, 같은 세션의 변이 시험이
 *   `git checkout -- .` 로 `package.json` 을 되돌리면서 **등록만 사라졌다.** 검사기 파일은
 *   untracked 라 되돌려지지 않아 그대로 남았고, 그래서 「검사기가 있다」와 「검사기가 돈다」가
 *   갈렸다. 그 상태로 두 판이 나갔고 배송 문서의 거짓 셋을 아무도 안 잡았다.
 *
 *   이 레포는 검사기로 규율을 집행한다. 그렇다면 **집행되고 있는지도 집행 대상**이다.
 *
 * ■ 무엇을 요구하나
 *   `scripts/check-*.mjs` 하나마다 `package.json` 의 `verify` 가 그것을 부르는 스크립트를
 *   지나야 한다. 「스크립트가 정의되어 있다」로는 부족하다 — 정의만 있고 체인에 없으면 안 돈다.
 *
 * ■ 걸리면
 *   `verify` 체인에 넣어라. 일부러 뺀 것이라면 파일을 지워라 — 안 도는 검사기는 **거짓 안심**을
 *   준다(이 검사기가 생긴 이유가 그것이다).
 *
 *   재현: `node scripts/check-verify-chain.mjs`
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let pkg;
try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
} catch (err) {
    console.error(`❌ verify 체인 검사 — package.json 을 읽지 못했습니다(통과가 아닙니다): ${err.message}`);
    process.exit(2);
}

const scripts = pkg.scripts ?? {};
const verify = typeof scripts.verify === "string" ? scripts.verify : "";
if (verify === "") {
    console.error("❌ verify 체인 검사 — `verify` 스크립트가 없습니다(통과가 아닙니다).");
    process.exit(2);
}

/** `verify` 가 부르는 스크립트 이름들. `npm run x && npm run y` 형태를 판다. */
const called = new Set([...verify.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
// 한 겹만 편다 — `verify` 가 부른 스크립트가 또 `npm run` 을 하는 경우(예: typecheck).
for (const name of [...called]) {
    const body = scripts[name];
    if (typeof body !== "string") continue;
    for (const m of body.matchAll(/npm run ([\w:-]+)/g)) called.add(m[1]);
}

/** 그 이름들이 실제로 실행하는 명령 전문. 여기서 파일명을 찾는다. */
const commands = [...called].map((name) => scripts[name] ?? "").join(" \n ");

const checkers = readdirSync(join(root, "scripts")).filter(
    (f) => f.startsWith("check-") && f.endsWith(".mjs"),
);
if (checkers.length === 0) {
    console.error("❌ verify 체인 검사 — 검사기가 0개입니다(통과가 아닙니다). 경로를 확인하십시오.");
    process.exit(2);
}

const orphans = checkers.filter((f) => !commands.includes(f));
if (orphans.length > 0) {
    console.error(`❌ verify 체인 검사 — 안 도는 검사기 ${orphans.length}건:`);
    for (const f of orphans) console.error(`   · scripts/${f}`);
    console.error("   → `verify` 체인에 넣으십시오. 일부러 뺀 것이면 파일을 지우십시오 —");
    console.error("     안 도는 검사기는 거짓 안심을 줍니다(이 검사기가 생긴 이유입니다).");
    process.exit(1);
}
console.log(`✅ verify 체인 검사 — 통과 (검사기 ${checkers.length}종이 전부 verify 를 지납니다)`);
