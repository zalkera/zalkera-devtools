/**
 * **오래 도는 명령에는 재진입 가드가 있는가 — 그리고 `finally` 로 푸는가.**
 *
 * ## 왜 검사기인가
 *
 * 이 성질은 확장 호스트 없이는 시험으로 못 잰다(`vscode` 모듈이 필요하다). 그런데 두 축 모두
 * 실사용에서 실제로 밟혔다:
 *
 *  · **가드 부재** — 받기는 최대 15분이고 취소 단추가 없다. 「멈춘 것 같다」며 다시 누르면 두
 *    받기가 같은 폴더를 목표로 돌고, 「비어 있는가」 판정은 둘 다 통과한다(그때는 정말 비어 있다).
 *    두 소스가 겹쳐 써지고 **둘 다 성공을 보고**한다.
 *  · **`finally` 부재** — 성공 경로에서만 풀면 한 번의 실패로 가드가 영영 잠긴다. `previewStarting`
 *    이 실제로 그랬다: 창을 새로 열 때까지 「준비하는 중입니다」만 반복했고, 준비 중인 것은 없었다.
 *
 * ## 무엇을 안 보는가
 *
 * **창이 둘일 때는 못 막습니다.** 프로세스 안 변수라서다. 그것까지 막으려면 파일시스템 자물쇠가
 * 필요한데, 그 길은 심의 세 라운드 연속으로 실패했다 — 파일시스템은 「주인이 살아 있는가」를
 * 답해 주지 않고, 그 대리 지표(mtime·pid)는 어느 방향으로 틀려도 사용자에게 보이는 고장을 낸다.
 * 커널이 그 답을 주는 `flock` 은 Node 표준 라이브러리에 없다. 알려진 한계로 둔다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../packages/vscode/src/extension.ts", import.meta.url));
/**
 * ⚠ **주석을 지운 사본에서 잰다.** 안 지우면 `// fetchingSource = true;` 로 **주석 처리한 것**이
 *   여전히 「잠근다」로 세어진다(변이가 살아남았다). 이 레포가 반복해 밟은 함정이다 —
 *   문면은 코드가 아니다.
 */
const text = readFileSync(SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const fail = [];

/** 오래 도는 명령과 그 가드 변수. 새 장기 명령이 생기면 여기 적는다. */
const GUARDED = [
    { fn: "openSite", flag: "fetchingSource", why: "소스 받기(최대 15분·취소 단추 없음)" },
    { fn: "startPreviewCommand", flag: "previewStarting", why: "프리뷰 시작(첫 실행은 수 분짜리 설치)" },
];

for (const { fn, flag, why } of GUARDED) {
    const body = new RegExp(`async function ${fn}\\s*\\([\\s\\S]*?\\n\\}`).exec(text)?.[0];
    if (body === undefined) {
        fail.push(`\`${fn}\` 을 찾지 못했습니다 — 이름이 바뀌었다면 이 표도 고치십시오(${why}).`);
        continue;
    }
    if (!new RegExp(`if\\s*\\(${flag}\\)`).test(body)) {
        fail.push(`\`${fn}\` 에 재진입 가드(\`if (${flag})\`)가 없습니다 — ${why}.`);
    }
    if (!new RegExp(`${flag}\\s*=\\s*true`).test(body)) {
        fail.push(`\`${fn}\` 이 \`${flag}\` 를 잠그지 않습니다 — 가드가 영영 안 걸립니다.`);
    }
    // **`finally` 로 푸는가.** 성공 경로에서만 풀면 한 번의 실패로 영영 잠긴다.
    const finallyBlock = new RegExp(`finally\\s*\\{[^}]*${flag}\\s*=\\s*false`).test(body);
    if (!finallyBlock) {
        fail.push(`\`${fn}\` 이 \`${flag}\` 를 \`finally\` 에서 풀지 않습니다 — 한 번의 실패로 영영 잠깁니다.`);
    }
}

if (fail.length > 0) {
    console.error(`❌ 재진입 가드 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    process.exit(1);
}
console.log(`✅ 재진입 가드 — 통과 (장기 명령 ${GUARDED.length}종 · 전부 finally 해제)`);
