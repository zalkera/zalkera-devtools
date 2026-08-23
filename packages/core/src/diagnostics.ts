/**
 * F2「실시간 진단」의 **판정부**(memo146 §5 F2). 편집기 연동은 확장이 하고, 규칙은 전부 여기 산다 —
 * CLI 도 같은 판정을 쓸 수 있어야 하고, 규칙이 확장 안에 있으면 그러지 못한다.
 *
 * **기계적으로 결정 가능한 것만 본다.** "이 코드가 좋은가"는 우리 일이 아니고(그건 고객의 AI 가 한다),
 * 여기서 잡는 것은 **우리 플랫폼의 계약을 어겨서 배포 후에야 드러나는 것**뿐이다.
 */
export interface Diagnostic {
    /** 0부터 세는 줄 번호. */
    line: number;
    column: number;
    length: number;
    severity: "error" | "warning";
    message: string;
    /** 규칙 식별자 — 사용자가 검색할 수 있게. */
    rule: string;
}

/** 접미 이름들. 순서는 판정에 영향이 없다 — 존재만 본다. */
const SECRET_SUFFIXES = ["KEY", "SECRET", "TOKEN", "PASSWORD"];

/**
 * `NEXT_PUBLIC_…KEY|SECRET|TOKEN|PASSWORD` 를 찾는다. **선형이다.**
 *
 * 식별자를 최대 munch 로 물면 매치가 겹치지 않아 훑기가 한 번이고, 접미는 그 매치 안에서
 * `endsWith` 로 본다. 정규식 하나로 하려 들면 접미 대안이 문자류의 부분집합이라 모호해진다.
 */
function matchPublicSecret(line: string): {0: string; index: number} | null {
    for (const m of line.matchAll(/NEXT_PUBLIC_[A-Z0-9_]*/g)) {
        const text = m[0];
        if (m.index === undefined) continue;
        // ⚠ **가장 늦게 끝나는 접미를 고른다.** 종전 정규식의 `*` 는 탐욕적이라 끝에서 되돌아오며
        //   **가장 긴 매치**를 냈다. 순서대로 첫 접미를 잡으면 `NEXT_PUBLIC_KEY_SECRET` 에서
        //   길이가 22 대신 15 가 되어 밑줄이 짧아진다(실측으로 갈렸다).
        let end = -1;
        for (const suffix of SECRET_SUFFIXES) {
            const at = text.lastIndexOf(suffix);
            if (at < 0) continue;
            if (at + suffix.length > end) end = at + suffix.length;
        }
        if (end > 0) return {0: text.slice(0, end), index: m.index};
    }
    return null;
}

/**
 * 파일 하나를 본다. 경로와 내용만으로 판정한다(빌드·타입 정보 없음 — 저장할 때마다 도는 것이라 싸야 한다).
 */
export function diagnose(filePath: string, content: string): Diagnostic[] {
    const found: Diagnostic[] = [];
    const lines = content.split("\n");
    // ⚠ **`^` 가 이미 줄머리를 준다 — `\s*` 가 개행을 넘을 이유가 없다.** 넘게 두면 빈 줄이 이어질
    //   때 줄머리마다 끝까지 훑고 되돌아와 비용이 제곱이 된다(실측: 빈 줄 100KB `.tsx` 하나로
    //   `refreshDiagnostics` 가 6.4초). 이 판정은 **여는 모든 파일에 무조건** 돌므로, 아래 규칙들보다
    //   전제조건이 적다 — 받은 소스 팩에 그런 파일 하나면 편집기가 선다.
    const isClientComponent = /^[^\S\n]*["']use client["']/m.test(content);

    lines.forEach((line, index) => {
        // ① 브라우저에서 백엔드로 직접 fetch — memo61 이 실측으로 "브라우저→백엔드 fetch 0" 을 확인하고
        //    동적 CORS 를 DON'T-BUILD 로 못박은 축이다. 이것을 쓰면 배포 후 CORS 로 죽고, 원인이 안 보인다.
        if (isClientComponent) {
            // ⚠ **모호한 반복을 두지 않는다.** 종전 형태는 `\s*` 둘 사이에 선택 문자만 있어서,
            //   공백이 길고 뒤의 `ZALKERA_API_BASE` 가 없을 때 공백을 두 반복에 나누는 경우의 수만큼
            //   되돌아왔다 — 비용이 줄 길이의 제곱이다. 이 함수는 **문서를 열 때와 저장할 때마다**
            //   확장 호스트 스레드에서 동기로 돌고, 그 스레드는 다른 확장과 공유한다. 받은 소스 팩에
            //   그런 줄 하나가 있으면 편집기가 선다.
            //
            //   ⚠ **상한으로 막지 않는다.** `{0,32}` 를 쓴 판을 냈다가 잡혔다 — 유계는 문자 종류로는
            //     상위집합이어도 **길이로는 부분집합**이라, 공백 33자를 낀 줄을 종전은 잡고 이 판은
            //     놓쳤다(탐지 회귀). 대신 **각 반복이 반드시 1자 이상을 소비하게** 만든다:
            //     `(?:[`"'${]\s*)*` 의 안쪽은 첫 글자가 반드시 소비되므로 공백을 나눠 가질 경우의
            //     수가 생기지 않는다. 길이는 무계로 두고 모호성만 없앤다.
            const direct =
                /\b(?:fetch|axios)\s*\(\s*(?:[`"'${]\s*)*(?:process\.env\.)?(?:NEXT_PUBLIC_)?ZALKERA_API_BASE/.exec(
                    line,
                );
            if (direct) {
                found.push({
                    line: index,
                    column: direct.index,
                    length: direct[0].length,
                    severity: "error",
                    rule: "zalkera/no-browser-direct-fetch",
                    message: "브라우저에서 잘커라 API 를 직접 부르면 배포 후 막힙니다. 서버 컴포넌트나 라우트 핸들러(BFF)에서 부르세요.",
                });
            }
        }

        // ② 자격증명을 브라우저 번들에 싣는 자리. `NEXT_PUBLIC_` 은 클라이언트로 그대로 나간다.
        // ⚠ **여기도 모호한 반복이었다.** 종전 형태 `NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|…)` 는
        //   접미 대안이 앞 문자류의 **부분집합**이라, `NEXT_PUBLIC_` 이 대문자 런 안에 여러 번
        //   나오면 시작점마다 줄 끝까지 훑고 되돌아온다 — 비용이 줄 길이의 제곱이다.
        //   바로 위 규칙 ①에서 같은 병을 고쳤는데 **이 형제를 안 봤다.**
        //
        //   처방: 식별자를 **최대 munch 로 먼저 물고**(겹치지 않아 선형) 접미는 그 안에서 본다.
        //   ⚠ 부정 lookahead 안에 같은 대안을 넣는 형태는 **같은 모호성을 다시 들여온다** —
        //     lookahead 없는 이 형태로 둘 것.
        //   재현: `node -e 'const{diagnose}=require("./packages/core/dist/diagnostics.js");
        //         const s="NEXT_PUBLIC_".repeat(34133);const t=Date.now();diagnose("a.tsx",s);
        //         console.log(Date.now()-t+"ms")'` → 종전 12,405ms · 지금 1ms
        const publicSecret = matchPublicSecret(line);
        if (publicSecret && !/PREVIEW/.test(publicSecret[0])) {
            found.push({
                line: index,
                column: publicSecret.index,
                length: publicSecret[0].length,
                severity: "error",
                rule: "zalkera/no-public-secret",
                message: `${publicSecret[0]} 은 브라우저 번들에 그대로 실립니다. 서버 전용 이름(NEXT_PUBLIC_ 없이)을 쓰세요.`,
            });
        }

        // ③ 스토어프론트 키를 소스에 박는 자리. 원문은 발급 응답 1회뿐이고 소스에 있으면 안 된다.
        const literalKey = /oqsk_[A-Za-z0-9]{8,}/.exec(line);
        if (literalKey) {
            found.push({
                line: index,
                column: literalKey.index,
                length: literalKey[0].length,
                severity: "error",
                rule: "zalkera/no-literal-key",
                message: "스토어프론트 키가 소스에 박혀 있습니다. .env.local 로 옮기고 이 키는 콘솔에서 폐기하세요.",
            });
        }
    });

    // ④ 없는 client API 호출 — 설치된 패키지가 실제로 내보내는 이름과 대조한다(대조할 수 없으면 안 본다).
    return found;
}

/**
 * `@zalkera/client` 호출 이름을 **설치된 패키지의 실제 export 와** 대조한다.
 *
 * 목록을 우리가 들고 있지 않는 것이 핵심이다 — 들고 있으면 client 가 성장할 때마다 어긋나고, 그 어긋남이
 * 고객에게는 "잘커라 도구가 틀렸다"로 보인다. 대조할 목록을 얻지 못하면(미설치 등) **아무 말도 하지 않는다.**
 */
export function diagnoseClientUsage(content: string, knownExports: readonly string[]): Diagnostic[] {
    if (knownExports.length === 0) return [];
    const known = new Set(knownExports);
    const found: Diagnostic[] = [];

    content.split("\n").forEach((line, index) => {
        const importMatch = /import\s*\{([^}]+)\}\s*from\s*["']@zalkera\/client["']/.exec(line);
        if (!importMatch?.[1]) return;
        for (const raw of importMatch[1].split(",")) {
            const name = raw.split(" as ")[0]?.trim().replace(/^type\s+/, "");
            if (!name || known.has(name)) continue;
            const column = line.indexOf(name);
            found.push({
                line: index,
                column: column < 0 ? 0 : column,
                length: name.length,
                severity: "warning",
                rule: "zalkera/unknown-client-export",
                message: `@zalkera/client 에 '${name}' 이 없습니다. 설치된 버전이 오래됐거나 이름이 바뀌었을 수 있습니다.`,
            });
        }
    });
    return found;
}

/**
 * 보호 경로의 **종류**. 문면이 아니라 이것으로 「이미 알렸는가」를 센다.
 *
 * ⚠ **경로마다 세면 토스트가 쏟아진다.** VS Code 는 재시작할 때 열려 있던 편집기를 **한꺼번에**
 *   되열고, 그때 `dist/` 아래 파일 셋이 열려 있으면 경고창이 셋 뜬다. 사용자가 보는 것은
 *   「무슨 일이 났나」이지 조언이 아니다. 종류로 세면 같은 조언이 두 번 뜰 수 없다 —
 *   조언은 파일마다 다르지 않고 **셋뿐**이다.
 */
export type ProtectedKind = "credential" | "dependencies" | "build-output";

/** 이 경로가 어느 종류의 보호 자리인가. 아니면 `null`. */
export function protectedPathKind(relativePath: string): ProtectedKind | null {
    const normalized = relativePath.replace(/\\/g, "/");
    // `zip.ts` 의 제외와 **같은 가정을 써야 한다** — 빼는 규칙과 알리는 규칙이 갈리면,
    // 빠진 줄 모르고 고치게 된다.
    if (/^\.env/.test(normalized)) return "credential";
    if (normalized.startsWith("node_modules/")) return "dependencies";
    if (normalized.startsWith(".next/") || normalized.startsWith("dist/") || normalized.startsWith("out/")) {
        return "build-output";
    }
    return null;
}

const PROTECTED_SAY: Readonly<Record<ProtectedKind, string>> = {
    credential:
        "이 파일에는 자격증명이 들어 있습니다. 값을 손으로 고치면 미리보기가 끊길 수 있고, 커밋하면 밖으로 나갑니다.",
    dependencies:
        "의존성 폴더는 캐시와 하드링크로 묶여 있어, 여기서 고치면 이 기계의 다른 프로젝트까지 번질 수 있습니다.",
    "build-output": "빌드 산출물이라 다음 빌드에 덮어써집니다. 소스를 고치세요.",
};

/**
 * F1「보호 경로 경고」(§5 F1) — **막지 않고 알린다.**
 *
 * 고객 소스는 고객 것이라 편집을 막을 권리가 우리에게 없다. 다만 **되돌리기 어려운 손해**로
 * 이어지는 자리는 알려 준다: 자격증명 파일, 의존성 트리(캐시와 하드링크로 묶여 있어 손대면
 * 다른 프로젝트까지 번진다), 빌드 산출물.
 *
 * 「언제·몇 번 알리는가」는 부르는 쪽이 정한다 — 이 함수는 **무엇을 말할지**만 안다.
 */
export function protectedPathWarning(relativePath: string): string | null {
    const kind = protectedPathKind(relativePath);
    return kind === null ? null : PROTECTED_SAY[kind];
}
