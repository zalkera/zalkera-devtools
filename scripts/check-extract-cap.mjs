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
 *  ⑴ `resolveCap` 이 [MAX_EXTRACT_BYTES] 로 죈다 — 파일 안 리터럴로 죄면 `limits.ts` 와 갈린다.
 *  ⑵ 두 해제 경로가 **둘 다** `resolveCap(` 을 지난다.
 *  ⑶ `untar.ts` 안에 크기 리터럴이 없다 — 상한은 `limits.ts` 에서 온다.
 *
 * ## 이 검사기가 못 하는 것 — 적어 둔다
 *
 * **형태만 봅니다.** 값을 딴 이름으로 계산해 끼워 넣거나(`const c2 = options.maxBytes ?? limit`),
 * `limits.ts` 쪽 유도식을 바꾸는 우회는 못 잡습니다. 이 검사기가 막는 것은 **되돌아가는 편집**
 * (되죄기 부활 · 한쪽 경로만 날값 · 리터럴 재도입)이지 작정한 우회가 아닙니다. 그 선을 넘는
 * 것은 시험이 해야 하는데, 천장을 관찰하려면 수백 MB 픽스처가 필요해 이 자리에서는 못 합니다 —
 * 대신 `resolveCap` 을 노출해 **그 함수의 계약**을 `limits.test.ts` 가 직접 잽니다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../packages/core/src/untar.ts", import.meta.url));
const text = readFileSync(SRC, "utf8");
const fail = [];

// ⑴ 기본값이 공용 상수인가 — 그리고 **되죄지 않는가**
//
// ⚠ 이 검사기의 첫 판이 `Math.min(…)` 문자열을 **요구**했다. 그 되죄기가 바로 뒤에 차단으로
//   드러났는데(페이로드 경로가 통째로 막혔다), 검사기는 그것을 요구사항으로 굳혀 두어 고치려는
//   손을 빨간불로 막았다. **검사기도 심의 대상이다.**
if (!/return maxBytes \?\? MAX_EXTRACT_BYTES;/.test(text)) {
    fail.push("`resolveCap` 이 `maxBytes ?? MAX_EXTRACT_BYTES` 가 아닙니다 — 기본값은 공용 상수여야 합니다.");
}
if (/resolveCap[\s\S]{0,200}?Math\.min/.test(text)) {
    fail.push("`resolveCap` 이 호출부 값을 되죕니다 — 호출부는 자기 입력에서 자기 상한을 유도합니다(마감 심의 차단).");
}
// ⑴-b 상수를 이 파일에서 가려 놓지 않았는가(별칭 import 로 이름만 남기는 우회)
if (!/import \{[^}]*\bMAX_EXTRACT_BYTES\b[^}]*\} from "\.\/limits\.ts";/.test(text)) {
    fail.push("`MAX_EXTRACT_BYTES` 를 limits.ts 에서 **그 이름 그대로** 들여오지 않았습니다.");
}
if (/\b(?:const|let|var|function)\s+MAX_EXTRACT_BYTES\b/.test(text)) {
    fail.push("`MAX_EXTRACT_BYTES` 를 이 파일에서 다시 선언했습니다 — 이름은 같고 값만 다른 우회입니다.");
}

// ⑵ 두 경로가 모두 그 문을 지나는가
const buffered = /const cap = resolveCap\(maxBytes\);/.test(text);
const streamed = /const limit = resolveCap\(options\.maxBytes\)/.test(text);
if (!buffered) fail.push("버퍼 경로(gunzipBuffer)가 `resolveCap` 을 안 지납니다.");
if (!streamed) fail.push("스트리밍 경로(extractTarGzFile)가 `resolveCap` 을 안 지납니다.");

// ⑶ 크기 리터럴이 남아 있지 않은가 — 주석은 뺀다(주석은 값이 아니다)
const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
// 표기를 가리지 않는다 — `200 * 1024 * 1024` 도 `0x8000_0000` 도 `209715200` 도 같은 것이다.
//
// ⚠ **바이트 규모만 본다.** 이 파일에는 개수 상한(`MAX_ENTRIES = 200_000`)도 산다. 그것은 크기가
//   아니라 **셈**이고 `limits.ts` 의 관할이 아니다 — 규모로 가른다(1,000,000 미만은 셈으로 본다).
for (const m of code.matchAll(/\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*\b|\b\d+\s*\*\s*1024\b/g)) {
    const token = m[0];
    if (/\*/.test(token)) {
        fail.push(`크기 리터럴이 남아 있습니다: \`${token}\` — 상한은 limits.ts 가 유도합니다.`);
        continue;
    }
    const value = Number(token.replace(/_/g, ""));
    if (Number.isFinite(value) && value >= 1_000_000) {
        fail.push(`크기 리터럴이 남아 있습니다: \`${token}\` — 상한은 limits.ts 가 유도합니다.`);
    }
}

if (fail.length > 0) {
    console.error(`❌ 해제 상한 일원화 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    console.error("   → 두 경로가 같은 문을 지나야 합니다. `resolveCap` 을 쓰십시오.");
    process.exit(1);
}
console.log("✅ 해제 상한 일원화 — 통과 (두 경로가 같은 문 · 천장은 limits.ts)");
