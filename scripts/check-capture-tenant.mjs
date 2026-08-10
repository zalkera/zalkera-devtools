#!/usr/bin/env node
/**
 * `captureTenant(` 호출이 **정확히 한 곳**인지 본다.
 *
 * ■ 왜 필요한가 (재심의 경고 · 2026-08-10)
 *   `CapturedTenant` 브랜드가 막는 것은 *"생 `string` 을 문구 함수에 넘기는 것"* 이다. 그런데
 *   **`captureTenant(tenantCode())` 는 완벽히 컴파일된다** — 가장 현실적인 우회로가 정식 문법이다.
 *   TS 브랜드의 본질적 한계이고, 방어의 실제 강도는 *"브랜드를 붙이는 자리가 하나뿐"* 이라는
 *   규율에 달려 있었다.
 *
 *   소스 주석은 *"호출하는 자리가 늘어나면 그것이 방어가 느슨해지는 신호다"* 라고 적어 뒀는데,
 *   **그 신호를 볼 장치가 없었다.** 규율을 구조로 바꾸는 것이 이 파일이다.
 *
 * ■ 왜 개수만 세나
 *   "어느 값을 넘겼는가"까지 보려면 타입 흐름 해석이 필요하다. 그건 tsc 의 일이고, tsc 는 이미
 *   브랜드로 그 절반을 한다. 여기서 세는 것은 **나머지 절반** — 브랜드를 새로 만드는 자리다.
 *   자리가 하나면 그 한 줄만 읽으면 되고, 늘어나면 사람이 봐야 한다.
 *
 * ■ 늘려야 한다면
 *   막지 않는다 — 아래 EXPECTED 를 올리고 **왜 늘었는지 커밋에 적어라.** 그 커밋이 곧 심의 대상이다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "packages", "vscode", "src");

/** 확장 소스에서 브랜드를 만드는 자리. 지금은 `ensureApiFor` 하나다. */
const EXPECTED = 1;

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
    });
}

const hits = [];
for (const file of walk(target)) {
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            // 주석은 세지 않는다 — 설명에 등장하는 것까지 세면 문서를 못 쓴다.
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
            if (/\bcaptureTenant\s*\(/.test(line)) hits.push(`${relative(root, file)}:${i + 1}`);
        });
}

if (hits.length !== EXPECTED) {
    console.error(`✗ captureTenant 호출이 ${hits.length}곳입니다(기대 ${EXPECTED}).`);
    for (const h of hits) console.error(`   ${h}`);
    console.error(
        "\n  브랜드는 **여기서만** 붙어야 합니다 — `captureTenant(tenantCode())` 는 컴파일되므로,\n" +
            "  자리가 늘면 표기와 동작이 다시 갈릴 수 있습니다. 정말 필요하면\n" +
            "  scripts/check-capture-tenant.mjs 의 EXPECTED 를 올리고 **이유를 커밋에 적으십시오.**",
    );
    process.exit(1);
}

console.log(`✓ captureTenant 호출 ${hits.length}곳 — ${hits[0]}`);
