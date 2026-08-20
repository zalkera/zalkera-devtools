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
 * ■ 시험 파일만이 아니다
 *   시험이 쓰는 **헬퍼**도 같은 자리에 있다(`src/testing/`). 파일 이름에 `.test.` 가 없어서 이름
 *   규칙만 보는 검사는 그것을 통과시킨다 — 그러면 빌드를 좁히는 규율이 반쪽이 된다. 실측으로,
 *   `exclude` 에서 그 폴더를 빼면 산출물이 셋 늘어나는데 종전 검사는 초록이었다.
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
            const rel = relative(root, full);
            // 시험 파일과 **시험 전용 폴더**를 같은 눈으로 본다. 둘 다 빌드가 좁혀 두는 것이라
            // 한쪽만 지키면 다른 쪽으로 샌다(`src/testing/` 은 시험 헬퍼가 사는 자리다).
            if (/\.test\.(js|cjs|mjs|d\.ts|js\.map|d\.ts\.map)$/.test(entry)) found.push(rel);
            else if (/(^|[\\/])testing[\\/]/.test(relative(dist, full))) found.push(rel);
        }
    }
})(dist);

if (seen === 0) {
    console.error("❌ 구운 것 검사 — dist 가 비었습니다(통과가 아닙니다).");
    process.exit(2);
}
if (found.length) {
    console.error(`❌ 구운 것 검사 — 시험 전용 산출물이 ${found.length}개 섞였습니다:`);
    for (const f of found.slice(0, 5)) console.error(`   · ${f}`);
    console.error("   → packages/core/tsconfig.json 의 exclude 를 되돌리십시오(타입 검사는 tsconfig.typecheck.json 이 봅니다).");
    process.exit(1);
}
console.log(`✅ 구운 것 검사 — 통과 (산출물 ${seen}개에 시험 없음)`);
