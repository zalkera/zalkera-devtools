import { lstat, mkdir } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import { DevtoolsError } from "./errors.ts";

/**
 * **받은 것을 디스크에 내려놓을 때의 판정.** 해제기(zip·tar)와 우리가 소유하는 파일 쓰기가 **같은
 * 한 벌**을 씁니다.
 *
 * ■ 왜 한 모듈인가
 *   이 판정은 두 벌로 살다가 갈렸습니다. tar 쪽은 *"부모 조각을 하나씩 `lstat` 해서 심링크면 거부"*
 *   로 고쳐졌는데, zip 쪽은 *"tar 해제기와 **같은 판정**이어야 한다"* 는 **주석만** 남기고 어휘
 *   판정(`resolve`·`normalize` 문자열 비교)을 유지했습니다. 그래서 같은 아카이브·같은 폴더에서
 *   tar 는 막고 zip 은 폴더 밖에 썼습니다.
 *
 * ■ 왜 문자열 판정으로는 부족한가
 *   `resolve("/root", "a/b")` 는 `/root/a/b` 라 어휘상 뿌리 안입니다. 그런데 `a` 가 이미 심링크면
 *   `writeFile` 은 그 링크를 따라가 **링크가 가리키는 곳**에 씁니다. 판정은 문자열이 아니라
 *   **파일시스템**에 물어야 합니다.
 *
 * ■ `..` 자체를 금지할 수 없는 이유
 *   `node_modules/.bin` 의 링크가 전부 `../` 입니다(실측). 그래서 금지가 아니라 **하강 검사**입니다.
 */

/**
 * 항목 이름을 뿌리 기준 조각 배열로. 뿌리 밖·절대경로·NUL 은 여기서 거절한다.
 *
 * 이것은 **어휘 판정**이고, 그것만으로는 부족하다 — 반드시 [descend] 와 함께 쓴다.
 */
export function safeSegments(root: string, name: string): string[] {
    const cleaned = name.replace(/^(\.\/)+/, "");
    if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned) || cleaned.includes("\0")) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일에 이상한 경로가 있습니다: ${name}`);
    }
    const path = resolve(root, normalize(cleaned));
    if (path !== root && !path.startsWith(root + sep)) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 파일이 폴더 밖을 가리킵니다: ${name}`);
    }
    return relative(root, path)
        .split(sep)
        .filter((part) => part.length > 0);
}

/**
 * 뿌리에서 조각 단위로 내려가며 **각 조각이 심링크가 아님을 확인**하고, 없으면 만든다.
 *
 * `verified` 는 이미 확인한 디렉터리 집합이다 — 항목마다 뿌리부터 다시 `lstat` 하지 않으려는 것이고,
 * 같은 해제 한 번 안에서만 유효하다.
 */
export async function descend(root: string, segments: string[], verified: Set<string>): Promise<string> {
    let current = root;
    for (const part of segments) {
        const next = join(current, part);
        if (verified.has(next)) {
            current = next;
            continue;
        }
        const info = await lstat(next).catch(() => null);
        if (info?.isSymbolicLink()) {
            throw new DevtoolsError(
                "SERVER_REJECTED",
                `받은 꾸러미가 링크를 거쳐 폴더 밖에 쓰려고 합니다: ${part}`,
                "잘못 받은 상태로 진행하지 않았습니다. 잘커라에 문의해 주세요.",
            );
        }
        if (!info) {
            await mkdir(next).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
            });
        } else if (!info.isDirectory()) {
            throw new DevtoolsError("SERVER_REJECTED", `받은 꾸러미의 경로가 파일과 겹칩니다: ${part}`);
        }
        verified.add(next);
        current = next;
    }
    return current;
}

/** 마지막 조각 자신이 심링크면 거부한다 — 부모가 깨끗해도 파일 자리가 링크일 수 있다. */
export async function assertNotSymlink(path: string, name: string): Promise<void> {
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) {
        throw new DevtoolsError("SERVER_REJECTED", `받은 꾸러미가 기존 링크를 덮어쓰려고 합니다: ${name}`);
    }
}

/**
 * **우리가 소유하는 파일**을 쓰기 전 확인. 해제기가 아니라 `.env.local`·`.mcp.json`·`AGENTS.md`
 * 처럼 우리가 만들어 주는 파일이 대상이다.
 *
 * 그 자리가 심링크면 내용이 링크 대상으로 간다 — `.env.local` 이면 **방금 발급한 프리뷰 키가
 * 프로젝트 밖으로** 나가고, 도구가 `.env*` 를 zip 에서 빼고 `.gitignore` 에 넣어 세운
 * "자격증명은 안 샌다" 가 그 한 번으로 거짓이 된다.
 */
export async function assertOwnFileWritable(path: string, label: string): Promise<void> {
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            `${label} 이 링크라 쓰지 않았습니다.`,
            "이 파일은 확장이 만들어 주는 자리입니다. 링크를 지우고 다시 시도해 주세요.",
        );
    }
}
