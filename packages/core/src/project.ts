import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";

/**
 * 프로젝트 판별과 위생. **"잘커라 사이트인가"를 좁게 묻지 않는다** — 고객 소스는 우리 템플릿에서
 * 얼마든지 멀어질 수 있고(그것이 소스 소유의 뜻이다), 좁게 물으면 정상 소스를 우리가 거절하게 된다.
 * 여기서 요구하는 것은 **개발 서버를 띄울 수 있는 최소 조건** 하나뿐이다: `package.json` 이 있을 것.
 */
export interface ProjectInfo {
    dir: string;
    /** `package.json` 이 선언한 이름(없으면 폴더명). 화면 표시용. */
    name: string;
    /** 의존성에 `next` 가 있는가 — 개발 서버 기동 방식을 정한다. */
    hasNext: boolean;
    /** `@zalkera/client` 선언 버전(없으면 null). 핸드셰이크의 최소 버전과 대조한다. */
    clientVersion: string | null;
    /** 의존성이 설치돼 있는가. */
    hasNodeModules: boolean;
}

interface PackageJson {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
}

export async function inspectProject(dir: string): Promise<ProjectInfo> {
    const packagePath = join(dir, "package.json");
    if (!existsSync(packagePath)) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "이 폴더에서 사이트 소스를 찾지 못했습니다.",
            "사이트 소스 폴더(package.json 이 있는 곳)를 골라 주세요.",
        );
    }

    let parsed: PackageJson;
    try {
        parsed = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
    } catch (cause) {
        throw new DevtoolsError(
            "NOT_A_SITE",
            "package.json 을 읽지 못했습니다(형식 오류).",
            "파일이 편집 중 깨졌는지 확인해 주세요.",
            cause,
        );
    }

    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    return {
        dir,
        name: parsed.name ?? dir.split("/").filter(Boolean).pop() ?? dir,
        hasNext: "next" in deps,
        clientVersion: deps["@zalkera/client"] ?? null,
        hasNodeModules: existsSync(join(dir, "node_modules")),
    };
}

/**
 * `.gitignore` 에 `.env.local` 을 보장한다(F4). 프리뷰 키가 **레포에 커밋되는 사고**를 막는 마지막 자리다.
 *
 * 이미 무시되고 있으면 아무것도 하지 않는다(중복 줄을 만들지 않는다). `.gitignore` 가 없으면 만들지 않는다 —
 * git 을 쓰지 않는 고객에게 git 파일을 만들어 주는 것은 우리 일이 아니다(업로드 경로는 git 이 안 보인다).
 * 대신 그 사실을 반환값으로 알린다.
 */
export async function ensureEnvIgnored(dir: string): Promise<"already" | "added" | "created" | "not-git"> {
    const path = join(dir, ".gitignore");
    if (!existsSync(path)) {
        // ⚠ **판정 축이 틀렸었다**(심의 차단 · 2026-08-03): 초판은 "`.gitignore` 파일이 있는가"로 물었다.
        // `git init` 만 한 폴더(신규 레포의 기본 상태)에서는 그 파일이 없으므로 아무것도 안 했고,
        // 프리뷰가 쓴 `.env.local` 이 `git add -A` 에 그대로 걸려 **프리뷰 키가 커밋된다**(실측).
        // 물어야 할 것은 "git 을 쓰는가"이고, 그 답은 `.git/` 존재다.
        if (!existsSync(join(dir, ".git"))) return "not-git";
        await writeFile(path, "# 로컬 자격증명 — 절대 커밋하지 않습니다(zalkera).\n.env.local\n", "utf8");
        return "created";
    }

    const content = await readFile(path, "utf8");
    const ignored = content
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line === ".env.local" || line === ".env*" || line === ".env*.local");
    if (ignored) return "already";

    const suffix = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    await writeFile(path, `${content}${suffix}\n# 로컬 자격증명 — 절대 커밋하지 않습니다(zalkera).\n.env.local\n`, "utf8");
    return "added";
}
