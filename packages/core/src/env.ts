import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertOwnFileWritable } from "./safeWrite.ts";

/**
 * `.env.local` 조립(backend memo146 §3.3·§10-2).
 *
 * **우리가 손대는 칸은 다섯이고, 나머지는 한 글자도 건드리지 않는다.** 고객이 넣어 둔 카카오 키·리밸리데이트
 * 시크릿 따위를 덮어쓰면 그 손해는 우리가 되돌려 줄 수 없다. 그래서 이 모듈은 **파일을 다시 쓰지 않고**
 * 줄 단위로 갈아 끼운다 — 주석·빈 줄·따옴표·줄 순서가 그대로 남는다.
 */
export const MANAGED_KEYS = [
    "ZALKERA_API_BASE",
    "ZALKERA_TENANT",
    "ZALKERA_STOREFRONT_KEY",
    "ZALKERA_SITE_URL",
    "NEXT_PUBLIC_ZALKERA_PREVIEW",
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface PreviewEnv {
    ZALKERA_API_BASE: string;
    ZALKERA_TENANT: string;
    ZALKERA_STOREFRONT_KEY: string;
    ZALKERA_SITE_URL: string;
    NEXT_PUBLIC_ZALKERA_PREVIEW: string;
}

/**
 * 기존 내용에 관리 대상 다섯 칸만 반영한 새 본문을 만든다(순수 함수 — 파일 입출력 없음).
 *
 * - 이미 있는 키는 **그 자리에서** 값만 바뀐다(위치 이동 없음 — diff 가 조용해진다).
 * - 없는 키는 파일 끝에 우리 블록으로 붙는다.
 * - 관리 대상이 아닌 줄은 원문 그대로 살아남는다(주석·빈 줄 포함).
 */
export function mergeEnv(existing: string, values: PreviewEnv): string {
    const pending = new Map<string, string>(Object.entries(values));
    const lines = existing.length === 0 ? [] : existing.split("\n");

    // ⚠ **중복 선언은 뒤엣것이 이긴다**(dotenv 규칙 · 심의 경고). 초판은 첫 줄만 갱신하고 뒤에 남은 옛 줄을
    // 그대로 뒀다 — 폐기된 키가 채택돼 **영구 401** 이 되고, 우리가 안내하는 "프리뷰를 다시 켜세요"를 따라도
    // 같은 결과가 반복됐다(사용자가 못 빠져나오는 왕복). 먼저 갱신할 키의 **중복 줄을 걷어낸다**.
    const seen = new Set<string>();
    const deduped = lines.filter((line) => {
        const key = keyOf(line);
        if (key === null || !pending.has(key)) return true;
        if (seen.has(key)) return false; // 같은 관리 키의 두 번째 이후 선언은 버린다.
        seen.add(key);
        return true;
    });

    const merged = deduped.map((line) => {
        const key = keyOf(line);
        if (key === null || !pending.has(key)) return line;
        const value = pending.get(key)!;
        pending.delete(key);
        return `${key}=${quoteIfNeeded(value)}`;
    });

    if (pending.size > 0) {
        if (merged.length > 0 && merged[merged.length - 1]?.trim() !== "") merged.push("");
        merged.push("# zalkera 확장이 관리하는 칸 — 프리뷰를 켤 때마다 갱신됩니다(다른 줄은 건드리지 않습니다).");
        for (const key of MANAGED_KEYS) {
            const value = pending.get(key);
            if (value !== undefined) merged.push(`${key}=${quoteIfNeeded(value)}`);
        }
        merged.push("");
    }
    return merged.join("\n");
}

/** `.env.local` 을 읽어 다섯 칸만 갱신해 다시 쓴다. 파일이 없으면 새로 만든다. */
export async function writePreviewEnv(projectDir: string, values: PreviewEnv): Promise<string> {
    const path = join(projectDir, ".env.local");
    const existing = existsSync(path) ? await readFile(path, "utf8") : "";
    const merged = mergeEnv(existing, values);
    // ⚠ 이 파일에는 방금 발급한 프리뷰 키가 들어간다. 자리가 심링크면 **프로젝트 밖으로** 나가고,
    //   `.env*` 를 zip 에서 빼고 `.gitignore` 에 넣어 세운 "자격증명은 안 샌다" 가 그 한 번으로 거짓이 된다.
    await assertOwnFileWritable(path, ".env.local");
    await writeFile(path, merged, { encoding: "utf8", mode: 0o600 });
    // `mode` 는 **생성 시에만** 적용된다 — 이미 644 로 있던 파일은 그대로였다(심의 실측).
    // 공용 기계의 다른 로컬 사용자가 프리뷰 키를 읽는 자리라 매번 조인다. 윈도우에서는 무의미하나 무해하다.
    await chmod(path, 0o600).catch(() => {});
    return path;
}

/**
 * 로그아웃 시 자격증명만 지운다(A4). **다른 칸은 남긴다** — 로그아웃이 고객 설정을 청소할 이유가 없다.
 * 키 줄은 값을 비우는 것이 아니라 **줄째 지운다**(빈 값이 남으면 dev 서버가 빈 키로 붙어 401 을 만든다).
 */
export function stripCredentials(existing: string): string {
    return existing
        .split("\n")
        .filter((line) => keyOf(line) !== "ZALKERA_STOREFRONT_KEY")
        .join("\n");
}

/** 이 줄이 선언하는 키 이름(없으면 null). `export KEY=` 형태와 앞 공백을 받아들인다. */
function keyOf(line: string): string | null {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match?.[1] ?? null;
}

/** 공백·따옴표·# 이 든 값만 따옴표로 감싼다 — 평범한 값에 불필요한 따옴표를 붙이지 않는다. */
function quoteIfNeeded(value: string): string {
    return /[\s"'#]/.test(value) ? JSON.stringify(value) : value;
}
