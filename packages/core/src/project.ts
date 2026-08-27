import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DevtoolsError } from "./errors.ts";
import { writeOwnFile } from "./safeWrite.ts";

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
    /**
     * **이 도구 자신**이 사이트 의존에 들어와 있는가(있으면 그 이름들).
     *
     * ⚠ 이것은 `import` 하는 패키지가 아니다 — 사람이 터미널에서 치는 명령이다. 의존에 들어가면
     *   그 `package.json` 이 업로드돼 **서버 빌드가 CLI 를 설치한다.**
     */
    toolInDeps: readonly string[];
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
        toolInDeps: TOOL_PACKAGES.filter((name) => name in deps),
        hasNodeModules: existsSync(join(dir, "node_modules")),
    };
}

/**
 * **이 도구 자신**의 npm 이름들. 사이트 의존에 들어와 있으면 안 되는 것들이다.
 *
 * ■ 왜 이름이 아니라 검사기인가
 *
 * 초안은 이 도구를 **비스코프 이름**으로 내서 「`@zalkera/*` 는 `import` 하는 것」이라는 경계로
 * 오용을 막으려 했다. npm 이 그 이름을 거절해(유사도 검사) 스코프 안으로 들어왔고, 그러면서
 * 이름만으로 지키던 경계가 사라졌다. **이름 관례는 규약이고 이것은 검사다** — 이 레포는 규약보다
 * 검사를 택한다.
 *
 * ■ 무엇이 문제인가
 *
 * 우리 나침반이 「고객 LLM + 로컬 코드 유지보수」다. 에이전트가 `node_modules/@zalkera/client` 에서
 * 규약을 읽는 환경에서 「@zalkera/cli 를 쓰라」는 말을 들으면, 형제 패키지로 보고 **사이트
 * 프로젝트에** 설치할 개연이 크다. 그러면 ⑴ 그 `package.json` 이 업로드돼 **서버 빌드가 CLI 를
 * 설치**하고 ⑵ 사이트 의존 트리에 쓰지도 않는 것이 얹힌다.
 *
 * ⚠ **옛 이름도 함께 본다.** 발행 전에 갈린 이름이라 실제로 설치된 적은 없지만, 이 목록이
 *   「지금 이름 하나」로 좁아지면 이름을 또 바꾸는 날 조용히 뚫린다.
 */
export const TOOL_PACKAGES = ["@zalkera/cli", "@zalkera/devtools", "zalkera", "zalkera-cli"] as const;

/**
 * `.gitignore` 에 `.env.local` 을 보장한다(F4). 미리보기 키가 **레포에 커밋되는 사고**를 막는 마지막 자리다.
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
        // 미리보기가 쓴 `.env.local` 이 `git add -A` 에 그대로 걸려 **미리보기 키가 커밋된다**(실측).
        // 물어야 할 것은 "git 을 쓰는가"이고, 그 답은 `.git/` 존재다.
        if (!existsSync(join(dir, ".git"))) return "not-git";
        await writeOwnFile(path, "# 로컬 자격증명 — 절대 커밋하지 않습니다(zalkera).\n.env.local\n");
        return "created";
    }

    const content = await readFile(path, "utf8");
    const ignored = content
        .split("\n")
        .map((line) => line.trim())
        .some((line) => line === ".env.local" || line === ".env*" || line === ".env*.local");
    if (ignored) return "already";

    const suffix = content.endsWith("\n") || content.length === 0 ? "" : "\n";
    await writeOwnFile(path, `${content}${suffix}\n# 로컬 자격증명 — 절대 커밋하지 않습니다(zalkera).\n.env.local\n`);
    return "added";
}
