#!/usr/bin/env node
/**
 * `npm audit` 게이트.
 *
 * ■ 왜 그냥 `npm audit` 이 아닌가
 *   오늘 **9건의 자문이 이미 떠 있고 고칠 방법이 없다.** 전부 우리가 VSIX 에 실어 나르는 `npm` CLI
 *   하나에서 나오는데, `npm@12.0.2` 가 **최신**이고 `npm audit fix` 는 아무것도 못 고친다(실측).
 *   그대로 `npm audit` 을 걸면 CI 가 첫날부터 빨갛고, 빨간 게이트는 **아무도 안 본다** — 그러면
 *   새 취약점이 와도 같은 빨강에 묻힌다.
 *
 * ■ 그래서 무엇을 하나
 *   **알려진 것만 통과시키고 새것은 막는다.** 아래 [ACCEPTED] 에 자문 번호를 적고, 목록에 없는
 *   것이 하나라도 나오면 실패한다. 받아들인 위험이 **코드에 적혀 있어야** 누군가 다시 볼 수 있다.
 *
 *   ⚠ **목록은 짧아야 한다.** 여기 줄이 늘어나면 그건 "우리가 위험을 관리한다"가 아니라
 *   "우리가 경고를 끈다"는 뜻이다. 추가할 때는 근거를 함께 적어라.
 *
 * ■ 고쳐진 것도 잡는다
 *   [ACCEPTED] 에 있는데 **더는 안 뜨는** 자문은 알려 준다(실패는 아니다). 낡은 면제가 남아 있으면
 *   다음 취약점이 그 그늘에 숨는다.
 */
import { execFileSync } from "node:child_process";

/**
 * 받아들인 위험. **전부 `npm` CLI 의 전이 의존이다.**
 *
 * 왜 받아들이나: 이 `npm` 은 **의존성 페이로드를 못 받았을 때의 폴백 설치기**다(`runtime.ts`).
 * 고객이 자기 프로젝트에서 자기 레지스트리로 설치할 때만 돌고, 그 경로를 타려면 공격자가 이미
 * 그 레지스트리나 그 프로젝트를 쥐고 있어야 한다. 그리고 **오늘 올릴 상위 버전이 없다.**
 *
 * 언제 걷어내나: `npm` 이 새 판을 내면 이 목록을 다시 재라. 줄이 사라지면 지워라.
 */
const ACCEPTED = new Map([
    [1130591, "brace-expansion DoS — npm 전이"],
    [1130734, "brace-expansion DoS(우회) — npm 전이"],
    [1130722, "ip-address 선행 0 옥텟 — npm 전이"],
    [1130723, "ip-address CIDR 접미 — npm 전이"],
    [1130724, "ip-address IPv4-mapped 오분류 — npm 전이"],
    [1124287, "node-tar 재귀 DoS — npm 전이"],
    [1130716, "undici 응답 desync — npm 전이"],
    [1130727, "undici CRLF 주입 — npm 전이"],
    [1130732, "undici 쿠키 속성 주입 — npm 전이"],
]);

let raw;
try {
    // audit 은 취약점이 있으면 **0 이 아닌 코드로 끝난다** — 그건 정상이고, 우리는 본문을 읽는다.
    raw = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
    raw = error.stdout;
    if (!raw) {
        console.error("✗ npm audit 을 실행하지 못했습니다:", error.message);
        process.exit(1);
    }
}

let report;
try {
    report = JSON.parse(raw);
} catch {
    console.error("✗ npm audit 출력을 읽지 못했습니다 — 형식이 바뀌었을 수 있습니다.");
    process.exit(1);
}

const found = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via) {
        if (typeof via === "object" && via.source) {
            found.set(via.source, { name: via.name, severity: via.severity, title: via.title ?? "" });
        }
    }
}

const fresh = [...found].filter(([id]) => !ACCEPTED.has(id));
const stale = [...ACCEPTED.keys()].filter((id) => !found.has(id));

if (stale.length > 0) {
    console.log(`· 면제 목록에서 사라진 자문 ${stale.length}건 — 지워도 됩니다: ${stale.join(", ")}`);
}

if (fresh.length > 0) {
    console.error(`✗ 새 취약점 ${fresh.length}건 — 면제 목록에 없습니다.`);
    for (const [id, v] of fresh) {
        console.error(`   [${v.severity}] ${v.name} (자문 ${id}) — ${v.title}`);
    }
    console.error("\n  고칠 수 있으면 고치십시오. 받아들일 것이면 scripts/check-audit.mjs 에 **근거와 함께** 적으십시오.");
    process.exit(1);
}

console.log(`✓ 새 취약점 없음 (받아들인 것 ${ACCEPTED.size}건 — 전부 동봉 npm CLI 의 전이 의존)`);
