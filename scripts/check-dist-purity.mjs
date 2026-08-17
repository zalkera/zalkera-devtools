#!/usr/bin/env node
/**
 * **구운 것에 시험이 섞였는가.**
 *
 * ■ 왜 있나
 *   타입 검사는 시험까지 봐야 하고(`tsconfig.typecheck.json`), 빌드는 시험을 구우면 안 된다
 *   (`tsconfig.json`). 설정이 둘이라 **합치고 싶은 유혹**이 늘 있다. 합치면 `dist` 에 시험이 57개
 *   구워지는데(실측), 그 사실은 아무 데서도 안 보인다 — 확장 번들은 진입점에서만 끌어오므로
 *   VSIX 는 멀쩡하고, 커지는 것은 발행 꾸러미와 빌드 시간뿐이다.
 *
 *   재현: `packages/core/tsconfig.json` 의 `exclude` 를 비우고 `npm run typecheck` 뒤
 *   `ls packages/core/dist | grep -c '\.test\.'`
 *
 * ■ 걸리면
 *   `tsconfig.json` 의 `exclude` 를 되돌린다. 타입 검사를 좁히지 말고 **빌드를 좁힌다.**
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/core/dist");
if (!existsSync(dist)) {
    console.error("❌ 구운 것 검사 — packages/core/dist 가 없습니다(통과가 아닙니다). 먼저 빌드하십시오.");
    process.exit(2);
}

const found = [];
let seen = 0;
(function walk(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else {
            seen += 1;
            if (/\.test\.(js|cjs|mjs|d\.ts|js\.map|d\.ts\.map)$/.test(entry)) found.push(relative(root, full));
        }
    }
})(dist);

if (seen === 0) {
    console.error("❌ 구운 것 검사 — dist 가 비었습니다(통과가 아닙니다).");
    process.exit(2);
}
if (found.length) {
    console.error(`❌ 구운 것 검사 — 시험이 ${found.length}개 섞였습니다:`);
    for (const f of found.slice(0, 5)) console.error(`   · ${f}`);
    console.error("   → packages/core/tsconfig.json 의 exclude 를 되돌리십시오(타입 검사는 tsconfig.typecheck.json 이 봅니다).");
    process.exit(1);
}
console.log(`✅ 구운 것 검사 — 통과 (산출물 ${seen}개에 시험 없음)`);
