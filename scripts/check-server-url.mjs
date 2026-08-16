#!/usr/bin/env node
/**
 * **서버가 준 값이 판정을 안 거치고 소비되는 자리**를 찾는다.
 *
 * ■ 왜 필요한가
 *   판정(`serverUrl.ts`)에는 시험이 붙어 있다. 그런데 술어 시험은 **호출부가 그걸 쓰는지 모른다** —
 *   호출부에서 그 줄을 지워도 시험은 초록이다. 형제 레포에서 정확히 그 형태로 두 자리를 놓쳤고,
 *   그때 배운 것이 *"판정을 잠그려면 판정이 아니라 **호출부**를 재라"* 였다.
 *
 * ■ 무엇을 세나
 *   ⑴ `config.mcp.<필드>` 가 **판정 함수의 인자로** 쓰였는가. 이 셋은 고객 `.mcp.json` 의 키와
 *      접속·로그인 주소가 된다 — 서버가 준 값 그대로 적으면 남의 항목을 덮고 엉뚱한 곳으로 보낸다.
 *   ⑵ `apiBase` 설정을 읽는 자리가 **하나뿐**인가. 여러 곳에서 읽으면 한 곳만 검증돼도 초록이다.
 *
 * ■ **못 잡는 것** — 이 검사를 전수로 믿지 말 것
 *   · 값을 변수에 담아 한 다리 건너 쓰는 형태. 텍스트 검사의 원리적 한계다.
 *   · `packages/` 밖. 관할이 `packages/**` 의 `.ts` 계열이다.
 *   · 새로 생기는 핸드셰이크 필드. **필드가 늘면 아래 목록도 늘려야 한다** — 그게 이 파일을 고치는
 *     유일한 이유이고, 그 커밋이 곧 심의 대상이다.
 *
 * 이 검사가 지키는 것은 *"서버가 준 값은 판정을 거친다"* 는 **규율의 가시화**이지 봉인이 아니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXT = [".ts", ".mts", ".cts", ".tsx"];

/** 판정을 반드시 거쳐야 하는 핸드셰이크 필드. 필드가 늘면 여기도 늘린다. */
const GUARDED_FIELDS = ["serverName", "authServerMetadataUrl", "sourceUrlTemplate"];
/** 핸드셰이크 경계가 반드시 걸러야 하는 필드 — 여기 없으면 새 소비처가 맨몸으로 들어온다. */
const BOUNDARY_FIELDS = [
    { path: "handshake.auth", judge: "apiBaseUrl" },
    { path: "handshake.mcp.authServerMetadataUrl", judge: "apiBaseUrl" },
    { path: "handshake.mcp.sourceUrlTemplate", judge: "httpUrl" },
    { path: "handshake.mcp.serverName", judge: "mcpServerName" },
];
/** 그 값을 받아도 되는 판정 함수. */
const JUDGES = ["httpUrl", "apiBaseUrl", "mcpServerName"];

function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
        if (name === "node_modules" || name === "dist") return [];
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return SOURCE_EXT.some((ext) => full.endsWith(ext)) ? [full] : [];
    });
}

/** 주석을 걷어낸다 — 주석 속 예시를 실제 호출로 세면 고칠 수 없는 적색이 된다. */
function stripComments(raw) {
    return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const bad = [];
let apiBaseReads = 0;

for (const file of walk(join(root, "packages"))) {
    const rel = relative(root, file);
    if (/\.(test|spec)\.[mc]?tsx?$/.test(rel)) continue; // 시험은 입력을 지어내는 것이 일이다
    const flat = stripComments(readFileSync(file, "utf8")).replace(/\s+/g, " ");

    for (const field of GUARDED_FIELDS) {
        const re = new RegExp(`[\\w.]*\\bmcp\\s*[.?]*\\s*\\.?\\s*${field}\\b`, "g");
        for (const m of flat.matchAll(re)) {
            // 판정 함수의 인자로 들어갔는가 — 여는 괄호부터 이 자리까지 사이에 판정 이름이 있어야 한다.
            const before = flat.slice(Math.max(0, m.index - 200), m.index);
            const judged = JUDGES.some((j) => new RegExp(`\\b${j}\\s*\\([^()]*$`).test(before));
            if (!judged) {
                bad.push(`${rel}  ← \`mcp.${field}\` 가 판정을 안 거치고 쓰였습니다`);
            }
        }
    }

    for (const _ of flat.matchAll(/getConfiguration\s*\(\s*["']zalkera["']\s*\)[^;]{0,120}?["']apiBase["']/g)) {
        apiBaseReads += 1;
    }
    // ⚠ **읽기 개수만 세면 안 된다.** 그 한 곳이 판정을 태우는지까지 봐야 한다 — 종전 판은
    //   `apiBaseUrl(configured)` 를 `new URL(configured)` 로 바꿔도 초록이었다(읽기는 여전히 1곳).
    if (/getConfiguration\s*\(\s*["']zalkera["']\s*\)[^;]{0,120}?["']apiBase["']/.test(flat) && !/\bapiBaseUrl\s*\(/.test(flat)) {
        bad.push(`${rel}  ← apiBase 를 읽는데 \`apiBaseUrl\` 판정을 안 태웁니다`);
    }
}

// 경계(`handshake.ts`)가 네 값을 전부 거르는가 — 소비처 검사만으로는 core 를 직접 쓰는 새 소비처를 못 막는다.
{
    const boundary = stripComments(readFileSync(join(root, "packages/core/src/handshake.ts"), "utf8")).replace(/\s+/g, " ");
    for (const {path, judge} of BOUNDARY_FIELDS) {
        const re = new RegExp(`${judge}\\s*\\(\\s*${path.replace(/\./g, "\\.")}`);
        if (!re.test(boundary)) bad.push(`handshake.ts  ← \`${path}\` 를 \`${judge}\` 로 안 거릅니다`);
    }
}

if (apiBaseReads !== 1) {
    bad.push(`apiBase 설정을 읽는 자리가 ${apiBaseReads}곳입니다 — 한 곳이어야 그 한 곳만 검증하면 됩니다`);
}

if (bad.length) {
    console.error("❌ 서버가 준 값이 판정을 안 거칩니다:");
    for (const b of bad) console.error(`   · ${b}`);
    console.error("\n   `packages/core/src/serverUrl.ts` 의 판정을 태우거나, 왜 안 태우는지 커밋에 적으십시오.");
    process.exit(1);
}

console.log(
    `✅ 서버가 준 값 — 판정 통과 (경계 ${BOUNDARY_FIELDS.length}종 · 소비처 mcp ${GUARDED_FIELDS.length}종 · apiBase 읽기 ${apiBaseReads}곳)`,
);
