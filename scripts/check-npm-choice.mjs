#!/usr/bin/env node
/**
 * **어느 npm 을 실행할지의 판정이 한 자리에 남아 있는가** — 세 축으로 본다.
 *
 * ■ 왜 있나
 *   이 판정은 세 파일에 흩어져 산다: 설정 스키마(`packages/vscode/package.json`), 판정
 *   (`packages/core/src/npmChoice.ts`), 배선(`packages/vscode/src/extension.ts`). 셋이 갈리는 방식이
 *   전부 조용하다 —
 *
 *   ⑴ 스키마에 값을 하나 더 넣고 판정에 안 넣으면, 사용자가 고른 값이 **말없이 `bundled` 로** 떨어진다.
 *   ⑵ 어딘가에서 `["npm", "install"]` 을 다시 기본값으로 쓰면, 비개발자 기계에서 `spawn` 이 ENOENT 로
 *      죽고 사용자는 "인터넷을 확인하세요"라는 **틀린 안내**를 받는다. 이것이 종전 결함이었고,
 *      되살아나도 시험은 **초록**이다 — 시험은 코어를 보지 배선을 안 본다.
 *   ⑶ 설정 범위가 `machine` 이 아니면 **남의 소스 폴더가 우리가 실행할 바이너리를 고른다.**
 *      zip 을 받아 여는 것이 이 도구의 기본 동작이라 가정이 아니다.
 *
 * ■ 걸리면
 *   판정을 `npmChoice.ts` 로 되돌린다. 배선에서 기본값을 만들지 않는다 — `npmArgvOf` 가 `null` 을 주면
 *   그것은 "PATH 로 해 보라"가 아니라 **"실행하지 마라"** 다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { parse, stringConsts, stringValue, ts, walk } from "./lib/ast.mjs";

const text = (node, source) => (node ? node.getText(source) : "");
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const problems = [];

// ── ① 스키마의 값 목록 ≡ 판정의 타입 목록
const pkg = JSON.parse(read("packages/vscode/package.json"));
const setting = pkg.contributes?.configuration?.properties?.["zalkera.npm"];
if (!setting) {
    problems.push("설정 `zalkera.npm` 이 package.json 에 없다 — 사용자는 고를 방법이 없다");
} else {
    const source = read("packages/core/src/npmChoice.ts");
    const decl = /export type NpmPreference\s*=\s*([^;]+);/.exec(source);
    if (!decl) {
        problems.push("npmChoice.ts 에서 `NpmPreference` 선언을 못 찾았다 — 이 검사가 판정을 못 읽는다");
    } else {
        const declared = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
        const offered = [...(setting.enum ?? [])].sort();
        if (declared.join("|") !== offered.join("|")) {
            problems.push(`설정 값 목록이 갈렸다: 스키마 [${offered}] ↔ 타입 [${declared}]`);
        }
        if (!offered.includes(setting.default)) {
            problems.push(`설정 기본값 "${setting.default}" 이 목록에 없다`);
        }
        // 배선의 기본값도 같아야 한다 — 스키마만 바꾸면 조용히 갈린다.
        const wiring = read("packages/vscode/src/extension.ts");
        const fallback = /function npmPreference\(\)[\s\S]{0,400}?return[^;]*?:\s*"([^"]+)";/.exec(wiring);
        if (!fallback) {
            problems.push("extension.ts 에서 `npmPreference()` 의 기본값을 못 읽었다");
        } else if (fallback[1] !== setting.default) {
            problems.push(`기본값이 갈렸다: 스키마 "${setting.default}" ↔ 배선 "${fallback[1]}"`);
        }
    }
    // ── ③ 범위는 machine 이어야 한다
    if (setting.scope !== "machine") {
        problems.push(`설정 \`zalkera.npm\` 의 scope 가 "${setting.scope}" 다 — machine 이어야 한다(남의 폴더가 실행 바이너리를 고른다)`);
    }
}

// ── ② npm 을 **이름**으로 부르는 자리가 있는가. 판정은 구문으로 한다(문면은 양방향으로 뚫린다).
const files = [];
// **고객 기계에서 도는 코드**만 본다 — 그것이 이 판정의 위협 모델이다(받은 zip 을 푼 폴더에서 돈다).
// `scripts/` 는 우리 레포에서만 도는 빌드 도구라 여기 안 든다(실측: VSIX 에 `extension/scripts/` 0건).
for (const dir of [join(root, "packages")]) {
    (function walkDir(at) {
        for (const entry of readdirSync(at)) {
            if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
            const full = join(at, entry);
            if (statSync(full).isDirectory()) walkDir(full);
            else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) files.push(full);
        }
    })(dir);
}
if (files.length === 0) problems.push("훑을 소스를 하나도 못 찾았다 — 이 검사가 아무것도 안 보고 통과했다");

let arrays = 0;
for (const full of files) {
    const rel = relative(root, full).replaceAll("\\", "/");
    let source;
    try {
        source = parse(full);
    } catch (error) {
        // ⚠ **못 읽으면 통과가 아니다.** 파싱 실패를 넘기면 «검사할 수 없는 파일»이 곧 면제가 된다.
        problems.push(`${rel}: 구문을 못 읽었다 [${error?.message ?? "?"}]`);
        continue;
    }
    const consts = stringConsts(source);
    const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    // ⑴ `spawn("npm", …)` 처럼 **이름으로 실행**하는 자리.
    walk(source, (node) => {
        if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
        const callee = text(node.expression, source).split(".").pop() ?? "";
        if (!/^(spawn|spawnSync|exec|execSync|execFile|execFileSync)$/.test(callee)) return;
        if (stringValue(node.arguments[0], consts) !== "npm") return;
        problems.push(`${rel}:${at(node)}: ${callee}("npm", …) — 실행 파일 탐색이 OS 손에 넘어간다. 경로로 부르라`);
    });
    // ⑵ `["npm", "install"]` 처럼 **이름으로 인자를 조립**하는 자리.
    walk(source, (node) => {
        if (!ts.isArrayLiteralExpression(node)) return;
        arrays += 1;
        const values = node.elements.map((e) => stringValue(e, consts));
        for (let i = 0; i + 1 < values.length; i += 1) {
            if (values[i] === "npm" && values[i + 1] === "install") {
                problems.push(
                    `${rel}:${at(node)}: npm 을 **이름**으로 부른다 — Windows 에서 셸이 필요해지고,` +
                        " 셸은 받은 zip 을 푼 폴더부터 실행 파일을 뒤진다. npmArgvOf 로 **경로**를 넘기라",
                );
            }
        }
    });
}

// `npmCommand` 는 선택 항목이 아니다 — 옵셔널로 되돌리면 기본값이 다시 생긴다.
// ⚠ 문면으로 보면 공백 하나(`npmCommand ?:`)나 `| undefined` 로 되돌아간다(둘 다 실측). 구문으로 본다.
for (const [file, label] of [["packages/core/src/deps.ts", "DepsOptions"], ["packages/core/src/preview.ts", "PreviewOptions"]]) {
    const source = parse(join(root, file));
    let seen = false;
    walk(source, (node) => {
        if (!ts.isPropertySignature(node) || node.name?.getText(source) !== "npmCommand") return;
        seen = true;
        const optional = Boolean(node.questionToken);
        const unionHasUndefined =
            node.type &&
            ts.isUnionTypeNode(node.type) &&
            node.type.types.some((t) => t.kind === ts.SyntaxKind.UndefinedKeyword);
        if (optional || unionHasUndefined) {
            problems.push(`${file}: ${label}.npmCommand 를 안 줘도 되게 돌렸다 — 필수여야 한다(안 주면 PATH 로 샌다)`);
        }
    });
    if (!seen) problems.push(`${file}: ${label}.npmCommand 선언을 못 찾았다 — 이 검사가 아무것도 안 봤다`);
}

// ── ④ 매뉴얼이 같은 말을 하는가. 설정은 사용자가 손으로 쓰는 값이라, 문서가 갈리면 **없는 값을 쓴다.**
{
    const manual = read("packages/vscode/media/help.md");
    const section = /### 어느 npm 으로 설치할까요([\s\S]*?)(?=\n### |\n---|\n## )/.exec(manual);
    if (!section) {
        problems.push("매뉴얼에 `### 어느 npm 으로 설치할까요` 절이 없다 — 사용자는 이 설정을 알 길이 없다");
    } else if (setting) {
        const rows = [...section[1].matchAll(/^\|\s*`([^`]+)`\s*(\([^)]*\))?\s*\|/gm)];
        const listed = rows.map((m) => m[1]).sort();
        const offered = [...(setting.enum ?? [])].sort();
        if (listed.join("|") !== offered.join("|")) {
            problems.push(`매뉴얼의 값 목록이 갈렸다: 문서 [${listed}] ↔ 스키마 [${offered}]`);
        }
        const marked = rows.filter((m) => m[2]).map((m) => m[1]);
        if (marked.length !== 1 || marked[0] !== setting.default) {
            problems.push(`매뉴얼이 기본값을 잘못 표시한다: 문서 [${marked}] ↔ 스키마 "${setting.default}"`);
        }
        const min = /MIN_SYSTEM_NPM_MAJOR = (\d+)/.exec(read("packages/core/src/npmChoice.ts"))?.[1];
        if (min && !new RegExp(`${min}\\s*이상`).test(section[1])) {
            problems.push(`매뉴얼이 최소 npm 판(${min} 이상)을 안 적거나 다르게 적는다`);
        }
    }
}

if (problems.length) {
    console.error("❌ npm 선택 판정 — 갈렸습니다:");
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
}
// ⚠ 문구를 **사거리에 맞춘다.** 이 판정이 보는 것은 이 파일 안에서 «문자열로 확정되는» 값이다.
// 다른 파일에서 온 상수·치환 템플릿·`"np"+"m"` 같은 조립은 못 본다(`ast.mjs` 참고). 「없음」이라고
// 단언하면 다음 사람이 이 검사를 보증으로 읽는다.
console.log(
    `✅ npm 선택 판정 — 통과 (설정 3축 · 매뉴얼 3축 · 배송 소스 ${files.length}개·배열 ${arrays}개에서` +
        " 이름 표기 못 찾음)",
);
