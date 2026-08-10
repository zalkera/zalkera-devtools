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
/**
 * ⚠ **관할을 모든 패키지의 `src` 로 잡는다**(3차 재심의 실측). 초판은 `packages/vscode/src` 만 봤는데,
 * 심의가 `core` 에 `captureFromLive(read) = captureTenant(read())` 헬퍼를 두니 **라이브 조회를 그대로
 * 브랜드로 만드는 자리**가 생겼는데도 초록이었다. 그리고 그건 적대적이지 않다 — 헬퍼를 넣을 가장
 * 자연스러운 자리가 `core` 다.
 */
const targets = readdirSync(join(root, "packages"))
    .map((pkg) => join(root, "packages", pkg, "src"))
    .filter((dir) => {
        try {
            return statSync(dir).isDirectory();
        } catch {
            return false;
        }
    });

/**
 * 브랜드를 만드는 자리. 지금은 `ensureApiFor` 하나다.
 *
 * ⚠ `core` 안의 정의 줄(`export function captureTenant`)은 세지 않는다 — **만드는 곳이 아니라
 * 쓰는 곳**을 센다. `core` 에 래퍼 헬퍼가 생기면 그것도 여기 잡힌다(그게 요점이다).
 */
const EXPECTED = 1;

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        // 시험은 브랜드를 **만들어야** 한다(입력을 지어내는 것이 시험의 일이다) — 세지 않는다.
        // 프로덕션에서 브랜드가 나는 자리만이 이 검사의 관심사다.
        if (!full.endsWith(".ts") || full.endsWith(".test.ts")) return [];
        return [full];
    });
}

const hits = [];
const aliases = [];
for (const file of targets.flatMap(walk)) {
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            // 주석은 세지 않는다 — 설명에 등장하는 것까지 세면 문서를 못 쓴다.
            // (오탐 방향이 빨강이라 안전하다: 코드를 주석으로 위장해도 tsc 가 먼저 죽는다.)
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
            const where = `${relative(root, file)}:${i + 1}`;

            // **별칭은 즉시 실패다.** `import { captureTenant as brandIt }` 로 이름을 바꾸면
            // 아래 리터럴 검사가 통째로 눈이 먼다(재심의 실측 — 2곳인데 1곳으로 보고했다).
            if (/\bcaptureTenant\s+as\s+/.test(line)) aliases.push(where);

            // 정의 줄은 세지 않는다 — 만드는 곳이 아니라 **쓰는 곳**을 센다.
            if (/export\s+function\s+captureTenant\s*\(/.test(line)) return;
            if (/\bcaptureTenant\s*\(/.test(line)) hits.push(where);
        });
}

if (aliases.length > 0) {
    console.error("✗ `captureTenant` 를 다른 이름으로 가져왔습니다 — 이 검사가 눈이 멉니다.");
    for (const a of aliases) console.error(`   ${a}`);
    process.exit(1);
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
