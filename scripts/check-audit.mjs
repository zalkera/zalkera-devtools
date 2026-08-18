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
 *
 * ■ **못 잰 것은 통과가 아니다**
 *   `npm audit` 은 레지스트리에 못 닿으면 취약점 목록이 없는 보고서를 낸다. 종전에는
 *   `report.vulnerabilities ?? {}` 로 받아 그것이 **「취약점 0건」과 같은 답**이 됐다 — 사내망
 *   프록시 뒤나 오프라인 CI 에서 이 게이트가 언제나 초록이었고, 초록인 이유가 "안전해서"인지
 *   "못 재서"인지 출력만 봐서는 구별되지 않았다(심의 지적).
 *
 *   [whyUnmeasured] 가 보고서의 형상을 먼저 본다. 재지 못했으면 rc=2 로 끊는다 — 실패(rc=1)와도
 *   구별되는 코드다.
 *
 *   재현: `node -e 'import("./scripts/check-audit.mjs").then(m=>console.log(m.whyUnmeasured({})))'`
 *   (판정만 불러 보려고 import 했을 때 감사가 통째로 도는 일이 없도록, 본문은 직접 실행일 때만 돈다.)
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * 이 보고서가 **실제로 잰 것**인가. 잰 것이면 `null`, 아니면 사람에게 보여 줄 이유.
 *
 * 판정 넷은 전부 "없는데 있는 척"을 막는다:
 *   ⑴ 형상을 아는 보고서인가 — `auditReportVersion` 이 없으면 우리가 읽는 그 형식이 아니다
 *   ⑵ 오류 보고서가 아닌가 — npm 은 실패를 `error` 로 실어 보내면서 종료코드는 0 일 수 있다
 *   ⑶ 취약점 칸이 **존재**하는가 — 비어 있는 것과 없는 것은 다른 사실이다
 *   ⑷ 잰 의존이 하나라도 있는가 — 0 개를 훑고 "0건"이라 답하면 그건 측정이 아니다
 */
export function whyUnmeasured(report) {
    if (report === null || typeof report !== "object") return "보고서가 객체가 아닙니다";
    if (report.error !== undefined) {
        // `??` 로 이으면 빈 문자열이 통과해 이유가 사라진다 — npm 이 실제로 빈 summary 를 준다(실측).
        const e = report.error ?? {};
        const detail = e.summary || e.code || e.message || JSON.stringify(report.error).slice(0, 200);
        return `npm audit 이 오류를 보고했습니다: ${detail}`;
    }
    if (typeof report.auditReportVersion !== "number") {
        return "auditReportVersion 이 없습니다 — 우리가 읽는 형식이 아닙니다";
    }
    if (!Object.hasOwn(report, "vulnerabilities") || typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
        return "취약점 칸이 없습니다 — 비어 있는 것과 없는 것은 다른 사실입니다";
    }
    const total = report.metadata?.dependencies?.total;
    if (typeof total !== "number" || total <= 0) {
        return `잰 의존이 ${total ?? "(없음)"} 개입니다 — 훑은 것이 없으면 «0건»은 측정이 아닙니다`;
    }
    return null;
}

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

// 판정([whyUnmeasured])은 import 로 불러 확인할 수 있어야 하고, 그때 감사가 돌면 안 된다.
if (process.argv[1] !== fileURLToPath(import.meta.url)) {
    // 라이브러리로 불렸다 — 아래 게이트는 돌지 않는다.
} else {
    run();
}

function run() {
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

const unmeasured = whyUnmeasured(report);
if (unmeasured !== null) {
    console.error(`✗ npm audit 결과를 신뢰할 수 없습니다 — ${unmeasured}`);
    console.error("  통과가 아닙니다. 레지스트리 접근·프록시 설정을 확인하고 다시 돌리십시오.");
    process.exit(2);
}

const found = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
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

console.log(
    `✓ 새 취약점 없음 (의존 ${report.metadata.dependencies.total}개를 훑음 · ` +
        `받아들인 것 ${ACCEPTED.size}건 — 전부 동봉 npm CLI 의 전이 의존)`,
);
}
