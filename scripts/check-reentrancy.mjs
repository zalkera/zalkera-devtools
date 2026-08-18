/**
 * **고객 폴더에 소스를 푸는 명령이 한 문을 지나는가.**
 *
 * ## 왜 검사기인가
 *
 * 확장 호스트 없이는 시험으로 못 잰다(`vscode` 모듈이 필요하다). 그런데 이 축은 실사용에서 실제로
 * 밟혔다: 받기는 **최대 15분**이고 취소 단추가 없어 「멈춘 것 같다」며 다른 명령을 누르는 것이
 * 자연스러운 반응인데, 「비어 있는가」 판정은 **둘 다 통과한다**(그때는 정말 비어 있다). 실측으로
 * 받기가 푼 파일이 예제 쪽 롤백에 통째로 걷혔다 — **「받았습니다」가 뜨고 폴더는 비었다.**
 *
 * ## 무엇을 보는가 — 첫 판이 안 물던 것까지
 *
 * 첫 판은 「함수 본문에 토큰이 있는가」만 봐서 **세 변이가 verify 전체 초록으로 살아남았다**:
 * `return` 만 지우기 · 가드 본문 비우기 · 잠금을 `await` 뒤로 옮기기. 토큰의 **존재**가 아니라
 * **순서와 효과**를 봐야 한다.
 *
 *  ⑴ 두 명령이 **같은 문**(`withSourceReceiveGuard`)을 지난다 — 각자 가드를 들면 한쪽만 고쳐진다.
 *  ⑵ 그 문이 잠겨 있으면 **되돌아간다**(`return`/`throw`) — 알리기만 하고 통과하면 가드가 아니다.
 *  ⑶ 잠금이 **첫 `await` 보다 앞**이다 — 사이에 `await` 가 있으면 check-then-act 다. 첫 판이
 *     폴더 대화상자 뒤에 잠갔다가 그 형상이 됐다(파일시스템 자물쇠에서 세 라운드 깨진 그것).
 *  ⑷ 해제가 **`finally`** 다 — 성공 경로에서만 풀면 한 번의 실패로 영영 잠긴다(`previewStarting`
 *     이 실제로 그랬다: 창을 새로 열 때까지 「준비하는 중입니다」만 반복했고 준비 중인 것은 없었다).
 *
 * ## 무엇을 안 보는가
 *
 * **창이 둘일 때는 애초에 못 막는다** — 프로세스 안 변수라서다. 알려진 한계이고, 그 사실을
 * 배송 주석이 정확히 말하는지도 이 검사기가 함께 본다(⑸).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../packages/vscode/src/extension.ts", import.meta.url));

/**
 * ⚠ **주석을 지운 사본에서 잰다.** 안 지우면 `// receivingSource = true;` 로 **주석 처리한 것**이
 *   여전히 「잠근다」로 세어진다(변이가 살아남았다). 문면은 코드가 아니다.
 */
const raw = readFileSync(SRC, "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const fail = [];

const GUARD = "withSourceReceiveGuard";
const FLAG = "receivingSource";
/** 고객 폴더에 소스를 푸는 명령. 새로 생기면 여기 적는다 — 표가 곧 계약이다. */
const RECEIVERS = ["openSite", "startFromExample"];

/** 함수 본문. 중첩 함수·화살표 표기에서도 절단이 틀리지 않게 **중괄호를 센다.** */
function bodyOf(name) {
    const head = new RegExp(`(?:async\\s+function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=\\s*async\\s*\\()`).exec(code);
    if (head === null) return null;
    const open = code.indexOf("{", head.index + head[0].length - 1);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
        if (code[i] === "{") depth += 1;
        else if (code[i] === "}") {
            depth -= 1;
            if (depth === 0) return code.slice(open, i + 1);
        }
    }
    return null;
}

// ⑴ 두 명령이 같은 문을 지나는가
for (const name of RECEIVERS) {
    const body = bodyOf(name);
    if (body === null) {
        fail.push(`\`${name}\` 을 찾지 못했습니다 — 이름이 바뀌었다면 이 표도 고치십시오.`);
        continue;
    }
    if (!new RegExp(`\\b${GUARD}\\s*\\(`).test(body)) {
        fail.push(`\`${name}\` 이 \`${GUARD}\` 를 안 지납니다 — 고객 폴더에 소스를 푸는 명령은 한 문을 지나야 합니다.`);
    }
}

// ⑵⑶⑷ 그 문 자체
const guard = bodyOf(GUARD);
if (guard === null) {
    fail.push(`\`${GUARD}\` 을 찾지 못했습니다.`);
} else {
    // ⑵ 잠겨 있으면 되돌아가는가 — 알리기만 하고 통과하면 가드가 아니다.
    const taken = new RegExp(`if\\s*\\(\\s*${FLAG}\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(guard);
    if (taken === null) {
        fail.push(`\`${GUARD}\` 에 \`if (${FLAG})\` 분기가 없습니다.`);
    } else if (!/\breturn\b|\bthrow\b/.test(taken[1])) {
        fail.push(`\`${GUARD}\` 이 잠겨 있는데 **되돌아가지 않습니다** — 알리기만 하고 통과하면 가드가 아닙니다.`);
    }

    // ⑶ 잠금이 첫 `await` 보다 앞인가 — 사이에 await 가 있으면 check-then-act 다.
    const lockAt = guard.search(new RegExp(`${FLAG}\\s*=\\s*true`));
    if (lockAt === -1) {
        fail.push(`\`${GUARD}\` 이 \`${FLAG}\` 를 잠그지 않습니다.`);
    } else {
        const firstAwait = guard.search(/\bawait\b/);
        if (firstAwait !== -1 && firstAwait < lockAt) {
            fail.push(
                `\`${GUARD}\` 이 **\`await\` 뒤에** 잠급니다 — 판정과 점유 사이에 틈이 생겨 두 실행이 ` +
                    `둘 다 통과합니다(check-then-act). 진입 즉시 잠그십시오.`,
            );
        }
    }

    // ⑷ 해제가 finally 인가
    if (!new RegExp(`finally\\s*\\{[^}]*${FLAG}\\s*=\\s*false`).test(guard)) {
        fail.push(`\`${GUARD}\` 이 \`${FLAG}\` 를 \`finally\` 에서 풀지 않습니다 — 한 번의 실패로 영영 잠깁니다.`);
    }
}

// ⑸ 배송 문면이 실제 범위를 말하는가 — 넓게 말하면 그것이 거짓 안심이다
if (!/창이 둘|프로세스가 둘/.test(raw)) {
    fail.push("가드의 **알려진 한계**(창이 둘일 때는 못 막는다)가 주석에 없습니다 — 넓게 말하면 거짓 안심입니다.");
}

if (fail.length > 0) {
    console.error(`❌ 재진입 가드 검사 — ${fail.length}건:`);
    for (const f of fail) console.error(`   · ${f}`);
    process.exit(1);
}
console.log(`✅ 재진입 가드 — 통과 (수신 명령 ${RECEIVERS.length}종이 한 문 · 진입 즉시 잠금 · finally 해제)`);
