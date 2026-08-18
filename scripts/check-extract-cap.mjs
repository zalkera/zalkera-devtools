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
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../packages/core/src/untar.ts", import.meta.url));
const text = readFileSync(SRC, "utf8");
const fail = [];

// ⑴ 죄는 상대가 공용 상수인가
if (!/return Math\.min\(maxBytes \?\? MAX_EXTRACT_BYTES, MAX_EXTRACT_BYTES\);/.test(text)) {
    fail.push("`resolveCap` 이 MAX_EXTRACT_BYTES 로 죄지 않습니다 — 파일 안 리터럴로 죄면 limits.ts 와 갈립니다.");
}

// ⑵ 두 경로가 모두 그 문을 지나는가
const buffered = /const cap = resolveCap\(maxBytes\);/.test(text);
const streamed = /const limit = resolveCap\(options\.maxBytes\)/.test(text);
if (!buffered) fail.push("버퍼 경로(gunzipBuffer)가 `resolveCap` 을 안 지납니다.");
if (!streamed) fail.push("스트리밍 경로(extractTarGzFile)가 `resolveCap` 을 안 지납니다.");

// ⑶ 크기 리터럴이 남아 있지 않은가 — 주석은 뺀다(주석은 값이 아니다)
const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
for (const m of code.matchAll(/\b\d+\s*\*\s*1024\s*\*\s*1024\b/g)) {
    fail.push(`크기 리터럴이 남아 있습니다: \`${m[0]}\` — 상한은 limits.ts 가 유도합니다.`);
}

if (fail.length > 0) {
    console.error(`❌ 해제 상한 일원화 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    console.error("   → 두 경로가 같은 문을 지나야 합니다. `resolveCap` 을 쓰십시오.");
    process.exit(1);
}
console.log("✅ 해제 상한 일원화 — 통과 (두 경로가 같은 문 · 천장은 limits.ts)");
