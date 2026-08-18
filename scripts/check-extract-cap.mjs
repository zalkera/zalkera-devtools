/**
 * **해제 상한이 두 경로에서 같은 문을 지나는가.**
 *
 * ## 왜 검사기인가
 *
 * 이 성질은 시험으로 못 잠근다 — 관찰하려면 **천장을 넘는 입력**이 필요하고, 그 픽스처는 수백 MB다.
 * 가드를 재는 시험이 가드가 막으려는 손해(디스크·메모리 폭탄)를 내면 안 된다. 그래서 형태를 본다.
 *
 * ## 무엇이 있었나
 *
 * 버퍼 경로만 `Math.min(…, 200MB)` 으로 되죄고 스트리밍 경로는 `options.maxBytes` 를 날로 썼다.
 * 그래서 **해제 250MB 짜리 정상 소스**가 버퍼 경로에서만 거부됐다 — 사이트 소스 받기가 쓰는
 * 것이 정확히 그 경로였다. 같은 파일이 스스로 「호출부가 건 상한이 경로에 따라 있다 없다 하면
 * 그건 상한이 아니다」라고 적어 두고 있었다.
 *
 * ## 세 가지를 본다
 *
 *  ⑴ `resolveCap` 의 기본값이 `MAX_EXTRACT_BYTES` 이고, 호출부 값을 **되죄지 않는다**.
 *  ⑵ 두 해제 경로가 **둘 다** `resolveCap(` 을 지난다.
 *  ⑶ 소스 경로의 상한이 `limits.ts` 의 상수 그대로다 — 실제 천장이 검사기 밖에 살면 안 된다.
 *  ⑷ 두 가드가 **해결된 상한 변수 그 자체**와 비교한다 — 값에 조건을 걸어 큰 입력에서만 죽는
 *     형태를 막는다. 숫자 표기를 열거하지 않으므로 무관한 상수에 오탐하지 않는다.
 *
 * ## 무엇을 안 보는가 — 그리고 왜 그게 낫다고 보는가
 *
 * **정확한 문자열을 요구하지 않습니다.** 첫 판이 `Math.min(…)` 을, 둘째 판이 지역변수 이름과
 * 인자 표기를 요구했더니, **정당한 편집 7건 중 6건**(변수 개명 · 줄바꿈 · 구조분해 · 셈 상수
 * 조정 · 오류 문자열 안의 숫자)에 빨간불이 났습니다(심의 실측). 검사기가 고치려는 손을 막으면
 * 그것은 방어가 아니라 마찰입니다. 그래서 **이름과 표기를 안 봅니다** — 보는 것은 셋뿐입니다.
 *
 * **대입의 존재만 보고 그 값이 쓰이는지는 안 봅니다.** `resolveCap(...) * 1024` 나 파이프라인에서
 * `guard` 를 빼는 우회는 못 잡습니다 — 그 축은 `npm test` 가 잡습니다(실측으로 확인했습니다).
 *
 * ⚠ **다만 시험이 무는 것은 «무조건 제거» 뿐입니다.** 값에 조건을 건 제거
 * (`if (limit < 2_000_000 && …)`)는 시험 상한이 1024B·1MB 라 초록입니다 — **상용 크기(450MB)의
 * 가드는 검사기도 시험도 안 밟습니다.** 그 공백은 ⑷ 규칙이 메웁니다. 한때 이 문단이 「그 축은
 * 시험이 잡습니다」라고만 적었는데, 그 문장이 **거짓**이었습니다(심의 반증).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CAP_SRC = fileURLToPath(new URL("../packages/core/src/untar.ts", import.meta.url));
const SOURCE_SRC = fileURLToPath(new URL("../packages/core/src/fetchSource.ts", import.meta.url));
const text = readFileSync(CAP_SRC, "utf8");
const fail = [];

/** 주석과 문자열을 지운 사본. 문면·설명은 판정 재료가 아니다(오류 문자열 안의 숫자도 마찬가지다). */
const code = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''");

/** `resolveCap` 본문. 이름·표기는 안 보고 **무엇을 하는가**만 본다. */
const capBody = /function resolveCap\s*\([^)]*\)\s*(?::[^{]*)?\{([\s\S]*?)\n\}/.exec(code)?.[1];
if (capBody === undefined) {
    fail.push("`resolveCap` 함수를 찾지 못했습니다 — 두 해제 경로가 지나는 유일한 문입니다.");
} else {
    // ⑴-a 기본값이 공용 상수인가
    if (!/\bMAX_EXTRACT_BYTES\b/.test(capBody)) {
        fail.push("`resolveCap` 이 `MAX_EXTRACT_BYTES` 를 안 씁니다 — 기본값이 limits.ts 와 갈립니다.");
    }
    // ⑴-b 호출부 값을 되죄지 않는가
    if (/\bMath\.min\b/.test(capBody)) {
        fail.push(
            "`resolveCap` 이 호출부 값을 되죕니다 — 호출부는 자기 입력에서 자기 상한을 유도합니다. " +
                "되죘더니 의존성 페이로드 해제가 **항상** 실패했습니다(마감 심의 차단).",
        );
    }
}

// ⑴-c 상수를 이 파일에서 가리지 않았는가(별칭 import · 재선언)
// ⚠ **원문에서 본다.** 지정자는 문자열 리터럴이라 위 사본에서는 지워져 있다.
if (!/import\s*\{[^}]*\bMAX_EXTRACT_BYTES\b[^}]*\}\s*from\s*["']\.\/limits\.ts["']/.test(text)) {
    fail.push("`MAX_EXTRACT_BYTES` 를 limits.ts 에서 **그 이름 그대로** 들여오지 않았습니다.");
}
if (/\b(?:const|let|var|function)\s+MAX_EXTRACT_BYTES\b/.test(code)) {
    fail.push("`MAX_EXTRACT_BYTES` 를 이 파일에서 다시 선언했습니다 — 이름은 같고 값만 다른 우회입니다.");
}

// ⑵ 두 경로가 **둘 다** 그 문을 지나는가
const buffered = /function gunzipBuffer\s*\([\s\S]*?\n\}/.exec(code)?.[0] ?? "";
const streamed = /export async function extractTarGzFile\s*\([\s\S]*?\n\}/.exec(code)?.[0] ?? "";
if (!/\bresolveCap\s*\(/.test(buffered)) fail.push("버퍼 경로(gunzipBuffer)가 `resolveCap` 을 안 지납니다.");
if (!/\bresolveCap\s*\(/.test(streamed)) fail.push("스트리밍 경로(extractTarGzFile)가 `resolveCap` 을 안 지납니다.");

// ⑶ 소스 경로의 실제 천장이 검사기 밖에 살지 않는가
//    `fetchSource.ts` 의 상한을 `Infinity` 로 바꾸면 여기까지 전부 초록이면서 상한이 사라진다(심의 우회).
const sourceCode = readFileSync(SOURCE_SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
if (!/const\s+MAX_SOURCE_EXTRACT_BYTES\s*=\s*MAX_EXTRACT_BYTES\s*;/.test(sourceCode)) {
    fail.push("`fetchSource.ts` 의 소스 상한이 `MAX_EXTRACT_BYTES` 그대로가 아닙니다 — 실제 천장이 검사기 밖에 삽니다.");
}

// ⑷ **가드가 «해결된 상한 그 자체»와 비교하는가** — 표기를 열거하지 않는다
//
// ⚠ 앞선 판이 「크기 리터럴을 찾는」 규칙을 뒀다가 표기 다섯 개에 뚫렸다(심의 실측):
//
//     limit < 2 * 1024 * 1024      ← `limits.ts` 자신이 쓰는 **집안 표기**
//     limit < 2e6                  limit < Number("2000000")      BigInt(limit) < 2_000_000n
//     maxOutputLength: cap < 2 * 1024 * 1024 ? cap : undefined
//
//   전부 `resolveCap` 은 그대로 부르므로 앞의 규칙들을 지나고, **시험도 안 문다** — 시험 상한이
//   1024B·1MB 라 「작은 상한만 지키는」 가드가 초록이기 때문이다. 즉 상용 크기(450MB)의 가드는
//   검사기도 시험도 한 번도 안 밟는다.
//
//   숫자 표기를 더 찾는 것은 **열거**다 — 이 레포가 반복해 밟은 병이고, 다음 표기에서 또 샌다.
//   뒤집는다: 가드는 **해결된 상한 변수 하나와 직접** 비교해야 한다. 그 형태가 아니면 무엇을 끼워
//   넣었든(리터럴이든 함수 호출이든) 걸린다. 덤으로 무관한 상수에 대한 오탐이 사라진다.
const capVars = new Set([...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveCap\s*\(/g)].map((m) => m[1]));

// ⚠ **모든 매치를 본다 — 첫 것만 보면 미끼 한 줄로 뚫린다.**
//   첫 판이 `.exec()` 로 첫 매치만 봤다. 그래서 앞에 죽은 미끼(`if (written > limit) { void 0; }`)를
//   두고 뒤에 진짜 가드를 되죄면 검사기가 미끼에서 멈췄다 — 5회전이 뚫은 두 형태가 미끼 한 줄로
//   부활했고 `npm run verify` 전체가 초록이었다(심의 실측).

// ⑷-a 버퍼 경로: `maxOutputLength` 는 **모든 자리에서** 해결된 상한 변수 하나여야 한다.
const capArgs = [...code.matchAll(/maxOutputLength:\s*([^,}]+?)\s*[,}]/g)];
if (capArgs.length === 0) {
    fail.push("버퍼 경로에서 `maxOutputLength` 를 찾지 못했습니다 — 상한이 zlib 에 안 걸립니다.");
}
for (const m of capArgs) {
    const arg = m[1].trim();
    if (!capVars.has(arg)) {
        fail.push(`\`maxOutputLength\` 이 해결된 상한 변수가 아닙니다: \`${arg}\` — 값에 조건을 걸면 큰 입력에서만 가드가 죽습니다.`);
    }
}

// ⑷-b 스트리밍 경로: 누적 비교는 **모든 자리에서** 상한과의 직접 비교여야 한다.
//
//   ⚠ 방향과 연산자는 안 따진다 — `written > limit`·`written >= limit`·`limit < written` 은 같은
//     뜻이거나 더 안전하다. 첫 판이 한 형태만 허용해 정당한 편집 둘을 막았다(심의 실측). 우리가
//     보는 것은 **상한 그 자체와 비교하는가**이지 표기가 아니다.
const DIRECT = /^(?:written\s*>=?\s*(?<a>[A-Za-z_$][\w$]*)|(?<b>[A-Za-z_$][\w$]*)\s*<=?\s*written)$/;
const writtenIfs = [...code.matchAll(/if\s*\(([^)]*\bwritten\b[^)]*)\)/g)];
if (writtenIfs.length === 0) {
    fail.push("스트리밍 경로에서 누적 비교(`written > …`)를 찾지 못했습니다.");
}
for (const m of writtenIfs) {
    const condition = m[1].trim();
    const parts = DIRECT.exec(condition)?.groups;
    const bound = parts?.a ?? parts?.b;
    if (bound === undefined || !capVars.has(bound)) {
        fail.push(`누적 비교가 해결된 상한과의 직접 비교가 아닙니다: \`${condition}\` — 조건을 덧붙이면 큰 입력에서만 가드가 죽습니다.`);
    }
}

if (fail.length > 0) {
    console.error(`❌ 해제 상한 일원화 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    console.error("   → 두 경로가 같은 문을 지나고, 그 문이 호출부를 되죄지 않아야 합니다.");
    process.exit(1);
}
console.log("✅ 해제 상한 일원화 — 통과 (두 경로가 같은 문 · 되죄기 없음 · 소스 천장은 limits.ts)");
