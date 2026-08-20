import { createHash } from "node:crypto";
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
    if (entries.length > MAX_ENTRIES) {
        throw new DevtoolsError(
            "PACK_FAILED",
            `파일이 너무 많습니다(${entries.length.toLocaleString()}개 · 상한 ${MAX_ENTRIES.toLocaleString()}개).`,
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
 */
/**
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
    ".next",
    "dist",
    "out",
    ".ds_store", // ⚠ 조회가 소문자라 **항목도 소문자여야 한다**(아래 참조)
    ".turbo",
    ".vercel",
    ".claude",
    // ⚠ **`.zalkera/source.json` 은 우리가 만드는 출처 표식이다**(`localMark.ts`). 정본에 실리면,
    //    서버가 만든 다음 판을 받은 폴더가 「나는 그 판에서 왔다」는 낡은 거짓을 품는다 — 그리고
    //    그 거짓이 그 판을 받는 **모두에게** 복제된다. 표식을 쓰는 코드와 이 줄은 같은 커밋에 있다.
    ".zalkera",
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
 * ⚠ **이 목록은 열거다 — 그리고 열거로 끝날 수밖에 없다.**
 *
 * 임의의 소스 트리에서 「무엇이 비밀인가」를 허용목록으로 뒤집을 방법은 없다. 파일 이름도 내용도
 * 고객이 정하기 때문이다. 그래서 이 함수의 보증을 **좁게 잡아 적는다**:
 *
 *  · **반드시 덮는 것** — *우리가 발급한* 비밀. 미리보기 키가 사는 `.env*` 는 접두 규칙으로 전부 뺀다.
 *    우리가 넣은 것이니 우리가 책임진다.
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
 */
function isSecretFile(name: string): boolean {
    const lower = name.toLowerCase();
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
            if (isSecretFile(item.name)) {
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
                //    「새 버전 올리기」를 한 번 누르면 확장 호스트가 그만큼 부푼다 — 그리고 이 자리에는
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
                entries.push({
                    path: relative(options.projectDir, full).split(sep).join("/"),
                    data: await readFile(full),
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
const MAX_ENTRIES = 65_535;

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
