import {SYNC_LEDGER_PATH} from "./syncLedger.ts";
import { createHash } from "node:crypto";
import { PROVENANCE_PATH, buildProvenance } from "./provenance.ts";
import {MAX_ZIP_ENTRIES} from "./limits.ts";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { DevtoolsError } from "./errors.ts";
import { deflateRaw } from "node:zlib";
import { promisify } from "node:util";

const deflate = promisify(deflateRaw);

/**
 * zip 작성기 — **의존성 0**(Node 내장 zlib 만 쓴다).
 *
 * 외부 압축 라이브러리를 안 쓰는 이유: 이 코드는 고객 노트북에서 돌고, 우리가 넣은 의존성 하나가
 * 그 기계에서 설치 실패하면 "올리기"가 통째로 막힌다. 형식은 표준 zip(로컬 헤더 + 중앙 디렉터리)이라
 * 서버가 쓰는 어느 해제기로도 열린다.
 *
 * ZIP64 는 다루지 않는다 — 업로드 상한이 100MB 라 4GB·65535개 경계에 닿을 수 없다.
 */
export interface ZipEntry {
    /** zip 안 경로. 항상 `/` 구분자(윈도우에서도). */
    path: string;
    data: Buffer;
}

export async function createZip(entries: ZipEntry[]): Promise<Buffer> {
    // ZIP64 를 안 다루므로 항목 수 상한이 실재한다. 초판 주석은 "100MB 상한이라 닿을 수 없다"고 적었지만
    // **거짓이었다** — 작은 파일 65,536개는 수 MB 다(심의 실측: raw RangeError). 사람 말로 끊는다.
    if (entries.length > MAX_ZIP_ENTRIES) {
        throw new DevtoolsError(
            "PACK_FAILED",
            `파일이 너무 많습니다(${entries.length.toLocaleString()}개 · 상한 ${MAX_ZIP_ENTRIES.toLocaleString()}개).`,
            "빌드 산출물·캐시 폴더가 섞여 있지 않은지 확인해 주세요.",
        );
    }
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.path, "utf8");
        const crc = crc32(entry.data);
        const compressed = await deflate(entry.data, { level: 6 });
        // 압축이 되레 커지는 파일(이미 압축된 이미지 등)은 저장(store)으로 둔다.
        const useDeflate = compressed.length < entry.data.length;
        const payload = useDeflate ? compressed : entry.data;
        const method = useDeflate ? 8 : 0;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // 필요 버전 2.0
        local.writeUInt16LE(0x0800, 6); // UTF-8 파일명 플래그
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); // 시각·날짜는 0 — **재현 가능한 zip**(같은 소스 → 같은 바이트)
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, nameBytes, payload);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(0, 38); // 외부 속성
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + payload.length;
    }

    const centralBuffer = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * 패킹에서 **반드시 빠지는 것들**(memo146 §5 D2).
 *
 * `node_modules` 가 첫 줄인 이유: 서버 업로드 정규화가 그것을 어차피 제거하고, 상한 100MB 에 먼저 걸린다.
 * `.env.local` 이 있는 이유는 더 무겁다 — **자격증명이 들어 있다.** 여기서 새면 미리보기 키가 서버로 올라간다.
 *
 * 이름이 같으면 뺀다. **소문자로 비교한다**(심의 실측: `.VSCode/settings.json` 이 실렸다) —
 * 우리가 만드는 파일은 늘 소문자지만, 판정이 대소문자를 타면 그건 판정이 아니다.
 *
 * ⚠ **여기 항목은 전부 소문자여야 한다.** 조회를 소문자로 바꾸면서 유일한 혼합 대소문자 항목이던
 * `.DS_Store` 가 조용히 안 걸리게 됐다(재심의 실측 — 시험 129건이 전부 초록인 채로). 대소문자를
 * 없애려던 수정이 대소문자 때문에 깨진 것이다. 새 항목을 넣을 때 이 줄을 보라.
 */
const ALWAYS_EXCLUDED = new Set([
    "node_modules",
    ".git",
    // macOS 기본 압축이 만드는 부스러기. 발행에도 들여오기에도 실릴 이유가 없다.
    // ⚠ 조회가 소문자라 **항목도 소문자여야 한다**(위 .ds_store 와 같은 함정).
    "__macosx",
    ".next",
    "dist",
    "out",
    ".ds_store", // ⚠ 조회가 소문자라 **항목도 소문자여야 한다**(아래 참조)
    ".turbo",
    ".vercel",
    ".claude",
    // ── 아래 넷은 심의 실측으로 추가됐다(2026-08-10) ──────────────────────────
    // 이 목록이 옛 배치 기준으로 쓰인 뒤 **우리가 파일을 늘렸는데** 목록을 안 늘렸다.
    //
    // `.mcp.json` 은 **우리가 만든다**(「에이전트 연결」). 그리고 그 파일은 남의 MCP 서버 항목을
    // 일부러 보존하는데(mcp.ts), stdio 형 서버는 관례적으로 `env: { GITHUB_TOKEN: … }` 를 들고 다닌다.
    // 우리가 만든 파일이 정본 소스가 되어 그 버전을 받는 **모두에게** 배포되는 자리였다.
    ".mcp.json",
    // `.vscode/settings.json` 에는 **우리가 적은 `zalkera.tenant`** 가 들어 있다(`configTarget()`).
    // 그것이 zip 에 실려 유통되면, 그 소스를 받아 연 사람의 확장이 조용히 그 테넌트를 가리킨다.
    // 편집기 설정은 **배포되는 사이트의 내용이 아니다** — 빠져도 잃는 것이 없다.
    ".vscode",
    ".idea",
    // 홈 디렉터리 자격증명이 프로젝트 안에 복사돼 있는 경우가 실제로 있다.
    ".ssh",
    ".aws",
]);

/**
 * **값이 없는 서식.** `.env.example`·`.env.sample`·`.env.template` — 채워 넣으라고 배포하는 안내문이다.
 *
 * ■ 왜 예외인가
 *   이 예외가 없을 때, 정본 팩의 `.env.example` 이 들여오기에서 **말없이 빠졌다**(실측: 팩 4종 전부
 *   172→171·188→187·183→182·177→176). 그 파일은 장식이 아니다 — 팩의 `README.md` 첫 명령이
 *   `cp .env.example .env.local` 이라 **README 자신이 그 폴더 안에서 실패했다.** 그리고 「비우면
 *   기동·빌드가 실패한다」·「안 바꾸면 검색엔진에 localhost 가 색인된다」는 두 경고가 이 파일에만
 *   있었다(팩의 다른 문서 전수 대조).
 *
 * ■ 왜 안전한가
 *   덮기로 **약속한 것**은 «우리가 발급한 비밀»이고, 그것이 사는 자리는 `.env.local` 이다. 서식
 *   파일에는 우리가 아무것도 안 넣는다.
 *
 * ■ 자를 새로 만들지 않는다
 *   정본 팩 게이트(`zalkera-storefront-examples/scripts/verify-zip.mjs` 의 `ENV_KEEP`)가 이미 같은
 *   규칙을 「값이 없어 허용」으로 쓴다. 여기서 다르게 적으면 두 자가 갈리고, 갈린 날 「팩 게이트는
 *   통과했는데 들여오면 사라지는」 파일이 생긴다.
 *
 * ⚠ **접미만 본다.** `.env.example.bak` 은 여기 안 걸리고 위 `.env` 접두 규칙에 걸려 그대로 빠진다.
 */
function isValueLessTemplate(lower: string): boolean {
    return lower.startsWith(".env") && /\.(example|sample|template)$/.test(lower);
}

/**
 * **값 자리에 앉으면 「살아 있는 비밀」로 보는 형상.**
 *
 * 표는 정본 팩 게이트(`zalkera-storefront-examples/scripts/lib/secret-content.mjs` 의 `SECRET_CONTENT`)와
 * 같다. 두 자를 다르게 두면 「팩 게이트는 잡는데 여기는 흘리는」 값이 생긴다.
 *
 * ⚠ **표가 같아도 그 표를 쓰는 규칙이 갈리면 소용이 없다** — 실제로 그렇게 샜다(자리표시자 면제를
 *   값 전체에 걸어 진짜 키가 그 옆에서 통과했다). 면제식은 저쪽 `verify-zip.mjs` 와 자구까지 맞춘다.
 *
 * ⚠ **완전하지 않다.** 고엔트로피 문자열 일반은 안 본다 — 그래서 이 함수가 하는 말은
 *   「알려진 형식의 살아 있는 열쇠가 값 자리에 있다」이지 「비밀이 없다」가 아니다.
 */
// ⚠ **이 표가 보는 종.** 형제 백엔드의 `scripts/checks/detect-credential-parity.py` 가 이 선언을
//   자기 표와 대사한다 — 사본이 낡는 것을 사람 눈이 아니라 검사기가 본다. 표를 넓히면 여기도
//   같이 넓혀라(안 넓히면 그 검사기가 red 다).
//   ⚠ 줄 처음에서만 읽히고 **둘 이상이면 거절**된다 — 옛 줄을 주석으로 남기지 마라.
export const SPECIES = ["aws", "github", "stripe", "slack", "google", "npm", "oqsk", "pem"];

const LIVE_SECRET: ReadonlyArray<readonly [string, RegExp]> = [
    ["잘커라 스토어프론트 키", /\boqsk_[0-9A-Za-z_-]{8,}/],
    ["AWS 액세스키", /\bAKIA[0-9A-Z]{16}\b/],
    ["개인키 블록", /-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----/],
    ["결제 라이브 시크릿", /\b(?:sk_live_|live_sk_)[0-9A-Za-z]{8,}/],
    ["GitHub 토큰", /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,})\b/],
    ["Slack 토큰", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/],
    ["Google API 키", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ["npm 토큰", /\bnpm_[0-9A-Za-z]{36}\b/],
];

/** AWS 가 자기 문서에 싣는 자리표시자. 어디서도 인증되지 않는다. */
const AWS_DOC_PLACEHOLDER = /\bAKIA[0-9A-Z]{9}EXAMPLE\b/;
/** 자리표시자가 **아닌** AKIA 토큰. 하나라도 있으면 면제하지 않는다. */
const AWS_LIVE_KEY = /\bAKIA(?![0-9A-Z]{9}EXAMPLE\b)[0-9A-Z]{16}\b/;

/**
 * 자격증명이 박힌 URL. **호스트까지 본다** — 표에 두지 않고 따로 다루는 이유가 그것이다.
 *
 * ⚠ 형상만 보면 `postgres://user:pass@localhost:5432/db` 가 걸린다. 그것은 Node·Docker Compose
 *   생태계에서 **가장 흔한 서식 한 줄**이고, `user`·`pass` 는 글자 그대로 자리표시자다. 걸리면
 *   그 서식 파일이 통째로 빠져, 이 기능이 세운 바로 그 보증("정상 소스가 조용히 안 빠진다")을
 *   스스로 어긴다(심의 실증 — 전형적 Node/Postgres 서식이 통째로 빠졌다).
 *
 * 그래서 **닿을 수 있는 호스트일 때만** 비밀로 본다. 루프백·사설망·예약 접미·단일 라벨(점 없는
 * compose 서비스 이름)에 박힌 열쇠는 나가도 남이 쓸 수 없다 — 그것이 이 예외의 근거다.
 */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@([^\s/?#]+)/;
const UNREACHABLE_HOST =
    /^(?:localhost|0\.0\.0\.0|::1|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;
/** RFC 2606·6761 이 문서·내부용으로 못 박은 접미. 여기에 박힌 열쇠는 어디로도 안 간다. */
const UNREACHABLE_SUFFIX = /\.(?:local|localhost|internal|test|invalid)$/i;

function reachableHost(raw: string): boolean {
    const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (UNREACHABLE_HOST.test(host) || UNREACHABLE_SUFFIX.test(host)) return false;
    // 점이 없으면 단일 라벨 — compose 서비스 이름·내부 별칭이다. 공개 호스트에는 점이 있다.
    return host.includes(".");
}

/** 서식 파일에서 훑을 최대 바이트. 서식은 작다 — 이보다 크면 서식이 아니다. */
const TEMPLATE_SCAN_BYTES = 256 * 1024;

/**
 * **서식을 글자로 읽는다 — 못 읽으면 `null`.**
 *
 * ⚠ `toString("utf8")` 하나로 때우면 **UTF-16 으로 저장한 서식이 검사를 통째로 지나간다.**
 *   ASCII 가 바이트 사이에 `00` 을 끼고 앉아 어떤 정규식에도 안 걸린다 — 실측으로 라이브 열쇠가
 *   경고 한 줄 없이 나갔다. Windows PowerShell 5.1 의 `Out-File`·`>` 기본값이 UTF-16LE 라
 *   「PowerShell 로 서식을 채워 저장」은 드문 경로가 아니다.
 *
 * BOM 이 있으면 그대로 읽고, 없는데 `00` 바이트가 섞였으면 **글자가 아니다** — 그때는 읽었다고
 * 하지 않고 `null` 을 준다. 부르는 쪽이 fail-closed 로 처리한다: 못 읽은 것은 안 싣는다.
 */
function decodeTemplate(data: Buffer): string | null {
    // ⚠ **UTF-32 를 먼저 배제한다.** UTF-32LE 의 BOM 은 `FF FE 00 00` 이라 **앞 두 바이트가
    //    UTF-16LE 와 같다.** 아래 분기가 그것을 삼키면 4바이트 코드유닛을 2바이트로 잘라 읽어
    //    글자 사이마다 `U+0000` 이 끼고, 인접 문자를 보는 패턴이 전부 빗나간다. 그러면서
    //    문자열을 돌려주므로 「못 읽었다」로도 안 잡힌다 — **잘못 읽고 0건으로 통과**한다
    //    (심의 실증: 실제 zip 이 빌드까지 완주하고 rc=0 으로 지났다).
    //    UTF-32BE(`00 00 FE FF`)는 `00` 검사에 걸려 이미 안전하지만 나란히 적어 둔다.
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xfe && data[2] === 0x00 && data[3] === 0x00) return null;
    if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0xfe && data[3] === 0xff) return null;
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
        return data.subarray(2).toString("utf16le");
    }
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
        const swapped = Buffer.from(data.subarray(2));
        swapped.swap16();
        return swapped.toString("utf16le");
    }
    if (data.includes(0x00)) return null;
    return data.toString("utf8");
}

/**
 * **서식이 정말 비어 있는가 — 이름이 아니라 값으로 판정한다.**
 *
 * ■ 왜 있나
 *   `.env.example` 은 이름으로 예외를 받는다([isValueLessTemplate]). 그런데 사람은 서식을
 *   **복사하지 않고 그 자리에 채운다.** 채운 서식이 그대로 나가면, 이 파일이 스스로 좁혀 둔
 *   보증("*우리가 발급한* 비밀은 반드시 덮는다")이 파일 이름 하나로 뚫린다.
 *
 * ■ **주석도 본다**
 *   처음에는 `#` 줄을 건너뛰었다. 안내문이 형식 이름을 적는 것을 오인하지 않으려는 것이었는데,
 *   변이시험이 그 건너뛰기가 **아무것도 지키지 않으면서 구멍만 낸다**는 것을 보였다: 정본 팩의
 *   안내문에는 `=` 가 없어 애초에 값으로 안 읽히고, 반대로 사람이 자기 열쇠를 **주석 처리해**
 *   두면(`# KEY=oqsk_…`) 그대로 나간다. 새는 쪽이 조용하고 되돌릴 수 없으므로, 헛디딤을
 *   감수하고 다 본다 — 헛디딤은 이름과 이유를 대므로 사람이 고칠 수 있다.
 *
 * 찾으면 **무엇으로 보였는지**를 돌려준다 — 이름을 대야 사람이 고칠 수 있다.
 */
export function templateHoldsSecret(text: string): string | null {
    // ⚠ **개인키 블록만은 줄 파싱 밖에서 본다.** PEM 을 붙여넣으면 `KEY="` 다음 줄부터 본문이
    //    오는데, 그 줄에는 `=` 가 없어 값으로 안 읽힌다 — 「가장 흔한 붙여넣기」를 놓치는
    //    자리였다(심의 실증). 본문 한 줄이면 충분하므로 파일 전체에서 형상만 본다.
    if (/-----BEGIN [A-Z ]{0,20}PRIVATE KEY-----/.test(text)) return "개인키 블록";
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === "") continue;
        // `# KEY=…` 도 본다 — 주석 처리한 열쇠가 새는 자리다(위 ■ 참조). `#` 를 떼고 값을 읽는다.
        const eq = line.replace(/^#+\s*/, "").indexOf("=");
        if (eq < 0) continue;
        const value = line.replace(/^#+\s*/, "").slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
        if (value === "") continue;
        for (const [what, pattern] of LIVE_SECRET) {
            if (!pattern.test(value)) continue;
            // AWS 가 자기 문서에서 쓰는 자리표시자. GitHub 의 스캐너도 비-비밀로 안다.
            //
            // ⚠ **자리표시자가 「있다」로 면제하면 안 된다.** 값 한 줄에 진짜 키와 자리표시자가
            //   같이 있으면(`KEY=<진짜>  # 예: <자리표시자>`) 통째로 면제되어 살아 있는 키가
            //   팩에 실린다(실증). 자리표시자가 있고 **동시에 자리표시자 아닌 키가 없을 때만**
            //   면제한다 — 정본 팩 게이트(`storefront-examples/scripts/verify-zip.mjs`)와 같은 식이다.
            if (
                what === "AWS 액세스키" &&
                AWS_DOC_PLACEHOLDER.test(value) &&
                !AWS_LIVE_KEY.test(value)
            ) {
                continue;
            }
            return what;
        }
        const url = URL_CREDENTIAL.exec(value);
        if (url !== null && reachableHost(url[1] ?? "")) return "URL 내장 자격증명";
    }
    return null;
}

function isSecretFile(name: string, isDirectory = false): boolean {
    const lower = name.toLowerCase();
    // ⚠ **서식 예외는 파일에만 준다.** `.env.example/` 라는 **폴더**를 만들면 이름 판정이
    //    그 폴더를 통과시키고, 그 안의 `notes.txt` 는 이름도 안 걸리고 내용검사 대상도 아니다 —
    //    양쪽 그물 밖이다(심의 실증: 라이브 열쇠가 그대로 실렸다). 폴더는 `.env` 접두 규칙대로 뺀다.
    if (!isDirectory && isValueLessTemplate(lower)) return false;
    // ⚠ **접두는 `.env` 다, `.env.` 가 아니다**(클로징 심의 · Fable·Opus 공통 차단 · 실측 유출).
    // 주석과 도움말은 처음부터 "`.env` 로 **시작**하는 것은 전부"라고 적었는데 코드만 점을 하나 더
    // 요구했다. 그 한 글자 틈으로 `.envrc`(direnv — `export AWS_SECRET_ACCESS_KEY=…` 가 관례)와
    // `.env~`(편집기 백업 — **`.env` 의 바이트 사본**)가 나갔다.
    //
    // 부수 제외는 `.environment` 같은 **숨은** 이름뿐이다. 점 없는 `environment.ts` 는 그대로 실린다.
    if (lower.startsWith(".env")) return true;
    if (SECRET_NAMES.has(lower)) return true;
    if (SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
    // GCP/Firebase 서비스계정 키. **기본 다운로드 이름이 `service-account` 로 시작하지 않는다** —
    // 콘솔이 주는 이름은 `<project>-firebase-adminsdk-<hash>.json` 이다(심의 실측으로 새던 자리).
    if (lower.endsWith(".json") && (lower.startsWith("service-account") || lower.includes("firebase-adminsdk"))) {
        return true;
    }
    // `production.env`·`local.env` — docker compose `env_file` 관례다. `.env` 로 **시작**하는 규칙만으로는
    // 안 걸린다(심의 실측).
    return lower.endsWith(".env");
}

const SECRET_NAMES = new Set([
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials.json",
    ".npmrc",
    // 심의 추가(2026-08-10) — 셋 다 **평문 자격증명**을 담는 표준 파일명이다.
    ".netrc",
    "_netrc", // 윈도 변형 — 같은 파일이다
    ".git-credentials",
    ".yarnrc.yml",
  // 도구별 자격증명 파일. 전부 **평문**이고, 홈이 아니라 프로젝트 루트에 놓이는 일이 흔하다.
  ".dockercfg",
  ".pgpass", // libpq — `host:port:db:user:password`
  ".pypirc", // twine 업로드 토큰
  "kubeconfig", // 클러스터 자격증명(이름 그대로 두는 관례)
  "secrets.json", // .NET user-secrets 등의 관례명
]);

/** 확장자로 거른다. 이름은 자유롭고 내용은 열쇠인 것들이다. */
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".p8"];

export interface PackOptions {
    projectDir: string;
    /**
     * 출처 표시를 찍을 사이트. 없으면 **안 찍는다**(연결 안 된 폴더).
     *
     * ⚠ **디스크의 표시를 그대로 싣지 않는다** — 위 [EXCLUDED_PATHS] 가 걷기에서 빼고, 여기서
     *   **지금 소속으로 새로** 만들어 넣는다. 그래서 낡은 표시가 따라다닐 몸통이 없다.
     */
    provenanceTenant?: string;
    /** 추가 제외(프로젝트 사정). 이름 단위 비교라 경로가 아니라 파일·폴더 이름을 넣는다. */
    exclude?: string[];
    onProgress?: (message: string) => void;
}

export interface PackResult {
    buffer: Buffer;
    fileCount: number;
    /** 업로드 전 무결성 확인용(서버가 다시 계산한다). */
    sha256: string;
}

/**
 * **경로로 빼는 것.** 위 목록은 이름으로 빼므로 폴더가 통째로 사라진다 — 그러면 안 되는 자리가 있다.
 *
 * `.zalkera/source.json` 은 우리가 만드는 출처 표식이라 정본에 실리면 안 된다(다음 판을 받은
 * 폴더가 「나는 그 판에서 왔다」는 낡은 거짓을 품고, 그 거짓이 그 판을 받는 모두에게 복제된다).
 *
 * ⚠ 그런데 **`.zalkera/` 를 통째로 빼면 안 된다.** 백엔드가 canonical tar 에서 그 폴더를 일부러
 *   남기고(고객 소스와 동행), 같은 폴더의 `ASSETS-LICENSE.md`(라이선스 대장)·`pack.json`(판 출처)이
 *   배송 문서가 가리키는 실물이다 — 폴더째 빼면 그 참조가 매달린다.
 */
const EXCLUDED_PATHS = new Set([".zalkera/source.json", SYNC_LEDGER_PATH, PROVENANCE_PATH]);

/**
 * **접두로 빼는 자리.** 정확일치·세그먼트 이름으로는 안 걸리는 것들이다.
 *
 * ⚠ `.zalkera/saved/2026…/foo.tsx` 같은 「치워 두는 자리」가 그렇다. 본선 방어는 그 자리를
 *   **트리 밖 형제 디렉터리**로 두는 것이고(`pull.ts` 의 `setAside`), 이것은 둘째 겹이다 —
 *   사람이 그 폴더를 프로젝트 안으로 옮겨 놓는 것을 막을 길이 없기 때문이다.
 * ⚠ **`.zalkera/` 를 통째로 넣지 마라** — 같은 폴더의 `ASSETS-LICENSE.md`·`pack.json` 은
 *   배송 문서가 가리키는 실물이다.
 */
const EXCLUDED_PREFIXES = [".zalkera/saved/"];

/**
 * **경로로 빼는 판정 — 한 벌.**
 *
 * 🔴 종전에는 [packProject] 의 훑기가 `EXCLUDED_PATHS` 만 인라인으로 보고 [EXCLUDED_PREFIXES] 는
 *    안 봤다. 그래서 접두 배제가 「둘째 겹」이라 적혀 있었는데도 **정본 zip 을 만드는 경로에는
 *    아예 안 닿았다** — 치워 둔 옛 작업이 프로젝트 안에 있으면 그대로 실려 나갔다(심의 실측).
 *    두 자리가 각자 목록을 보면 이런 갈림이 조용히 산다.
 *
 * @param path 프로젝트 뿌리 기준 상대 경로. 구분자·대소문자는 부르는 쪽이 이미 골랐다고 본다.
 */
function isExcludedPath(path: string): boolean {
    return EXCLUDED_PATHS.has(path) || EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * ⚠ **이 목록은 열거다 — 그리고 열거로 끝날 수밖에 없다.**
 *
 * 임의의 소스 트리에서 「무엇이 비밀인가」를 허용목록으로 뒤집을 방법은 없다. 파일 이름도 내용도
 * 고객이 정하기 때문이다. 그래서 이 함수의 보증을 **좁게 잡아 적는다**:
 *
 *  · **반드시 덮는 것** — *우리가 발급한* 비밀. 미리보기 키가 사는 `.env*` 는 접두 규칙으로 전부 뺀다.
 *    우리가 넣은 것이니 우리가 책임진다.
 *    ⚠ **한 자리만 예외다**: 값이 빈 서식(`.env.example` 류 · [isValueLessTemplate]). 그 자리는
 *    이름이 아니라 **내용**으로 지킨다([templateHoldsSecret]) — 정규식 휴리스틱이므로 그 파일에
 *    한해서는 이 등급이 아래의 «최선으로 덮는 것»이다. 좁혀 적는 것이 이 절의 존재 이유다.
 *  · **최선으로 덮는 것** — 널리 쓰이는 표준 자격증명 파일명·확장자(아래 두 표).
 *  · **보증하지 않는 것** — 그 밖의 이름. `media/help.md` 가 같은 말을 사용자 문장으로 적는다.
 *
 * 이 비대칭이 정직한 선이다. 「전부 막는다」고 적으면 못 막은 하나가 배신이 된다.
 *
 * `.env` 로 시작하는 것은 **전부** 뺀다(대소문자 무관).
 *
 * 초판은 `.env`·`.env.local` 정확 일치만 봤다. 심의가 실측으로 `.env.production`·`.env.development.local`·
 * `.env.local.bak`·`.Env.Local` 에서 **`oqsk_` 키가 zip 에 실리는 것**을 확인했다 — 앞의 둘은 Next 가 실제로
 * 읽는 표준 파일명이다. 자격증명이 새는 자리는 정확 일치로 막을 수 없다.
 *
 * zip 항목 하나(`a/b/c.ts` 꼴 상대 경로)가 **정본에 실리지 않는 것**인가.
 *
 * ⚠ **들여오기가 이 판정을 같이 쓴다**(`importZip.ts`). 목록을 사본으로 들고 가면 두 목록이
 *   갈리고, 갈린 날 「발행에서는 빠지는데 들여올 때는 들어오는」 파일이 생긴다. 보낸 쪽
 *   `.vscode/settings.json` 이 정확히 그런 파일이다 — 들어오면 그 폴더가 **보낸 사람의 사이트라고
 *   주장**한다.
 */
export function isExcludedEntry(entryPath: string): boolean {
    const path = entryPath.split(sep).join("/").toLowerCase();
    if (isExcludedPath(path)) return true;
    // 이름 기준 제외는 **어느 층에 있든** 걸린다 — 뿌리의 `node_modules` 만 보면 중첩된 것이 샌다.
    const segments = path.split("/").filter((s) => s !== "");
    if (segments.some((segment) => ALWAYS_EXCLUDED.has(segment))) return true;
    return segments.some((segment) => isSecretFile(segment));
}

/** 프로젝트를 zip 으로 묶는다. 제외 규칙은 위 목록 + 호출부 추가분. */
export async function packProject(options: PackOptions): Promise<PackResult> {
    const excluded = new Set(
        [...ALWAYS_EXCLUDED, ...(options.exclude ?? [])].map((name) => name.toLowerCase()),
    );
    const entries: ZipEntry[] = [];
    const report = options.onProgress ?? (() => {});

    /**
     * 비밀로 판단해 뺀 것을 **이름 대고 말한다**(심의 제안 · 이 파일이 이미 세운 원칙 §"조용히 빼지 않는다").
     *
     * 이름만 비슷한 정상 파일(`turkey.key` · 공개 CA 번들 `cert-bundle.pem` · 데이터 픽스처
     * `service-accounts.json`)이 조용히 빠지면, 사용자는 **배포된 사이트가 왜 다른지** 알 수 없다.
     * 막지는 않는다 — 규칙을 느슨하게 하는 쪽이 더 나쁘다. 대신 보이게 한다.
     */
    const dropped: string[] = [];

    // ⚠ **`walk` 보다 위에 둔다.** 아래에 두면 TDZ 함정이 된다 — 지금은 호출이 선언 뒤라
    //    돌지만, 누가 `walk` 를 위로 올려 부르는 순간 모듈이 조용히 죽는다.
    let totalBytes = 0;
    const walk = async (dir: string): Promise<void> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
            if (excluded.has(item.name.toLowerCase())) continue;
            if (isSecretFile(item.name, item.isDirectory())) {
                // 디렉터리도 센다 — `config.env/` 하나면 그 아래 소스가 **통째로** 사라지는데,
                // 파일만 세면 그때가 제일 조용하다(재심의 경고).
                const shown = relative(options.projectDir, join(dir, item.name));
                dropped.push(item.isDirectory() ? `${shown}/` : shown);
                continue;
            }
            const full = join(dir, item.name);
            if (item.isDirectory()) {
                await walk(full);
            } else if (item.isFile()) {
                // 경로로 빼는 것 — 이름으로 빼면 폴더가 통째로 사라지는 자리다. 판정은
                // [isExcludedPath] 한 벌을 쓴다(형제 `isExcludedEntry` 와 같은 문).
                if (isExcludedPath(relative(options.projectDir, full).split(sep).join("/").toLowerCase())) {
                    continue;
                }
                const info = await stat(full);
                if (info.size > MAX_FILE_BYTES) {
                    // ⚠ **조용히 빼지 않는다**(심의 차단 · 2026-08-03). 초판은 건너뛰고 로그 한 줄만 남겼는데,
                    // 사용자는 출력 채널을 열어 두지 않는다 — "발행 접수" 알림만 보고 **자기 동영상이 사라진 줄
                    // 모른 채** 라이브가 바뀐다. 게다가 20MB 라는 선에 근거가 없었다(서버 상한은 아카이브 전체
                    // 100MB 이고 그 검사는 publish 가 따로 한다). 넘으면 **끊고 이름을 말한다.**
                    throw new DevtoolsError(
                        "PACK_FAILED",
                        `너무 큰 파일이 있습니다: ${relative(options.projectDir, full)} (${Math.round(info.size / 1024 / 1024)}MB)`,
                        "동영상·원본 이미지는 소스에 넣지 말고 미디어로 올려 주세요. 업로드 상한은 전체 100MB 입니다.",
                    );
                }
                // ⚠ **누적을 여기서 본다 — 다 담고 나서가 아니라.** 파일당 상한만 있고 총량이
                //    없어서, 150MB 짜리 폴더는 **전부 메모리에 올린 뒤에야** 「너무 큽니다」로
                //    거절됐다(실측 VmHWM 445MB ≈ 원본의 3배, 3.2초). 사진·영상이 섞인 1GB 폴더에
                //    「새 버전 배포」를 한 번 누르면 확장 호스트가 그만큼 부푼다 — 그리고 이 자리에는
                //    취소 단추가 없다. 상한은 **메모리 예산**이다 — 업로드 상한과 다른 양이다([MAX_RAW_BYTES]).
                totalBytes += info.size;
                if (totalBytes > MAX_RAW_BYTES) {
                    throw new DevtoolsError(
                        "PACK_FAILED",
                        `폴더가 너무 큽니다 — 원본 ${Math.round(totalBytes / 1024 / 1024)}MB 이상입니다(한 번에 묶을 수 있는 원본은 ${Math.round(MAX_RAW_BYTES / 1024 / 1024)}MB).`,
                        "소스가 아닌 것이 폴더에 들어 있지 않은지 보세요 — 동영상·원본 이미지·빌드 산출물이 흔한 원인입니다. " +
                            "업로드 자체의 상한은 묶은 뒤 크기 100MB 로 따로 있습니다. 다 담기 전에 멈췄습니다.",
                    );
                }
                const data = await readFile(full);
                // ⚠ **이름으로 받은 예외에 내용 문턱을 단다.** 서식은 「값이 없어」 허용한 것이므로,
                //    값이 들어 있으면 그 전제가 깨진 것이다. 막지 말고 **빼고 이름을 댄다** —
                //    규칙을 느슨하게 하는 쪽이 더 나쁘고, 조용히 빼는 쪽도 더 나쁘다.
                if (isValueLessTemplate(item.name.toLowerCase())) {
                    // ⚠ **전제가 깨지면 싣지 않는다.** 예외의 근거는 「서식은 작고 값이 없다」이다.
                    //    스캔 상한을 넘는 파일은 앞부분만 보고 **전체를 싣게** 되므로, 못 본 뒤쪽이
                    //    그대로 나간다(심의 실증). 서식치고 큰 것은 서식이 아니다.
                    const text = info.size > TEMPLATE_SCAN_BYTES ? null : decodeTemplate(data);
                    const found =
                        text === null
                            ? info.size > TEMPLATE_SCAN_BYTES
                                ? "서식치고 너무 큽니다"
                                : "글자로 읽히지 않습니다"
                            : templateHoldsSecret(text);
                    if (found !== null) {
                        dropped.push(`${relative(options.projectDir, full)} (${found})`);
                        continue;
                    }
                }
                entries.push({
                    path: relative(options.projectDir, full).split(sep).join("/"),
                    data,
                });
            }
            // 심볼릭 링크는 담지 않는다 — zip 밖을 가리키는 링크는 서버에서 해제할 때 위험하다.
        }
    };
    await walk(options.projectDir);
    if (dropped.length > 0) {
        // 개수만 말하면 "무엇이?" 가 남는다. 이름을 댄다 — 다만 많으면 앞의 몇만 대고 나머지는 센다.
        //
        // ⚠ **폴더를 앞으로 당긴다.** 배송 문서가 「폴더도 마찬가지입니다 … 그것도 이름을 알려
        //    드립니다」라고 약속하는데, 자른 순서가 그냥 발견 순이라 비밀 파일이 10개를 넘으면
        //    폴더 이름이 「외 N개」에 묻혔다(실증). 폴더는 **통째로** 빠지는 것이라 파일 하나보다
        //    놀라움이 크다 — 먼저 말한다.
        const folders = dropped.filter((name) => name.endsWith("/"));
        const files = dropped.filter((name) => !name.endsWith("/"));
        const shown = [...folders, ...files].slice(0, 10);
        report(
            `비밀로 판단해 뺀 파일 ${dropped.length}개: ${shown.join(", ")}` +
                (dropped.length > shown.length ? ` 외 ${dropped.length - shown.length}개` : ""),
        );
    }

    if (options.provenanceTenant !== undefined) {
        entries.push({ path: PROVENANCE_PATH, data: Buffer.from(buildProvenance(options.provenanceTenant), "utf8") });
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); // 재현 가능한 순서

    const buffer = await createZip(entries);
    return { buffer, fileCount: entries.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

/** 디버깅·CI 용 — 만든 zip 을 파일로 떨군다. */
export async function writeZip(path: string, buffer: Buffer): Promise<void> {
    await writeFile(path, buffer);
}

/** 파일 하나가 이보다 크면 어차피 전체 상한(100MB)을 다 먹는다 — 여기서 이름을 대고 끊는다. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 걷는 동안 **메모리에 쌓는** 원본 바이트의 상한.
 *
 * ⚠ **업로드 상한(100MB)과 같은 값을 쓰면 안 된다.** 그 값은 **압축된 아카이브** 기준인데 여기서
 *   재는 것은 **압축 전 원본**이다. 한때 둘을 같은 100MB 로 겹쳐 놓았더니, 원본 111MB 짜리
 *   텍스트 트리(zip 으로는 0.5MB)가 발행 거부됐다 — 어제까지 올라가던 사이트가 오늘 못 올라가는
 *   형상이다(마감 심의 차단). 커머스 카탈로그·i18n·콘텐츠 JSON 은 실제로 그 규모가 된다.
 *   게다가 처방이 "빌드 산출물·큰 이미지·동영상을 빼세요"라 **없는 것을 찾으라**고 시켰다.
 *
 * 그래서 이 상한이 재는 것은 **메모리 예산**이다(발행 가부는 묶은 뒤 `publish.ts` 가 아카이브
 * 크기로 판정한다 — 그쪽이 서버가 보는 값이다). 실측으로 원본의 약 3배가 최고 상주였으므로
 * (150MB → VmHWM 445MB), 확장 호스트를 1GB 아래로 두려면 원본 300MB 언저리가 선이다.
 */
const MAX_RAW_BYTES = 300 * 1024 * 1024;

let crcTable: Uint32Array | null = null;

function crc32(data: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let i = 0; i < 256; i += 1) {
            let c = i;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[i] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    // ⚠ **인덱스로 훑는다.** `for (const byte of data)` 는 Buffer 를 이터레이터 프로토콜로 돌려
    //   같은 알고리즘이 **5배 느리다**(실측: 64MB 에서 649ms → 123ms). 이 함수는 발행할 때
    //   파일마다 도는데, 확장 호스트는 **다른 확장과 공유**하는 스레드라 그동안 남의 확장도 멈춘다
    //   (64MB 파일 하나에서 이벤트 루프 최대 지연 670ms 실측).
    for (let i = 0; i < data.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]!) & 0xff]!;
    return (crc ^ 0xffffffff) >>> 0;
}
