/**
 * **서버가 무엇을 저장하는가** — 백엔드 `ArchiveNormalization` 의 이식본(memo191).
 *
 * ■ 왜 이식이 필요한가
 *   판 지문은 「이 폴더를 올리면 서버에 남을 판」을 미리 계산한다. 그런데 서버는 우리가 올린 zip 을
 *   **그대로 저장하지 않는다** — 자기 배제 규칙을 한 번 더 돌린다. 그 규칙을 여기서 같이 돌리지 않으면
 *   예측이 서버와 어긋나고, 화면은 정상 발행 직후에 「다름」이라 말한다.
 *
 * ■ 두 집합은 **양방향으로 다르다** (2026-09-07 실측)
 *   우리(`zip.ts`)만 빼는 것: `dist`·`out`·`.next`·`.turbo`·`.vercel`·`.vscode`·`.idea`·`.aws`·`.ssh`·
 *   `__MACOSX`·`.DS_Store`·`.claude`·`.mcp.json`·`.npmrc`·`.pgpass`·`kubeconfig`·`*.p8` …
 *   **서버만 빼는 것**: `.github/workflows/` · `*.jks`·`*.keystore`·`*.kdbx`·`*.ppk`·`*.ovpn`·
 *   `*.tfstate`·`*.tfvars`·`*.gpg`·`*.pgp` · `authorized_keys`·`known_hosts`·`htpasswd`·`shadow`·
 *   `credentials(.yml|.yaml)`·`secrets(.yml|.yaml)`·`database(.yml|.yaml)`·`wp-config.php` ·
 *   `id_rsa` 류의 **확장자 붙은 변형**(`id_rsa.bak`).
 *
 *   그래서 「우리가 더 많이 뺀다」는 종전 가정은 거짓이었고, 시작 소스 팩 20종이 싣는
 *   `.github/workflows/` 둘 때문에 예제로 시작한 폴더는 **첫 화면부터 「다름」**이었다(심의 실측).
 *
 * ■ 이것이 정본이 아니다 — 백엔드가 정본이다
 *   여기 목록이 백엔드와 갈리면 예측이 조용히 틀린다. 백엔드 게이트
 *   `detect-version-digest-parity.py` 가 두 상수 집합을 **글자로 대사**한다.
 *
 * ■ 범위
 *   경로 판정만 한다. 서버의 단일 폴더 언랩(`effectiveRoot`)은 `sourceVersion.ts` 가 맡는다.
 */

/** 이 접두로 시작하거나 그 이름 자체면 뺀다(대소문자 무시). 백엔드 `EXCLUDED_PREFIXES`. */
const EXCLUDED_PREFIXES = [".git/", "node_modules/", ".github/workflows/"];

/** 백엔드 `SECRET_FILE_NAMES` — 세그먼트 **전체 이름** 일치. */
const SECRET_FILE_NAMES = new Set([
    "authorized_keys", "known_hosts", "netrc", "htpasswd", "shadow",
    "credentials", "credentials.json", "credentials.yml", "credentials.yaml",
    "secrets.json", "secrets.yml", "secrets.yaml",
    "database.yml", "database.yaml", "wp-config.php",
]);

/** 백엔드 `SECRET_BASE_NAMES` — 첫 성분(확장자 앞) 일치. `id_card.png` 는 남는다. */
const SECRET_BASE_NAMES = new Set([
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk",
]);

/** 백엔드 `SECRET_EXTENSIONS` — 성분 전수 일치. 공개물(crt·cer·pub·asc)은 일부러 없다. */
const SECRET_EXTENSIONS = new Set([
    "pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "ovpn",
    "env", "tfstate", "tfvars", "gpg", "pgp",
]);

/** 백엔드 `ENV_FILE_KEEP_SUFFIXES` — 값 없는 서식은 시크릿이 아니다. */
const ENV_KEEP_SUFFIXES = [".example", ".sample", ".template"];

const ENV_FILE_REGEX = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_DIR_REGEX = /(^|\/)\.env(\.[^/]*)?\//;

/** 백엔드 `isEnvFile` 과 같은 문. 디렉터리 형태는 **서식 예외를 안 준다**. */
function isEnvFile(path: string): boolean {
    if (ENV_DIR_REGEX.test(path)) return true;
    if (!ENV_FILE_REGEX.test(path)) return false;
    const name = path.slice(path.lastIndexOf("/") + 1);
    return !ENV_KEEP_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * 백엔드 `isSecretFile` 과 같은 문 — 어느 세그먼트든 이름·첫 성분·확장자가 걸리면 참.
 * **부분문자열로 재지 않는다**(`assets/monkey-keys.css` 가 조용히 사라지는 자리).
 */
function isSecretFile(path: string): boolean {
    return path.split("/").some((segment) => {
        const name = segment.toLowerCase();
        if (name === "") return false;
        const parts = name.split(".");
        const exts = parts.slice(1);
        if (exts.length > 0 && ENV_KEEP_SUFFIXES.some((s) => name.endsWith(s))) return false;
        if (SECRET_FILE_NAMES.has(name)) return true;
        if (SECRET_BASE_NAMES.has(parts[0]!)) return true;
        return exts.some((e) => SECRET_EXTENSIONS.has(e));
    });
}

/** 서버가 이 경로를 **저장하지 않는가**. 경로는 `/` 구분 상대경로(언랩 뒤 기준). */
export function serverExcluded(relativePath: string): boolean {
    const normalized = relativePath.replace(/^\/+/, "");
    if (isEnvFile(normalized)) return true;
    if (isSecretFile(normalized)) return true;
    // ⚠ 접두도 대소문자를 접는다 — `.GitHub/workflows/ci.yml` 이 통과하면 목록이 아니다(백엔드 주석).
    const folded = normalized.toLowerCase();
    return EXCLUDED_PREFIXES.some((p) => folded === p.slice(0, -1) || folded.startsWith(p));
}

/** 대사기가 읽는 자리 — 백엔드 상수와 글자로 대조된다. 이름을 바꾸면 그쪽도 같이 고쳐야 한다. */
export const SERVER_NORMALIZATION_SETS = {
    prefixes: EXCLUDED_PREFIXES,
    secretFileNames: [...SECRET_FILE_NAMES],
    secretBaseNames: [...SECRET_BASE_NAMES],
    secretExtensions: [...SECRET_EXTENSIONS],
    envKeepSuffixes: ENV_KEEP_SUFFIXES,
} as const;
