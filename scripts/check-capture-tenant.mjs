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
 * ■ **못 잡는 것**(7차 경고 ③-O — 다음 사람이 이 검사를 전수로 믿지 않게)
 *   · 파일 전체를 문자열로 조립하는 등 **적대적 문자열 조작**. 텍스트 검사의 원리적 한계다.
 *   · `packages/` 밖의 소스, `.js`/`.mjs`. 관할이 `packages/**` 의 `.ts` 계열 4종이다.
 *   · 타입 시스템 자체를 우회하는 `@ts-ignore`·`declare` 병합. 이건 `tsc` 의 일이지 이 검사의 일이 아니다.
 *   이 검사가 지키는 것은 *"브랜드가 나는 자리는 하나"* 라는 **규율의 가시화**이지 봉인이 아니다.
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
 * 브랜드를 만드는 자리. 둘이다.
 *
 * ⑴ `ensureApiFor` — 사이트를 고르는 일반 경로.
 * ⑵ `offerFolderElsewhere` — 고른 사이트가 **이 폴더의 것이 아닐 때** 그 사이트의 소스를 받는 자리.
 *    이 창의 유효 사이트는 아직 폴더의 것이라 라이브로 읽으면 **엉뚱한 사이트를 받는다.** 고르는
 *    그 순간이 값이 API 에 묶일 값으로 고정되는 순간이므로, 거기서 잡아 `openSite` 로 넘긴다.
 *
 * ⚠ `core` 안의 정의 줄(`export function captureTenant`)은 세지 않는다 — **만드는 곳이 아니라
 * 쓰는 곳**을 센다. `core` 에 래퍼 헬퍼가 생기면 그것도 여기 잡힌다(그게 요점이다).
 */
const EXPECTED = 2;
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

/** 브랜드 선언 자체. 이 한 줄이 무너지면 아래 검사가 전부 무의미하다(6차 경고 ③-J). */
const BRAND_DECL = /export\s+type\s+CapturedTenant\s*=\s*string\s*&\s*\{\s*readonly\s+__capturedTenant\s*:\s*unique\s+symbol\s*\}/;

/** 제네릭 타입인자가 정상인 자리 — 컨테이너 생성은 브랜드를 만들지 않는다. */
const CONTAINERS = /^(Set|Map|WeakSet|WeakMap|Array|ReadonlyArray|Promise|Record|Partial|Readonly)$/;

/**
 * ⚠ **면제는 낱말 축에만 있었다**(6차 재심의 차단 ③-F). 5차에서 "정의 파일 통째 면제를 걷었다"고
 * 적었는데, 걷힌 것은 ⑴·⑶ 뿐이고 **브랜드 축(⑵-b)은 두 파일에서 그대로 꺼져 있었다.**
 * 그런데 타입 별칭·제네릭을 잡는 규칙이 정확히 그것 하나다 — 즉 **브랜드를 위조하는 별칭을
 * 브랜드 정의 파일 안에서 만들 수 있었다.** 커밋 자신의 진단 그대로다:
 * *"별칭을 놓기에 가장 자연스러운 파일이 곧 면제 파일이었다."*
 * ⇒ 브랜드 축에는 면제가 없다. 정의는 **형태로** 예외 처리한다(파일 이름이 아니라).
 *
 * 그리고 **허용 열거는 반대 방향으로 위험하다** — 정상 코드를 죽인다(6차 경고 ③-G, 3종 실측).
 * import/export 문을 먼저 통째로 들어내고 나머지에만 규칙을 적용한다. 그러면 specifier 를
 * `}` 로 어림잡을 필요가 없어져 객체 shorthand(`{ captureTenant }`)도 함께 닫힌다(③-K).
 */
function scan(rel, raw) {
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    let flat = stripped.replace(/\s+/g, " ");

    // ── import/export 문은 따로 본다 — 여기서는 **맨 이름**만 정상이다.
    const MODULE_STMT = /\b(?:import|export)\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
    for (const m of flat.matchAll(MODULE_STMT)) {
        for (const spec of m[1].split(",")) {
            if (!/\bcaptureTenant\b/.test(spec)) continue;
            if (!/^\s*(?:type\s+)?captureTenant\s*$/.test(spec)) {
                aliases.push(`${rel}  ← import/export 에서 개명(\`${spec.trim()}\`)`);
            }
        }
    }
    flat = flat.replace(MODULE_STMT, " ");

    // ── ⑵ 캐스트(공백 정규화 뒤라 줄바꿈 캐스트 포함)
    for (const _ of flat.matchAll(/\bas\s+CapturedTenant\b/g)) casts.push(rel);

    // ── ⑵-b 브랜드가 나는 **다른 길**. 면제 없음.
    //    ⓐ 타입 별칭 — 래퍼 한 겹(`Exclude<CapturedTenant, never>`)에도 무너지지 않게 RHS 전체를 본다(③-I).
    // ⚠ 타입 **파라미터 목록**을 건너뛴다(7차 경고 ③-L). `type W<T> = T & CapturedTenant` 는
    //    이름 뒤 즉시 `=` 가 아니라서 눈이 멀었다 — `tsc` 초록·검사기 초록으로 브랜드가 났다.
    for (const m of flat.matchAll(/\btype\s+(\w+)\s*(?:<[^=<>]*(?:<[^<>]*>[^=<>]*)*>)?\s*=\s*([^;]*?)(?=;|$)/g)) {
        if (m[1] === "CapturedTenant") continue; // 선언 자체
        if (/\bCapturedTenant\b/.test(m[2])) {
            aliases.push(`${rel}  ← \`type ${m[1]} = …CapturedTenant…\` — 이 이름으로 캐스트하면 캐스트 검사가 눈이 먼다`);
        }
    }
    //    ⓑ 제네릭 타입인자로 브랜드 생성. `new` 와 컨테이너는 뺀다 — 값을 만들지 브랜드를 만들지 않는다(③-G).
    for (const m of flat.matchAll(/(new\s+)?(\w+)\s*<\s*CapturedTenant\s*>\s*\(/g)) {
        if (m[1] || CONTAINERS.test(m[2])) continue;
        aliases.push(`${rel}  ← \`${m[2]}<CapturedTenant>(…)\` — 제네릭 경유로 브랜드 생성`);
    }
    //    ⓑ' **타입 파라미터 기본값**도 같은 길이다 — `f<T = CapturedTenant>(x): T { return x as T }`.
    for (const _ of flat.matchAll(/<[^<>]*\bT\s*=\s*CapturedTenant\b/g)) {
        aliases.push(`${rel}  ← 타입 파라미터 기본값으로 브랜드 생성`);
    }
    //    ⓒ **브랜드를 반환한다고 선언한 함수**. `as any` 한 줄이면 캐스트도 별칭도 안 거친다(③-H).
    // ⚠ 정의를 화살표 const 로 바꾸거나 인자에 `)` 가 들어가도 빗나가지 않게 넓게 잡는다(③-N).
    //    빗나가면 **정의 자신**이 "브랜드를 반환하는 함수가 또 있다" 로 보고돼 없는 결함을 찾게 된다.
    const withoutDef = flat.replace(/(?:export\s+)?(?:function\s+captureTenant|const\s+captureTenant\s*[:=])[\s\S]*?\)\s*:\s*CapturedTenant/g, " ");
    for (const _ of withoutDef.matchAll(/\)\s*:\s*CapturedTenant\b/g)) {
        aliases.push(`${rel}  ← 브랜드를 반환하는 함수가 또 있다 — 본문이 \`as any\` 면 이 검사가 전부 눈이 먼다`);
    }

    // ── ⑴·⑶ 낱말. import/export 를 들어냈으므로 **호출만** 정상이다.
    for (const m of flat.matchAll(/\bcaptureTenant\b/g)) {
        const before = flat.slice(Math.max(0, m.index - 40), m.index).trimEnd();
        const after = flat.slice(m.index + "captureTenant".length).trimStart();
        if (before.endsWith("export function")) continue; // 정의
        // ⚠ **호출 판정이 먼저다**(③-G). `:` 를 먼저 보면 삼항(`c ? x : captureTenant(…)`)을
        //   "객체 값으로 넘김" 으로 **오진**한다 — 정상 호출인데 값 누출로 보고했다.
        if (after.startsWith("(")) {
            if (!isTest(rel)) hits.push(rel);
            continue;
        }
        aliases.push(`${rel}  ← 호출이 아닌 형태(별칭·값 대입·shorthand·동적 접근)`);
    }
}

const scanned = targets.flatMap(walk);
for (const file of scanned) scan(relative(root, file), readFileSync(file, "utf8"));

// 브랜드 선언이 살아 있는가 — `= string` 한 줄이면 생 string 이 어디서나 통과한다.
const defFile = scanned.find((f) => relative(root, f) === DEFINITION);
if (!defFile || !BRAND_DECL.test(readFileSync(defFile, "utf8"))) {
    console.error(`✗ 브랜드 선언이 기대한 형태가 아닙니다 — ${DEFINITION}`);
    console.error("\n  `export type CapturedTenant = string & { readonly __capturedTenant: unique symbol }`");
    console.error("  이 한 줄이 무너지면 아래 검사가 전부 통과하면서 생 string 이 어디서나 지나갑니다.");
    process.exit(1);
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
