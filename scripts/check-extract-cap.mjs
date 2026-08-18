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

// ⑷ 상한 판정에 **크기 리터럴**이 끼지 않았는가
//
// ⚠ 직전 판이 이 규칙을 **삭제**했다가 우회 두 개를 놓쳤다(심의 실측):
//
//     if (limit < 2_000_000 && written > limit)          ← 스트리밍 상한 무력화
//     maxOutputLength: cap < 2_000_000 ? cap : undefined ← 버퍼 상한 무력화
//
//   둘 다 `resolveCap` 은 그대로 부르므로 위 규칙들을 전부 통과하고, **시험도 안 문다** — 시험의
//   상한이 1024B·1MB 라 «작은 상한만 지키는» 가드가 초록이기 때문이다. 상용 크기(450MB)의 가드는
//   검사기도 시험도 한 번도 안 밟는다. 그 공백을 메우는 것이 이 규칙이다.
//
//   삭제됐던 이유는 오탐이었다 — 셈 상수(`MAX_ENTRIES`)와 **오류 문자열 안의 숫자**를 함께 잡았다.
//   지금은 주석·문자열을 지운 사본(`code`)에서 재고 셈 규모를 가르므로 그 둘이 안 걸린다(실측).
for (const m of code.matchAll(/\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*\b/g)) {
    const value = Number(m[0].replace(/_/g, ""));
    if (Number.isFinite(value) && value >= 1_000_000) {
        fail.push(`크기 리터럴이 남아 있습니다: \`${m[0]}\` — 상한은 limits.ts 가 유도합니다.`);
    }
}

if (fail.length > 0) {
    console.error(`❌ 해제 상한 일원화 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    console.error("   → 두 경로가 같은 문을 지나고, 그 문이 호출부를 되죄지 않아야 합니다.");
    process.exit(1);
}
console.log("✅ 해제 상한 일원화 — 통과 (두 경로가 같은 문 · 되죄기 없음 · 소스 천장은 limits.ts)");
