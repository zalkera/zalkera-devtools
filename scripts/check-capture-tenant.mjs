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
 * ■ 무엇을 세나 — **브랜드가 나는 자리 전부**
 *   ⚠ 초판은 `captureTenant(` **호출**만 셌다. 그런데 브랜드는 그 함수 없이도 난다 — 그 함수 자체가
 *   한 줄짜리 캐스트(`tenant as CapturedTenant`)이고, **그 한 줄을 아무 데나 복사하면 그만**이다.
 *   4차 재심의가 우회 7종 중 **6종을 초록으로 통과**시켰고, 그중 `read() as CapturedTenant` 는
 *   적대적이지도 않고 `tsc` 도 통과했다. *"관할 집합의 이름을 실제 위험 집합보다 좁게 적었다."*
 *
 *   그래서 셋을 함께 본다:
 *   ⑴ `captureTenant(` **호출** — 브랜드를 만드는 함수를 쓰는 자리
 *   ⑵ `as CapturedTenant` **캐스트** — 함수를 안 거치고 브랜드를 만드는 자리(정의 1줄뿐이어야 한다)
 *   ⑶ `captureTenant` 라는 **낱말이 `(` 없이** 나오는 자리 — 별칭·구조분해·동적 인덱스·re-export.
 *      값으로 넘어가는 순간 ⑴ 의 리터럴 검사가 눈이 먼다.
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
    .map((pkg) => join(root, "packages", pkg))
    .filter((dir) => {
        try {
            return statSync(dir).isDirectory();
        } catch {
            return false;
        }
    });

/** 브랜드 정의가 사는 파일. 여기서는 캐스트도 낱말도 정상이다. */
const DEFINITION = join("packages", "core", "src", "tenantScope.ts");
/** 재수출만 하는 자리 — 낱말이 `(` 없이 나오는 것이 정상이다. */
const REEXPORT = join("packages", "core", "src", "index.ts");

/**
 * 브랜드를 만드는 자리. 지금은 `ensureApiFor` 하나다.
 *
 * ⚠ `core` 안의 정의 줄(`export function captureTenant`)은 세지 않는다 — **만드는 곳이 아니라
 * 쓰는 곳**을 센다. `core` 에 래퍼 헬퍼가 생기면 그것도 여기 잡힌다(그게 요점이다).
 */
const EXPECTED = 1;
/** `as CapturedTenant` 는 **정의 한 줄**뿐이어야 한다. 늘면 함수를 안 거치고 브랜드가 난 것이다. */
const EXPECTED_CASTS = 1;

const SOURCE_EXT = [".ts", ".mts", ".cts", ".tsx"];

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "dist") return [];
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        // ⚠ **`packages/*/src` 만 보면 안 된다**(4차 실측 — `packages/vscode/tools/` 로 새어 나갔다).
        // 패키지 아래 전부를 본다(빌드 산출물·의존성은 위에서 자른다).
        return SOURCE_EXT.some((ext) => full.endsWith(ext)) ? [full] : [];
    });
}

/** 시험은 브랜드를 **만들어야** 한다 — 입력을 지어내는 것이 시험의 일이다. 호출 수에서만 뺀다. */
const isTest = (rel) => /\.(test|spec)\.[mc]?tsx?$/.test(rel);

const hits = [];
const aliases = [];
const casts = [];
for (const file of targets.flatMap(walk)) {
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            // 주석은 세지 않는다 — 설명에 등장하는 것까지 세면 문서를 못 쓴다.
            // (오탐 방향이 빨강이라 안전하다: 코드를 주석으로 위장해도 tsc 가 먼저 죽는다.)
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
            const where = `${relative(root, file)}:${i + 1}`;

            // ⑵ 캐스트 — 함수를 **안 거치고** 브랜드를 만드는 자리.
            if (/\bas\s+CapturedTenant\b/.test(line)) casts.push(where);

            // ⑶ **낱말이 값으로 새는 자리.** `captureTenant` 뒤에 `(` 가 없으면 별칭·구조분해·
            //    동적 인덱스·re-export 중 하나이고, 그 순간 ⑴ 의 리터럴 검사가 눈이 먼다.
            //    한 규칙으로 그 넷을 함께 잡는다(4차 실측: 별칭만 막았더니 나머지 셋이 통과했다).
            const rel = relative(root, file);
            if (rel !== DEFINITION && rel !== REEXPORT) {
                // 평범한 named import(`{ captureTenant, … }`)는 정상이다 — **이름을 바꾸거나 문자열로
                // 만드는** 형태만 잡는다. 그 셋이 리터럴 검사를 눈멀게 하는 전부다(4차 실측).
                const disguises = [
                    [/\bcaptureTenant\s+as\b/, "별칭(`as`)"],
                    [/\bcaptureTenant\s*:/, "구조분해 개명(`:`)"],
                    [/["'`]captureTenant["'`]/, "문자열 인덱스"],
                ];
                for (const [re, what] of disguises) {
                    if (re.test(line)) aliases.push(`${where}  ← ${what}`);
                }
            }

            // ⑴ 호출. 정의 줄은 세지 않는다 — 만드는 곳이 아니라 **쓰는 곳**을 센다.
            if (/export\s+function\s+captureTenant\s*\(/.test(line)) return;
            if (isTest(rel)) return;
            if (/\bcaptureTenant\s*\(/.test(line)) hits.push(where);
        });
}

// ⚠ **시험 파일은 무엇도 export 하지 않는다**(4차 실측 — `.test.ts` 제외를 이용해 프로덕션 헬퍼를
// 거기 숨기면 호출 수에서 빠졌다). 시험은 실행되는 잎이지 남이 import 하는 모듈이 아니다.
// 이 규칙이 서면 "시험은 안 센다"는 면제가 안전해진다.
const leakyTests = [];
for (const file of targets.flatMap(walk)) {
    const rel = relative(root, file);
    if (!isTest(rel)) continue;
    readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
            if (/^\s*export\s/.test(line)) leakyTests.push(`${rel}:${i + 1}`);
        });
}

if (leakyTests.length > 0) {
    console.error("✗ 시험 파일이 무언가를 export 합니다 — 브랜드 생성 지점을 숨길 수 있습니다.");
    for (const t of leakyTests) console.error(`   ${t}`);
    console.error("\n  시험은 실행되는 잎입니다. 프로덕션이 쓸 것이면 시험 파일 밖으로 옮기십시오.");
    process.exit(1);
}

if (aliases.length > 0) {
    console.error("✗ `captureTenant` 가 호출이 아닌 형태로 쓰였습니다 — 이 검사가 눈이 멉니다.");
    for (const a of aliases) console.error(`   ${a}`);
    console.error("\n  별칭·구조분해·동적 인덱스·re-export 는 브랜드 생성 지점을 감춥니다.");
    process.exit(1);
}

if (casts.length !== EXPECTED_CASTS) {
    console.error(`✗ \`as CapturedTenant\` 캐스트가 ${casts.length}곳입니다(기대 ${EXPECTED_CASTS} — 정의뿐).`);
    for (const c of casts) console.error(`   ${c}`);
    console.error(
        "\n  캐스트 한 줄이면 `captureTenant` 를 **안 거치고** 브랜드가 납니다 —\n" +
            "  그러면 '표기와 동작이 같은 값을 본다'는 보증이 그 자리에서 끝납니다.",
    );
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

console.log(`✓ captureTenant 호출 ${hits.length}곳 — ${hits[0]} · 캐스트 ${casts.length}곳(정의)`);
